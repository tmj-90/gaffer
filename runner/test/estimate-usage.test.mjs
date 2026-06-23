#!/usr/bin/env node
// =====================================================================
// SPEND ESTIMATE validation (lib/estimate.mjs + bin/estimate-usage.mjs).
// ---------------------------------------------------------------------
// The point of this tool is HONESTY — it PREDICTS a ticket's likely token/turn
// usage from history so a human can sanity-check spend BEFORE a run. These checks
// prove the honesty rules are enforced in CODE, not just documented:
//   AC1  correct median + p10–p90 RANGE over the MEASURED rows of a kind, and
//        measured:false / "unknown" rows contribute NOTHING
//   AC2  thin history (< MIN_SAMPLES) → the "not enough history" notice and NO
//        numbers (never extrapolate from 1–2 samples)
//   AC3  output is TOKENS + TURNS, carries the loud "actuals may differ" label,
//        and contains NO '$' / cost figure anywhere
//   AC4  --ticket resolves the ticket's kind from its latest measured ledger row
//   AC5  bad invocation (unknown / missing kind) exits non-zero
//
// Zero deps beyond node. Run: node test/estimate-usage.test.mjs
// =====================================================================
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_DIR = resolve(HERE, "..");
const CLI = resolve(RUNNER_DIR, "bin", "estimate-usage.mjs");
const LIB = resolve(RUNNER_DIR, "lib", "estimate.mjs");

const {
  MIN_SAMPLES,
  parseLedger,
  filterMeasured,
  summarise,
  median,
  percentile,
  rowInputTokens,
  rowOutputTokens,
  resolveTicketKind,
} = await import(LIB);

let passed = 0;
const failures = [];
const ok = (m) => {
  passed++;
  console.log(`  ok   ${m}`);
};
const bad = (m) => {
  failures.push(m);
  console.log(`  FAIL ${m}`);
};
const assert = (m, cond) => (cond ? ok(m) : bad(m));

// --- Synthetic ledger helpers -----------------------------------------------
// A measured delivery row whose single model carries the given input/output
// tokens and num_turns. Mirrors the shape lib/usage-ledger.mjs writes.
function measuredRow({ ticket, kind, ts, input, output, turns }) {
  return JSON.stringify({
    ts,
    ticket,
    kind,
    measured: true,
    models: {
      "claude-sonnet-4-6": { input, output, cache_read: 9999, cache_create: 1, cost_usd: 0.05 },
    },
    total_cost_usd: 0.05,
    num_turns: turns,
    duration_ms: 1000,
  });
}

// An UNMEASURED row — every numeric field is the string "unknown". Must be ignored.
function unknownRow({ ticket, kind, ts }) {
  return JSON.stringify({
    ts,
    ticket,
    kind,
    measured: false,
    unknown_reason: "timeout",
    models: "unknown",
    total_cost_usd: "unknown",
    num_turns: "unknown",
    duration_ms: "unknown",
  });
}

// 10 measured delivery rows: input 100..1000, output 10..100, turns 1..10.
// Plus 2 unknown delivery rows (with absurd would-be values) that MUST be ignored.
function richLedger() {
  const lines = [];
  for (let i = 1; i <= 10; i++) {
    lines.push(
      measuredRow({
        ticket: i,
        kind: "delivery",
        ts: `2026-06-${String(i).padStart(2, "0")}T00:00:00.000Z`,
        input: i * 100,
        output: i * 10,
        turns: i,
      }),
    );
  }
  // Noise that must NOT affect the estimate.
  lines.push(unknownRow({ ticket: 99, kind: "delivery", ts: "2026-06-15T00:00:00.000Z" }));
  lines.push(unknownRow({ ticket: 98, kind: "delivery", ts: "2026-06-16T00:00:00.000Z" }));
  // A measured row of ANOTHER kind that must not leak into a delivery estimate.
  lines.push(
    measuredRow({
      ticket: 50,
      kind: "review",
      ts: "2026-06-14T00:00:00.000Z",
      input: 999999,
      output: 999999,
      turns: 999,
    }),
  );
  return lines.join("\n") + "\n";
}

function writeLedger(text) {
  const dir = mkdtempSync(join(tmpdir(), "estimate-"));
  const path = join(dir, "usage-ledger.jsonl");
  writeFileSync(path, text);
  return { dir, path };
}

function runCli(extraArgs, env = {}) {
  return spawnSync(process.execPath, [CLI, ...extraArgs], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

// ============================================================================
console.log("== AC1: median + p10–p90 range over MEASURED rows; unknown rows ignored ==");
{
  const records = parseLedger(richLedger());
  const measured = filterMeasured(records, "delivery");
  assert(
    "exactly 10 measured delivery rows kept (2 unknown + 1 review dropped)",
    measured.length === 10,
  );

  const inputs = measured.map(rowInputTokens);
  // values 100..1000 → median 550, p10 190, p90 910 (type-7 interpolation)
  assert("input median = 550", median(inputs) === 550);
  assert("input p10 = 190", percentile(inputs, 10) === 190);
  assert("input p90 = 910", percentile(inputs, 90) === 910);

  const outputs = measured.map(rowOutputTokens);
  assert("output median = 55", median(outputs) === 55);

  const s = summarise(measured, "delivery");
  assert("summary reports n=10", s.n === 10);
  assert("summary marks enough history", s.enough === true);
  assert(
    "summary input band correct",
    s.inputTokens.median === 550 && s.inputTokens.low === 190 && s.inputTokens.high === 910,
  );
  assert(
    "summary turns band correct (1..10)",
    s.turns.median === 5.5 && s.turns.low === 1.9 && s.turns.high === 9.1,
  );
  assert(
    "summary carries date range from MEASURED rows only",
    s.dateRange.first === "2026-06-01T00:00:00.000Z" &&
      s.dateRange.last === "2026-06-10T00:00:00.000Z",
  );
  // Honesty rule 1: the summary object carries NO cost field.
  assert(
    "summary has no cost/dollar field",
    !("cost" in s) && !("total_cost_usd" in s) && !("cost_usd" in s),
  );
}

console.log("== AC1 (CLI): rich history prints an estimate with tokens + turns ==");
{
  const { dir, path } = writeLedger(richLedger());
  try {
    const res = runCli(["--kind", "delivery", "--ledger", path]);
    assert("CLI exits 0 on rich history", res.status === 0);
    assert("CLI reports input tokens", /input tokens/.test(res.stdout));
    assert("CLI reports output tokens", /output tokens/.test(res.stdout));
    assert("CLI reports turns", /turns/.test(res.stdout));
    assert("CLI shows median input ~550", /550/.test(res.stdout));
    assert(
      "CLI shows N=10 basis",
      /N=10/.test(res.stdout) || /10 past delivery calls/.test(res.stdout),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("== AC2: thin history (< MIN_SAMPLES) → 'not enough history' + NO numbers ==");
{
  // Only 2 measured rows → below the threshold of 5.
  const thin =
    [
      measuredRow({
        ticket: 1,
        kind: "clarify",
        ts: "2026-06-01T00:00:00.000Z",
        input: 123,
        output: 45,
        turns: 3,
      }),
      measuredRow({
        ticket: 2,
        kind: "clarify",
        ts: "2026-06-02T00:00:00.000Z",
        input: 678,
        output: 90,
        turns: 4,
      }),
    ].join("\n") + "\n";
  const { dir, path } = writeLedger(thin);
  try {
    assert("threshold sanity: MIN_SAMPLES === 5", MIN_SAMPLES === 5);
    const measured = filterMeasured(parseLedger(thin), "clarify");
    const s = summarise(measured, "clarify");
    assert("summary marks NOT enough", s.enough === false && s.n === 2);
    assert(
      "summary withholds all numeric bands",
      s.inputTokens === undefined && s.outputTokens === undefined && s.turns === undefined,
    );

    const res = runCli(["--kind", "clarify", "--ledger", path]);
    assert("CLI exits 0 on thin history (honest notice, not an error)", res.status === 0);
    assert(
      "CLI prints the 'not enough history' notice",
      /not enough history to estimate yet/.test(res.stdout),
    );
    assert(
      "CLI states the actual count (only 2)",
      /only 2 measured clarify calls/.test(res.stdout),
    );
    // CRITICAL: never extrapolate — the input token COUNTS must NOT appear.
    assert(
      "CLI prints NO token numbers from the 2 samples",
      !/123/.test(res.stdout) && !/678/.test(res.stdout),
    );
    assert(
      "CLI prints no median/range section",
      !/range/.test(res.stdout) && !/ESTIMATE \(tokens\)/.test(res.stdout),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("== AC3: TOKENS+TURNS only — loud label, and NO '$'/cost anywhere ==");
{
  const { dir, path } = writeLedger(richLedger());
  try {
    const res = runCli(["--kind", "delivery", "--ledger", path]);
    const out = res.stdout;
    // The loud prediction banner (honesty rule 2).
    assert("output carries 'ESTIMATE (tokens)' label", /ESTIMATE \(tokens\)/.test(out));
    assert("output carries 'actuals may differ' disclaimer", /actuals may differ/.test(out));
    assert(
      "output mentions it is a PREDICTION, not a measurement",
      /prediction, not a measurement/i.test(out),
    );
    // Tokens + turns present.
    assert("output contains 'tokens'", /tokens/.test(out));
    assert("output contains 'turns'", /turns/.test(out));
    // Honesty rule 1: ABSOLUTELY no money. No '$', no 'cost', no 'usd', no 'dollar'.
    assert("output contains NO '$' sign", !out.includes("$"));
    assert("output contains no 'cost'", !/cost/i.test(out));
    assert("output contains no 'usd'", !/usd/i.test(out));
    assert("output contains no 'dollar'", !/dollar/i.test(out));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("== AC4: --ticket resolves the ticket's kind from its latest measured row ==");
{
  // Ticket 7 appears as a measured 'delivery' row in the rich ledger.
  const records = parseLedger(richLedger());
  assert("resolveTicketKind(7) → 'delivery'", resolveTicketKind(records, 7) === "delivery");
  assert("resolveTicketKind(50) → 'review'", resolveTicketKind(records, 50) === "review");
  assert(
    "resolveTicketKind(unknown-only ticket 99) → null",
    resolveTicketKind(records, 99) === null,
  );
  assert("resolveTicketKind(absent ticket) → null", resolveTicketKind(records, 12345) === null);

  const { dir, path } = writeLedger(richLedger());
  try {
    const res = runCli(["--ticket", "7", "--ledger", path]);
    assert("CLI --ticket 7 exits 0", res.status === 0);
    assert("CLI announces resolved kind", /resolved ticket 7 → kind 'delivery'/.test(res.stdout));
    assert("CLI then estimates the delivery kind", /ESTIMATE \(tokens\)/.test(res.stdout));

    // A ticket that exists only as unknown rows can't be resolved → exit 2.
    const res2 = runCli(["--ticket", "99", "--ledger", path]);
    assert("CLI --ticket 99 (unknown-only) exits 2", res2.status === 2);
    assert("CLI explains it cannot resolve the kind", /cannot resolve its kind/.test(res2.stderr));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("== AC5: bad invocation exits non-zero ==");
{
  const { dir, path } = writeLedger(richLedger());
  try {
    const noArgs = runCli(["--ledger", path]);
    assert("no --kind / --ticket → exit 2", noArgs.status === 2);

    const badKind = runCli(["--kind", "wibble", "--ledger", path]);
    assert("unknown kind → exit 2", badKind.status === 2);
    assert("unknown kind error names the valid set", /Expected one of/.test(badKind.stderr));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("== AC6: path resolution honours GAFFER_USAGE_LEDGER then GAFFER_DATA ==");
{
  const { dir, path } = writeLedger(richLedger());
  try {
    // Via GAFFER_USAGE_LEDGER (explicit file).
    const res1 = runCli(["--kind", "delivery"], { GAFFER_USAGE_LEDGER: path, GAFFER_DATA: "" });
    assert(
      "GAFFER_USAGE_LEDGER path is used",
      res1.status === 0 && /ESTIMATE \(tokens\)/.test(res1.stdout),
    );
    // Via GAFFER_DATA (default filename inside the dir).
    const res2 = runCli(["--kind", "delivery"], { GAFFER_USAGE_LEDGER: "", GAFFER_DATA: dir });
    assert(
      "GAFFER_DATA/<ledger> path is used",
      res2.status === 0 && /ESTIMATE \(tokens\)/.test(res2.stdout),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log();
if (failures.length === 0) {
  console.log(`PASS: ${passed} checks`);
  process.exit(0);
} else {
  console.log(`FAILED — ${failures.length} of ${passed + failures.length}`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}

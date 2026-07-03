#!/usr/bin/env node
// =====================================================================
// WORKER RESULT PARSER seam (lib/worker.mjs parseResult) — Spec 3 / Phase 2.
// ---------------------------------------------------------------------
// parseResult is the ONE place that knows the `claude -p … --output-format json`
// envelope schema. This suite proves BEHAVIOURAL PARITY with the parsing it
// replaced, against real-shaped Claude JSON fixtures across every input class:
//   • measured        — full modelUsage + top-level usage + cost + turns
//   • unknown          — a result with NO usage signal at all
//   • cap-hit          — num_turns at the cap, and a max-turns stop reason
//   • error envelope   — an is_error / error-shaped result
//   • negative control — a MALFORMED envelope → the degraded/unknown path, no crash
//
// It also pins the `parse-result` CLI (the bash cap/spend guards' entrypoint) to the
// exact legacy output format, and cross-checks that a ledger row (buildUsageRecord)
// and parseResult agree on the same numbers (they share extractUsage).
//
// Zero deps beyond node. Run: node test/worker-parse-result.test.mjs
// =====================================================================
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_DIR = resolve(HERE, "..");
const WORKER = resolve(RUNNER_DIR, "lib", "worker.mjs");
const LEDGER = resolve(RUNNER_DIR, "lib", "usage-ledger.mjs");

const { parseResult, UNKNOWN } = await import(WORKER);
const { buildUsageRecord } = await import(LEDGER);

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

// A real-shaped, fully-measured result envelope (fields verified against the API).
const MEASURED = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "Delivered the feature and committed on the gaffer/ branch.",
  total_cost_usd: 0.1234,
  num_turns: 7,
  duration_ms: 42000,
  stop_reason: "end_turn",
  usage: {
    input_tokens: 1500,
    output_tokens: 800,
    cache_creation_input_tokens: 200,
    cache_read_input_tokens: 5000,
  },
  modelUsage: {
    "claude-opus-4-8": {
      inputTokens: 500,
      outputTokens: 300,
      cacheReadInputTokens: 1000,
      cacheCreationInputTokens: 50,
      costUSD: 0.09,
    },
    "claude-sonnet-4-6": {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadInputTokens: 4000,
      cacheCreationInputTokens: 150,
      costUSD: 0.0334,
    },
  },
};

console.log("== measured envelope: resultText + usage relayed verbatim ==");
{
  const p = parseResult(JSON.stringify(MEASURED));
  assert("resultText is the agent's .result", p.resultText.startsWith("Delivered the feature"));
  assert("total cost relayed verbatim", p.usage.totalCostUsd === 0.1234);
  assert("num_turns verbatim", p.usage.numTurns === 7);
  assert("duration verbatim", p.usage.durationMs === 42000);
  assert(
    "per-model tokens verbatim (opus)",
    p.usage.models["claude-opus-4-8"].input === 500 &&
      p.usage.models["claude-opus-4-8"].cost_usd === 0.09,
  );
  assert("top-level usage carried", p.usage.topLevelUsage.input_tokens === 1500);
  assert("capHit.numTurns is the finite turn count", p.capHit.numTurns === 7);
  assert("not a max-turns stop (end_turn)", p.capHit.stopReasonIsMaxTurns === false);
  assert("stopReason surfaced", p.stopReason === "end_turn");

  // PARITY: a ledger row built from the same json agrees on the numbers.
  const rec = buildUsageRecord({ json: p.json, kind: "delivery" });
  assert(
    "ledger row agrees with parseResult (measured + cost + turns)",
    rec.measured === true && rec.total_cost_usd === 0.1234 && rec.num_turns === 7,
  );
  assert(
    "ledger models === parseResult models (shared extractor)",
    JSON.stringify(rec.models) === JSON.stringify(p.usage.models),
  );
}

console.log("== unknown envelope: no usage signal → 'unknown', never 0 ==");
{
  const p = parseResult(JSON.stringify({ result: "did stuff but no usage block" }));
  assert("resultText still extracted", p.resultText === "did stuff but no usage block");
  assert("cost is UNKNOWN (not 0)", p.usage.totalCostUsd === UNKNOWN && p.usage.totalCostUsd !== 0);
  assert("turns UNKNOWN, models null", p.usage.numTurns === UNKNOWN && p.usage.models === null);
  assert("no cap signal invented from missing data", p.capHit.numTurns === null);
  // PARITY: the ledger treats a no-usage result as UNMEASURED, not all-zeros.
  const rec = buildUsageRecord({ json: p.json, kind: "delivery" });
  assert("ledger row is measured:false for a no-usage result", rec.measured === false);
  assert("ledger cost 'unknown', not 0", rec.total_cost_usd === UNKNOWN);
}

console.log("== cap-hit envelopes: turn count AND max-turns stop reason ==");
{
  const overCap = parseResult(
    JSON.stringify({ num_turns: 60, total_cost_usd: 2.56, result: "hi", stop_reason: "end_turn" }),
  );
  assert("cap: num_turns=60 surfaced", overCap.capHit.numTurns === 60);
  assert("cap: end_turn is not a max-turns stop", overCap.capHit.stopReasonIsMaxTurns === false);

  const reason = parseResult(JSON.stringify({ subtype: "error_max_turns", num_turns: 3 }));
  assert(
    "cap: subtype error_max_turns detected as max-turns",
    reason.capHit.stopReasonIsMaxTurns === true,
  );

  const nested = parseResult(
    JSON.stringify({ error: { message: "hit max-turns limit" }, num_turns: 2 }),
  );
  assert(
    "cap: nested error.message max-turns detected",
    nested.capHit.stopReasonIsMaxTurns === true,
  );
}

console.log("== error envelope: is_error / error-shaped result ==");
{
  const p = parseResult(
    JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "the agent failed partway",
      total_cost_usd: 0.02,
      num_turns: 4,
    }),
  );
  // An error envelope that STILL carries a cost/turn signal is measured honestly.
  assert("error envelope with a cost signal relays it", p.usage.totalCostUsd === 0.02);
  assert("error envelope resultText preserved", p.resultText === "the agent failed partway");
  assert("error subtype (non-maxturns) is not a cap-hit", p.capHit.stopReasonIsMaxTurns === false);
  const rec = buildUsageRecord({ json: p.json, kind: "delivery" });
  assert("ledger row for error envelope stays measured (has cost signal)", rec.measured === true);
}

console.log("== negative control: MALFORMED envelope → degraded path, never a crash ==");
{
  let threw = false;
  let p;
  try {
    p = parseResult("not json at all }{ truncated  ");
  } catch {
    threw = true;
  }
  assert("malformed text never throws", threw === false);
  assert("malformed → json null", p.json === null);
  assert("malformed → resultText ''", p.resultText === "");
  assert("malformed → cost UNKNOWN (not 0)", p.usage.totalCostUsd === UNKNOWN);
  assert(
    "malformed → no cap invented",
    p.capHit.numTurns === null && p.capHit.stopReasonIsMaxTurns === false,
  );
  // Empty / non-string inputs degrade the same way.
  assert("empty string degrades cleanly", parseResult("").json === null);
  assert("undefined input degrades cleanly", parseResult(undefined).usage.numTurns === UNKNOWN);
}

console.log("== parse-result CLI: the bash cap/spend guards' entrypoint (exact format) ==");
{
  const dir = mkdtempSync(join(tmpdir(), "worker-pr-"));
  try {
    const write = (name, obj) => {
      const f = join(dir, name);
      writeFileSync(f, typeof obj === "string" ? obj : JSON.stringify(obj));
      return f;
    };
    const run = (field, f) =>
      spawnSync(process.execPath, [WORKER, "parse-result", field, "--json-file", f], {
        encoding: "utf8",
      });

    const measuredFile = write("measured.json", MEASURED);
    const reasonFile = write("reason.json", { subtype: "error_max_turns", num_turns: 3 });
    const underFile = write("under.json", { num_turns: 12, total_cost_usd: 0.4 });
    const noCostFile = write("nocost.json", { num_turns: 3 });
    const garbageFile = write("garbage.json", "totally not json");

    // num-turns: integer or empty.
    const nt = run("num-turns", measuredFile);
    assert("CLI num-turns prints the integer", nt.status === 0 && nt.stdout === "7");
    const ntMissing = run("num-turns", garbageFile);
    assert(
      "CLI num-turns empty on unparseable (exit 0)",
      ntMissing.status === 0 && ntMissing.stdout === "",
    );

    // spend: "$x.xxxx" or "unknown".
    const sp = run("spend", underFile);
    assert('CLI spend prints "$0.4000"', sp.status === 0 && sp.stdout === "$0.4000");
    const spUnknown = run("spend", noCostFile);
    assert('CLI spend prints "unknown" when no cost (never $0)', spUnknown.stdout === "unknown");
    const spGarbage = run("spend", garbageFile);
    assert("CLI spend degrades to 'unknown' on garbage", spGarbage.stdout === "unknown");

    // stopreason-maxturns: exit 0 iff max-turns.
    const srYes = run("stopreason-maxturns", reasonFile);
    assert("CLI stopreason-maxturns exit 0 on a max-turns stop", srYes.status === 0);
    const srNo = run("stopreason-maxturns", underFile);
    assert("CLI stopreason-maxturns exit 1 when not max-turns", srNo.status === 1);
    const srGarbage = run("stopreason-maxturns", garbageFile);
    assert("CLI stopreason-maxturns exit 1 on garbage (no crash)", srGarbage.status === 1);
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

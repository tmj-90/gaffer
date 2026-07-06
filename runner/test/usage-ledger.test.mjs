#!/usr/bin/env node
// =====================================================================
// USAGE LEDGER validation (lib/usage-ledger.mjs).
// ---------------------------------------------------------------------
// Proves the honest-usage discipline that mirrors the safety-block ledger:
//   AC1  a record is written from a sample claude JSON with CORRECT token/cost
//        passthrough (tokens verbatim, dollars RELAYED — never computed)
//   AC2  an UNMEASURABLE call (rc!=0 / no JSON / no usage block) records
//        "unknown" — NEVER 0, never inferred — with measured:false
//   AC3  the ledger is GATED on GAFFER_DATA and FULLY SWALLOWED (no GAFFER_DATA →
//        no write, no throw); the CLI prints the agent's `.result` text so the
//        bash caller can preserve its human-readable log
//   AC4  --output-format json is the actual switch wired into every call site
//
// Zero deps beyond node. Run: node test/usage-ledger.test.mjs
// =====================================================================
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_DIR = resolve(HERE, "..");
const MOD = resolve(RUNNER_DIR, "lib", "usage-ledger.mjs");

const {
  parseClaudeJson,
  buildUsageRecord,
  unknownRecord,
  extractResultText,
  appendUsageRecord,
  UNKNOWN,
  LEDGER_FILENAME,
} = await import(MOD);

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

// Ground-truth-shaped result object (verified API fields).
const SAMPLE = {
  type: "result",
  subtype: "success",
  result: "Delivered the feature and committed on the gaffer/ branch.",
  total_cost_usd: 0.1234,
  num_turns: 7,
  duration_ms: 42000,
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

console.log("== AC1: record from sample JSON — token/cost passthrough ==");
{
  const json = parseClaudeJson(JSON.stringify(SAMPLE));
  assert("whole-string JSON parses to an object", json && typeof json === "object");
  const rec = buildUsageRecord({
    json,
    ticket: 42,
    kind: "delivery",
    ts: "2026-01-01T00:00:00.000Z",
  });
  assert("measured:true", rec.measured === true);
  assert("ticket + kind carried", rec.ticket === 42 && rec.kind === "delivery");
  // Tokens are GROUND TRUTH — verbatim from modelUsage's camelCase fields.
  const opus = rec.models["claude-opus-4-8"];
  const sonnet = rec.models["claude-sonnet-4-6"];
  assert(
    "opus tokens verbatim",
    opus.input === 500 &&
      opus.output === 300 &&
      opus.cache_read === 1000 &&
      opus.cache_create === 50,
  );
  assert(
    "sonnet tokens verbatim",
    sonnet.input === 1000 &&
      sonnet.output === 500 &&
      sonnet.cache_read === 4000 &&
      sonnet.cache_create === 150,
  );
  // Dollars are RELAYED from Claude Code's own costUSD / total_cost_usd — NOT computed.
  assert("per-model cost relayed verbatim", opus.cost_usd === 0.09 && sonnet.cost_usd === 0.0334);
  assert("total_cost_usd relayed verbatim", rec.total_cost_usd === 0.1234);
  assert("num_turns + duration_ms verbatim", rec.num_turns === 7 && rec.duration_ms === 42000);
  assert("result text extracted", extractResultText(json).startsWith("Delivered the feature"));
}

console.log("== AC1b: cost is NEVER fabricated when the API omits it ==");
{
  // A modelUsage entry with NO costUSD, and NO total_cost_usd: cost must be
  // "unknown", never a computed/zero number (no hidden price table).
  const noCost = {
    result: "x",
    num_turns: 1,
    modelUsage: { "claude-sonnet-4-6": { inputTokens: 10, outputTokens: 5 } },
  };
  const rec = buildUsageRecord({ json: noCost, kind: "review" });
  assert(
    "missing per-model cost → unknown (not 0)",
    rec.models["claude-sonnet-4-6"].cost_usd === UNKNOWN,
  );
  assert("missing total cost → unknown (not 0)", rec.total_cost_usd === UNKNOWN);
  assert(
    "tokens still verbatim alongside unknown cost",
    rec.models["claude-sonnet-4-6"].input === 10,
  );
}

console.log("== AC2: unmeasurable call → 'unknown', never 0 ==");
{
  // (a) helper.
  const u = unknownRecord({ ticket: 9, kind: "clarify", reason: "timeout" });
  assert("measured:false", u.measured === false);
  assert("models = 'unknown'", u.models === UNKNOWN);
  assert(
    "total_cost_usd = 'unknown' (NOT 0)",
    u.total_cost_usd === UNKNOWN && u.total_cost_usd !== 0,
  );
  assert("num_turns/duration = 'unknown'", u.num_turns === UNKNOWN && u.duration_ms === UNKNOWN);
  // (b) a result JSON with NO usage block at all → treated as unmeasured, not all-zeros.
  const noUsage = buildUsageRecord({
    json: { result: "did stuff but no usage" },
    kind: "delivery",
  });
  assert("no-usage result → measured:false", noUsage.measured === false);
  assert("no-usage result → cost 'unknown', not 0", noUsage.total_cost_usd === UNKNOWN);
  // (c) unparseable text → null → caller records unknown.
  assert("garbage text → parse null", parseClaudeJson("not json at all") === null);
  assert("empty text → parse null", parseClaudeJson("") === null);
}

console.log("== AC2b: embedded JSON object is still recovered (defensive parse) ==");
{
  const noisy = `some log line\n${JSON.stringify(SAMPLE)}\ntrailing noise`;
  const json = parseClaudeJson(noisy);
  assert("last balanced {…} recovered from noisy stdout", json && json.total_cost_usd === 0.1234);
}

console.log("== AC3: gated on GAFFER_DATA + fully swallowed ==");
{
  // No GAFFER_DATA, no explicit path → no write, returns false, never throws.
  let threw = false;
  let wrote = true;
  try {
    wrote = appendUsageRecord({ measured: true }, {}); // empty env
  } catch {
    threw = true;
  }
  assert("no GAFFER_DATA → no write (returns false)", wrote === false);
  assert("gated-off append never throws", threw === false);
}

console.log("== R-4: an append FAILURE is non-fatal but VISIBLE (warns; doesn't throw) ==");
{
  // A resolvable path that cannot be written (the parent dir does not exist) forces
  // appendFileSync to throw. The append must stay non-fatal (no throw, returns false)
  // yet now SURFACE a WARNING so a measurement gap is visible — not silently dropped.
  const unwritable = join(tmpdir(), "no-such-dir-xyz", "ledger.jsonl");
  const errs = [];
  const origWrite = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    errs.push(String(chunk));
    return origWrite.call(process.stderr, chunk, ...rest);
  };
  let wrote = true;
  let threw = false;
  try {
    wrote = appendUsageRecord({ ticket: 77, measured: true }, { GAFFER_USAGE_LEDGER: unwritable });
  } catch {
    threw = true;
  } finally {
    process.stderr.write = origWrite;
  }
  assert("R-4: append to an unwritable path returns false", wrote === false);
  assert("R-4: append failure never throws (tick unaffected)", threw === false);
  const warned = errs.join("");
  assert(
    "R-4: a WARNING is emitted on append failure",
    /WARNING: usage-ledger append FAILED/.test(warned),
  );
  assert(
    "R-4: the warning names the ticket + flags the unmeasured cost",
    /#77/.test(warned) && /UNMEASURED/.test(warned),
  );

  // The gated-off case (no path resolvable) must stay SILENT — it's intentional, not
  // a failure, so it must NOT cry wolf with a warning.
  const errs2 = [];
  const origWrite2 = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    errs2.push(String(chunk));
    return origWrite2.call(process.stderr, chunk, ...rest);
  };
  try {
    appendUsageRecord({ ticket: 1, measured: true }, {}); // no GAFFER_DATA, no path
  } finally {
    process.stderr.write = origWrite2;
  }
  assert(
    "R-4: gated-off append stays silent (no false-alarm warning)",
    !/WARNING/.test(errs2.join("")),
  );
}

console.log("== R-4b: the tick.sh ledger call site routes the module's stderr to the log ==");
{
  // The WARNING reaches the operator only if the call site stops discarding node's
  // stderr. gaffer_usage_record (factory.config.sh) must route it to $GAFFER_LOG.
  const cfg = readFileSync(resolve(RUNNER_DIR, "factory.config.sh"), "utf8");
  const fn = cfg.slice(cfg.indexOf("gaffer_usage_record() {"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 1);
  assert(
    "R-4b: gaffer_usage_record routes module stderr to $GAFFER_LOG (not /dev/null)",
    /2>>"\$GAFFER_LOG"/.test(body) && !/2>\/dev\/null/.test(body),
  );
}

console.log("== AC3b: CLI prints .result text AND writes the ledger (gated on GAFFER_DATA) ==");
{
  const dir = mkdtempSync(join(tmpdir(), "usage-cli-"));
  try {
    const sampleFile = join(dir, "sample.json");
    writeFileSync(sampleFile, JSON.stringify(SAMPLE));
    const res = spawnSync(
      process.execPath,
      [MOD, "--kind", "delivery", "--ticket", "42", "--rc", "0", "--json-file", sampleFile],
      {
        env: { ...process.env, GAFFER_DATA: dir },
        encoding: "utf8",
      },
    );
    assert("CLI exits 0", res.status === 0);
    assert(
      "CLI stdout is the agent's .result text (log-preserving)",
      res.stdout.includes("Delivered the feature"),
    );
    const ledgerPath = join(dir, LEDGER_FILENAME);
    assert("ledger file written", existsSync(ledgerPath));
    const rec = JSON.parse(readFileSync(ledgerPath, "utf8").trim());
    assert(
      "ledgered record is measured w/ verbatim total cost",
      rec.measured === true && rec.total_cost_usd === 0.1234,
    );

    // Unmeasurable via rc=124 → unknown row appended, still exit 0 (never fails the tick).
    const res2 = spawnSync(
      process.execPath,
      [MOD, "--kind", "clarify", "--ticket", "9", "--rc", "124", "--json-file", "/dev/null"],
      {
        env: { ...process.env, GAFFER_DATA: dir },
        encoding: "utf8",
      },
    );
    assert("CLI on rc=124 still exits 0 (swallowed)", res2.status === 0);
    const lines = readFileSync(ledgerPath, "utf8").trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1]);
    assert(
      "timeout row recorded as unknown (not 0)",
      last.measured === false && last.total_cost_usd === UNKNOWN,
    );

    // No GAFFER_DATA in the CLI env → still exit 0, writes nothing (gated + swallowed).
    const before = readdirSync(dir).length;
    const res3 = spawnSync(
      process.execPath,
      [MOD, "--kind", "review", "--rc", "0", "--json-file", sampleFile],
      {
        env: { ...process.env, GAFFER_DATA: "" },
        encoding: "utf8",
      },
    );
    assert("CLI without GAFFER_DATA still exits 0", res3.status === 0);
    assert("CLI without GAFFER_DATA writes nothing", readdirSync(dir).length === before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("== AC4: --output-format json is wired into the consolidated invocation ==");
{
  // Spec 3 / Phase 1 moved the ONE `"$CLAUDE_BIN" -p …` invocation out of tick.sh's
  // four call sites into the worker_deliver seam (lib/worker.sh). Intent preserved:
  // the single invocation carries --output-format json, tick.sh routes all four
  // agent turns (delivery, bootstrap, review, clarify) through worker_deliver, and
  // each routed turn still ledgers via gaffer_usage_record.
  const tick = readFileSync(resolve(RUNNER_DIR, "tick.sh"), "utf8");
  const worker = readFileSync(resolve(RUNNER_DIR, "lib", "worker.sh"), "utf8");
  // B-H3 (monolith paydown): the review + clarify agent turns were extracted from
  // tick.sh into lib/review.sh + lib/clarify.sh (sourced by tick.sh). Count the
  // routing/ledger wiring across tick.sh AND the two extracted passes — the runtime
  // set of four agent turns is unchanged, only relocated.
  const review = readFileSync(resolve(RUNNER_DIR, "lib", "review.sh"), "utf8");
  const clarify = readFileSync(resolve(RUNNER_DIR, "lib", "clarify.sh"), "utf8");
  const passes = tick + "\n" + review + "\n" + clarify;
  // No open-coded claude -p remains in tick.sh — it all flows through the seam.
  const inlineSites = tick.split("\n").filter((l) => /"\$CLAUDE_BIN"\s+-p\b/.test(l)).length;
  assert("tick.sh has no open-coded claude -p (moved to the worker seam)", inlineSites === 0);
  // The seam is the ONE invocation site and it carries --output-format json.
  const workerSites = worker.split("\n").filter((l) => /"\$CLAUDE_BIN"\s+-p\b/.test(l)).length;
  const workerJson = worker
    .split("\n")
    .filter((l) => /"\$CLAUDE_BIN"\s+-p\b/.test(l) && /--output-format json/.test(l)).length;
  assert("lib/worker.sh has exactly 1 claude -p invocation site", workerSites === 1);
  assert("lib/worker.sh: the invocation uses --output-format json", workerJson === 1);
  // tick.sh + the extracted review/clarify passes route all 4 agent turns through the seam.
  const routed = (passes.match(/^\s*worker_deliver /gm) || []).length;
  assert(
    "tick.sh + review/clarify libs route exactly 4 turns through worker_deliver",
    routed === 4,
  );
  assert(
    "each routed turn ledgers via gaffer_usage_record (across tick.sh + review/clarify libs)",
    (passes.match(/gaffer_usage_record/g) || []).length >= 4,
  );
  const dec = readFileSync(resolve(RUNNER_DIR, "bin", "decompose.mjs"), "utf8");
  assert(
    "decompose.mjs uses --output-format json",
    /--output-format/.test(dec) && /buildUsageRecord/.test(dec),
  );
  const po = readFileSync(resolve(RUNNER_DIR, "bin", "product-owner-run.mjs"), "utf8");
  assert(
    "product-owner-run.mjs uses --output-format json",
    /--output-format/.test(po) && /buildUsageRecord/.test(po),
  );
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

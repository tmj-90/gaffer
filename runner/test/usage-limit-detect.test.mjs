#!/usr/bin/env node
// =====================================================================
// USAGE-LIMIT DETECTION TABLE (lib/worker.mjs detectUsageLimit / parseResult).
// ---------------------------------------------------------------------
// A plan usage window running out, or a rate limit, used to read as a failed
// delivery: it burned an attempt and, overnight, parked good tickets. parseResult
// now classifies it as its own outcome. This suite pins:
//   1. every row of USAGE_LIMIT_PATTERNS / USAGE_LIMIT_SHAPES against a fixture
//      built from the EXACT string Claude Code prints (see the table's provenance);
//   2. reset-time parsing: "3pm (Europe/London)", "3:30pm", "Oct 9, 3pm", a year,
//      next-day rollover, DST, an unknown zone (→ null, the default pause applies),
//      the legacy unix epoch and a retry-after hint;
//   3. negative controls: an ordinary reply that TALKS about rate limits, a success
//      envelope carrying limit-shaped text, a turn-cap stop, malformed JSON → null;
//   4. parseResult carries `usageLimit`, the `parse-result usage-limit` CLI exits
//      0/1, and a ledger row from the same envelope is labelled usage_limit (parity).
// Zero deps beyond node. Run: node test/usage-limit-detect.test.mjs
// =====================================================================
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_DIR = resolve(HERE, "..");
const WORKER = resolve(RUNNER_DIR, "lib", "worker.mjs");
const { detectUsageLimit, parseResult, parseResetClock, USAGE_LIMIT_PATTERNS, USAGE_LIMIT_SHAPES } =
  await import(WORKER);
const { buildUsageRecord } = await import(resolve(RUNNER_DIR, "lib", "usage-ledger.mjs"));

let passed = 0;
const failures = [];
const assert = (m, cond, got) => {
  if (cond) {
    passed++;
    console.log(`  ok   ${m}`);
  } else {
    failures.push(m);
    console.log(`  FAIL ${m}${got === undefined ? "" : ` (got ${JSON.stringify(got)})`}`);
  }
};
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
// 31 Oct 2026, 12:00 UTC — London is on GMT (BST ended 25 Oct), New York on EDT.
const NOW = Date.UTC(2026, 9, 31, 12, 0);
const errEnv = (result, extra = {}) => ({
  type: "result",
  subtype: "success",
  is_error: true,
  result,
  num_turns: 1,
  total_cost_usd: 0,
  ...extra,
});

console.log("== 1: every table row matches the exact CLI string ==");
const ROWS = [
  // [fixture, expected id, expected kind, expected resetsAt ISO or null]
  [
    errEnv("You've hit your session limit · resets 3pm (Europe/London)"),
    "cc-hit-your-limit",
    "usage_limit",
    "2026-10-31T15:00:00.000Z",
  ],
  [
    errEnv("You've hit your weekly limit · resets Nov 3, 9am (America/New_York)"),
    "cc-hit-your-limit",
    "usage_limit",
    "2026-11-03T14:00:00.000Z",
  ],
  [
    errEnv("You've hit your Opus limit · resets 4:30pm (America/New_York)"),
    "cc-hit-your-limit",
    "usage_limit",
    "2026-10-31T20:30:00.000Z",
  ],
  [
    errEnv("You've hit your Sonnet limit · resets Nov 6, 2026, 1am (UTC)"),
    "cc-hit-your-limit",
    "usage_limit",
    "2026-11-06T01:00:00.000Z",
  ],
  [errEnv("You've hit your usage limit"), "cc-hit-your-limit", "usage_limit", null],
  [
    errEnv("You've hit your limit · resets 11am (UTC)"),
    "cc-hit-your-limit",
    "usage_limit",
    "2026-11-01T11:00:00.000Z",
  ],
  [
    errEnv("You're out of extra usage · resets 6pm (Europe/Paris)"),
    "cc-out-of-extra-usage",
    "usage_limit",
    "2026-10-31T17:00:00.000Z",
  ],
  [
    errEnv("Claude AI usage limit reached|1793451600"),
    "cc-legacy-usage-limit",
    "usage_limit",
    "2026-10-31T13:00:00.000Z",
  ],
  [errEnv("API Error: Rate limit reached"), "cc-api-rate-limit", "rate_limit", null],
  [
    errEnv("Opus is experiencing high load, please use /model to switch to Sonnet"),
    "cc-opus-high-load",
    "rate_limit",
    null,
  ],
  [
    errEnv(
      'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}} retry-after: 30',
    ),
    "api-429-rate-limit-error",
    "rate_limit",
    "2026-10-31T12:00:30.000Z",
  ],
  [
    { type: "assistant", error: "rate_limit", message: { content: [] } },
    "sdk-assistant-error-rate-limit",
    "rate_limit",
    null,
  ],
  [
    { type: "error", error: { type: "rate_limit_error", message: "Rate limited" } },
    "api-error-rate-limit-error",
    "rate_limit",
    null,
  ],
  // The CLI's `errors[]` array on an error_during_execution result is read too.
  [
    {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["You've hit your session limit · resets 3pm (Europe/London)"],
    },
    "cc-hit-your-limit",
    "usage_limit",
    "2026-10-31T15:00:00.000Z",
  ],
];
const seenIds = new Set();
for (const [fx, id, kind, at] of ROWS) {
  const d = detectUsageLimit(fx, NOW);
  seenIds.add(d && d.id);
  assert(
    `${id}: ${String(fx.result ?? fx.errors ?? JSON.stringify(fx.error)).slice(0, 70)}`,
    d && d.id === id && d.kind === kind && iso(d.resetsAtMs) === at,
    d && { id: d.id, kind: d.kind, at: iso(d.resetsAtMs) },
  );
}
for (const row of [...USAGE_LIMIT_PATTERNS, ...USAGE_LIMIT_SHAPES]) {
  assert(
    `table row ${row.id} has a kind, a source and a fixture above`,
    !!row.kind && !!row.source && seenIds.has(row.id),
  );
}
assert(
  "table ids are unique",
  new Set([...USAGE_LIMIT_PATTERNS, ...USAGE_LIMIT_SHAPES].map((r) => r.id)).size ===
    USAGE_LIMIT_PATTERNS.length + USAGE_LIMIT_SHAPES.length,
);

console.log("== 2: reset-time parsing ==");
const at = (t) => iso(parseResetClock(`You've hit your session limit · resets ${t}`, NOW));
assert(
  "3pm today in London (GMT)",
  at("3pm (Europe/London)") === "2026-10-31T15:00:00.000Z",
  at("3pm (Europe/London)"),
);
assert(
  "8am already passed today → tomorrow 8am",
  at("8am (UTC)") === "2026-11-01T08:00:00.000Z",
  at("8am (UTC)"),
);
assert(
  "12pm is noon, 12am is midnight",
  at("12am (UTC)") === "2026-11-01T00:00:00.000Z" &&
    at("12pm (UTC)") === "2026-11-01T12:00:00.000Z",
  [at("12am (UTC)"), at("12pm (UTC)")],
);
assert(
  "DST: New York 9am on Nov 3 (after DST ends) is 14:00Z",
  at("Nov 3, 9am (America/New_York)") === "2026-11-03T14:00:00.000Z",
);
assert(
  "DST: New York 9am on Oct 31 (still EDT) would be 13:00Z — 4:30pm → 20:30Z",
  at("4:30pm (America/New_York)") === "2026-10-31T20:30:00.000Z",
);
assert(
  "a date already past this year rolls to next year",
  at("Jan 2, 9am (UTC)") === "2027-01-02T09:00:00.000Z",
  at("Jan 2, 9am (UTC)"),
);
assert("an unknown zone → null (the default pause applies)", at("3pm (Mars/Olympus)") === null);
assert("garbage time → null", at("soonish (UTC)") === null && at("25pm (UTC)") === null);
assert("no reset suffix → null", parseResetClock("You've hit your session limit", NOW) === null);

console.log("== 3: negative controls — ordinary replies are never a limit ==");
const NEG = [
  [
    "a delivered reply that adds a rate limiter",
    {
      type: "result",
      subtype: "success",
      is_error: false,
      result:
        "Added a token-bucket rate limiter; API Error: Rate limit reached is now returned with 429.",
    },
  ],
  [
    "limit-shaped text on a SUCCESS envelope",
    {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "You've hit your session limit · resets 3pm (UTC)",
    },
  ],
  [
    "a turn-cap stop",
    { type: "result", subtype: "error_max_turns", is_error: true, num_turns: 200, result: "" },
  ],
  [
    "a budget stop",
    { type: "result", subtype: "error_max_budget_usd", is_error: true, result: "" },
  ],
  ["an auth error", errEnv("Invalid API key · Please run /login")],
  [
    "a mid-sentence mention on an error",
    errEnv("Failed: the upstream said You've hit your session limit"),
  ],
  ["null", null],
];
for (const [name, fx] of NEG)
  assert(`${name} → null`, detectUsageLimit(fx, NOW) === null, detectUsageLimit(fx, NOW));
assert(
  "malformed stdout → parseResult.usageLimit null",
  parseResult("not json {", { nowMs: NOW }).usageLimit === null,
);
assert(
  "the legacy whole-string form on a success envelope (the agent's own reply) → null",
  detectUsageLimit(
    {
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 9,
      total_cost_usd: 0.5,
      result: "Claude AI usage limit reached|1793451600",
    },
    NOW,
  ) === null,
);
assert(
  "the legacy whole-string form with no is_error at all → null",
  detectUsageLimit({ result: "Claude AI usage limit reached|1793451600" }, NOW) === null,
);
assert(
  "the legacy whole-string form on an error envelope is still read",
  detectUsageLimit(errEnv("Claude AI usage limit reached|1793451600"), NOW)?.id ===
    "cc-legacy-usage-limit",
);
assert(
  "parseResult: an agent reply carrying the legacy string is not a usage limit",
  parseResult(
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 9,
      result: "Claude AI usage limit reached|1793451600",
    }),
    { nowMs: NOW },
  ).usageLimit === null,
);

console.log("== 4: parseResult, the CLI, and ledger parity ==");
const text = JSON.stringify(errEnv("You've hit your session limit · resets 3pm (Europe/London)"));
const pr = parseResult(text, { nowMs: NOW });
assert(
  "parseResult carries usageLimit",
  pr.usageLimit && pr.usageLimit.kind === "usage_limit" && pr.capHit.numTurns === 1,
);
assert(
  "an ordinary result's usageLimit is null",
  parseResult('{"result":"done","is_error":false}').usageLimit === null,
);
const dir = mkdtempSync(join(tmpdir(), "ul-detect-"));
try {
  const f = join(dir, "r.json");
  writeFileSync(f, text);
  const r = spawnSync("node", [WORKER, "parse-result", "usage-limit", "--json-file", f], {
    encoding: "utf8",
  });
  assert(
    "CLI usage-limit → exit 0 + JSON",
    r.status === 0 && JSON.parse(r.stdout).id === "cc-hit-your-limit",
    r.status,
  );
  writeFileSync(f, '{"result":"done","is_error":false}');
  const r2 = spawnSync("node", [WORKER, "parse-result", "usage-limit", "--json-file", f], {
    encoding: "utf8",
  });
  assert(
    "CLI usage-limit on an ordinary result → exit 1, no output",
    r2.status === 1 && r2.stdout === "",
    r2.status,
  );
  // The ledger CLI on a refusal that exited 1 (Claude Code exits non-zero on
  // is_error): the conservative kill estimate is kept, and the row says why.
  writeFileSync(f, text);
  const lr = spawnSync(
    "node",
    [
      resolve(RUNNER_DIR, "lib", "usage-ledger.mjs"),
      "--kind",
      "delivery",
      "--ticket",
      "7",
      "--rc",
      "1",
      "--json-file",
      f,
    ],
    { encoding: "utf8", env: { ...process.env, GAFFER_DATA: dir, GAFFER_USAGE_LEDGER: "" } },
  );
  let row = {};
  try {
    row = JSON.parse(
      readFileSync(join(dir, "usage-ledger.jsonl"), "utf8").trim().split("\n").pop(),
    );
  } catch {
    /* asserted below */
  }
  assert(
    "ledger CLI, rc=1 refusal: still the unmeasured/estimated row (caps never under-count) + usage_limit label",
    lr.status === 0 && row.usage_limit === "usage_limit" && row.measured === false,
    row,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
const rec = buildUsageRecord({ json: JSON.parse(text), kind: "delivery", ticket: 7 });
assert(
  "ledger row is labelled usage_limit (same detector)",
  rec.usage_limit === "usage_limit",
  rec.usage_limit,
);
const plain = buildUsageRecord({
  json: { result: "ok", total_cost_usd: 0.1, num_turns: 2 },
  kind: "delivery",
});
assert(
  "an ordinary ledger row has no usage_limit field (rows unchanged)",
  !("usage_limit" in plain),
);

console.log("");
if (failures.length) {
  console.log(`usage-limit-detect: ${failures.length} FAILURE(S)`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`usage-limit-detect: ALL ${passed} checks passed`);

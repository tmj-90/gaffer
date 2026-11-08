#!/usr/bin/env node
// =====================================================================
// The matched experiment's ACCEPTANCE interval (runner/eval/experiment.mjs), external
// review finding 2 (review13/2). Acceptance is a paired yes/no outcome; a t interval on
// the -1/0/+1 differences gave ten ties the interval [0, 0], "exactly no difference",
// and the routing rule took a lower bound of 0 as evidence. The interval is now
// Newcombe's paired score interval (1998, method 10), named in results.json and the
// report with the discordant-pair count; spend keeps its paired t interval.
//   1. Newcombe's published example (a=36, b=12, c=2, d=0) → 0.0569 to 0.3404
//   2. ten ties (one-sided or mixed) → an interval that is not [0, 0], zero discordant
//      pairs, in the report
//   3. the figures routing-recommend.test.ts uses (within / outside the margin)
//   4. memory_matched flips the interval and the discordant split with the arms
// Zero deps beyond node. Run: node test/eval-experiment-interval.test.mjs
// =====================================================================
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const XP = resolve(HERE, "..", "eval", "experiment.mjs");
const mod = await import(XP);
const { report, markdown } = mod;

let passed = 0;
const failures = [];
const assert = (m, cond, got) => {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${m}`);
  } else {
    failures.push(m);
    console.log(`  FAIL ${m}${got === undefined ? "" : ` (got ${JSON.stringify(got)})`}`);
  }
};
const near = (a, b) => typeof a === "number" && Math.abs(a - b) < 1e-4;

/** A synthetic plan and runs: `cells` is [both, armOnly, baseOnly, neither]. */
function world(cells, { armOverrides = { tier: "cheap" }, armName = "cheap" } = {}) {
  const [a, b, c, d] = cells;
  const tickets = [];
  const runs = [];
  let i = 0;
  const add = (count, arm, vs) => {
    for (let k = 0; k < count; k += 1) {
      const id = `t${(i += 1)}`;
      tickets.push({ id, source: "fixture" });
      runs.push({
        ticket: id,
        arm: armName,
        ran: true,
        accepted: arm,
        attempts: 1,
        spend_usd: 0.2,
        judge_score: null,
      });
      runs.push({
        ticket: id,
        arm: "baseline",
        ran: true,
        accepted: vs,
        attempts: 1,
        spend_usd: 0.5,
        judge_score: null,
      });
    }
  };
  add(a, true, true);
  add(b, true, false);
  add(c, false, true);
  add(d, false, false);
  const plan = {
    mode: "stub",
    seed: 1,
    baseline: "baseline",
    arms: [
      { name: "baseline", overrides: {} },
      { name: armName, overrides: armOverrides },
    ],
    tickets,
    order: [],
  };
  return report(plan, runs);
}

console.log("== 1. Newcombe's published example ==");
{
  const acc = world([36, 12, 2, 0]).comparisons[0].acceptance;
  assert(
    "method is named newcombe_paired_score",
    acc.method === "newcombe_paired_score",
    acc.method,
  );
  assert("mean is the descriptive 0.2", near(acc.mean, 0.2), acc.mean);
  assert(
    "interval is 0.0569 to 0.3404 (Newcombe 1998, Table II, method 10)",
    acc.ci95 && near(acc.ci95[0], 0.0569) && near(acc.ci95[1], 0.3404),
    acc.ci95,
  );
  assert(
    "14 discordant pairs: 12 favour the arm, 2 the baseline",
    acc.discordant === 14 && acc.favours_arm === 12 && acc.favours_baseline === 2,
    acc,
  );
}

console.log("== 2. ten ties ==");
{
  const res = world([10, 0, 0, 0]);
  const acc = res.comparisons[0].acceptance;
  assert("zero discordant pairs", acc.discordant === 0, acc.discordant);
  assert(
    "the interval is not [0, 0]: -0.2775 to 0.2775",
    acc.ci95 && near(acc.ci95[0], -0.2775) && near(acc.ci95[1], 0.2775),
    acc.ci95,
  );
  const none = world([0, 0, 0, 10]).comparisons[0].acceptance;
  assert("ten shared failures read the same", none.ci95 && near(none.ci95[0], -0.2775), none.ci95);
  // Mixed ties (some tickets both accepted, the rest both rejected): method 10's phi is 1
  // here and its interval collapses to [0, 0], the very claim this replaced. With no
  // discordant pair the interval is the bound on the discordant rate instead, the same
  // +/- z^2/(n + z^2) the one-sided ties above get.
  const mixed = world([5, 0, 0, 5]).comparisons[0].acceptance;
  assert(
    "five shared passes and five shared failures are not [0, 0] either: -0.2775 to 0.2775",
    mixed.ci95 && near(mixed.ci95[0], -0.2775) && near(mixed.ci95[1], 0.2775),
    mixed.ci95,
  );
  const one = world([1, 0, 0, 1]).comparisons[0].acceptance;
  assert(
    "two mixed ties: -0.6576 to 0.6576",
    one.ci95 && near(one.ci95[0], -0.6576) && near(one.ci95[1], 0.6576),
    one.ci95,
  );
  const md = markdown(res);
  assert(
    "the report names the method and the discordant count",
    /acceptance difference: 0 \(95% Newcombe paired score interval -0\.2775 to 0\.2775; 0 discordant pair\(s\)/.test(
      md,
    ),
    md.split("\n").find((l) => l.includes("acceptance difference")),
  );
  const spend = res.comparisons[0].spend_usd;
  assert(
    "spend keeps its paired t interval (continuous)",
    spend.method === undefined && near(spend.mean, -0.3),
    spend,
  );
  assert(
    "the limits name both methods",
    res.limits.some(
      (l) => /Newcombe's paired score interval/.test(l) && /paired t interval/.test(l),
    ),
  );
}

console.log("== 3. the figures the routing rule's tests use ==");
{
  const w = world([17, 3, 0, 0]).comparisons[0].acceptance;
  assert(
    "17/3/0/0 → 0.15, -0.0384 to 0.3604",
    near(w.mean, 0.15) && near(w.ci95[0], -0.0384) && near(w.ci95[1], 0.3604),
    w,
  );
  const o = world([20, 1, 3, 0]).comparisons[0].acceptance;
  assert(
    "20/1/3/0 → -0.0833, -0.2742 to 0.1026",
    near(o.mean, -0.0833) && near(o.ci95[0], -0.2742) && near(o.ci95[1], 0.1026),
    o,
  );
}

console.log("== 5. the non-inferiority margin is recorded with the result (review14/3) ==");
{
  const w = world([17, 3, 0, 0]);
  assert(
    "the default margin is 0.10 and results.json names it",
    w.non_inferiority_margin === 0.1,
    w.non_inferiority_margin,
  );
  const plan = {
    mode: "stub",
    seed: 1,
    baseline: "baseline",
    arms: [
      { name: "baseline", overrides: {} },
      { name: "cheap", overrides: { tier: "cheap" } },
    ],
    tickets: [],
    order: [],
  };
  const r05 = report(plan, [], { margin: 0.05 });
  assert("an explicit --margin 0.05 is stored", r05.non_inferiority_margin === 0.05, r05);
  const md = markdown(w);
  assert(
    "the report says which margin and whether the bound is within it",
    /non-inferiority margin 0\.1/.test(md) &&
      /lower bound -0\.0384 is within the non-inferiority margin of -0\.1/.test(md),
    md.split("\n").filter((l) => /margin/.test(l)),
  );
  const tight = report({ ...plan, tickets: w.tickets, order: [] }, w.runs, { margin: 0.03 });
  assert(
    "at 0.03 the same bound is outside, and the comparison says so",
    tight.comparisons[0].non_inferiority &&
      tight.comparisons[0].non_inferiority.holds === false &&
      tight.comparisons[0].non_inferiority.margin === 0.03,
    tight.comparisons[0].non_inferiority,
  );
  let threw = 0;
  for (const m of [0, 0.5, 0.9, -0.1, Number.NaN, "x"]) {
    try {
      report(plan, [], { margin: m });
    } catch {
      threw += 1;
    }
  }
  assert("a margin outside 0 < m < 0.5 is refused", threw === 6, threw);
}

{
  const pilot = world([30, 1, 0, 0]).comparisons[0].acceptance;
  assert(
    "30/1/0/0 → 0.0323, -0.0811 to 0.1619 (within 0.10, outside 0.05: routing-recommend.test.ts)",
    near(pilot.mean, 0.0323) && near(pilot.ci95[0], -0.0811) && near(pilot.ci95[1], 0.1619),
    pilot,
  );
}

console.log("== 4. memory_matched flips with the arms ==");
{
  const res = world([5, 1, 3, 1], { armName: "nomem", armOverrides: { memory: "off" } });
  const fwd = res.comparisons[0].acceptance;
  const mm = res.memory_matched.acceptance;
  assert(
    "the flipped interval negates and swaps the limits",
    near(mm.mean, -fwd.mean) && near(mm.ci95[0], -fwd.ci95[1]) && near(mm.ci95[1], -fwd.ci95[0]),
    { fwd, mm },
  );
  assert(
    "and swaps the discordant split",
    mm.favours_arm === fwd.favours_baseline && mm.favours_baseline === fwd.favours_arm,
    mm,
  );
}

console.log();
if (failures.length === 0) {
  console.log(`PASS: ${passed} checks`);
  process.exit(0);
} else {
  console.log(`FAILED: ${failures.length} of ${passed + failures.length}`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}

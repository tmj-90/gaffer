#!/usr/bin/env node
// =====================================================================
// A DOLLAR CAP STOPS EXACTLY AT ITS BOUNDARY (audit finding 8c).
// ---------------------------------------------------------------------
// lib/budget-admission.mjs summed the ledger as floats and tested "below the cap" on the
// running sum: ten $0.10 calls sum to 0.9999999999999999, so an eleventh call was
// admitted at a $1.00 cap. Sums and cap tests now run in integer micro-dollars.
//   C1  ten $0.10 calls today, daily cap $1.00: the next launch is refused
//   C2  the same on the lifetime cap (rows from earlier days)
//   C3  nine $0.10 calls: still admitted (the boundary is not moved the other way)
//   C4  a cap that holds exactly three $0.10 worst cases admits the third beside two
//       live reservations ($0.30 cap), and refuses a fourth
//   C5  the spend the admission reports is exact ($1.0000, not 0.9999999999999999)
// Run: node test/budget-cap-boundary.test.mjs
// =====================================================================
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gafferMkdtemp } from "./lib/tmpdir.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ADMISSION = resolve(HERE, "..", "lib", "budget-admission.mjs");
const { pidStartTime } = await import(ADMISSION);

let passed = 0;
const failures = [];
const check = (cond, m, detail = "") => {
  if (cond) {
    passed += 1;
    process.stdout.write(`  ok   ${m}\n`);
  } else {
    const msg = detail ? `${m} (${detail})` : m;
    failures.push(msg);
    process.stdout.write(`  FAIL ${msg}\n`);
  }
};
const WORK = gafferMkdtemp(join(process.env.TMPDIR || tmpdir(), "budget-cap-boundary-"));
process.on("exit", () => {
  try {
    rmSync(WORK, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});
const BASE_ENV = (() => {
  const e = { ...process.env };
  for (const k of [
    "GAFFER_DAILY_BUDGET_USD",
    "GAFFER_BUDGET_USD",
    "GAFFER_BUDGET_REMAINING",
    "GAFFER_USAGE_LEDGER",
    "GAFFER_ALLOW_UNCAPPED",
    "GAFFER_MAX_CALL_USD",
    "GAFFER_KILL_ESTIMATE_USD",
  ])
    delete e[k];
  return e;
})();
let n = 0;
function world(rows, extra) {
  n += 1;
  const data = join(WORK, `w${n}`);
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "settings.json"), "{}");
  writeFileSync(
    join(data, "usage-ledger.jsonl"),
    rows.map((r) => JSON.stringify(r) + "\n").join(""),
  );
  return { ...BASE_ENV, GAFFER_DATA: data, ...extra };
}
const calls = (k, ts) =>
  Array.from({ length: k }, () => ({ ts, kind: "delivery", measured: true, total_cost_usd: 0.1 }));
const ask = (env, worst) =>
  spawnSync(
    process.execPath,
    [ADMISSION, "check", "--kind", "delivery", ...(worst ? ["--worst-usd", worst] : [])],
    { env, encoding: "utf8" },
  );
const now = new Date().toISOString();
const earlier = new Date(Date.now() - 3 * 86400000).toISOString();

console.log("== C1: ten $0.10 calls today, daily cap $1.00 ==");
{
  const r = ask(world(calls(10, now), { GAFFER_DAILY_BUDGET_USD: "1" }));
  check(r.status === 3, "the eleventh call is refused at the $1.00 daily cap", r.stdout);
  const out = JSON.parse(r.stdout || "{}");
  check(
    out.daily && out.daily.spent === 1 && /spent \$1\.0000/.test(out.reason || ""),
    "C5 the spend reads exactly $1.0000",
    r.stdout,
  );
}

console.log("== C2: the lifetime cap, rows from earlier days ==");
{
  const r = ask(world(calls(10, earlier), { GAFFER_BUDGET_USD: "1" }));
  check(r.status === 3, "the eleventh call is refused at the $1.00 lifetime cap", r.stdout);
}

console.log("== C3: nine calls: still below the cap ==");
{
  const r = ask(world(calls(9, now), { GAFFER_DAILY_BUDGET_USD: "1" }));
  check(r.status === 0, "nine $0.10 calls leave room under $1.00", r.stdout);
}

console.log("== C4: a $0.30 cap holds exactly three $0.10 calls in flight ==");
{
  const st = pidStartTime(process.pid);
  const resv = (id) => ({
    ts: now,
    kind: "reservation",
    launch_kind: "delivery",
    reservation_id: id,
    reserved_usd: 0.1,
    reserve_basis: "per-call-cap",
    measured: false,
    pid: process.pid,
    host: hostname(),
    ...(st ? { pid_start: st } : {}),
  });
  const two = ask(
    world([resv("r-live-1"), resv("r-live-2")], { GAFFER_DAILY_BUDGET_USD: "0.3" }),
    "0.1",
  );
  check(two.status === 0, "a third $0.10 call fits beside two in flight under $0.30", two.stdout);
  const three = ask(
    world([resv("r-live-1"), resv("r-live-2"), resv("r-live-3")], {
      GAFFER_DAILY_BUDGET_USD: "0.3",
    }),
    "0.1",
  );
  check(three.status === 3, "a fourth does not", three.stdout);
}

console.log();
if (failures.length === 0) {
  console.log(`PASS: ${passed} checks`);
  process.exit(0);
}
console.log(`FAILED: ${failures.length} of ${passed + failures.length}`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(1);

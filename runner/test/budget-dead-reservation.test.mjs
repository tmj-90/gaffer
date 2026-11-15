#!/usr/bin/env node
// =====================================================================
// AN INTERRUPTED PAID CALL MUST NOT HOLD THE BUDGET FOR GOOD (audit finding 2).
// ---------------------------------------------------------------------
// Only the delivery and bootstrap envelopes were settled by the tick's crash path. A
// review, security review, clarify, eval judge, scout or inherit call, and every Node
// launcher, killed before it booked its row left its reservation OPEN, and admission
// counted it against the daily AND the lifetime cap whatever the day, with a refusal
// that said "it fits once those calls book their cost" (they never would).
//
// The contract: reservePaidLaunch, under the admission lock, settles every open
// reservation on this host whose launcher is provably gone with a labelled kill
// estimate (`settles`), the row the shell crash path books. A reservation whose
// launcher may still be alive (a live pid, no recorded start time to tell it from a
// reused one) or that was booked on another host is never touched.
//
//   D1  reserve as review, kill the launcher, reserve again: the first is settled with
//       an estimate and its reserved_usd no longer reduces admission
//   D2  a LIVE reservation (pid alive, matching start time) is untouched
//   D3  a live pid with no recorded start time is untouched (cannot be told apart)
//   D4  a reused pid (alive, different start time) is settled
//   D5  another host's reservation is untouched, and the refusal says why
//   D6  the refusal text no longer promises the dead call will book its cost
//   D7  concurrency: 6 reservations at once settle a dead one exactly once
//   D8  the history estimate: with measured history of the kind, the settle books its P10
//   D9  the shell crash path settles the review, security-review and clarify envelopes
//
// Run: node test/budget-dead-reservation.test.mjs
// =====================================================================
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gafferMkdtemp } from "./lib/tmpdir.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_DIR = resolve(HERE, "..");
const ADMISSION = resolve(RUNNER_DIR, "lib", "budget-admission.mjs");
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

const WORK = gafferMkdtemp(join(process.env.TMPDIR || tmpdir(), "budget-dead-resv-"));
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
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
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
function world(extra = {}) {
  n += 1;
  const data = join(WORK, `w${n}`, "data");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "settings.json"), "{}");
  const ledger = join(data, "usage-ledger.jsonl");
  return {
    data,
    ledger,
    env: { ...BASE_ENV, GAFFER_DATA: data, ...extra },
    rows: () =>
      existsSync(ledger)
        ? readFileSync(ledger, "utf8")
            .split("\n")
            .filter((l) => l.trim())
            .map((l) => JSON.parse(l))
        : [],
    append: (r) => writeFileSync(ledger, JSON.stringify(r) + "\n", { flag: "a" }),
  };
}
const deadPid = () =>
  Number(
    spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
      encoding: "utf8",
    }).stdout.trim(),
  );
const reserve = (w, kind, pid, extra = []) =>
  spawnSync(
    process.execPath,
    [ADMISSION, "reserve", "--kind", kind, "--ticket", "7", "--pid", String(pid), ...extra],
    { env: w.env, encoding: "utf8" },
  );
const checkCli = (w, kind) =>
  spawnSync(process.execPath, [ADMISSION, "check", "--kind", kind], {
    env: w.env,
    encoding: "utf8",
  });
const resv = (id, pid, more = {}) => ({
  ts: new Date().toISOString(),
  ticket: 7,
  kind: "reservation",
  launch_kind: "review",
  reservation_id: id,
  reserved_usd: 2,
  reserve_basis: "per-call-cap",
  measured: false,
  pid,
  host: hostname(),
  ...more,
});
const settleOf = (w, id) => w.rows().filter((r) => r.settles === id && r.kind !== "reservation");

console.log("== D1: an interrupted review's reservation is settled by the next reservation ==");
{
  const w = world({ GAFFER_DAILY_BUDGET_USD: "5", GAFFER_MAX_CALL_USD: "2" });
  const pid = deadPid();
  const r1 = reserve(w, "review", pid);
  check(r1.status === 0, "the review is admitted and books a $2 reservation", r1.stderr);
  const first = w.rows().find((r) => r.kind === "reservation");
  // One measured $1.20 call lands meanwhile (the auditor's repro).
  w.append({ ts: new Date().toISOString(), kind: "delivery", measured: true, total_cost_usd: 1.2 });
  const r2 = reserve(w, "delivery", process.pid);
  check(
    r2.status === 0,
    "the next launch is admitted: the dead review's $2 no longer holds the cap ($1.20 + $0.05 + $2 fits $5)",
    `rc=${r2.status} ${r2.stdout} ${r2.stderr}`,
  );
  const s = first ? settleOf(w, first.reservation_id) : [];
  check(
    s.length === 1 &&
      s[0].estimated === true &&
      s[0].estimated_cost_usd === 0.05 &&
      s[0].estimate_basis === "flat-floor" &&
      s[0].measured === false &&
      s[0].kind === "review" &&
      s[0].ticket === 7,
    "the dead reservation is settled once with a labelled $0.05 kill estimate (kind review, ticket 7)",
    JSON.stringify(s),
  );
  const c = checkCli(w, "delivery");
  const out = JSON.parse(c.stdout || "{}");
  check(
    out.daily && Math.abs(out.daily.reserved - 2) < 1e-9 && Math.abs(out.daily.spent - 1.25) < 1e-9,
    "admission now counts $1.25 spent and only the live $2 reservation",
    c.stdout,
  );
}

console.log("== D2/D3/D4: a launcher that may still be alive is never settled ==");
{
  const w = world({ GAFFER_DAILY_BUDGET_USD: "100" });
  const st = pidStartTime(process.pid);
  w.append(resv("r-live-start", process.pid, st ? { pid_start: st } : {}));
  w.append(resv("r-live-nostart", process.pid));
  const reused = st
    ? resv("r-reused", process.pid, { pid_start: String(Number(st) + 12345) })
    : null;
  if (reused) w.append(reused);
  const r = reserve(w, "delivery", process.pid);
  check(r.status === 0, "the new launch is admitted", r.stderr);
  check(settleOf(w, "r-live-start").length === 0, "D2 a live launcher's reservation is untouched");
  check(
    settleOf(w, "r-live-nostart").length === 0,
    "D3 a live pid with no recorded start time is untouched (pid reuse cannot be ruled out)",
  );
  if (reused)
    check(
      settleOf(w, "r-reused").length === 1,
      "D4 a live pid whose start time differs (a reused pid) is settled",
    );
  else check(true, "D4 skipped: no /proc start times on this platform");
}

console.log("== D5/D6: another host's reservation stays held; the refusal says why ==");
{
  const w = world({ GAFFER_DAILY_BUDGET_USD: "3", GAFFER_MAX_CALL_USD: "2" });
  w.append(resv("r-elsewhere", deadPid(), { host: "some-other-host" }));
  w.append(resv("r-dead-here", deadPid()));
  const c = checkCli(w, "delivery");
  const reason = JSON.parse(c.stdout || "{}").reason || "";
  check(c.status === 3, "check refuses while both are open (check never settles)", c.stdout);
  check(
    /no longer running/.test(reason) && /another host/.test(reason),
    "D6 the refusal says one launcher is gone (settled next) and one is on another host",
    reason,
  );
  check(
    !/it fits once those calls book their cost/.test(reason),
    "D6 the refusal no longer promises the dead call will book its cost",
    reason,
  );
  const r = reserve(w, "delivery", process.pid);
  check(settleOf(w, "r-dead-here").length === 1, "reserve settles the dead local one");
  check(settleOf(w, "r-elsewhere").length === 0, "D5 the other host's reservation is untouched");
  const reason2 = JSON.parse(r.stdout || "{}").reason || "";
  check(
    r.status === 3 && /another host/.test(reason2) && /--open-reservations/.test(reason2),
    "the remaining refusal names the other host's hold and how to list and settle it",
    `rc=${r.status} ${reason2}`,
  );
}

console.log("== D7: six reservations at once settle a dead reservation exactly once ==");
{
  const w = world({ GAFFER_DAILY_BUDGET_USD: "100" });
  w.append(resv("r-dead-race", deadPid()));
  const runs = Array.from(
    { length: 6 },
    () =>
      new Promise((done) => {
        const c = spawn(
          process.execPath,
          [ADMISSION, "reserve", "--kind", "delivery", "--pid", String(process.pid)],
          { env: w.env, stdio: ["ignore", "pipe", "pipe"] },
        );
        c.on("close", (code) => done(code));
      }),
  );
  const codes = await Promise.all(runs);
  check(
    codes.every((c) => c === 0),
    "all six are admitted",
    codes.join(","),
  );
  check(
    settleOf(w, "r-dead-race").length === 1,
    "the dead reservation has exactly one settle row",
    String(settleOf(w, "r-dead-race").length),
  );
}

console.log("== D8: with measured history of the kind the settle books its P10 ==");
{
  const w = world({ GAFFER_DAILY_BUDGET_USD: "100" });
  const old = new Date(Date.now() - 3 * 86400000).toISOString();
  for (const c of [0.4, 0.5, 0.6, 0.7, 0.8])
    w.append({ ts: old, kind: "review", measured: true, total_cost_usd: c });
  w.append(resv("r-dead-hist", deadPid()));
  reserve(w, "delivery", process.pid);
  const s = settleOf(w, "r-dead-hist");
  check(
    s.length === 1 &&
      s[0].estimate_basis === "history-p10" &&
      Math.abs(s[0].estimated_cost_usd - 0.44) < 1e-9,
    "the settle books the review history's P10 ($0.44)",
    JSON.stringify(s),
  );
}

console.log("== D9: the shell crash path settles the review lanes' own envelopes ==");
{
  const rec = readFileSync(join(RUNNER_DIR, "lib", "tick-recovery.sh"), "utf8");
  for (const [kind, v] of [
    ["review", "R_USAGE_JSON"],
    ["security-review", "S_USAGE_JSON"],
    ["clarify", "C_USAGE_JSON"],
  ])
    check(
      new RegExp(`gaffer_usage_settle_crashed ${kind} "[^"]*" "\\$\\{${v}:-\\}"`).test(rec),
      `gaffer_crash_cleanup settles the ${kind} envelope (${v})`,
    );
}

console.log();
if (failures.length === 0) {
  console.log(`PASS: ${passed} checks`);
  process.exit(0);
}
console.log(`FAILED: ${failures.length} of ${passed + failures.length}`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(1);

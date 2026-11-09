#!/usr/bin/env node
// =====================================================================
// WHAT AN AGGREGATE DOLLAR CAP PROMISES UNDER CONCURRENT LAUNCHES (external review 16).
// ---------------------------------------------------------------------
// The reviewer's probe: two independent processes asked lib/budget-admission.mjs at the
// same moment against a $1 cap, both saw $0 spent and were admitted, both calls then
// cost $0.70 and $1.40 was recorded; only the NEXT admission was refused. The per-tick
// reservation in lib/budget.sh protects tick COUNTS, not the dollars of calls that are
// already running.
//
// The contract (docs/CONFIG.md, "Budget admission and reservations"): a dollar cap is a
// ceiling, so an admitted paid launch books a `reservation` row for its worst case (its
// per-call cap, else the kill estimate, else a floor) under one per-ledger lock, before
// it starts; admission counts open reservations as spend; the call's own row names the
// reservation it settles (`settles`); a reservation whose call never booked keeps
// holding (fail closed) until a crash path books it or the operator reconciles.
//
// Proves, with stub workers (no model is ever called):
//   P1  the reviewer's probe through the Node seam: two launches at once against $1 with
//       a $0.70 per-call cap ⇒ exactly one starts, and no more than the cap is recorded
//   P2  an open reservation counts as spend: a launch that does not fit beside it is
//       refused, and the refusal names the reservation
//   P3  a settled reservation stops counting
//   P4  a reservation from a dead call keeps holding until the operator reconciles
//   P5  BOTH launch paths at once (lib/worker.sh delivery and lib/worker.mjs planner)
//       against one GAFFER_DATA ⇒ exactly one starts
//   P6  the lock closes the race: 8 admissions at once against a cap that fits 3 worst
//       cases ⇒ exactly 3 admitted
//   P7  a launch refused after admission (no agent spawned) releases its reservation
//   P8  the shell crash path settles an open reservation at the kill estimate
//   P9  the usage report shows reservations apart, never as calls
//   P10 a reservation is never a reading: no cost fields, ignored by the estimators
//   P11 a call that ran keeps its reservation; only one that never started releases it
//   P12 the admission lock: a live holder is never reaped, a dead or stale one is
//
// Run: node test/budget-concurrency.test.mjs
// =====================================================================
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gafferMkdtemp } from "./lib/tmpdir.mjs";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_DIR = resolve(HERE, "..");
const ADMISSION = resolve(RUNNER_DIR, "lib", "budget-admission.mjs");
const LEDGER_MOD = resolve(RUNNER_DIR, "lib", "usage-ledger.mjs");

let passed = 0;
const failures = [];
const ok = (m) => {
  passed += 1;
  process.stdout.write(`  ok   ${m}\n`);
};
const fail = (m) => {
  failures.push(m);
  process.stdout.write(`  FAIL ${m}\n`);
};
const check = (cond, m, detail = "") => (cond ? ok(m) : fail(detail ? `${m} (${detail})` : m));

const WORK = gafferMkdtemp(join(process.env.TMPDIR || tmpdir(), "budget-concurrency-"));
process.on("exit", () => {
  try {
    rmSync(WORK, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// The ONE environment every child gets: a scrubbed copy, so an operator's own caps,
// ledger or provider never leak in. The stub world never reaches a model.
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
    "GAFFER_WORKER_PROVIDER",
    "GAFFER_WORKER_COMMAND",
    "SANDBOX_PROVIDER",
  ])
    delete e[k];
  return { ...e, GAFFER_STRICT_REQUIRE: "0", STRICT_MODE: "0", RUNNER_DIR };
})();

let caseNo = 0;
/** A fresh world: data dir, empty settings.json, a stub claude costing `cost` after `sleep` s. */
function world({ cost = 0.7, sleep = 0 } = {}) {
  caseNo += 1;
  const dir = join(WORK, `w${caseNo}`);
  const data = join(dir, "data");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "settings.json"), "{}");
  const inv = join(dir, "invocations");
  const stub = join(dir, "claude");
  writeFileSync(
    stub,
    `#!/usr/bin/env bash\necho invoked >> "${inv}"\nsleep ${sleep}\n` +
      `printf '{"type":"result","subtype":"success","is_error":false,"result":"done","total_cost_usd":${cost},"num_turns":1,"duration_ms":1000}\\n'\n`,
  );
  chmodSync(stub, 0o755);
  const ledger = join(data, "usage-ledger.jsonl");
  return {
    dir,
    data,
    stub,
    ledger,
    env: { ...BASE_ENV, GAFFER_DATA: data, CLAUDE_BIN: stub },
    calls: () =>
      existsSync(inv) ? readFileSync(inv, "utf8").split("\n").filter(Boolean).length : 0,
    rows: () =>
      existsSync(ledger)
        ? readFileSync(ledger, "utf8")
            .split("\n")
            .filter((l) => l.trim())
            .map((l) => JSON.parse(l))
        : [],
    write: (rows) => writeFileSync(ledger, rows.map((r) => JSON.stringify(r) + "\n").join("")),
  };
}
/** Spend the ledger records, the way the caps count it (measured, else the estimate). */
const recordedSpend = (rows) =>
  rows.reduce((s, r) => {
    if (typeof r.total_cost_usd === "number") return s + r.total_cost_usd;
    if (r.estimated === true && typeof r.estimated_cost_usd === "number")
      return s + r.estimated_cost_usd;
    return s;
  }, 0);

/** Run a child to completion (async, so several run at once). */
function run(cmd, args, { env, input, cwd } = {}) {
  return new Promise((done) => {
    const c = spawn(cmd, args, { env, cwd: cwd || WORK, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (err += d));
    c.on("close", (code) => done({ code, out, err }));
    if (input) c.stdin.end(input);
    else c.stdin.end();
  });
}

/** Wait (async) until `pred()` holds, or the deadline passes. */
async function until(pred, ms = 60000) {
  const t = Date.now();
  while (!pred()) {
    if (Date.now() - t > ms) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  return true;
}

// A Node launcher exactly as bin/decompose.mjs books it: Worker.deliver, then the
// call's own row. It writes <ready> once loaded and waits for <go>, so several start
// their admission at the same instant (a barrier, not a sleep).
const NODE_LAUNCHER = `
import { existsSync, writeFileSync } from "node:fs";
const W = await import(process.env.RUNNER_DIR + "/lib/worker.mjs");
const L = await import(process.env.RUNNER_DIR + "/lib/usage-ledger.mjs");
writeFileSync(process.env.READY, "1");
const sab = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(process.env.GO)) Atomics.wait(sab, 0, 0, 5);
const res = W.deliver({ bin: process.env.CLAUDE_BIN, argv: ["-p", "x", "--output-format", "json"], cwd: process.cwd(), timeoutMs: 60000, maxBuffer: 1 << 20, env: {}, kind: "decompose" });
if (res.status === 0 && !res.error) {
  const json = L.parseClaudeJson(res.stdout || "");
  L.appendUsageRecord(L.successfulCallRecord({ json, kind: "decompose" }));
}
process.stdout.write(JSON.stringify({ status: res.status, budgetRefused: !!res.budgetRefused }));
`;

// A shell launcher exactly as lib/tick-launch.sh books a delivery: factory.config.sh,
// worker_deliver, then gaffer_usage_record on the same envelope file.
const SHELL_LAUNCHER = `
set -u
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
export GAFFER_STRICT_REQUIRE=0 STRICT_MODE=0
GAFFER_LOG="$W/shell.log"
printf '{}' > "$W/mcp.json"
echo 1 > "$READY"
while [ ! -f "$GO" ]; do sleep 0.02; done
GAFFER_LAUNCH_KIND=delivery worker_deliver "$W" "prompt" "" "$W/mcp.json" "$W/out.json" 2>>"$W/shell.err"; rc=$?
[ "$rc" = 77 ] || gaffer_usage_record delivery 1 "$rc" "$W/out.json" >/dev/null 2>&1
echo "rc=$rc"
`;

// ───────────────────────────────────────────────────────────────────────────────
console.log("== P1: the reviewer's probe through the Node seam (two launches, $1 cap) ==");
{
  const w = world({ cost: 0.7, sleep: 2 });
  const env = { ...w.env, GAFFER_DAILY_BUDGET_USD: "1", GAFFER_MAX_CALL_USD: "0.7" };
  const go = join(w.dir, "go");
  const kids = [1, 2].map((i) =>
    run(process.execPath, ["--input-type=module", "-e", NODE_LAUNCHER], {
      env: { ...env, READY: join(w.dir, `ready${i}`), GO: go },
    }),
  );
  await until(() => existsSync(join(w.dir, "ready1")) && existsSync(join(w.dir, "ready2")));
  writeFileSync(go, "1");
  const res = await Promise.all(kids);
  const started = res.filter((r) => /"status":0/.test(r.out)).length;
  const refused = res.filter((r) => /"budgetRefused":true/.test(r.out)).length;
  const spend = recordedSpend(w.rows());
  check(
    w.calls() === 1 && started === 1,
    "two launches at once against $1 with a $0.70 worst case: exactly one starts",
    `calls=${w.calls()} started=${started} out=${res.map((r) => r.out + r.err.slice(-200)).join(" | ")}`,
  );
  check(
    refused === 1,
    "the other is refused by the budget admission (status 77)",
    `refused=${refused}`,
  );
  check(spend <= 1 + 1e-9, "no more than the $1 cap is recorded", `recorded $${spend.toFixed(2)}`);
}

console.log("== P2/P3: an open reservation counts as spend; a settled one stops counting ==");
{
  const w = world();
  const { paidLaunchAdmission, ledgerSpend } = await import(ADMISSION);
  const env = { ...w.env, GAFFER_DAILY_BUDGET_USD: "1" };
  const now = new Date();
  const ts = now.toISOString();
  w.write([
    { ts, kind: "delivery", ticket: 3, measured: true, total_cost_usd: 0.1 },
    {
      ts,
      kind: "reservation",
      launch_kind: "delivery",
      reservation_id: "r-open-1",
      reserved_usd: 0.7,
      reserve_basis: "per-call-cap",
      measured: false,
    },
  ]);
  const s = ledgerSpend(env, now);
  check(
    !s.unknown && Math.abs((s.reservedUsd ?? -1) - 0.7) < 1e-9 && s.openReservations === 1,
    "ledgerSpend reads one open reservation of $0.70, apart from spend",
    JSON.stringify(s),
  );
  check(
    s.unknownToday === 0,
    "a reservation row is not an unknown-cost call (it never holds the caps as 'unknown')",
    JSON.stringify(s),
  );
  const d = paidLaunchAdmission({ kind: "decompose", env, now, worstUsd: 0.7 });
  check(
    !d.ok && /reserv/i.test(d.reason || ""),
    "a $0.70 launch beside an open $0.70 reservation and $0.10 spent under $1: refused, naming the reservation",
    JSON.stringify(d),
  );
  const small = paidLaunchAdmission({ kind: "decompose", env, now, worstUsd: 0.2 });
  check(
    small.ok,
    "a $0.20 launch still fits beside it ($0.10 + $0.70 + $0.20 <= $1)",
    JSON.stringify(small),
  );
  // The call books its real row, naming the reservation: the reservation stops counting.
  w.write([
    ...w.rows(),
    { ts, kind: "delivery", ticket: 3, measured: true, total_cost_usd: 0.15, settles: "r-open-1" },
  ]);
  const s2 = ledgerSpend(env, now);
  check(
    s2.openReservations === 0 && (s2.reservedUsd ?? -1) === 0 && Math.abs(s2.today - 0.25) < 1e-9,
    "once settled: no open reservation, only the real $0.15 counts",
    JSON.stringify(s2),
  );
  const d2 = paidLaunchAdmission({ kind: "decompose", env, now, worstUsd: 0.7 });
  check(d2.ok, "the same $0.70 launch is admitted after the settle", JSON.stringify(d2));
  // A lone call keeps the old rule (below the cap is enough): nothing else is in flight.
  w.write([{ ts, kind: "delivery", measured: true, total_cost_usd: 0.95 }]);
  const lone = paidLaunchAdmission({ kind: "decompose", env, now, worstUsd: 0.7 });
  check(
    lone.ok,
    "with nothing in flight, spend below the cap still admits (unchanged rule)",
    JSON.stringify(lone),
  );
}

console.log("== P4: a reservation from a dead call keeps holding until reconciled ==");
{
  const w = world();
  const env = { ...w.env, GAFFER_DAILY_BUDGET_USD: "1" };
  // A pid that is certainly not running: a child that has already exited.
  const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
    encoding: "utf8",
  }).stdout.trim();
  const yesterday = new Date(Date.now() - 86400000).toISOString();
  w.write([
    {
      ts: yesterday,
      kind: "reservation",
      launch_kind: "tester",
      reservation_id: "r-dead-1",
      reserved_usd: 0.9,
      reserve_basis: "per-call-cap",
      pid: Number(dead),
      host: (await import("node:os")).hostname(),
      measured: false,
    },
  ]);
  const adm = () =>
    spawnSync(process.execPath, [ADMISSION, "check", "--kind", "decompose", "--worst-usd", "0.2"], {
      env,
      encoding: "utf8",
    });
  const a1 = adm();
  check(
    a1.status === 3,
    "an open reservation from a call that died yesterday still holds today's cap (fail closed)",
    `rc=${a1.status} ${a1.stdout}`,
  );
  const list = spawnSync(process.execPath, [LEDGER_MOD, "--open-reservations"], {
    env,
    encoding: "utf8",
  });
  check(
    list.status === 0 && /r-dead-1/.test(list.stdout),
    "usage-ledger.mjs --open-reservations lists it",
    `${list.status} ${list.stdout} ${list.stderr}`,
  );
  const rec = spawnSync(process.execPath, [LEDGER_MOD, "--reconcile", "--usd", "0.3"], {
    env,
    encoding: "utf8",
  });
  check(rec.status === 0, "the operator reconciles (--reconcile --usd 0.3)", rec.stderr);
  const last = w.rows().at(-1);
  check(
    last &&
      last.kind === "reconcile" &&
      Array.isArray(last.settles_reservations) &&
      last.settles_reservations.includes("r-dead-1"),
    "the reconcile row names the dead reservation it settles",
    JSON.stringify(last),
  );
  const a2 = adm();
  check(
    a2.status === 0,
    "after the reconcile the reservation stops holding: admitted",
    `rc=${a2.status} ${a2.stdout}`,
  );
  // A LIVE launcher's reservation is never swept up by a reconcile: its call is in flight.
  w.write([
    ...w.rows(),
    {
      ts: new Date().toISOString(),
      kind: "reservation",
      launch_kind: "delivery",
      reservation_id: "r-live-1",
      reserved_usd: 0.1,
      pid: process.pid,
      host: (await import("node:os")).hostname(),
      measured: false,
    },
  ]);
  spawnSync(process.execPath, [LEDGER_MOD, "--reconcile", "--usd", "0.01"], {
    env,
    encoding: "utf8",
  });
  const last2 = w.rows().at(-1);
  check(
    last2.kind === "reconcile" && !(last2.settles_reservations || []).includes("r-live-1"),
    "a reconcile leaves a live launcher's reservation open",
    JSON.stringify(last2),
  );
  // PID REUSE (independent review of review 16): a reservation records its launcher's
  // start time where the OS exposes it (/proc), so a dead launcher's pid that the kernel
  // has handed to another live process is not taken for the launcher.
  const { pidStartTime } = await import(ADMISSION);
  const myStart = pidStartTime(process.pid);
  if (myStart === null) {
    ok("pid reuse: no /proc on this host, the live-pid rule alone applies (skipped)");
  } else {
    const host = (await import("node:os")).hostname();
    const row = (id, pidStart) => ({
      ts: new Date().toISOString(),
      kind: "reservation",
      launch_kind: "delivery",
      reservation_id: id,
      reserved_usd: 0.1,
      pid: process.pid,
      pid_start: pidStart,
      host,
      measured: false,
    });
    w.write([...w.rows(), row("r-same-start", myStart), row("r-reused-pid", `${myStart}1`)]);
    spawnSync(process.execPath, [LEDGER_MOD, "--reconcile", "--usd", "0.01"], {
      env,
      encoding: "utf8",
    });
    const swept = w.rows().at(-1).settles_reservations || [];
    check(
      swept.includes("r-reused-pid") && !swept.includes("r-same-start"),
      "pid reuse: a live pid with another start time is not the launcher (swept); the same start time is (kept)",
      JSON.stringify(swept),
    );
  }
  // A reservation booked through the seam records the start time where /proc has it.
  const w3 = world();
  spawnSync(
    process.execPath,
    [ADMISSION, "reserve", "--kind", "decompose", "--pid", String(process.pid)],
    {
      env: { ...w3.env, GAFFER_DAILY_BUDGET_USD: "1" },
      encoding: "utf8",
    },
  );
  const booked = w3.rows().find((r) => r.reservation_id);
  check(
    booked && (myStart === null ? booked.pid_start === undefined : booked.pid_start === myStart),
    "the reservation row names its launcher's start time where the OS exposes it",
    JSON.stringify(booked),
  );
}

console.log("== P5: both launch paths at once (worker.sh delivery + worker.mjs planner) ==");
{
  const w = world({ cost: 0.7, sleep: 2 });
  const env = { ...w.env, GAFFER_DAILY_BUDGET_USD: "1", GAFFER_MAX_CALL_USD: "0.7", W: w.dir };
  const go = join(w.dir, "go");
  const node = run(process.execPath, ["--input-type=module", "-e", NODE_LAUNCHER], {
    env: { ...env, READY: join(w.dir, "ready-node"), GO: go },
  });
  const sh = run("bash", ["-c", SHELL_LAUNCHER], {
    env: { ...env, READY: join(w.dir, "ready-sh"), GO: go },
  });
  const ready = await until(
    () => existsSync(join(w.dir, "ready-node")) && existsSync(join(w.dir, "ready-sh")),
    120000,
  );
  writeFileSync(go, "1");
  const [rn, rs] = await Promise.all([node, sh]);
  const nodeStarted = /"status":0/.test(rn.out);
  const shStarted = /rc=0/.test(rs.out);
  check(
    ready && w.calls() === 1 && nodeStarted !== shStarted,
    "the shell delivery and the Node planner race against $1: exactly one starts",
    `calls=${w.calls()} node=${rn.out} sh=${rs.out.trim()} err=${(rn.err + rs.err).slice(-300)}`,
  );
  const rows = w.rows();
  const opened = rows
    .filter((r) => r.kind === "reservation" && r.reservation_id)
    .map((r) => r.reservation_id);
  const settled = new Set(rows.filter((r) => typeof r.settles === "string").map((r) => r.settles));
  check(
    opened.length === 1 && opened.every((id) => settled.has(id)),
    "the started call's reservation is settled by its own booking row",
    JSON.stringify(rows),
  );
  check(
    recordedSpend(rows) <= 1 + 1e-9,
    "no more than the cap is recorded",
    `$${recordedSpend(rows)}`,
  );
}

console.log("== P6: the lock closes the race (8 admissions at once, a cap that fits 3) ==");
{
  const w = world();
  // $0.75 fits exactly three $0.25 worst cases (binary-exact, so no rounding edge).
  const env = { ...w.env, GAFFER_DAILY_BUDGET_USD: "0.75" };
  const kids = Array.from({ length: 8 }, () =>
    run(process.execPath, [ADMISSION, "reserve", "--kind", "probe", "--worst-usd", "0.25"], {
      env,
    }),
  );
  const res = await Promise.all(kids);
  const admitted = res.filter((r) => r.code === 0).length;
  const refused = res.filter((r) => r.code === 3).length;
  check(
    admitted === 3 && refused === 5,
    "exactly 3 admitted, 5 refused",
    `admitted=${admitted} refused=${refused} codes=${res.map((r) => r.code).join(",")} err=${res
      .map((r) => r.err)
      .join("")
      .slice(0, 300)}`,
  );
  const open = w.rows().filter((r) => r.kind === "reservation" && r.reservation_id);
  check(open.length === 3, "three reservation rows were booked", `${open.length}`);
  check(!existsSync(`${w.ledger}.admit.lock.d`), "the admission lock is released after the race");
}

console.log("== P7: a launch refused after admission releases its reservation ==");
{
  const w = world();
  // The command provider with no sandbox the runner can use: refused (75) after the
  // budget admission, before any program runs. Its program lives outside the call's
  // write root (the launcher's cwd), as the provider requires.
  const cwd = join(w.dir, "cwd");
  mkdirSync(cwd, { recursive: true });
  const env = {
    ...w.env,
    GAFFER_DAILY_BUDGET_USD: "1",
    GAFFER_WORKER_PROVIDER: "command",
    GAFFER_WORKER_COMMAND: w.stub,
  };
  delete env.GAFFER_STRICT_REQUIRE;
  const r = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const W = await import(process.env.RUNNER_DIR + "/lib/worker.mjs");
       const r = W.deliver({ bin: "x", argv: ["-p", "x", "--output-format", "json"], cwd: process.cwd(), timeoutMs: 5000, env: {}, kind: "decompose" });
       process.stdout.write(String(r.status));`,
    ],
    { env, encoding: "utf8", cwd },
  );
  const { ledgerSpend } = await import(ADMISSION);
  const s = ledgerSpend(env);
  const rows = w.rows();
  check(w.calls() === 0, "nothing was spawned", `calls=${w.calls()} status=${r.stdout}`);
  check(
    r.stdout === "75" &&
      rows.some((x) => x.kind === "reservation" && x.reservation_id) &&
      rows.some((x) => x.kind === "reservation" && x.released === true && x.settles) &&
      s.openReservations === 0,
    "refused after the admission (75): the reservation it booked is released, none left open",
    `status=${r.stdout} ${JSON.stringify(s)} rows=${JSON.stringify(rows)} err=${r.stderr.slice(-300)}`,
  );
}

console.log("== P8: the shell crash path settles an open reservation at the kill estimate ==");
{
  const w = world({ cost: 0.4, sleep: 0 });
  const env = { ...w.env, GAFFER_DAILY_BUDGET_USD: "5", GAFFER_KILL_ESTIMATE_USD: "0.3", W: w.dir };
  const r = spawnSync(
    "bash",
    [
      "-c",
      `source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
       export GAFFER_STRICT_REQUIRE=0 STRICT_MODE=0 GAFFER_LOG="$W/log"
       printf '{}' > "$W/mcp.json"
       GAFFER_LAUNCH_KIND=delivery worker_deliver "$W" "prompt" "" "$W/mcp.json" "$W/out.json" 2>/dev/null; echo "rc=$?"
       [ -f "$W/out.json.reservation" ] && echo "held"
       : > "$W/out.json"   # the tick died before booking: the envelope is lost
       gaffer_usage_settle_crashed delivery 7 "$W/out.json"
       [ -f "$W/out.json.reservation" ] || echo "cleared"`,
    ],
    { env, encoding: "utf8" },
  );
  check(
    /rc=0/.test(r.stdout) && /held/.test(r.stdout),
    "worker_deliver leaves the reservation id beside the envelope",
    r.stdout + r.stderr,
  );
  const rows = w.rows();
  const resv = rows.find((x) => x.kind === "reservation" && x.reservation_id);
  const booked = rows.find((x) => x.settles && resv && x.settles === resv.reservation_id);
  check(
    !!booked &&
      booked.estimated === true &&
      booked.estimated_cost_usd === 0.3 &&
      booked.measured === false,
    "the crash path books the kill estimate, labelled, settling the reservation",
    JSON.stringify(rows),
  );
  check(/cleared/.test(r.stdout), "the reservation file is consumed", r.stdout);
}

console.log("== P9: the usage report shows reservations apart ==");
{
  const w = world();
  const ts = new Date().toISOString();
  w.write([
    { ts, kind: "delivery", ticket: 1, measured: true, total_cost_usd: 0.2, models: {} },
    {
      ts,
      kind: "reservation",
      launch_kind: "delivery",
      reservation_id: "a",
      reserved_usd: 0.5,
      measured: false,
    },
    {
      ts,
      kind: "reservation",
      launch_kind: "tester",
      reservation_id: "b",
      reserved_usd: 0.25,
      measured: false,
    },
    {
      ts,
      kind: "delivery",
      ticket: 1,
      measured: true,
      total_cost_usd: 0.1,
      models: {},
      settles: "a",
    },
  ]);
  const r = spawnSync(
    process.execPath,
    [join(RUNNER_DIR, "lib", "json-tool.mjs"), "summary-usage", w.ledger],
    {
      env: w.env,
      encoding: "utf8",
    },
  );
  const out = r.stdout.replace(new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g"), "");
  check(
    /2 call\(s\) measured, 0 unknown/.test(out),
    "reservation rows are not counted as calls (2 measured, 0 unknown)",
    out,
  );
  check(
    /reserved: \$0\.2500 held by 1 open reservation/.test(out),
    "the open reservation is shown on its own line, as a hold, not a cost",
    out,
  );
}

console.log("== P10: a reservation is never a reading ==");
{
  const w = world();
  const env = { ...w.env, GAFFER_DAILY_BUDGET_USD: "1", GAFFER_MAX_CALL_USD: "0.4" };
  const r = spawnSync(
    process.execPath,
    [ADMISSION, "reserve", "--kind", "decompose", "--worst-usd", "0.4"],
    {
      env,
      encoding: "utf8",
    },
  );
  const row = w.rows().find((x) => x.kind === "reservation");
  check(r.status === 0 && !!row, "the reserve verb books one reservation row", r.stdout + r.stderr);
  if (row) {
    check(
      row.measured === false &&
        !("total_cost_usd" in row) &&
        !("estimated_cost_usd" in row) &&
        !("estimated" in row) &&
        row.reserved_usd === 0.4 &&
        row.reserve_basis === "per-call-cap",
      "it carries reserved_usd and its basis, and no cost field at all",
      JSON.stringify(row),
    );
  }
  const { isMeasuredRow } = await import(resolve(RUNNER_DIR, "lib", "estimate.mjs"));
  const { killEstimateFromHistory } = await import(LEDGER_MOD);
  check(row && !isMeasuredRow(row), "the estimator never reads it as a measured row");
  const hist = Array.from({ length: 6 }, () => JSON.stringify({ ...row, kind: "decompose" })).join(
    "\n",
  );
  check(
    killEstimateFromHistory(hist, "decompose") === null,
    "the kill estimate never grounds itself on reservations",
  );
  // Under no cap at all (the opt-out) nothing is reserved: there is no ceiling to hold.
  const w2 = world();
  const r2 = spawnSync(process.execPath, [ADMISSION, "reserve", "--kind", "decompose"], {
    env: { ...w2.env, GAFFER_ALLOW_UNCAPPED: "1" },
    encoding: "utf8",
  });
  check(
    r2.status === 0 && w2.rows().length === 0,
    "uncapped (GAFFER_ALLOW_UNCAPPED=1): admitted, nothing reserved",
    r2.stdout,
  );
}

console.log(
  "== P11: a call that ran keeps its reservation; only one that never started gives it back ==",
);
{
  // The spec author's direct spawn (independent review of review 16): a call whose output
  // overflowed maxBuffer (ENOBUFS) RAN and may have spent, so its reservation must keep
  // holding (fail closed); a binary that does not exist (ENOENT) ran nothing and gives
  // its reservation back.
  const SPEC = resolve(RUNNER_DIR, "bin", "spec-author.mjs");
  for (const [label, big, wantOpen] of [
    ["a call that ran and overflowed its output buffer keeps holding", true, 1],
    ["a binary that could not be started releases its reservation", false, 0],
  ]) {
    const w = world();
    if (big)
      writeFileSync(
        w.stub,
        `#!/usr/bin/env bash\necho ran >> "${join(w.dir, "invocations")}"\nhead -c 17000000 /dev/zero | tr "\\0" a\n`,
      );
    const req = join(w.dir, "req.json");
    writeFileSync(req, JSON.stringify({ brief: "a per-user gym tracker, web only" }));
    const r = spawnSync(process.execPath, [SPEC, "--input", req], {
      env: {
        ...w.env,
        CLAUDE_BIN: big ? w.stub : join(w.dir, "no-such-binary"),
        GAFFER_DAILY_BUDGET_USD: "1",
        GAFFER_MAX_CALL_USD: "0.5",
      },
      encoding: "utf8",
      maxBuffer: 1 << 20,
    });
    const rows = w.rows();
    const opened = rows.filter((x) => x.kind === "reservation" && x.reservation_id);
    const settled = new Set(
      rows.filter((x) => typeof x.settles === "string").map((x) => x.settles),
    );
    const open = opened.filter((x) => !settled.has(x.reservation_id)).length;
    check(
      opened.length === 1 && open === wantOpen && w.calls() === (big ? 1 : 0),
      label,
      `rc=${r.status} calls=${w.calls()} rows=${JSON.stringify(rows)}`,
    );
  }
}

console.log("== P12: the admission lock's holder rules (independent review of review 16) ==");
{
  // A live holder is never reaped (the launch is refused at the timeout, never admitted);
  // a dead holder is reaped; a pid-less lock is reaped only once it is stale.
  const { utimesSync } = await import("node:fs");
  const w = world();
  const env = { ...w.env, GAFFER_DAILY_BUDGET_USD: "1", GAFFER_LOCK_TIMEOUT: "1" };
  const lock = `${w.ledger}.admit.lock.d`;
  const reserve = () =>
    spawnSync(process.execPath, [ADMISSION, "reserve", "--kind", "decompose"], {
      env,
      encoding: "utf8",
    });
  const hold = (pid, ageS = 0) => {
    rmSync(lock, { recursive: true, force: true });
    mkdirSync(lock);
    if (pid !== null) writeFileSync(join(lock, "pid"), String(pid));
    if (ageS) {
      const t = new Date(Date.now() - ageS * 1000);
      utimesSync(lock, t, t);
    }
  };
  hold(process.pid);
  let r = reserve();
  check(
    r.status === 3 && /lock/.test(r.stdout) && w.rows().length === 0,
    "a lock held by a live process: refused at the timeout, nothing reserved",
    `rc=${r.status} ${r.stdout}`,
  );
  const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
    encoding: "utf8",
  }).stdout;
  hold(dead);
  r = reserve();
  check(
    r.status === 0 && w.rows().length === 1 && !existsSync(lock),
    "a lock whose holder is dead is reaped: admitted and reserved",
    `rc=${r.status} ${r.stdout}`,
  );
  hold(null);
  r = reserve();
  check(
    r.status === 3,
    "a fresh pid-less lock is not reaped (its holder may be writing its pid)",
    `rc=${r.status}`,
  );
  hold(null, 60);
  r = reserve();
  check(
    r.status === 0 && !existsSync(lock),
    "a stale pid-less lock is reaped",
    `rc=${r.status} ${r.stdout}`,
  );
}

console.log("");
if (failures.length) {
  console.log(`FAILED ${failures.length} (passed ${passed})`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`all ${passed} passed`);

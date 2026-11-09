#!/usr/bin/env node
// =====================================================================
// lib/budget-admission.mjs — the ONE budget admission check before a PAID launch.
//
// External review #6: with both the daily (GAFFER_DAILY_BUDGET_USD) and lifetime
// (GAFFER_BUDGET_USD) limits exhausted, the dashboard's planning path (Plan a build →
// the decomposer) and the product-owner "Suggest work" run still invoked the worker
// and booked a call: the caps were enforced only at the top of a delivery tick. Every
// paid worker launch — delivery, review, clarify, tester, decompose, product owner,
// onboarding analysis, merge resolver, spec author — now passes THIS check immediately
// before it spawns, at the two worker seams (lib/worker.mjs `deliver` for the Node
// launchers; lib/worker.sh `worker_deliver` for the shell ones calls the CLI below via
// lib/budget.sh `gaffer_paid_launch_admitted`), so one rule governs them all.
//
// Rule (same semantics as budget.sh's gaffer_spend_cap_ok / gaffer_day_usd_cap_ok /
// gaffer_budget_headroom_ok):
//   • a cap that is unset, empty, <= 0 or not a number is OFF;
//   • NO CAP AT ALL refuses, as a live run does (exploratory finding fresh-user/F-09:
//     onboarding analysis, Plan a build, Suggest work, the spec author, the merge
//     resolver and the tester used to launch paid calls with no dollar cap anywhere).
//     GAFFER_ALLOW_UNCAPPED=1 in the ENVIRONMENT (never settings.json) opts out;
//   • daily: today's (UTC) spend from the usage ledger must be BELOW the cap;
//   • lifetime: the whole ledger's spend must be BELOW the budget;
//   • spend = measured total_cost_usd, else the labelled estimated_cost_usd (killed
//     and timed-out calls count, and so does a call whose envelope reported no total);
//   • a row booked TODAY with neither (an unknown cost: no envelope total, no history
//     and the kill floor set to 0) means today's spend cannot be established, so with a
//     cap set the launch is refused until the operator books what those calls cost
//     (`node runner/lib/usage-ledger.mjs --reconcile --usd <amount>`) or the UTC day
//     turns over. A command worker the operator chose to trust
//     (GAFFER_WORKER_COMMAND_COST_USD=0, cost_basis "unreported") is the one documented
//     exception and still counts as $0;
//   • the ledger is the file the writer appends to (lib/usage-ledger-path.mjs, shared);
//   • a call whose ledger append FAILED is not free (external review 16): the writer holds
//     its row in $GAFFER_DATA/usage-ledger.held.jsonl, and every held row is an unknown
//     cost (daily and lifetime) until `usage-ledger.mjs --reconcile` moves it into the
//     ledger (a hold file the reconcile claimed and has not retired counts too); a hold
//     file that cannot be read is an unknown spend;
//   • FAIL CLOSED: with a cap set, a ledger that exists but cannot be read, or holds a
//     line that is not a JSON object, is an UNKNOWN spend and refuses the launch; so
//     is a ledger that is turned off or has no location (nothing would be booked).
// Caps come from the environment (the operator's env, or what factory.config.sh
// exported from settings.json); a Node launcher spawned by the dashboard's API has no
// such env, so settings.json ($GAFFER_DATA/settings.json) is read as the fallback. A
// settings.json that exists but does not parse refuses (the caps are unknowable).
//
// RESERVATIONS (external review 16): a dollar cap is a CEILING, so the calls already
// running hold their worst case against it. Two launches that both read "$0 spent" used
// to both start against a $1 cap and record $1.40. Now:
//   • under any cap, an admitted launch books a `reservation` row in the usage ledger
//     BEFORE the call starts (reservePaidLaunch; the seams lib/worker.mjs deliver and
//     lib/worker.sh worker_deliver call it), for the call's worst case: its per-call cap
//     (--max-budget-usd / GAFFER_MAX_CALL_USD) where set, else the kill estimate
//     (GAFFER_KILL_ESTIMATE_USD, default 0.05), else RESERVATION_FLOOR_USD;
//   • "read spend + write reservation" runs under ONE per-ledger lock
//     (<ledger>.admit.lock.d, withAdmissionLock), so two launches can never both read
//     the same headroom;
//   • admission counts OPEN reservations as spend, today and lifetime: spend plus open
//     reservations must be below the cap, and when other calls are in flight the new
//     call's own worst case must fit beside them (spend + reserved + worst <= cap). With
//     nothing in flight the rule is the one above, unchanged (below the cap admits);
//   • the call's own row (measured or estimated) names the reservation it settles
//     (`settles`), and the reader stops counting it; a launch refused after admission
//     (no agent spawned) releases it with a `settles` row of its own;
//   • a reservation whose call died without booking stays OPEN and keeps holding both
//     caps (fail closed) until the shell crash path books its kill estimate
//     (config/14-usage.sh gaffer_usage_settle_crashed) or the operator reconciles
//     (`usage-ledger.mjs --reconcile`, which settles the reservations whose launcher is
//     no longer running).
// A reservation is never a reading: it carries `reserved_usd` and its basis, never a
// total_cost_usd or an estimated_cost_usd, so no cost view or estimator reads it as one.
//
// CLI: node lib/budget-admission.mjs check [--kind <launcher>] [--worst-usd <n>]
//      → one JSON line { ok, kind, reason, daily, lifetime }; exit 0 admitted · 3 refused
//      node lib/budget-admission.mjs reserve --kind <launcher> [--worst-usd <n>]
//           [--ticket <n>] [--pid <launcher pid>] [--out <file>]
//      → the check and, when admitted under a cap, one reservation row, under the lock;
//        the reservation id is written to <file>; exit 0 admitted · 3 refused
//      node lib/budget-admission.mjs release (--id <id> | --file <file>) [--reason <text>]
//      → a launch that was admitted but never started gives its reservation back
// =====================================================================
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ledgerDisabled,
  resolveHoldClaims,
  resolveHoldPath,
  resolveLedgerPath,
} from "./usage-ledger-path.mjs";

export const BUDGET_REFUSED_STATUS = 77;

/** The ledger row kind of a reservation (and of the row that releases one). */
export const RESERVATION_KIND = "reservation";
/** The worst case booked when no per-call cap is set and the kill estimate is 0. */
export const RESERVATION_FLOOR_USD = 0.05;
/** The kill estimate's default outside factory.config.sh (usage-ledger.mjs parity). */
const KILL_ESTIMATE_DEFAULT = 0.05;
const RESERVATION_ID_RE = /^r-[A-Za-z0-9-]{4,64}$/;

/** The one-line fix, word for word lib/budget.sh gaffer_spend_cap_hint. */
export const SPEND_CAP_HINT =
  "no dollar cap is set: set GAFFER_DAILY_BUDGET_USD (try 5) or GAFFER_BUDGET_USD in your environment or the dashboard's Settings → Budget & caps; GAFFER_ALLOW_UNCAPPED=1 runs without one";

const finiteNonNeg = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const finitePos = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * True for a ledger row whose cost is not known at all: no finite total_cost_usd and no
 * labelled estimate. A command worker's `cost_basis: "unreported"` row is the operator's
 * explicit choice (GAFFER_WORKER_COMMAND_COST_USD=0) and is not counted as unknown.
 */
export function isUnknownCostRow(r) {
  if (!r || typeof r !== "object") return false;
  // A reservation row is a HOLD for a call in flight, never a call: it carries no cost
  // by design and is counted through reservedUsd, not as an unknown cost.
  if (r.kind === RESERVATION_KIND) return false;
  if (finiteNonNeg(r.total_cost_usd)) return false;
  if (r.estimated === true && finiteNonNeg(r.estimated_cost_usd)) return false;
  if (r.cost_basis === "unreported" && r.worker_provider === "command") return false;
  return true;
}

/** The operator's way out of an unknown-cost refusal, quoted in the reason. */
export const RECONCILE_HINT =
  "book what those calls cost with `node runner/lib/usage-ledger.mjs --reconcile --usd <amount>` (it counts toward the caps, so raise the cap if that exhausts it), or wait for the next UTC day";

function capValue(raw) {
  const s = String(raw ?? "").trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function settingsPath(env) {
  const data = String(env.GAFFER_DATA ?? "").trim();
  return join(data !== "" ? resolve(data) : join(homedir(), ".gaffer"), "settings.json");
}

/** The configured caps: env first, else settings.json. `{ error }` when unknowable. */
export function readBudgetCaps(env = process.env) {
  let file = {};
  const p = settingsPath(env);
  if (existsSync(p)) {
    try {
      const parsed = JSON.parse(readFileSync(p, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) file = parsed;
      else return { error: `settings.json at ${p} is not an object` };
    } catch (e) {
      return { error: `settings.json at ${p} could not be read (${e?.message ?? e})` };
    }
  }
  const pick = (k) => (env[k] !== undefined && String(env[k]).trim() !== "" ? env[k] : file[k]);
  return {
    daily: capValue(pick("GAFFER_DAILY_BUDGET_USD")),
    lifetime: capValue(pick("GAFFER_BUDGET_USD")),
  };
}

/**
 * `{ today, lifetime }` USD spend from the ledger (strict), or `{ unknown: reason }`.
 * The path comes from the SAME resolver the writer uses (lib/usage-ledger-path.mjs), so
 * a relative GAFFER_USAGE_LEDGER is read under GAFFER_DATA exactly where the calls are
 * booked. Only called with a cap set, so a ledger that is turned off
 * (GAFFER_USAGE_LEDGER=0/off/false/no) or has no location (no GAFFER_DATA) is an
 * UNKNOWN spend, never "nothing spent": no call would ever be booked against the cap.
 */
export function ledgerSpend(env = process.env, now = new Date()) {
  const raw = String(env.GAFFER_USAGE_LEDGER ?? "").trim();
  if (ledgerDisabled(raw))
    return {
      unknown: `the usage ledger is turned off (GAFFER_USAGE_LEDGER=${raw}), so no spend is recorded`,
    };
  const p = resolveLedgerPath(env);
  if (!p)
    return {
      unknown: "the usage ledger has no location (GAFFER_DATA and GAFFER_USAGE_LEDGER are unset)",
    };
  // UNBOOKED CALLS: rows held by a failed append count as unknown cost, whatever the day.
  // A reconcile's claimed hold files (resolveHoldClaims) count until it retires them.
  let held = 0;
  const hold = resolveHoldPath(env);
  for (const f of [hold, ...resolveHoldClaims(env)]) {
    if (!f || !existsSync(f)) continue;
    try {
      held += readFileSync(f, "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "").length;
    } catch (e) {
      return { unknown: `the held usage rows ${f} cannot be read (${e?.code ?? e})` };
    }
  }
  // Nothing booked yet (held rows aside).
  if (!existsSync(p))
    return {
      today: 0,
      lifetime: 0,
      unknownToday: held,
      unknownAll: held,
      held,
      reservedUsd: 0,
      openReservations: 0,
      reservations: [],
    };
  let text;
  try {
    text = readFileSync(p, "utf8");
  } catch (e) {
    return { unknown: `the usage ledger ${p} cannot be read (${e?.code ?? e})` };
  }
  const day = now.toISOString().slice(0, 10);
  let today = 0;
  let lifetime = 0;
  // Unknown-cost rows since the last operator reconcile row: those booked today (they
  // hold the DAILY cap) and all of them, whatever the day (they hold the LIFETIME cap: a
  // call whose cost was never established does not become free when the UTC day turns;
  // external review 15).
  let unknownToday = 0;
  let unknownAll = 0;
  // Open reservations (id → row) and the ids some row has settled; a settle may in
  // principle be read before its reservation, so both are kept until the end.
  const open = new Map();
  const settled = new Set();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      return { unknown: `the usage ledger ${p} holds a line that is not JSON` };
    }
    if (!r || typeof r !== "object" || Array.isArray(r))
      return { unknown: `the usage ledger ${p} holds a record that is not an object` };
    if (typeof r.settles === "string" && r.settles) {
      settled.add(r.settles);
      open.delete(r.settles);
    }
    if (r.kind === "reconcile" && Array.isArray(r.settles_reservations))
      for (const id of r.settles_reservations)
        if (typeof id === "string") {
          settled.add(id);
          open.delete(id);
        }
    if (r.kind === RESERVATION_KIND) {
      // A release row (it carries `settles`) was handled above. An open reservation
      // must state a finite worst case: one that does not is a hold of unknown size.
      if (typeof r.reservation_id === "string" && r.reservation_id && !r.settles) {
        if (!finiteNonNeg(r.reserved_usd))
          return {
            unknown: `the usage ledger ${p} holds a reservation (${r.reservation_id}) with no readable reserved_usd`,
          };
        if (!settled.has(r.reservation_id)) open.set(r.reservation_id, r);
      }
      continue; // never a call, never a cost
    }
    let c = 0;
    if (
      typeof r.total_cost_usd === "number" &&
      Number.isFinite(r.total_cost_usd) &&
      r.total_cost_usd >= 0
    )
      c = r.total_cost_usd;
    else if (
      typeof r.estimated_cost_usd === "number" &&
      Number.isFinite(r.estimated_cost_usd) &&
      r.estimated_cost_usd >= 0
    )
      c = r.estimated_cost_usd;
    lifetime += c;
    const isToday = typeof r.ts === "string" && r.ts.slice(0, 10) === day;
    if (isToday) today += c;
    // Only a reconcile row that booked a positive figure clears the unknown rows before
    // it: one at $0 (hand-written, or from an older writer) would count them as free.
    // A HELD reconcile row (its own append failed; a later reconcile moved it here) does
    // not clear either: it now sits after calls it never covered. Its cost still counts
    // and its settles_reservations still settle (fail closed: an over-count at worst).
    if (
      r.kind === "reconcile" &&
      r.estimated === true &&
      r.held !== true &&
      finitePos(r.estimated_cost_usd)
    ) {
      unknownToday = 0;
      unknownAll = 0;
    } else if (isUnknownCostRow(r)) {
      unknownAll += 1;
      if (isToday) unknownToday += 1;
    }
  }
  const reservations = [...open.values()];
  const reservedUsd = reservations.reduce((a, r) => a + r.reserved_usd, 0);
  return {
    today,
    lifetime,
    // Rows held by a failed append (and claimed, unretired ones) are unknown cost on
    // both caps; `held` says how many of the unknown calls are those.
    unknownToday: unknownToday + held,
    unknownAll: unknownAll + held,
    held,
    reservedUsd,
    openReservations: reservations.length,
    reservations,
  };
}

/** The refusal's note on held rows: they sit in the hold file, not in the ledger itself. */
function heldNote(spend) {
  const n = spend && typeof spend.held === "number" ? spend.held : 0;
  return n > 0
    ? ` (${n} of them held by a failed ledger append, in usage-ledger.held.jsonl or a reconcile's claim beside it; \`usage-ledger.mjs --open-reservations\` lists them)`
    : "";
}

/**
 * The worst case a launch reserves: `{ usd, basis }`. The call's own per-call cap
 * (`worstUsd`, the --max-budget-usd it is launched with) where given, else
 * GAFFER_MAX_CALL_USD (clamped to GAFFER_BUDGET_REMAINING, lib/worker.mjs callBudgetUsd
 * parity), else the kill estimate (GAFFER_KILL_ESTIMATE_USD, default 0.05), else the
 * floor. Never derived from tokens or a price table.
 */
export function reservationWorst({ env = process.env, worstUsd } = {}) {
  const w = typeof worstUsd === "string" ? Number(worstUsd) : worstUsd;
  if (finitePos(w)) return { usd: w, basis: "per-call-cap" };
  const callCap = capValue(env.GAFFER_MAX_CALL_USD);
  if (callCap !== null) {
    const rem = String(env.GAFFER_BUDGET_REMAINING ?? "").trim();
    const r = rem === "" ? NaN : Number(rem);
    const v = Number.isFinite(r) && r < callCap ? r : callCap;
    if (v > 0) return { usd: v, basis: "per-call-cap" };
  }
  const rawKill = String(env.GAFFER_KILL_ESTIMATE_USD ?? "").trim();
  const kill = rawKill === "" ? KILL_ESTIMATE_DEFAULT : Number(rawKill);
  if (finitePos(kill)) return { usd: kill, basis: "kill-estimate" };
  return { usd: RESERVATION_FLOOR_USD, basis: "floor" };
}

/**
 * May a paid worker launch start now? `{ ok, kind, reason, daily, lifetime }`. DRY runs
 * never reach a launch, so no DRY_RUN exemption lives here.
 */
export function paidLaunchAdmission({
  kind = "worker",
  env = process.env,
  now = new Date(),
  worstUsd,
} = {}) {
  const caps = readBudgetCaps(env);
  if (caps.error)
    return {
      ok: false,
      kind,
      reason: `budget caps unknowable: ${caps.error} — refusing the paid ${kind} launch (fail closed)`,
    };
  if (caps.daily === null && caps.lifetime === null) {
    if (String(env.GAFFER_ALLOW_UNCAPPED ?? "").trim() === "1")
      return {
        ok: true,
        kind,
        reason: "no budget cap configured (GAFFER_ALLOW_UNCAPPED=1)",
        daily: null,
        lifetime: null,
      };
    return {
      ok: false,
      kind,
      noCap: true,
      reason: `a paid ${kind} launch refuses to start without a dollar cap, like a live run — ${SPEND_CAP_HINT}`,
      daily: null,
      lifetime: null,
    };
  }
  const spend = ledgerSpend(env, now);
  if (spend.unknown)
    return {
      ok: false,
      kind,
      reason: `a budget cap is set but the spend cannot be established: ${spend.unknown} — refusing the paid ${kind} launch (fail closed)`,
    };
  if (spend.unknownToday > 0)
    return {
      ok: false,
      kind,
      unknownCost: spend.unknownToday,
      reason: `a budget cap is set but the spend cannot be established: the usage ledger holds ${spend.unknownToday} call(s) today with no reported cost and no estimate${heldNote(spend)}, so the paid ${kind} launch is refused (fail closed); ${RECONCILE_HINT}`,
    };
  // The lifetime cap counts every day, so an unknown-cost row from an earlier day holds
  // it until the operator books the cost: the day turning over clears the daily hold
  // only (external review 15).
  if (caps.lifetime !== null && spend.unknownAll > 0)
    return {
      ok: false,
      kind,
      unknownCost: spend.unknownAll,
      reason: `the lifetime budget (GAFFER_BUDGET_USD=${caps.lifetime}) cannot be checked: the usage ledger holds ${spend.unknownAll} call(s) from an earlier day with no reported cost and no estimate${heldNote(spend)}, so the paid ${kind} launch is refused (fail closed); book what those calls cost with \`node runner/lib/usage-ledger.mjs --reconcile --usd <amount>\` (it counts toward the caps)`,
    };
  // Open reservations (calls in flight, or that died without booking) count as spend
  // against BOTH caps, whatever day they were booked on: a call still running books its
  // real row today, and one that never booked holds until it is settled (fail closed).
  const reserved = spend.reservedUsd || 0;
  const nOpen = spend.openReservations || 0;
  const worst = reservationWorst({ env, worstUsd });
  const daily = caps.daily === null ? null : { cap: caps.daily, spent: spend.today, reserved };
  const lifetime =
    caps.lifetime === null ? null : { cap: caps.lifetime, spent: spend.lifetime, reserved };
  const held =
    reserved > 0 ? ` and $${reserved.toFixed(4)} held by ${nOpen} open reservation(s)` : "";
  // EPS: a sum of decimal dollars (0.1 + 0.2) is not exact in binary; the fit test
  // allows for it so a cap that holds exactly N worst cases admits N.
  const EPS = 1e-9;
  for (const [b, label, knob, when] of [
    [daily, "daily", "GAFFER_DAILY_BUDGET_USD", " today"],
    [lifetime, "lifetime", "GAFFER_BUDGET_USD", ""],
  ]) {
    if (!b) continue;
    if (!(b.spent + reserved < b.cap))
      return {
        ok: false,
        kind,
        reason: `the ${label} budget is exhausted (${knob}=${b.cap}, spent $${b.spent.toFixed(4)}${when}${held}) — the paid ${kind} launch was not started`,
        daily,
        lifetime,
        worst,
      };
    // Other calls are in flight: this one starts only if its own worst case fits beside
    // them, so the ceiling holds for the calls already running.
    if (reserved > 0 && b.spent + reserved + worst.usd > b.cap + EPS)
      return {
        ok: false,
        kind,
        reason: `the ${label} budget cannot hold another call (${knob}=${b.cap}, spent $${b.spent.toFixed(4)}${when}${held} for calls in flight; this launch reserves $${worst.usd.toFixed(4)}, ${worst.basis}) — the paid ${kind} launch was not started; it fits once those calls book their cost`,
        daily,
        lifetime,
        worst,
      };
  }
  return { ok: true, kind, reason: "within budget", daily, lifetime, worst };
}

// ── THE ADMISSION LOCK ──────────────────────────────────────────────────────────
// "read spend + write reservation" must be one step, or two launches read the same
// headroom. A mkdir lock beside the ledger (<ledger>.admit.lock.d, with the holder's pid
// inside), the same discipline as config/10-locks.sh gaffer_with_lock's portable path:
// a holder that is alive is never reaped however long it holds; a dead holder's lock is
// reaped under a guard; a lock with no pid older than LOCK_STALE_NOPID_MS is reaped. The
// shell launchers reach it through this module's CLI, so there is ONE lock for both.
const LOCK_STALE_NOPID_MS = 10000;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM"; // alive, owned by someone else
  }
}
/**
 * The start time of process `pid` as the kernel counts it (/proc/<pid>/stat field 22,
 * clock ticks since boot), or null where there is no /proc (macOS) or no such process.
 * With the pid it names one process for good: a pid the kernel has handed to a new
 * process since reads a different start time.
 */
export function pidStartTime(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return null;
  try {
    const stat = readFileSync(`/proc/${n}/stat`, "utf8");
    // comm (field 2) may hold spaces or parentheses: the fields after it follow the LAST ")".
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const v = rest[19]; // field 22 = index 19 after state (field 3)
    return v && /^\d+$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Is a reservation's launcher still running on this host (its call may be in flight)?
 * A pid that is alive but whose start time differs from the one the reservation
 * recorded is a reused pid: the launcher is gone. Without a recorded start time, or
 * where /proc is absent, a live pid reads as the launcher (fail closed: the hold stays).
 */
export function launcherAlive(r, host = hostname()) {
  if (!r || r.host !== host) return false;
  if (!pidAlive(r.pid)) return false;
  if (typeof r.pid_start === "string" && r.pid_start) {
    const now = pidStartTime(r.pid);
    if (now !== null && now !== r.pid_start) return false;
  }
  return true;
}

function ageMs(p) {
  try {
    return Date.now() - statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}
function readPid(dir) {
  try {
    return readFileSync(join(dir, "pid"), "utf8").trim();
  } catch {
    return "";
  }
}
function reapLock(dir, seenPid) {
  const guard = `${dir}.reap`;
  try {
    mkdirSync(guard);
  } catch {
    if (ageMs(guard) > LOCK_STALE_NOPID_MS) rmSync(guard, { recursive: true, force: true });
    return false;
  }
  let reaped = false;
  try {
    // Re-checked under the guard: the lock may have been reaped and taken again since
    // it was seen. A pid-less lock must ALSO still be stale, or a fresh holder that has
    // not written its pid yet would be reaped and two launches would both hold it.
    if (
      existsSync(dir) &&
      readPid(dir) === seenPid &&
      (seenPid !== "" || ageMs(dir) > LOCK_STALE_NOPID_MS)
    ) {
      rmSync(dir, { recursive: true, force: true });
      reaped = true;
    }
  } finally {
    rmSync(guard, { recursive: true, force: true });
  }
  return reaped;
}

/**
 * Run `fn()` holding the admission lock of `ledgerPath`. `{ locked: true, value }`, or
 * `{ locked: false, reason }` when it could not be taken within GAFFER_LOCK_TIMEOUT
 * seconds (default 30): the caller then refuses the launch (fail closed).
 */
export function withAdmissionLock(ledgerPath, fn, env = process.env) {
  const dir = `${ledgerPath}.admit.lock.d`;
  const t = Number(String(env.GAFFER_LOCK_TIMEOUT ?? "").trim() || "30");
  const deadline = Date.now() + (Number.isFinite(t) && t > 0 ? t : 30) * 1000;
  try {
    mkdirSync(dirname(ledgerPath), { recursive: true });
  } catch {
    /* the mkdir below reports it */
  }
  for (;;) {
    try {
      mkdirSync(dir);
      break;
    } catch (e) {
      if (e?.code !== "EEXIST")
        return {
          locked: false,
          reason: `the admission lock ${dir} cannot be created (${e?.code ?? e})`,
        };
    }
    const pid = readPid(dir);
    if (pid ? !pidAlive(pid) : ageMs(dir) > LOCK_STALE_NOPID_MS) {
      if (reapLock(dir, pid)) continue;
    }
    if (Date.now() > deadline)
      return { locked: false, reason: `the admission lock ${dir} was not free within ${t}s` };
    sleepSync(10 + Math.floor(Math.random() * 15));
  }
  try {
    writeFileSync(join(dir, "pid"), String(process.pid));
  } catch {
    /* a lock with no pid is reaped by age only; the section below is milliseconds */
  }
  try {
    return { locked: true, value: fn() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The reservation this process booked and its call has not settled yet (the Node seam
// is synchronous, so one at a time): usage-ledger.mjs appendUsageRecord stamps the next
// call row it appends to the same ledger with `settles`.
let pending = null;
/** Take (and clear) the pending reservation id for `ledgerPath`, or null. */
export function takePendingReservation(ledgerPath) {
  if (!pending || pending.ledger !== ledgerPath) return null;
  const id = pending.id;
  pending = null;
  return id;
}

function appendRow(ledgerPath, row) {
  try {
    appendFileSync(ledgerPath, JSON.stringify(row) + "\n");
    return true;
  } catch (e) {
    process.stderr.write(
      `gaffer: budget: could not write to the usage ledger ${ledgerPath} (${e?.code ?? e})\n`,
    );
    return false;
  }
}

/**
 * The admission check AND, when it admits under a cap, the reservation row, as one
 * locked step. Returns the admission (`ok`, `reason`, ...) plus `reservation:
 * { id, usd, basis }` when one was booked. No cap (the GAFFER_ALLOW_UNCAPPED opt-out)
 * books nothing: there is no ceiling to hold. A lock that cannot be taken, or a
 * reservation that cannot be written, refuses (fail closed).
 */
export function reservePaidLaunch({
  kind = "worker",
  env = process.env,
  now = new Date(),
  worstUsd,
  ticket = null,
  pid = process.pid,
  remember = true,
} = {}) {
  const caps = readBudgetCaps(env);
  if (caps.error || (caps.daily === null && caps.lifetime === null))
    return paidLaunchAdmission({ kind, env, now, worstUsd });
  const ledgerPath = resolveLedgerPath(env);
  if (!ledgerPath) return paidLaunchAdmission({ kind, env, now, worstUsd }); // refuses: no location
  const held = withAdmissionLock(
    ledgerPath,
    () => {
      const d = paidLaunchAdmission({ kind, env, now: new Date(), worstUsd });
      if (!d.ok) return d;
      const id = `r-${Date.now().toString(36)}-${randomBytes(5).toString("hex")}`;
      const n = ticket != null && /^\d+$/.test(String(ticket)) ? Number(ticket) : null;
      const row = {
        ts: new Date().toISOString(),
        ticket: n,
        kind: RESERVATION_KIND,
        launch_kind: String(kind).slice(0, 40),
        reservation_id: id,
        reserved_usd: d.worst.usd,
        reserve_basis: d.worst.basis,
        measured: false,
        pid: Number(pid) || process.pid,
        host: hostname(),
      };
      // The launcher's start time where the OS exposes it, so a reconcile never takes a
      // pid reused by another process for the launcher (lib/usage-ledger.mjs).
      const st = pidStartTime(row.pid);
      if (st !== null) row.pid_start = st;
      if (!appendRow(ledgerPath, row))
        return {
          ok: false,
          kind,
          reason: `the reservation for the paid ${kind} launch could not be booked in the usage ledger — refusing the launch (fail closed)`,
        };
      return { ...d, reservation: { id, usd: d.worst.usd, basis: d.worst.basis } };
    },
    env,
  );
  if (!held.locked)
    return {
      ok: false,
      kind,
      reason: `the budget admission could not take its lock: ${held.reason} — refusing the paid ${kind} launch (fail closed)`,
    };
  const d = held.value;
  if (d.ok && d.reservation && remember) pending = { id: d.reservation.id, ledger: ledgerPath };
  return d;
}

/**
 * Give back a reservation whose launch was admitted but never started (a sandbox or
 * bridge refusal after the admission, a spawn that could not exec): one release row
 * naming it (`settles`), $0 and no cost fields, since nothing ran. Best-effort; a
 * release that cannot be written leaves the reservation holding (fail closed).
 */
export function releaseReservation({ id, reason, env = process.env } = {}) {
  if (typeof id !== "string" || !RESERVATION_ID_RE.test(id)) return false;
  const ledgerPath = resolveLedgerPath(env);
  if (!ledgerPath) return false;
  if (pending && pending.id === id) pending = null;
  return appendRow(ledgerPath, {
    ts: new Date().toISOString(),
    ticket: null,
    kind: RESERVATION_KIND,
    settles: id,
    released: true,
    measured: false,
    reason: String(reason || "the launch did not start").slice(0, 200),
  });
}

/** The pending reservation, released (see releaseReservation). */
export function releasePendingReservation(reason, env = process.env) {
  if (!pending) return false;
  return releaseReservation({ id: pending.id, reason, env });
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const opt = (name) => {
    const i = rest.indexOf(name);
    return i >= 0 && rest[i + 1] !== undefined ? rest[i + 1] : undefined;
  };
  const kind = opt("--kind") || "worker";
  const worstUsd = opt("--worst-usd");
  if (cmd === "release") {
    const file = opt("--file");
    let id = opt("--id");
    if (!id && file) {
      try {
        id = readFileSync(file, "utf8").trim();
      } catch {
        id = "";
      }
    }
    const done = releaseReservation({ id, reason: opt("--reason") });
    if (done && file) rmSync(file, { force: true });
    process.exit(done ? 0 : 1);
  }
  if (cmd !== "check" && cmd !== "reserve") {
    process.stderr.write(
      "usage: budget-admission.mjs check|reserve [--kind <launcher>] [--worst-usd <n>] [--ticket <n>] [--pid <n>] [--out <file>]\n" +
        "       budget-admission.mjs release (--id <id> | --file <file>) [--reason <text>]\n",
    );
    process.exit(2);
  }
  const d =
    cmd === "reserve"
      ? reservePaidLaunch({
          kind,
          worstUsd,
          ticket: opt("--ticket"),
          pid: opt("--pid"),
          remember: false,
        })
      : paidLaunchAdmission({ kind, worstUsd });
  const out = opt("--out");
  if (d.ok && d.reservation && out) {
    try {
      writeFileSync(out, d.reservation.id + "\n");
    } catch (e) {
      // The caller could never settle it: give it back and refuse (fail closed).
      releaseReservation({
        id: d.reservation.id,
        reason: "the reservation id could not be handed to the launcher",
      });
      process.stderr.write(
        `gaffer: budget: could not write ${out} (${e?.code ?? e}) — refusing the paid ${kind} launch\n`,
      );
      process.exit(3);
    }
  }
  process.stdout.write(JSON.stringify(d) + "\n");
  if (!d.ok) process.stderr.write(`gaffer: budget: ${d.reason}\n`);
  process.exit(d.ok ? 0 : 3);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  main(process.argv.slice(2));

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
//     and timed-out calls count);
//   • the ledger is the file the writer appends to (lib/usage-ledger-path.mjs, shared);
//   • FAIL CLOSED: with a cap set, a ledger that exists but cannot be read, or holds a
//     line that is not a JSON object, is an UNKNOWN spend and refuses the launch; so
//     is a ledger that is turned off or has no location (nothing would be booked).
// Caps come from the environment (the operator's env, or what factory.config.sh
// exported from settings.json); a Node launcher spawned by the dashboard's API has no
// such env, so settings.json ($GAFFER_DATA/settings.json) is read as the fallback. A
// settings.json that exists but does not parse refuses (the caps are unknowable).
//
// CLI: node lib/budget-admission.mjs check [--kind <launcher>]
//      → one JSON line { ok, kind, reason, daily, lifetime }; exit 0 admitted · 3 refused
// =====================================================================
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ledgerDisabled, resolveLedgerPath } from "./usage-ledger-path.mjs";

export const BUDGET_REFUSED_STATUS = 77;

/** The one-line fix, word for word lib/budget.sh gaffer_spend_cap_hint. */
export const SPEND_CAP_HINT =
  "no dollar cap is set: set GAFFER_DAILY_BUDGET_USD (try 5) or GAFFER_BUDGET_USD in your environment or the dashboard's Settings → Budget & caps; GAFFER_ALLOW_UNCAPPED=1 runs without one";

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
  if (!existsSync(p)) return { today: 0, lifetime: 0 }; // nothing spent yet
  let text;
  try {
    text = readFileSync(p, "utf8");
  } catch (e) {
    return { unknown: `the usage ledger ${p} cannot be read (${e?.code ?? e})` };
  }
  const day = now.toISOString().slice(0, 10);
  let today = 0;
  let lifetime = 0;
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
    if (typeof r.ts === "string" && r.ts.slice(0, 10) === day) today += c;
  }
  return { today, lifetime };
}

/**
 * May a paid worker launch start now? `{ ok, kind, reason, daily, lifetime }`. DRY runs
 * never reach a launch, so no DRY_RUN exemption lives here.
 */
export function paidLaunchAdmission({ kind = "worker", env = process.env, now = new Date() } = {}) {
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
  const daily = caps.daily === null ? null : { cap: caps.daily, spent: spend.today };
  const lifetime = caps.lifetime === null ? null : { cap: caps.lifetime, spent: spend.lifetime };
  if (daily && !(daily.spent < daily.cap))
    return {
      ok: false,
      kind,
      reason: `the daily budget is exhausted (GAFFER_DAILY_BUDGET_USD=${daily.cap}, spent $${daily.spent.toFixed(4)} today) — the paid ${kind} launch was not started`,
      daily,
      lifetime,
    };
  if (lifetime && !(lifetime.spent < lifetime.cap))
    return {
      ok: false,
      kind,
      reason: `the lifetime budget is exhausted (GAFFER_BUDGET_USD=${lifetime.cap}, spent $${lifetime.spent.toFixed(4)}) — the paid ${kind} launch was not started`,
      daily,
      lifetime,
    };
  return { ok: true, kind, reason: "within budget", daily, lifetime };
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd !== "check") {
    process.stderr.write("usage: budget-admission.mjs check [--kind <launcher>]\n");
    process.exit(2);
  }
  const i = rest.indexOf("--kind");
  const kind = i >= 0 && rest[i + 1] ? rest[i + 1] : "worker";
  const d = paidLaunchAdmission({ kind });
  process.stdout.write(JSON.stringify(d) + "\n");
  if (!d.ok) process.stderr.write(`gaffer: budget: ${d.reason}\n`);
  process.exit(d.ok ? 0 : 3);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  main(process.argv.slice(2));

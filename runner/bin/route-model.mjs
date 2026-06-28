#!/usr/bin/env node
// Gaffer factory — intelligent, data-driven MODEL ROUTER (audit item I1).
//
// PRINCIPLE: the routing decision is made HERE, in deterministic code, from a
// config-driven registry — NOT by an agent. A pure function maps a routing
// context (phase, risk, AC count, stack, attempt, budget) to a concrete model
// id, and every decision is auditable. The cheapest-correct tier wins; we only
// pay for a stronger model when risk, complexity, or a prior failure demands it.
//
// Adding a model/provider or changing a tier is a CONFIG edit (model-registry.json
// or the GAFFER_MODEL_* env seams) — never a code change here. This file encodes
// the ROUTING POLICY (the rules); the registry encodes the menu (the models).
//
// Zero runtime dependencies — reads the JSON registry by hand so the factory
// never needs an install to route. Used by tick.sh per phase.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The in-tree registry shipped beside the runner. Override via GAFFER_MODEL_REGISTRY. */
export const DEFAULT_REGISTRY_PATH = resolve(HERE, "..", "model-registry.json");

/**
 * A safe built-in registry used ONLY when the JSON file is missing/unreadable —
 * the router must NEVER crash a tick over a registry problem. Mirrors the shipped
 * model-registry.json defaults so behaviour degrades to sane, not to a throw.
 */
export const FALLBACK_REGISTRY = Object.freeze({
  tiers: { cheap: "haiku", mid: "sonnet", strong: "opus" },
  escalationOrder: ["cheap", "mid", "strong"],
  phaseDefaults: {
    decompose: "strong",
    plan: "strong",
    implement: "mid",
    test: "mid",
    "self-review": "mid",
    "merge-conflict-resolve": "strong",
    onboarding: "cheap",
  },
  localSeam: { enabled: false, tier: "cheap", phases: ["onboarding"] },
});

/** Risk ladder, weakest → strongest. An unknown/missing risk reads as "medium". */
const RISK_ORDER = ["low", "medium", "high", "critical"];

/** Phases where a trivial ticket may be routed down to the cheapest tier. */
const TRIVIAL_DOWNGRADE_PHASES = new Set(["implement", "test"]);

/**
 * Complexity thresholds. An AC count at/above HIGH_AC pushes a ticket toward a
 * stronger tier; a ticket with TRIVIAL_AC-or-fewer ACs at low risk is a downgrade
 * candidate. Named constants — no magic numbers.
 */
const HIGH_AC = 5;
const TRIVIAL_AC = 1;

/** Load + validate the registry. A bad file falls back; it never throws. */
export function loadRegistry(
  registryPath = process.env.GAFFER_MODEL_REGISTRY || DEFAULT_REGISTRY_PATH,
) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(registryPath, "utf8"));
  } catch {
    return { ...FALLBACK_REGISTRY };
  }
  return normaliseRegistry(raw);
}

/**
 * Normalise a parsed registry into the shape the router relies on, filling any
 * missing piece from the fallback so a partial/edited file can never crash the
 * router (e.g. a tier added but escalationOrder forgotten).
 */
export function normaliseRegistry(raw) {
  const reg = raw && typeof raw === "object" ? raw : {};
  const tiers =
    reg.tiers && typeof reg.tiers === "object" && Object.keys(reg.tiers).length > 0
      ? { ...reg.tiers }
      : { ...FALLBACK_REGISTRY.tiers };
  // Keep only escalation entries that name a real tier, in declared order.
  const order = (
    Array.isArray(reg.escalationOrder) ? reg.escalationOrder : FALLBACK_REGISTRY.escalationOrder
  ).filter((t) => typeof t === "string" && Object.prototype.hasOwnProperty.call(tiers, t));
  const escalationOrder = order.length > 0 ? order : Object.keys(tiers);
  const phaseDefaults = {
    ...FALLBACK_REGISTRY.phaseDefaults,
    ...(reg.phaseDefaults && typeof reg.phaseDefaults === "object" ? reg.phaseDefaults : {}),
  };
  const localSeam = {
    ...FALLBACK_REGISTRY.localSeam,
    ...(reg.localSeam && typeof reg.localSeam === "object" ? reg.localSeam : {}),
  };
  return { tiers, escalationOrder, phaseDefaults, localSeam };
}

/** Clamp an index into the escalation order so we never run off either end. */
function clampIndex(idx, order) {
  if (idx < 0) return 0;
  if (idx >= order.length) return order.length - 1;
  return idx;
}

/** The escalation-order index of a tier, or -1 if it isn't in the order. */
function tierIndex(tier, order) {
  return order.indexOf(tier);
}

/**
 * Pure routing decision. Inputs describe the work; output is the chosen tier +
 * concrete model + the audit trail (why this tier). NEVER throws — an unknown or
 * missing input falls back to a safe default so a malformed context can't crash
 * the tick.
 *
 * @param {object} ctx
 * @param {string} ctx.phase        decompose|plan|implement|test|self-review|merge-conflict-resolve|onboarding
 * @param {string} [ctx.risk]       low|medium|high|critical (default medium)
 * @param {number} [ctx.acCount]    acceptance-criteria count (default 0)
 * @param {string} [ctx.stack]      repo stack label — plumbed through; no rule keys on it yet
 * @param {number} [ctx.attempt]    delivery attempt (1 = first; >1 = a prior rejection → escalate)
 * @param {number} [ctx.budgetRemaining]  budget seam; undefined/<0 = unlimited (H1 not built)
 * @param {object} [registry]       a loaded/normalised registry (defaults to loadRegistry())
 * @returns {{model:string, tier:string, planDebate:boolean, reasons:string[], inputs:object}}
 */
export function routeModel(ctx = {}, registry = loadRegistry()) {
  const reg = registry && registry.tiers ? registry : normaliseRegistry(registry);
  const order = reg.escalationOrder;
  const reasons = [];

  const phase = typeof ctx.phase === "string" && ctx.phase ? ctx.phase : "implement";
  const risk = RISK_ORDER.includes(ctx.risk) ? ctx.risk : "medium";
  const acCount = Number.isFinite(ctx.acCount) && ctx.acCount > 0 ? Math.floor(ctx.acCount) : 0;
  const stack = typeof ctx.stack === "string" ? ctx.stack : "";
  const attempt = Number.isFinite(ctx.attempt) && ctx.attempt > 0 ? Math.floor(ctx.attempt) : 1;
  const budgetRemaining =
    Number.isFinite(ctx.budgetRemaining) && ctx.budgetRemaining >= 0
      ? ctx.budgetRemaining
      : Infinity;

  // 1) Phase default tier (from the registry; unknown phase → mid-of-order).
  let tier = reg.phaseDefaults[phase];
  if (!tier || !Object.prototype.hasOwnProperty.call(reg.tiers, tier)) {
    tier = order[clampIndex(Math.floor((order.length - 1) / 2), order)];
    reasons.push(`phase '${phase}' has no registry default → mid tier '${tier}'`);
  } else {
    reasons.push(`phase '${phase}' default tier '${tier}'`);
  }
  let idx = clampIndex(tierIndex(tier, order), order);

  // 2) Local-model seam: the cheap idle/scan path may route to a local tier for
  //    privacy + ~zero cost. Only a config edit (localSeam.enabled) turns it on.
  if (
    reg.localSeam.enabled &&
    Array.isArray(reg.localSeam.phases) &&
    reg.localSeam.phases.includes(phase)
  ) {
    const localTier = reg.localSeam.tier;
    if (Object.prototype.hasOwnProperty.call(reg.tiers, localTier)) {
      idx = clampIndex(tierIndex(localTier, order), order);
      reasons.push(`local-model seam active for phase '${phase}' → tier '${localTier}'`);
    }
  }

  // 3) Risk / complexity. High-or-worse risk, or a large AC count, bumps UP one
  //    tier. A trivial ticket (low risk, ≤1 AC) on an implement/test phase bumps
  //    DOWN to the cheapest tier — the cheapest-correct policy.
  const riskRank = RISK_ORDER.indexOf(risk);
  const highRisk = riskRank >= RISK_ORDER.indexOf("high");
  const largeAc = acCount >= HIGH_AC;
  const trivial = riskRank <= RISK_ORDER.indexOf("low") && acCount <= TRIVIAL_AC;

  if (highRisk) {
    idx = clampIndex(idx + 1, order);
    reasons.push(`risk '${risk}' is high/critical → +1 tier`);
  }
  if (largeAc) {
    idx = clampIndex(idx + 1, order);
    reasons.push(`acCount ${acCount} ≥ ${HIGH_AC} (large) → +1 tier`);
  }
  if (trivial && TRIVIAL_DOWNGRADE_PHASES.has(phase) && !highRisk && !largeAc) {
    idx = 0;
    reasons.push(`trivial (risk '${risk}', acCount ${acCount}) on '${phase}' → cheapest tier`);
  }

  // 4) Failure-escalation ladder. A prior rejection/failure (attempt > 1) means
  //    re-running the SAME tier is the wrong move — escalate one tier per extra
  //    attempt, and enable plan-debate on plan phases. Cheap-first, escalate-on-
  //    failure is the cost-optimal policy.
  let planDebate = false;
  if (attempt > 1) {
    const bump = attempt - 1;
    idx = clampIndex(idx + bump, order);
    reasons.push(`attempt ${attempt} (prior failure) → +${bump} tier (escalation ladder)`);
    if (phase === "plan" || phase === "decompose") {
      planDebate = true;
      reasons.push(`attempt ${attempt} on '${phase}' → enable plan-debate`);
    }
  }

  // 5) Budget-aware downgrade (H1 seam). When the remaining budget is low, bias
  //    one tier CHEAPER and LOG the trade-off so the cost decision is auditable.
  //    H1 (the real budget feed) isn't built yet, so budgetRemaining is unlimited
  //    by default and this never fires in practice — the seam is wired + tested.
  const BUDGET_LOW_THRESHOLD = budgetLowThreshold();
  if (budgetRemaining < BUDGET_LOW_THRESHOLD && idx > 0) {
    idx = clampIndex(idx - 1, order);
    reasons.push(
      `budgetRemaining ${budgetRemaining} < ${BUDGET_LOW_THRESHOLD} (low) → -1 tier (cost/quality trade-off)`,
    );
  }

  // 6) Stack is plumbed through for a FUTURE stack-aware rule; today it only
  //    annotates the audit trail (skill-pack selection stays in select-skills.mjs).
  if (stack) reasons.push(`stack '${stack}' (informational; no stack rule yet)`);

  const finalTier = order[idx];
  const model = reg.tiers[finalTier];
  return {
    model,
    tier: finalTier,
    planDebate,
    reasons,
    inputs: {
      phase,
      risk,
      acCount,
      stack,
      attempt,
      // Serialise Infinity as a readable token so the JSON audit line is honest
      // (JSON.stringify turns Infinity into null, which reads as "0/unknown").
      budgetRemaining: budgetRemaining === Infinity ? "unlimited" : budgetRemaining,
    },
  };
}

/**
 * The "budget is low" threshold. Read from GAFFER_BUDGET_LOW_THRESHOLD when set;
 * default 0 means the downgrade only fires when an explicit budgetRemaining is
 * BELOW 0 — i.e. never under today's unlimited default. This keeps the seam inert
 * until H1 supplies a real budget AND an operator sets a threshold.
 */
function budgetLowThreshold() {
  const v = Number(process.env.GAFFER_BUDGET_LOW_THRESHOLD);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** Parse the runner's env-driven budget seam (H1 not built → unlimited default). */
export function budgetRemainingFromEnv(env = process.env) {
  const raw = env.GAFFER_BUDGET_REMAINING;
  if (raw === undefined || raw === "") return Infinity;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : Infinity;
}

function parseArgs(argv) {
  const opts = { phase: "implement", risk: "", acCount: 0, stack: "", attempt: 1, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[(i += 1)];
    switch (arg) {
      case "--phase":
        opts.phase = next() ?? "implement";
        break;
      case "--risk":
        opts.risk = next() ?? "";
        break;
      case "--ac-count":
        opts.acCount = Number(next() ?? 0);
        break;
      case "--stack":
        opts.stack = next() ?? "";
        break;
      case "--attempt":
        opts.attempt = Number(next() ?? 1);
        break;
      case "--budget-remaining":
        opts.budgetRemaining = Number(next() ?? "");
        break;
      case "--json":
        opts.json = true;
        break;
      default:
        break;
    }
  }
  return opts;
}

// CLI: resolve a routing decision and print it. tick.sh calls this per phase to
// pick the model + (when set) the plan-debate flag, and to emit the audit line.
//   --model-only   print just the model id (the flag value tick.sh splices in)
//   --json         print the full decision (model, tier, planDebate, reasons)
//   default        print "<tier>\t<model>\t<planDebate>" for easy shell parsing
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);
  const budgetRemaining =
    opts.budgetRemaining !== undefined ? opts.budgetRemaining : budgetRemainingFromEnv();
  const decision = routeModel(
    {
      phase: opts.phase,
      risk: opts.risk,
      acCount: opts.acCount,
      stack: opts.stack,
      attempt: opts.attempt,
      budgetRemaining,
    },
    loadRegistry(),
  );
  if (argv.includes("--model-only")) {
    process.stdout.write((decision.model ?? "") + "\n");
  } else if (opts.json) {
    process.stdout.write(JSON.stringify(decision) + "\n");
  } else {
    process.stdout.write(`${decision.tier}\t${decision.model}\t${decision.planDebate ? 1 : 0}\n`);
  }
}

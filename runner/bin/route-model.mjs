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

/** Difficulty ladder, easiest → hardest. An unknown/missing signal reads as "medium". */
export const DIFFICULTY_ORDER = ["low", "medium", "high"];

/** Phases where a trivial ticket may be routed down to the cheapest tier. */
const TRIVIAL_DOWNGRADE_PHASES = new Set(["implement", "test"]);

/**
 * Complexity thresholds. An AC count at/above HIGH_AC pushes a ticket toward a
 * stronger tier; a ticket with TRIVIAL_AC-or-fewer ACs at low risk is a downgrade
 * candidate. Named constants — no magic numbers.
 */
const HIGH_AC = 5;
const TRIVIAL_AC = 1;

/**
 * DIFFICULTY thresholds (audit item 3b). A ticket's *difficulty* is a measured,
 * pre-model signal distinct from AC count / risk: how big is the change likely to
 * be, and how costly has this area been historically. Any signal crossing its HIGH
 * mark makes the ticket "high" (route a stronger tier FROM THE START — escalation
 * is no longer only attempt-driven); a ticket whose every provided signal is at/under
 * its LOW mark is "low" (stay cheap). Named constants — no magic numbers.
 *
 *   diffBytes           — size of the (accumulated) diff in bytes (0/absent on a
 *                         first attempt, non-zero on rework once a branch has commits).
 *   fileCount           — number of files the change touches.
 *   historicalCostUsd   — measured spend already booked to this ticket's area
 *                         (repo) in the usage-ledger — a costly area is a hard area.
 */
const DIFFICULTY = Object.freeze({
  HIGH_DIFF_BYTES: 40000,
  HIGH_FILE_COUNT: 8,
  HIGH_HISTORICAL_USD: 1.5,
  LOW_DIFF_BYTES: 2000,
  LOW_FILE_COUNT: 2,
  LOW_HISTORICAL_USD: 0.15,
});

/**
 * Turn raw, MEASURED difficulty signals into a difficulty label. Pure + defensive:
 * a missing/NaN/negative signal simply doesn't vote. Returns the label plus the
 * signals that fired so the routing audit trail can explain *why* a ticket is hard.
 *
 * Policy: any signal at/over its HIGH mark ⇒ "high". Otherwise, when at least one
 * signal is present and EVERY present signal is at/under its LOW mark ⇒ "low".
 * Anything in between (or no signals at all) ⇒ "medium".
 *
 * @param {object} [signals]
 * @param {number} [signals.diffBytes]
 * @param {number} [signals.fileCount]
 * @param {number} [signals.historicalCostUsd]
 * @returns {{label:string, reasons:string[]}}
 */
export function scoreDifficulty(signals = {}) {
  const present = [];
  const highHits = [];
  const lowHits = [];
  const consider = (name, value, highMark, lowMark, unit) => {
    // A value of 0 (no diff / no files / no booked spend) is ABSENT, not "easy" — a
    // fresh ticket has no history, so it must not vote "low". Only a positive,
    // finite measurement counts as a signal.
    if (!(typeof value === "number" && Number.isFinite(value) && value > 0)) return;
    present.push(name);
    if (value >= highMark) highHits.push(`${name} ${value}${unit} ≥ ${highMark}${unit}`);
    else if (value <= lowMark) lowHits.push(`${name} ${value}${unit} ≤ ${lowMark}${unit}`);
  };
  consider(
    "diffBytes",
    signals.diffBytes,
    DIFFICULTY.HIGH_DIFF_BYTES,
    DIFFICULTY.LOW_DIFF_BYTES,
    "B",
  );
  consider(
    "fileCount",
    signals.fileCount,
    DIFFICULTY.HIGH_FILE_COUNT,
    DIFFICULTY.LOW_FILE_COUNT,
    "",
  );
  consider(
    "historicalCostUsd",
    signals.historicalCostUsd,
    DIFFICULTY.HIGH_HISTORICAL_USD,
    DIFFICULTY.LOW_HISTORICAL_USD,
    "$",
  );

  if (highHits.length > 0) {
    return { label: "high", reasons: highHits };
  }
  if (present.length > 0 && lowHits.length === present.length) {
    return { label: "low", reasons: lowHits };
  }
  return { label: "medium", reasons: [] };
}

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
 * @param {number} [ctx.budgetRemaining]  live USD headroom from the ledger; undefined/<0 = unlimited
 * @param {string} [ctx.difficulty] measured difficulty label low|medium|high (default medium) —
 *                                  a hard ticket routes stronger FROM THE START (3b)
 * @param {boolean} [ctx.cheapClass] Settings routed this CLASS of work to the cheap tier (3a) —
 *                                  biases the decision one tier cheaper (never below cheapest)
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
  const difficulty = DIFFICULTY_ORDER.includes(ctx.difficulty) ? ctx.difficulty : "medium";
  const cheapClass = ctx.cheapClass === true;
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
  const highDifficulty = difficulty === "high";
  const lowDifficulty = difficulty === "low";
  // A trivial ticket is low-risk + tiny AC; a low-difficulty ticket (small change,
  // cheap area) is also a downgrade candidate on the same phases. Either qualifies
  // for the cheapest tier, but NEVER when risk/AC/difficulty say the work is hard.
  const trivial = riskRank <= RISK_ORDER.indexOf("low") && acCount <= TRIVIAL_AC;

  if (highRisk) {
    idx = clampIndex(idx + 1, order);
    reasons.push(`risk '${risk}' is high/critical → +1 tier`);
  }
  if (largeAc) {
    idx = clampIndex(idx + 1, order);
    reasons.push(`acCount ${acCount} ≥ ${HIGH_AC} (large) → +1 tier`);
  }
  // DIFFICULTY (3b): a measured-hard ticket escalates from the START — escalation is
  // no longer only attempt-count driven. A big diff / many files / a historically
  // costly area routes one tier stronger up front so we don't burn a cheap-then-fail
  // attempt on work we already know is hard.
  if (highDifficulty) {
    idx = clampIndex(idx + 1, order);
    reasons.push(`difficulty 'high' (big diff / many files / costly area) → +1 tier`);
  }
  if (
    (trivial || lowDifficulty) &&
    TRIVIAL_DOWNGRADE_PHASES.has(phase) &&
    !highRisk &&
    !largeAc &&
    !highDifficulty
  ) {
    idx = 0;
    const why = trivial
      ? `trivial (risk '${risk}', acCount ${acCount})`
      : `difficulty 'low' (small diff / few files / cheap area)`;
    reasons.push(`${why} on '${phase}' → cheapest tier`);
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

  // 5) Budget-aware downgrade (Track 3a — now LIVE). When the remaining budget is
  //    low, bias one tier CHEAPER and LOG the trade-off so the cost decision is
  //    auditable. The real budget feed IS wired: factory.config.sh recomputes
  //    GAFFER_BUDGET_REMAINING from the usage ledger each tick and passes it in, so
  //    this fires for real once an operator sets GAFFER_BUDGET_USD (+ a low
  //    threshold). With no budget configured, budgetRemaining stays unlimited and the
  //    downgrade is inert — the default, not a stub.
  const BUDGET_LOW_THRESHOLD = budgetLowThreshold();
  if (budgetRemaining < BUDGET_LOW_THRESHOLD && idx > 0) {
    idx = clampIndex(idx - 1, order);
    reasons.push(
      `budgetRemaining ${budgetRemaining} < ${BUDGET_LOW_THRESHOLD} (low) → -1 tier (cost/quality trade-off)`,
    );
  }

  // 6) Cost-as-control class knob (3a). Settings can route a CLASS of work to the
  //    cheap tier (e.g. onboarding/self-review/test phases). When this ticket's
  //    class is flagged cheap, bias one tier CHEAPER and LOG the trade-off — but
  //    never override a high/critical-risk escalation (safety wins over thrift).
  if (cheapClass && idx > 0 && !highRisk) {
    idx = clampIndex(idx - 1, order);
    reasons.push(`Settings routed this class to cheap → -1 tier (cost bias)`);
  }

  // 7) Stack is plumbed through for a FUTURE stack-aware rule; today it only
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
      difficulty,
      cheapClass,
      // Serialise Infinity as a readable token so the JSON audit line is honest
      // (JSON.stringify turns Infinity into null, which reads as "0/unknown").
      budgetRemaining: budgetRemaining === Infinity ? "unlimited" : budgetRemaining,
    },
  };
}

/**
 * The "budget is low" threshold. Read from GAFFER_BUDGET_LOW_THRESHOLD when set;
 * default 0 means the downgrade only fires when an explicit budgetRemaining is
 * BELOW 0 — i.e. never under the unlimited default. factory.config.sh derives a real
 * threshold (a fraction of GAFFER_BUDGET_USD) once a budget is configured, so the
 * downgrade is inert only when no budget is set — not because the feed is missing.
 */
function budgetLowThreshold() {
  const v = Number(process.env.GAFFER_BUDGET_LOW_THRESHOLD);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** Parse the runner's env-driven budget seam (unset budget → unlimited default). */
export function budgetRemainingFromEnv(env = process.env) {
  const raw = env.GAFFER_BUDGET_REMAINING;
  if (raw === undefined || raw === "") return Infinity;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : Infinity;
}

function parseArgs(argv) {
  const opts = {
    phase: "implement",
    risk: "",
    acCount: 0,
    stack: "",
    attempt: 1,
    difficulty: "",
    json: false,
  };
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
      // Difficulty (3b): either an explicit label, or raw measured signals the
      // router scores itself via scoreDifficulty (diff size / files / area cost).
      case "--difficulty":
        opts.difficulty = next() ?? "";
        break;
      case "--diff-bytes":
        opts.diffBytes = Number(next() ?? "");
        break;
      case "--file-count":
        opts.fileCount = Number(next() ?? "");
        break;
      case "--historical-cost":
        opts.historicalCostUsd = Number(next() ?? "");
        break;
      // Cost-as-control (3a): Settings flagged this class of work as cheap.
      case "--cheap-class":
        opts.cheapClass = true;
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

/**
 * Resolve the CLI's difficulty input: an explicit --difficulty label wins;
 * otherwise score the raw --diff-bytes/--file-count/--historical-cost signals.
 * Returns "" when neither is supplied (→ router default 'medium').
 */
function resolveDifficulty(opts) {
  if (DIFFICULTY_ORDER.includes(opts.difficulty)) return opts.difficulty;
  const hasRaw =
    Number.isFinite(opts.diffBytes) ||
    Number.isFinite(opts.fileCount) ||
    Number.isFinite(opts.historicalCostUsd);
  if (!hasRaw) return "";
  return scoreDifficulty({
    diffBytes: opts.diffBytes,
    fileCount: opts.fileCount,
    historicalCostUsd: opts.historicalCostUsd,
  }).label;
}

/**
 * Resolve whether this CLASS of work is Settings-flagged cheap (3a). Either an
 * explicit --cheap-class flag, or the current phase appears in the operator's
 * GAFFER_CHEAP_PHASES allow-list (comma/space separated). Read from env here so the
 * pure router stays env-free and unit-testable.
 */
export function cheapClassFromEnv(phase, env = process.env) {
  const raw = env.GAFFER_CHEAP_PHASES;
  if (typeof raw !== "string" || !raw.trim()) return false;
  const phases = raw
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  return phases.includes(phase);
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
      difficulty: resolveDifficulty(opts),
      cheapClass: opts.cheapClass === true || cheapClassFromEnv(opts.phase),
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

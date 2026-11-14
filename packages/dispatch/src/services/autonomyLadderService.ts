/**
 * THE AUTONOMY LADDER: one read model of how much the factory may do on its own, for
 * every repo x risk x gate (approve, merge), and why.
 *
 * Each cell is on one rung:
 *   - `person`    a person decides (no grant, too little evidence, a step-down in force,
 *                 or the critical ceiling);
 *   - `suggested` the human review record clears the bar: a person may turn it on;
 *   - `automatic` an `auto` policy row (or the mode's env floor) lets it happen alone.
 *
 * With the evidence behind it (k of n human decisions since the window opened, the rate
 * with its Wilson interval, the threshold and the minimum sample), the distance to the
 * next rung in plain numbers ("7 of 10 decisions, 100% agreement: 3 more"), and any
 * step-down in force (when, why, what lifts it). Read-only: it decides nothing. The gate
 * (autonomyPolicyService.ts) and this read share the same ceiling and step-down rules.
 */
import { RISK_LEVELS, type RiskLevel } from "../domain/types.js";
import type { ReviewDecisionRow } from "../repositories/eventRepository.js";
import type { AutonomyMode, AutonomyPolicyView } from "../repositories/autonomyPolicyRepository.js";
import {
  AGREEMENT_THRESHOLD,
  classifyDecision,
  MIN_SAMPLES,
  UNCHANGED_THRESHOLD,
  type AutonomyGate,
  type AutonomyRecommendation,
} from "./autonomyRecommendationService.js";
import {
  AUTONOMY_CEILING_RISK,
  CEILING_MESSAGE,
  envAllowsAuto,
  priorAllowedAt,
} from "./autonomyPolicyService.js";
import { stepDownKey, type StepDownRecord, type StepDownState } from "./autonomyStepDownStore.js";

/** The two gates the ladder shows (memory is not on it). */
export const LADDER_GATES: readonly AutonomyGate[] = ["approve", "merge"];

export type Rung = "person" | "suggested" | "automatic";

/** A Wilson score interval (95%), as fractions. */
export interface Interval {
  lo: number;
  hi: number;
}

/** Wilson score interval for k of n (z = 1.96); null for n = 0. Exact 0 and 1 at the edges. */
export function wilson(k: number, n: number, z = 1.96): Interval | null {
  if (!(n > 0) || k < 0 || k > n) return null;
  const p = k / n;
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const den = 1 + z2 / n;
  const lo = k === 0 ? 0 : Math.max(0, (centre - spread) / den);
  const hi = k === n ? 1 : Math.min(1, (centre + spread) / den);
  return { lo: round4(lo), hi: round4(hi) };
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

/**
 * How many more decisions, all in favour, until k of n clears both the minimum sample and
 * the threshold: the smallest x >= 0 with n + x >= min and (k + x) / (n + x) >= threshold.
 * 0 when it already clears. Exact for the house thresholds (a small epsilon absorbs the
 * float in 0.9).
 */
export function moreNeeded(k: number, n: number, min: number, threshold: number): number {
  const eps = 1e-9;
  const clears = (x: number): boolean =>
    n + x >= min && n + x > 0 && (k + x) / (n + x) >= threshold - eps;
  if (clears(0)) return 0;
  let x = Math.max(0, min - n);
  if (threshold < 1) {
    x = Math.max(x, Math.ceil((threshold * n - k) / (1 - threshold) - eps));
  }
  while (!clears(x)) x += 1;
  return x;
}

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/** The evidence behind one cell (same-repo human decisions since the window opened). */
export interface LadderEvidence {
  /** `agreement` (approve: approved of decided) or `approved_unchanged` (merge). */
  measure: "agreement" | "approved_unchanged";
  k: number;
  n: number;
  rate: number | null;
  wilson: Interval | null;
  threshold: number;
  min_samples: number;
  /** Where the window opens: the latest step-down for this row, or null (all time). */
  since: string | null;
  /** Merge only: the approve-vs-reject agreement the merge bar also needs. */
  agreement?: { k: number; n: number; rate: number | null };
  /** True when this repo's own evidence clears the bar. */
  clears: boolean;
}

export interface LadderStepDown {
  at: string;
  trigger: StepDownRecord["trigger"];
  why: string;
  tickets: StepDownRecord["tickets"];
  by: StepDownRecord["by"];
  cascade_from: string | null;
  /** What would lift it, in plain words, and whether re-enabling is open now. */
  lift: { text: string; reenable_ready: boolean; more: number };
}

export interface LadderCell {
  gate: AutonomyGate;
  risk_level: RiskLevel;
  rung: Rung;
  /** For `automatic`: what grants it (a policy row, or the mode's env floor). */
  source: "policy" | "mode" | null;
  /** The stored policy row's mode, or null when there is none. */
  policy_mode: AutonomyMode | null;
  /** True for critical: a person always decides. */
  ceiling: boolean;
  evidence: LadderEvidence;
  /** The cross-repo prior (low and medium only, never after a step-down). */
  prior: { used: boolean; k: number | null; n: number | null };
  distance: { more: number | null; text: string };
  step_down: LadderStepDown | null;
}

export interface LadderRepo {
  repo_id: string;
  repo_name: string;
  rows: Array<{ risk_level: RiskLevel; gates: Record<AutonomyGate, LadderCell> }>;
}

export interface RecentStepDown {
  repo_id: string;
  repo_name: string;
  risk_level: string;
  gate: string;
  at: string;
  trigger: StepDownRecord["trigger"];
  why: string;
  in_force: boolean;
}

export interface AutonomyLadder {
  generated_at: string;
  rules: {
    min_samples: number;
    agreement_threshold: number;
    unchanged_threshold: number;
    ceiling_risk: string;
    ceiling_message: string;
    high_needs_same_repo_evidence: true;
    step_down_tester_fails: number;
    step_down_window_days: number;
    cascade: string;
  };
  repos: LadderRepo[];
  /** Step-downs recorded in the last 7 days on the repos shown (the Overview line). */
  recent_step_downs: RecentStepDown[];
}

export interface LadderInput {
  now: string;
  repos: ReadonlyArray<{ id: string; name: string }>;
  policies: readonly AutonomyPolicyView[];
  decisions: readonly ReviewDecisionRow[];
  recommendations: readonly AutonomyRecommendation[];
  stepDowns: ReadonlyMap<string, StepDownState>;
  env: NodeJS.ProcessEnv;
  /** False for a scoped viewer: cross-repo counts are not shown (they include other repos). */
  showCrossRepoCounts: boolean;
  stepDownTesterFails: number;
  stepDownWindowDays: number;
}

const RECENT_MS = 7 * 86_400_000;

interface Tally {
  approvals: number;
  rejections: number;
  unchanged: number;
  unchangedKnown: number;
}

function tally(
  decisions: readonly ReviewDecisionRow[],
  repoId: string,
  risk: string,
  since: string | null,
): Tally {
  const t: Tally = { approvals: 0, rejections: 0, unchanged: 0, unchangedKnown: 0 };
  for (const row of decisions) {
    if (row.repoId !== repoId || row.riskLevel !== risk) continue;
    if (row.actorType !== "human" && row.actorType !== "admin") continue;
    if (since !== null && (row.at === undefined || row.at <= since)) continue;
    const outcome = classifyDecision(row);
    if (outcome === "approved") {
      t.approvals += 1;
      if (row.approvedUnchanged !== null) {
        t.unchangedKnown += 1;
        if (row.approvedUnchanged) t.unchanged += 1;
      }
    } else if (outcome === "rejected") {
      t.rejections += 1;
    }
  }
  return t;
}

function rateOf(k: number, n: number): number | null {
  return n > 0 ? round4(k / n) : null;
}

function evidenceFor(gate: AutonomyGate, t: Tally, since: string | null): LadderEvidence {
  const decided = t.approvals + t.rejections;
  const agreeClears =
    decided >= MIN_SAMPLES && t.approvals / Math.max(1, decided) >= AGREEMENT_THRESHOLD;
  if (gate === "approve") {
    return {
      measure: "agreement",
      k: t.approvals,
      n: decided,
      rate: rateOf(t.approvals, decided),
      wilson: wilson(t.approvals, decided),
      threshold: AGREEMENT_THRESHOLD,
      min_samples: MIN_SAMPLES,
      since,
      clears: agreeClears,
    };
  }
  const unchangedClears =
    t.unchangedKnown >= MIN_SAMPLES &&
    t.unchanged / Math.max(1, t.unchangedKnown) >= UNCHANGED_THRESHOLD;
  return {
    measure: "approved_unchanged",
    k: t.unchanged,
    n: t.unchangedKnown,
    rate: rateOf(t.unchanged, t.unchangedKnown),
    wilson: wilson(t.unchanged, t.unchangedKnown),
    threshold: UNCHANGED_THRESHOLD,
    min_samples: MIN_SAMPLES,
    since,
    agreement: { k: t.approvals, n: decided, rate: rateOf(t.approvals, decided) },
    clears: agreeClears && unchangedClears,
  };
}

/** More decisions needed (all in favour) for this evidence to clear its bar. */
function evidenceMore(e: LadderEvidence): number {
  const main = moreNeeded(e.k, e.n, e.min_samples, e.threshold);
  if (!e.agreement) return main;
  // Every approved-unchanged decision is also an approval, so both counts move together.
  return Math.max(main, moreNeeded(e.agreement.k, e.agreement.n, MIN_SAMPLES, AGREEMENT_THRESHOLD));
}

/** "7 of 10 decisions, 100% agreement: 3 more" (or the merge wording). */
export function distanceText(e: LadderEvidence, more: number): string {
  const noun = e.measure === "agreement" ? "decisions" : "approvals with a known edit record";
  const what = e.measure === "agreement" ? "agreement" : "approved unchanged";
  const count = e.n < e.min_samples ? `${e.n} of ${e.min_samples} ${noun}` : `${e.n} ${noun}`;
  const rate = e.rate === null ? "" : `, ${pct(e.rate)} ${what}`;
  let tail = `${more} more`;
  if (e.agreement && e.agreement.n > 0) {
    const agreeMore = moreNeeded(e.agreement.k, e.agreement.n, MIN_SAMPLES, AGREEMENT_THRESHOLD);
    if (agreeMore > moreNeeded(e.k, e.n, e.min_samples, e.threshold)) {
      tail += ` (review agreement is ${pct(e.agreement.rate ?? 0)} of ${e.agreement.n})`;
    }
  }
  return `${count}${rate}: ${tail}`;
}

function liftText(e: LadderEvidence, more: number): string {
  if (more === 0) {
    return "The evidence since the step-down clears the bar again: a person can re-enable it, or override it with a reason.";
  }
  return `A person re-enables it once the evidence since the step-down clears the bar (${distanceText(e, more)}), or overrides it with a reason.`;
}

/** The ladder for the given repos (the caller has already applied the viewer's scope). */
export function computeLadder(input: LadderInput): AutonomyLadder {
  const policyOf = new Map<string, AutonomyPolicyView>();
  for (const p of input.policies) policyOf.set(stepDownKey(p.repo_id, p.risk_level, p.gate), p);
  const priors = new Map<string, AutonomyRecommendation>();
  for (const r of input.recommendations) {
    if (r.repoId === "*") priors.set(`${r.riskLevel}\u0000${r.gate}`, r);
  }
  const repos: LadderRepo[] = [];
  for (const repo of input.repos) {
    const rows: LadderRepo["rows"] = [];
    for (const risk of RISK_LEVELS) {
      const gates = {} as Record<AutonomyGate, LadderCell>;
      for (const gate of LADDER_GATES) {
        const key = stepDownKey(repo.id, risk, gate);
        const sd = input.stepDowns.get(key);
        const since = sd?.lastStepDown?.at ?? null;
        const evidence = evidenceFor(gate, tally(input.decisions, repo.id, risk, since), since);
        const more = evidenceMore(evidence);
        const policy = policyOf.get(key) ?? null;
        const ceiling = risk === AUTONOMY_CEILING_RISK;
        const inForce = sd?.inForce ?? null;
        // The cross-repo prior: low and medium only, and never for a row that has stepped
        // down (the restart drops the evidence before it; the prior still holds it).
        const prior = priors.get(`${risk}\u0000${gate}`);
        const priorUsed = !ceiling && priorAllowedAt(risk) && !sd?.lastStepDown && !!prior;
        let rung: Rung = "person";
        let source: LadderCell["source"] = null;
        if (!ceiling && !inForce) {
          if (policy?.mode === "auto") {
            rung = "automatic";
            source = "policy";
          } else if (envAllowsAuto(gate, input.env)) {
            rung = "automatic";
            source = "mode";
          } else if (evidence.clears || priorUsed) {
            rung = "suggested";
          }
        }
        let distance: LadderCell["distance"];
        if (ceiling) distance = { more: null, text: CEILING_MESSAGE };
        else if (inForce) {
          distance = {
            more,
            text:
              more === 0
                ? "Stepped down: the evidence since then clears the bar, a person can re-enable it."
                : `Stepped down: ${distanceText(evidence, more)} to re-enable.`,
          };
        } else if (rung === "automatic") {
          distance = {
            more: 0,
            text:
              source === "mode"
                ? "Automatic: the autonomy mode allows it for every repo."
                : "Automatic: the top rung.",
          };
        } else if (rung === "suggested") {
          distance = {
            more: 0,
            text: evidence.clears
              ? "Clears the bar: a person can turn it on."
              : "Suggested from the record across all repos: a person can turn it on.",
          };
        } else {
          distance = { more, text: distanceText(evidence, more) };
        }
        gates[gate] = {
          gate,
          risk_level: risk,
          rung,
          source,
          policy_mode: policy?.mode ?? null,
          ceiling,
          evidence,
          prior: {
            used: priorUsed,
            k: priorUsed && input.showCrossRepoCounts && prior ? priorK(prior, gate) : null,
            n: priorUsed && input.showCrossRepoCounts && prior ? priorN(prior, gate) : null,
          },
          distance,
          step_down: inForce
            ? {
                at: inForce.at,
                trigger: inForce.trigger,
                why: inForce.why,
                tickets: inForce.tickets,
                by: inForce.by,
                cascade_from: inForce.cascadeFrom,
                lift: {
                  text: ceiling ? CEILING_MESSAGE : liftText(evidence, more),
                  reenable_ready: !ceiling && more === 0,
                  more,
                },
              }
            : null,
        };
      }
      rows.push({ risk_level: risk, gates });
    }
    repos.push({ repo_id: repo.id, repo_name: repo.name, rows });
  }
  const nowMs = Date.parse(input.now);
  const recent: RecentStepDown[] = [];
  const names = new Map(input.repos.map((r) => [r.id, r.name]));
  for (const state of input.stepDowns.values()) {
    const sd = state.lastStepDown;
    if (!sd || !names.has(sd.repoId)) continue;
    const at = Date.parse(sd.at);
    if (!Number.isFinite(at) || !(nowMs - at <= RECENT_MS)) continue;
    recent.push({
      repo_id: sd.repoId,
      repo_name: names.get(sd.repoId) ?? sd.repoId,
      risk_level: sd.riskLevel,
      gate: sd.gate,
      at: sd.at,
      trigger: sd.trigger,
      why: sd.why,
      in_force: state.inForce?.eventId === sd.eventId,
    });
  }
  recent.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return {
    generated_at: input.now,
    rules: {
      min_samples: MIN_SAMPLES,
      agreement_threshold: AGREEMENT_THRESHOLD,
      unchanged_threshold: UNCHANGED_THRESHOLD,
      ceiling_risk: AUTONOMY_CEILING_RISK,
      ceiling_message: CEILING_MESSAGE,
      high_needs_same_repo_evidence: true,
      step_down_tester_fails: input.stepDownTesterFails,
      step_down_window_days: input.stepDownWindowDays,
      cascade:
        "a merge step-down at one risk also steps down merge at every higher risk in the repo",
    },
    repos,
    recent_step_downs: recent,
  };
}

function priorK(rec: AutonomyRecommendation, gate: AutonomyGate): number {
  return gate === "approve" ? rec.sample.approvals : rec.sample.unchanged;
}

function priorN(rec: AutonomyRecommendation, gate: AutonomyGate): number {
  return gate === "approve" ? rec.sample.total : rec.sample.unchangedKnown;
}

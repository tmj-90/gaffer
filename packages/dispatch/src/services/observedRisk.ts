/**
 * OBSERVED-vs-DECLARED risk for the AUTO-SHIP gate (Trust & Autonomy, security-critical).
 *
 * The agent-declared `risk_level` label is a claim the agent (or a prompt-injected /
 * optimistically-labelled ticket) makes about its own change. When an autonomy flag
 * lets an agent auto-approve+merge WITHOUT a human, gating on that self-reported label
 * is unsafe: a ticket can carry `risk_level=low` while its real diff touches sensitive
 * paths, changes dependencies, deletes a lot, or spans many files/lines.
 *
 * This module derives an OBSERVED risk level from the REAL server-computed diff — it
 * reuses the existing advisory risk-annotation overlay ({@link RiskAnnotation}, computed
 * in diffService.ts from `git diff --numstat`) plus a pure size→level mapping over the
 * already-present file/line counts. NO new evidence source, NO heavyweight model, NO I/O.
 *
 * The gate compares observed vs declared and ESCALATES (holds for a human) when observed
 * exceeds declared (or crosses a configured hard ceiling). It can ONLY make the auto path
 * more conservative — it never grants an approval, and the manual human gate is untouched.
 *
 * Pure + deterministic + env-injectable, mirroring riskAnnotations.ts style.
 */

import { type RiskLevel, riskRank } from "../domain/types.js";
import type { RepoDiff } from "./diffService.js";

export interface ObservedRisk {
  /** Aggregated observed level from the real diff. Maxes at "high" (never "critical"). */
  level: RiskLevel;
  /**
   * False when the diff could not be honestly observed for EVERY write repo (no write
   * repo, or any repo's diff came back `unavailable`). The gate fails toward a human when
   * the observation is indeterminate.
   */
  determinate: boolean;
  /** Human-readable reasons recorded on the escalation event. */
  reasons: string[];
  /** Total files changed across write repos (from --numstat). */
  files: number;
  /** Total lines changed (additions + deletions) across write repos. */
  lines: number;
}

/** Parse a positive-int env knob, falling back to `fallback` when absent/invalid. */
function intEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const n = Number.parseInt(env[key] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Size thresholds (env-overridable). Defaults tuned with PM; match DISPATCH_* naming. */
function sizeThresholds(env: NodeJS.ProcessEnv): {
  filesMed: number;
  filesHigh: number;
  linesMed: number;
  linesHigh: number;
} {
  return {
    filesMed: intEnv(env, "DISPATCH_OBSERVED_RISK_FILES_MEDIUM", 10),
    filesHigh: intEnv(env, "DISPATCH_OBSERVED_RISK_FILES_HIGH", 25),
    linesMed: intEnv(env, "DISPATCH_OBSERVED_RISK_LINES_MEDIUM", 200),
    linesHigh: intEnv(env, "DISPATCH_OBSERVED_RISK_LINES_HIGH", 600),
  };
}

/** Take the riskier of two levels. */
function maxLevel(a: RiskLevel, b: RiskLevel): RiskLevel {
  return riskRank(b) > riskRank(a) ? b : a;
}

/**
 * Aggregate an OBSERVED risk level from the real diff of a ticket's WRITE repos.
 *
 * Signals (all from data diffService already computed — no new evidence source):
 *  - risk annotations: a `sensitive-path` flag ⇒ high; `dependency-change` /
 *    `large-deletion` ⇒ medium (directly reuses the advisory overlay).
 *  - size: total files ≥ FILES_HIGH or lines ≥ LINES_HIGH ⇒ high; ≥ *_MEDIUM ⇒ medium.
 *
 * `determinate` is false when there are no write repos or ANY write repo's diff was
 * `unavailable` (no branch, not on disk, git error, empty) — the observation cannot be
 * trusted, so the gate should fail toward a human.
 */
export function observedRisk(
  repos: readonly RepoDiff[],
  env: NodeJS.ProcessEnv = process.env,
): ObservedRisk {
  const t = sizeThresholds(env);
  const reasons: string[] = [];
  let level: RiskLevel = "low";
  let files = 0;
  let lines = 0;

  for (const repo of repos) {
    files += repo.files;
    lines += repo.additions + repo.deletions;
    for (const ann of repo.riskAnnotations) {
      if (ann.kind === "sensitive-path") {
        level = maxLevel(level, "high");
        reasons.push(`${repo.repo}: ${ann.detail}`);
      } else {
        level = maxLevel(level, "medium");
        reasons.push(`${repo.repo}: ${ann.detail}`);
      }
    }
  }

  if (files >= t.filesHigh || lines >= t.linesHigh) {
    level = maxLevel(level, "high");
    reasons.push(`large change (${files} files, ${lines} lines)`);
  } else if (files >= t.filesMed || lines >= t.linesMed) {
    level = maxLevel(level, "medium");
    reasons.push(`sizeable change (${files} files, ${lines} lines)`);
  }

  const determinate = repos.length > 0 && repos.every((r) => !r.unavailable);
  if (!determinate) {
    reasons.push(
      repos.length === 0
        ? "no write-repo diff available to observe"
        : "diff unavailable for at least one write repo",
    );
  }

  return { level, determinate, reasons, files, lines };
}

/**
 * Optional HARD ceiling from `DISPATCH_OBSERVED_RISK_CEILING` (a RiskLevel; empty = off).
 * When set, an observed level at/above the ceiling escalates regardless of the declared
 * label. Returns null when unset or malformed (⇒ ceiling inactive; parity preserved).
 */
export function observedRiskCeiling(env: NodeJS.ProcessEnv = process.env): RiskLevel | null {
  const raw = (env.DISPATCH_OBSERVED_RISK_CEILING ?? "").trim().toLowerCase();
  if (raw === "low" || raw === "medium" || raw === "high" || raw === "critical") {
    return raw;
  }
  return null;
}

/**
 * The pure escalation predicate. ESCALATE (hold for a human) iff:
 *   - the observation is indeterminate (fail toward human), OR
 *   - observed level > declared level (the under-declaration this gate exists to catch), OR
 *   - a hard ceiling is configured and observed >= that ceiling.
 *
 * When observed ≤ declared and no ceiling trips, this returns false and the ticket
 * auto-ships exactly as before — an honestly-declared high/critical ticket ships per the
 * operator's explicit autonomy policy; only a LIE (declared low, observed high) is caught.
 */
export function shouldEscalate(
  observed: ObservedRisk,
  declared: RiskLevel,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!observed.determinate) return true;
  if (riskRank(observed.level) > riskRank(declared)) return true;
  const ceiling = observedRiskCeiling(env);
  if (ceiling && riskRank(observed.level) >= riskRank(ceiling)) return true;
  return false;
}

import { checkBranchPolicy } from "./branchPolicy.js";
import type { GitPolicy } from "./policySchema.js";

/**
 * Delivery post-conditions: verifiable end-of-delivery checks that prove a
 * required step actually happened, rather than trusting that the agent ran it.
 *
 * Skill use in v1 is prompt-driven — the agent is *asked* to branch correctly,
 * run tests, evidence each AC and keep lint clean. This module re-derives those
 * facts from the delivery itself (branch name, recorded evidence, AC coverage)
 * so a skipped step is flagged/blocked at the boundary instead of slipping
 * through review. It is a pure checker: it reports, it never mutates state.
 */

/** One post-condition verdict for a delivery. */
export interface PostConditionCheck {
  /** Stable machine-readable id, e.g. "branch.prefix". */
  readonly id: string;
  /** Human-readable name. */
  readonly name: string;
  /** Whether this check must pass for the delivery to proceed. */
  readonly required: boolean;
  /** Whether the check is satisfied by the delivery's own evidence. */
  readonly satisfied: boolean;
  /** Always explains the verdict, for the event log and CLI. */
  readonly reason: string;
}

/**
 * The outcome of verifying every enabled post-condition. `passed` is false when
 * any *required* check is unsatisfied — that is the signal to block the delivery.
 */
export interface PostConditionReport {
  readonly passed: boolean;
  readonly checks: readonly PostConditionCheck[];
  /** The required checks that failed (empty when `passed`). */
  readonly failures: readonly PostConditionCheck[];
}

/** Minimal evidence shape the checker inspects — its AC link and type. */
export interface DeliveryEvidence {
  readonly acId?: string | undefined;
  readonly evidenceType: string;
}

/** Minimal acceptance-criterion shape the checker needs to confirm coverage. */
export interface DeliveryAcceptanceCriterion {
  readonly id: string;
  readonly text: string;
}

/** Which post-conditions to enforce for this delivery. */
export interface PostConditionRequirements {
  readonly branchPrefix: boolean;
  readonly testEvidence: boolean;
  readonly acEvidence: boolean;
  readonly lintClean: boolean;
}

/** Everything the checker needs to verify a delivery — facts, not trust. */
export interface DeliveryFacts {
  readonly branch: string;
  readonly ticketNumber: number;
  readonly gitPolicy: GitPolicy;
  readonly acceptanceCriteria: readonly DeliveryAcceptanceCriterion[];
  readonly evidence: readonly DeliveryEvidence[];
  /** True when the repo has a lint command, so lint evidence is expected. */
  readonly lintConfigured: boolean;
  readonly requirements: PostConditionRequirements;
}

/** True for evidence that demonstrates the test suite was actually executed. */
export function isTestEvidence(evidenceType: string): boolean {
  return /test/i.test(evidenceType);
}

/** True for evidence that demonstrates the linter was run / is clean. */
export function isLintEvidence(evidenceType: string): boolean {
  return /lint/i.test(evidenceType);
}

function check(
  id: string,
  name: string,
  required: boolean,
  satisfied: boolean,
  reason: string,
): PostConditionCheck {
  return { id, name, required, satisfied, reason };
}

/**
 * Verify the enabled post-conditions against the delivery's own facts. Returns a
 * report whose `passed` flag is false if any required check is unsatisfied.
 */
export function checkPostConditions(facts: DeliveryFacts): PostConditionReport {
  const checks: PostConditionCheck[] = [];
  const req = facts.requirements;

  if (req.branchPrefix) {
    const decision = checkBranchPolicy(facts.branch, facts.gitPolicy);
    const ticketToken = `ticket-${facts.ticketNumber}`;
    const referencesTicket = facts.branch.includes(ticketToken);
    const satisfied = decision.allowed && referencesTicket;
    const reason = !decision.allowed
      ? decision.reason
      : referencesTicket
        ? `Branch '${facts.branch}' carries the required prefix and references the ticket.`
        : `Branch '${facts.branch}' does not reference the ticket (expected to contain '${ticketToken}').`;
    checks.push(
      check(
        "branch.prefix",
        "Branch matches the required prefix and ticket",
        true,
        satisfied,
        reason,
      ),
    );
  }

  if (req.testEvidence) {
    const satisfied = facts.evidence.some((e) => isTestEvidence(e.evidenceType));
    checks.push(
      check(
        "tests.evidence",
        "Tests were actually run (test evidence present)",
        true,
        satisfied,
        satisfied
          ? "Test-run evidence is present on the delivery."
          : "No test-run evidence was recorded for this delivery.",
      ),
    );
  }

  if (req.acEvidence) {
    const uncovered = facts.acceptanceCriteria.filter(
      (ac) => !facts.evidence.some((e) => e.acId === ac.id),
    );
    const satisfied = uncovered.length === 0;
    checks.push(
      check(
        "ac.evidence",
        "Every acceptance criterion has evidence",
        true,
        satisfied,
        satisfied
          ? "Every acceptance criterion has at least one evidence item."
          : `${uncovered.length} acceptance criterion(s) have no recorded evidence.`,
      ),
    );
  }

  if (req.lintClean) {
    if (!facts.lintConfigured) {
      // Not applicable: a repo with no lint command can't produce lint evidence.
      checks.push(
        check(
          "lint.clean",
          "Lint is clean (lint evidence present)",
          false,
          true,
          "No lint command is configured for the repo; lint post-condition not applicable.",
        ),
      );
    } else {
      const satisfied = facts.evidence.some((e) => isLintEvidence(e.evidenceType));
      checks.push(
        check(
          "lint.clean",
          "Lint is clean (lint evidence present)",
          true,
          satisfied,
          satisfied
            ? "Lint evidence is present on the delivery."
            : "Repo has a lint command but no lint evidence was recorded.",
        ),
      );
    }
  }

  const failures = checks.filter((c) => c.required && !c.satisfied);
  return { passed: failures.length === 0, checks, failures };
}

/** A one-line, human-readable summary of the failed required post-conditions. */
export function summarisePostConditionFailures(report: PostConditionReport): string {
  return report.failures.map((c) => `${c.name} — ${c.reason}`).join(" | ");
}

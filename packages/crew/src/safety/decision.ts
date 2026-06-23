/** The three-valued result every safety guard returns. */
export type SafetyOutcome = "allowed" | "needs_approval" | "denied";

/**
 * Structured guard decision. `allowed` is the boolean convenience flag,
 * `outcome` is the precise verdict, `reason` always explains the decision so the
 * CLI and event log can render it, and `approvalScope` (when set) names exactly
 * what would need approving.
 */
export interface SafetyDecision {
  readonly allowed: boolean;
  readonly outcome: SafetyOutcome;
  readonly reason: string;
  readonly approvalScope?: string;
  readonly rule?: string;
}

export function allow(reason: string, rule?: string): SafetyDecision {
  return { allowed: true, outcome: "allowed", reason, ...(rule ? { rule } : {}) };
}

export function deny(reason: string, rule?: string): SafetyDecision {
  return { allowed: false, outcome: "denied", reason, ...(rule ? { rule } : {}) };
}

export function needsApproval(
  reason: string,
  approvalScope: string,
  rule?: string,
): SafetyDecision {
  return {
    allowed: false,
    outcome: "needs_approval",
    reason,
    approvalScope,
    ...(rule ? { rule } : {}),
  };
}

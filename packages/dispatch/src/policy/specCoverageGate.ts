/**
 * Spec-coverage DoD gate — SEAM ONLY (Spec-Driven Development, Phase 3).
 *
 * The eventual policy is: "a clause with no SATISFIED acceptance criterion blocks
 * epic completion." This module is the wiring for that signal — a single, testable
 * place that reads the flag — but it is deliberately NON-ENFORCING today: nothing
 * calls it on a completion path, and it is OFF by default. Turning the flag on
 * currently changes only the advisory `gate_enabled` bit in the coverage read
 * model; it never denies a transition. Enforcement is a later phase's job.
 *
 * Kept separate (not an inline `process.env` read) so the future enforcement path
 * has one honest source of truth and the flag is unit-testable without a live env.
 */

/** Env var that will one day arm the spec-coverage DoD gate. Off unless set truthy. */
export const SPEC_COVERAGE_GATE_ENV = "GAFFER_SPEC_COVERAGE_GATE";

/**
 * Whether the (future) spec-coverage DoD gate is armed. Reads the flag only — it
 * does NOT gate anything yet. `"1"` / `"true"` / `"yes"` count as on; everything
 * else (including unset) is off, so the default posture is non-enforcing.
 */
export function isSpecCoverageGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[SPEC_COVERAGE_GATE_ENV]?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

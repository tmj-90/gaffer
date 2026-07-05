import type { AutonomyMode, AutonomyPolicyGate } from "../repositories/autonomyPolicyRepository.js";

/**
 * GRADUATED-AUTONOMY (Spec 2, Phase 3) — ENFORCEMENT DECISION (SECURITY-CRITICAL).
 *
 * This module answers ONE question at the two autonomy chokepoints (agent-approve
 * in reviewGateService, auto-merge in the API): "is `auto` permitted for this
 * (repo × risk × gate)?" It FAILS CLOSED.
 *
 * THE ABSOLUTE INVARIANT — never weaken:
 *   A stored policy is only ever an ADDITIONAL allow-path. The env flag is the sole
 *   default. So:
 *     - NO policy row for (repo,risk,gate)      → decision = env flag (today's behaviour)
 *     - a mode='off' or 'recommend' row         → decision = env flag (does NOT grant auto)
 *     - a mode='auto' row for EVERY write repo  → allow (the additional path)
 *   With no policy rows anywhere, {@link isAutonomyAllowed} reduces to exactly the
 *   pre-Phase-3 env check — the proof-of-no-regression the tests pin down.
 *
 * FAIL-CLOSED specifics:
 *   - a ticket with NO write repos never gets an auto grant (empty set ⇒ false);
 *   - a multi-write-repo ticket needs a mode='auto' row for EVERY write repo — one
 *     uncovered repo denies the whole grant (you can't half-auto a change that lands
 *     in two repos);
 *   - the risk/gate must match exactly — an `auto` row for risk=low never covers a
 *     risk=high ticket, nor an `approve` row a `merge` decision.
 */

/** The point lookup the enforcement needs — satisfied by AutonomyPolicyRepository. */
export interface PolicyLookup {
  get(repoId: string, riskLevel: string, gate: string): { mode: AutonomyMode } | undefined;
}

/**
 * Does the STORED policy grant `auto` for (risk, gate) across ALL of a ticket's
 * write repos? Pure — reads only the policy table, NEVER the environment, so the
 * caller can OR it with the env fallback and a mode='auto' row can only ever ADD an
 * allow-path. Fail-closed: an empty repo set, or any repo lacking a mode='auto' row,
 * returns false. mode='off'/'recommend' are explicitly NOT auto.
 */
export function policyGrantsAuto(
  lookup: PolicyLookup,
  repoIds: readonly string[],
  riskLevel: string,
  gate: AutonomyPolicyGate,
): boolean {
  if (repoIds.length === 0) return false; // no write repo ⇒ never auto (fail-closed).
  return repoIds.every((repoId) => lookup.get(repoId, riskLevel, gate)?.mode === "auto");
}

/** Env var that today gates whether an agent may self-approve a review. */
export const ALLOW_AGENT_APPROVE_ENV = "DISPATCH_ALLOW_AGENT_APPROVE";

/**
 * The two env flags that together form the `merge` gate's blocking floor. BOTH must be
 * "1" for the env to permit an auto-merge — the same pair the runner's AFK ship posture
 * (`autonomous`) sets, and the exact pair `graduated` leaves OFF so the policy is the
 * sole allow-path. Kept as named constants so the CLI decision surface, the runner, and
 * the mode config all name the identical floor.
 */
export const AUTO_MERGE_ENV = "AUTO_MERGE";
export const MERGE_ON_AGENT_REVIEW_ENV = "MERGE_ON_AGENT_REVIEW";

/**
 * Env var reserved for the deferred memory-auto-approve gate. Not yet wired to a
 * chokepoint (memory autonomy is a later phase); defined so the `memory` gate's
 * fallback is honest rather than magic.
 */
export const MEMORY_AUTO_APPROVE_ENV = "MEMORY_AUTO_APPROVE";

/**
 * The env fallback for a gate — the ONLY default, reproducing today's behaviour so
 * that with no matching auto policy the decision is byte-identical to pre-Phase-3:
 *
 *   - approve → `DISPATCH_ALLOW_AGENT_APPROVE === "1"` (the exact pre-Phase-3 flag).
 *   - merge   → `AUTO_MERGE === "1" && MERGE_ON_AGENT_REVIEW === "1"` — the BLOCKING
 *               default the earlier revision anticipated ("ready to become load-bearing
 *               the moment a blocking default is added"). This is the AFK env FLOOR for
 *               the merge gate: with it OFF (and no `auto` merge policy row) the runner's
 *               unattended merge is HELD, which is exactly what `graduated` needs so the
 *               per-repo/risk policy becomes the sole allow-path. `autonomous` sets both
 *               flags ⇒ the term stays true ⇒ ships as before. A mode='auto' merge policy
 *               is an ADDITIONAL allow-path (env OR policy), never a subtraction.
 *
 *               SCOPE — this floor governs the AUTONOMOUS (runner/agent) merge, NOT a
 *               human's explicit approval. A human REST/dashboard approve is the human
 *               merge gate and STILL auto-merges byte-identically: the REST approve site
 *               (api/server.ts) fires the merge for a human/admin actor regardless of
 *               this floor, so tightening the floor never regresses the human path.
 *   - memory  → `MEMORY_AUTO_APPROVE === "1"` (deferred gate; wired for completeness).
 */
export function envAllowsAuto(
  gate: AutonomyPolicyGate,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  switch (gate) {
    case "approve":
      return env[ALLOW_AGENT_APPROVE_ENV] === "1";
    case "merge":
      return env[AUTO_MERGE_ENV] === "1" && env[MERGE_ON_AGENT_REVIEW_ENV] === "1";
    case "memory":
      return env[MEMORY_AUTO_APPROVE_ENV] === "1";
  }
}

/**
 * The full enforcement decision at a chokepoint: `auto` is permitted iff the env
 * fallback allows it OR a mode='auto' policy covers every write repo. The env term
 * is FIRST and independent, so a policy can only ever ADD an allow-path — it can
 * never subtract one, and it can never turn a blocked default into a regression.
 */
export function isAutonomyAllowed(
  lookup: PolicyLookup,
  repoIds: readonly string[],
  riskLevel: string,
  gate: AutonomyPolicyGate,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return envAllowsAuto(gate, env) || policyGrantsAuto(lookup, repoIds, riskLevel, gate);
}

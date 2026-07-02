import type {
  AutonomyMode,
  AutonomyPolicyGate,
} from "../repositories/autonomyPolicyRepository.js";

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
  get(
    repoId: string,
    riskLevel: string,
    gate: string,
  ): { mode: AutonomyMode } | undefined;
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
 *   - merge   → `true`. Today the auto-merge ALWAYS fires once a ticket is approved
 *               (the mergeRunner itself still enforces DISPATCH_MERGE_CMD being
 *               configured, unchanged), so the merge chokepoint has no blocking env
 *               flag to reproduce — its default is "fire". A mode='auto' merge policy
 *               is therefore a no-op today (already permitted) but records the
 *               operator's explicit, evidence-backed intent at the chokepoint and is
 *               ready to become load-bearing the moment a blocking default is added.
 *               Critically, this keeps the merge site byte-identical (never regresses
 *               a human REST approval, which always auto-merges today).
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
      return true;
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

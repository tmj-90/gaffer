/**
 * GRADUATED AUTONOMY on the facade: the read-only ship decision the runner asks per ticket
 * and the confirmed enable/disable of a (repo x risk x gate) policy.
 */
import { type Actor, type RiskLevel, type Ticket } from "../domain/types.js";
import {
  type AutonomyPolicyGate,
  type AutonomyPolicyRow,
  type AutonomyMode,
} from "../repositories/autonomyPolicyRepository.js";
import { isAutonomyAllowed } from "./autonomyPolicyService.js";
import { DispatchError, notFound } from "../util/errors.js";
import { newId } from "../util/id.js";
import type { Dispatch } from "../core.js";
import { writeRepoIdsForTicket } from "./ticketGitService.js";

/** What these functions read from the {@link Dispatch} facade they are handed. */
export type AutonomyGateHost = Pick<
  Dispatch,
  "autonomyPolicy" | "autonomyRecommendationsList" | "clock" | "repos"
>;

/**
 * GRADUATED-AUTONOMY (Spec 2, Phase 3): the READ-ONLY ship-decision surface the AFK
 * runner consults per ticket instead of the raw AUTO_MERGE/MERGE_ON_AGENT_REVIEW flags
 * (`wg ticket auto-decision <N> --gate approve|merge`). Pure — reuses the SAME
 * {@link isAutonomyAllowed} the approve/merge chokepoints use (env floor OR an `auto`
 * policy covering this ticket's risk × EVERY write repo), so the runner adds NO policy
 * logic and can never diverge from the enforced decision. No mutation, no side effects.
 * FAIL-CLOSED by construction: an empty write-repo set ⇒ deny; any uncovered write repo
 * ⇒ deny; risk/gate match exactly. Returns the decision plus the (repo, risk) context it
 * was computed over so the runner can log WHY a ticket held.
 */
export function autonomyGateDecision(
  host: AutonomyGateHost,
  ticket: Ticket,
  gate: AutonomyPolicyGate,
): {
  gate: AutonomyPolicyGate;
  decision: "allow" | "deny";
  risk_level: string;
  write_repo_ids: string[];
} {
  const writeRepoIds = writeRepoIdsForTicket(host, ticket);
  const allowed = isAutonomyAllowed(host.autonomyPolicy, writeRepoIds, ticket.risk_level, gate);
  return {
    gate,
    decision: allowed ? "allow" : "deny",
    risk_level: ticket.risk_level,
    write_repo_ids: writeRepoIds,
  };
}

/**
 * GRADUATED-AUTONOMY (Spec 2, Phase 3): enable/disable an autonomy policy for
 * (repo × risk × gate). Enabling (mode !== 'off') is the trust-boundary action and
 * requires an EXPLICIT confirm (LOCKED posture: the operator confirms with the
 * evidence shown) — on enable we SNAPSHOT the current recommendation evidence into
 * `evidence_json` so there is an audit trail of WHY auto was granted. Reversible:
 * mode='off' clears the enablement (and re-gates via the env fallback). Idempotent
 * upsert keyed on (repo, risk, gate).
 */
export function setAutonomyPolicy(
  host: AutonomyGateHost,
  input: {
    repoId: string;
    riskLevel: RiskLevel;
    gate: AutonomyPolicyGate;
    mode: AutonomyMode;
    confirm?: boolean;
  },
  actor: Actor,
): AutonomyPolicyRow {
  const repo = host.repos.findById(input.repoId);
  if (!repo) throw notFound("repository", input.repoId);
  // Trust boundary: enabling any non-off mode demands an explicit confirmation that
  // the operator saw the evidence. Disabling (off) is always allowed (fail-safe).
  if (input.mode !== "off" && input.confirm !== true) {
    throw new DispatchError(
      "VALIDATION_ERROR",
      "Enabling an autonomy policy requires an explicit confirmation (confirm: true) that the evidence was reviewed.",
      { gate: input.gate, mode: input.mode },
    );
  }
  const now = host.clock.now();
  const actorRef = actor.id ?? actor.type;
  const enabling = input.mode !== "off";
  // Snapshot the recommendation evidence shown at enable time (audit trail). The
  // recommendation service only speaks to approve/merge; a memory gate (or a repo
  // with no live recommendation) snapshots a null recommendation, which is honest.
  let evidenceJson: string | null = null;
  if (enabling) {
    const rec =
      host
        .autonomyRecommendationsList()
        .find(
          (r) =>
            r.repoId === input.repoId &&
            r.riskLevel === input.riskLevel &&
            r.gate === (input.gate as typeof r.gate),
        ) ?? null;
    evidenceJson = JSON.stringify({
      snapshot_at: now,
      confirmed_by: actorRef,
      recommendation: rec,
    });
  }
  return host.autonomyPolicy.upsert({
    id: newId(),
    repoId: input.repoId,
    riskLevel: input.riskLevel,
    gate: input.gate,
    mode: input.mode,
    enabledBy: enabling ? actorRef : null,
    enabledAt: enabling ? now : null,
    evidenceJson,
    now,
  });
}

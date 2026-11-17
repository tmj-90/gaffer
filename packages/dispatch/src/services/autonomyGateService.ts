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
import {
  AUTONOMY_CEILING_RISK,
  CEILING_MESSAGE,
  autonomyHold,
  holdMessage,
  isAutonomyAllowed,
  type AutonomyHold,
} from "./autonomyPolicyService.js";
import { inTransaction } from "../db/connection.js";
import { writeEvent } from "../events/eventWriter.js";
import { GateKeyError } from "../events/gateSeal.js";
import {
  AUTONOMY_POLICY_CHANGED_EVENT,
  AUTONOMY_POLICY_DISABLED_EVENT,
  AUTONOMY_POLICY_ENABLED_EVENT,
  retirePolicySeal,
  sealPolicy,
} from "../events/autonomySeal.js";
import { DispatchError, notFound } from "../util/errors.js";
import { newId } from "../util/id.js";
import type { Dispatch } from "../core.js";
import { writeRepoIdsForTicket } from "./ticketGitService.js";

/** What these functions read from the {@link Dispatch} facade they are handed. */
export type AutonomyGateHost = Pick<
  Dispatch,
  | "autonomyPolicy"
  | "autonomyRecommendationsList"
  | "clock"
  | "repos"
  | "db"
  | "gateKeyring"
  | "autonomyRisk"
>;

/** A key this process may not sign with: the whole act rolls back. */
function refuseSealKey(e: unknown): never {
  if (e instanceof GateKeyError) {
    throw new DispatchError(
      "GATE_KEY_REFUSED",
      `Nothing was recorded: ${e.message}. Autonomy policies are signed with the factory key on the host (gaffer setup creates it).`,
      { reason: e.why },
    );
  }
  throw e;
}

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
  /** The risk the decision used: the signed risk, or the highest when it is not signed. */
  risk_level: string;
  /** The ticket's stored risk column. */
  stored_risk_level: string;
  /** SEALED AUTONOMY: the stored risk carries a valid seal. */
  risk_signed: boolean;
  write_repo_ids: string[];
  /** THE AUTONOMY LADDER: why a person decides whatever the floor or a row says, or null. */
  held: { kind: AutonomyHold["kind"]; repo_id: string | null; message: string } | null;
} {
  const writeRepoIds = writeRepoIdsForTicket(host, ticket);
  // SEALED AUTONOMY: the risk the decision uses is the SIGNED one; an unsigned risk reads as
  // the highest (the ceiling: a person decides), never as the stored column.
  const risk = host.autonomyRisk(ticket);
  const allowed = isAutonomyAllowed(host.autonomyPolicy, writeRepoIds, risk.level, gate);
  const hold: AutonomyHold | null = risk.signed
    ? autonomyHold(host.autonomyPolicy, writeRepoIds, risk.level, gate)
    : gate === "memory"
      ? null
      : { kind: "risk_unsigned", repoId: null };
  return {
    gate,
    decision: allowed ? "allow" : "deny",
    risk_level: risk.level,
    stored_risk_level: risk.stored,
    risk_signed: risk.signed,
    write_repo_ids: writeRepoIds,
    held: hold ? { kind: hold.kind, repo_id: hold.repoId, message: holdMessage(hold, gate) } : null,
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
  // THE CEILING (product rule): a person always decides critical changes, at either gate.
  // Enabling any mode there is refused; turning a row off stays allowed (fail safe), and a
  // row that already exists is ignored at decision time (autonomyHold).
  if (
    input.mode !== "off" &&
    input.riskLevel === AUTONOMY_CEILING_RISK &&
    (input.gate === "approve" || input.gate === "merge")
  ) {
    throw new DispatchError("VALIDATION_ERROR", CEILING_MESSAGE, {
      reason: "autonomy_ceiling",
      gate: input.gate,
      risk_level: input.riskLevel,
    });
  }
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
  // SEALED AUTONOMY: the row, its lifecycle event and its seal in ONE transaction. Turning a
  // row off writes the event and retires the seal; anything else is sealed over exactly
  // the row as stored (a key this process may not use rolls the whole change back).
  return inTransaction(host.db, () => {
    const before = host.autonomyPolicy.getStored(input.repoId, input.riskLevel, input.gate);
    const row = host.autonomyPolicy.upsert({
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
    const eventType = !enabling
      ? AUTONOMY_POLICY_DISABLED_EVENT
      : !before || before.mode === "off"
        ? AUTONOMY_POLICY_ENABLED_EVENT
        : AUTONOMY_POLICY_CHANGED_EVENT;
    const eventId = writeEvent(host.db, {
      entity_type: "autonomy_policy",
      entity_id: row.id,
      actor,
      event_type: eventType,
      payload: {
        repo_id: row.repo_id,
        repo: repo.name,
        risk_level: row.risk_level,
        gate: row.gate,
        mode: row.mode,
        was: before?.mode ?? null,
      },
    });
    if (!enabling) {
      retirePolicySeal(host.db, row.id);
    } else {
      try {
        sealPolicy(host.db, host.gateKeyring, row, eventId, now);
      } catch (e) {
        refuseSealKey(e);
      }
    }
    return row;
  });
}

/**
 * SIGNED GATE EVENTS, the review gate's side: seal an approval or a tester PASS in the
 * transaction that records it (a refusal rolls the whole act back), and refuse any
 * landing whose approval or tester verdict does not verify (events/gateSeal.ts).
 */
import type { Ticket } from "../../domain/types.js";
import {
  GateKeyError,
  sealApproval,
  sealTesterPass,
  verifyLandingActs,
  type LandingTarget,
} from "../../events/gateSeal.js";
import { DispatchError } from "../../util/errors.js";
import type { ReviewGateInternals } from "./internals.js";

type SealInternals = Pick<ReviewGateInternals, "clock" | "db" | "gateKeyring">;

function refuseKey(e: unknown): never {
  if (e instanceof GateKeyError) {
    throw new DispatchError(
      "GATE_KEY_REFUSED",
      `Nothing was recorded: ${e.message}. Approvals and tester verdicts are signed with the factory key on the host (gaffer setup creates it).`,
      { reason: e.why },
    );
  }
  throw e;
}

/** Seal the approval event `eventId` (a transition into ready_for_merge). */
export function sealApprovalEvent(internals: SealInternals, ticket: Ticket, eventId: string): void {
  try {
    sealApproval(internals.db, internals.gateKeyring, eventId, ticket.id, internals.clock.now());
  } catch (e) {
    refuseKey(e);
  }
}

/** Seal the `ticket.tester_passed` event `eventId` naming verdict row `evidenceId`. */
export function sealTesterPassEvent(
  internals: SealInternals,
  ticket: Ticket,
  eventId: string,
  evidenceId: string,
): void {
  try {
    sealTesterPass(
      internals.db,
      internals.gateKeyring,
      eventId,
      ticket.id,
      evidenceId,
      internals.clock.now(),
    );
  } catch (e) {
    refuseKey(e);
  }
}

/**
 * Refuse (STATE_CONFLICT, details.reason `unsigned_approval` | `unsigned_tester_verdict`)
 * unless the approval the landing acts on and the tester verdict it relies on verify under
 * the factory key, and every commit in `targets` is one the signed approval pinned.
 */
export function assertSignedActs(
  internals: Pick<ReviewGateInternals, "db" | "gateKeyring">,
  ticket: Ticket,
  targets: readonly LandingTarget[],
  approvalId?: string | null,
  opts: { revocation?: boolean } = {},
): void {
  const v = verifyLandingActs(internals.db, internals.gateKeyring, ticket.id, {
    targets,
    approvalId: approvalId ?? null,
    ticketNumber: ticket.number,
    ...(opts.revocation === false ? { revocation: false } : {}),
  });
  if (v.ok) return;
  throw new DispatchError("STATE_CONFLICT", `#${ticket.number ?? "?"} cannot land: ${v.reason}`, {
    reason: v.code,
    failure: v.failure,
  });
}

/**
 * Records the runner and the Review view write about a delivery without changing its
 * status: the eval judge's verdict, review-open telemetry, lane verdicts, the pre-work
 * scout, and the delivery dossier (assembled, and its hash recorded). Measurements: nothing
 * gates on them.
 */
import { inTransaction } from "../db/connection.js";
import { type Actor, type Ticket } from "../domain/types.js";
import { listEvents, writeEvent } from "../events/eventWriter.js";
import { DispatchError } from "../util/errors.js";
import { currentJudgment, type RecordedEvalJudgment } from "./evalJudgment.js";
import { DOSSIER_EVENT_TYPE, type Dossier } from "./dossierService.js";
import {
  assertMayRecordJudgment,
  EVAL_JUDGED_EVENT,
  normalizeJudgment,
  type EvalJudgment,
} from "./evalJudgment.js";
import {
  assertMayRecordScout,
  normalizeScoutRecord,
  SCOUT_RECORDED_EVENT,
  type ScoutRecord,
} from "./scoutRecord.js";
import {
  assertMayRecordLaneVerdict,
  assertMayRecordReviewOpen,
  LANE_VERDICT_EVENT,
  normalizeLaneVerdict,
  REVIEW_JUDGE_REVEALED_EVENT,
  REVIEW_OPENED_EVENT,
  REVIEW_RAW_OPENED_EVENT,
  type LaneVerdict,
  type RawOpenKind,
} from "./reviewTelemetry.js";
import { type CostReader, enteredReviewAt, type ReviewPacket } from "./reviewPacketService.js";
import type { DispatchInternals } from "./dispatchInternals.js";
import type { Dispatch } from "../core.js";

/** What these functions read from the {@link Dispatch} facade they are handed. */
export type TicketRecordsHost = Pick<
  Dispatch,
  | "clock"
  | "db"
  | "dossierSvc"
  | "events"
  | "repoDeliveries"
  | "resolveTicket"
  | "reviewPacketSvc"
  | "tickets"
>;
/** The facade's private state these functions read. */
export type TicketRecordsInternals = Pick<DispatchInternals, "lastCallersRow">;

/** What recording a review open did (recorded, or why not). */
export interface ReviewOpenResult {
  ticketId: string;
  recorded: boolean;
  /** Why nothing was written: not_in_review | no_review_round | stale_round | already_recorded. */
  reason: string | null;
  eventId: string | null;
  roundEnteredAt: string | null;
}

/**
 * EVAL JUDGE: record the delivery-quality judge's verdict on a ticket (runner/lib/
 * eval-judge.sh after a submit). System/admin only. Telemetry: nothing reads it to
 * gate, approve or land; it is shown to the reviewer and paired with the review outcome
 * by `wg judge-agreement`.
 */
export function recordEvalJudgment(
  host: TicketRecordsHost,
  ref: string,
  input: unknown,
  actor: Actor,
): { ticketId: string; eventId: string; judgment: EvalJudgment } {
  assertMayRecordJudgment(actor);
  const ticket = host.resolveTicket(ref);
  const judgment = normalizeJudgment(input, ticket.attempt_count);
  const eventId = inTransaction(host.db, () => {
    const id = writeEvent(host.db, {
      entity_type: "ticket",
      entity_id: ticket.id,
      actor,
      event_type: EVAL_JUDGED_EVENT,
      payload: judgment,
    });
    // The Review view shows the grade, and it (and its packet cache) re-reads a ticket
    // only when its updated_at moves: bump it so an open page shows the grade. Nothing
    // else changes: no status, no row_version, no gate input.
    host.tickets.touch(ticket.id, host.clock.now());
    return id;
  });
  return { ticketId: ticket.id, eventId, judgment };
}

/**
 * REVIEW TELEMETRY: a person rendered this ticket in the Review view. Recorded once per
 * review round (the round is the ticket's last entry into in_review, computed here, not
 * taken from the caller), with the delivery commits recorded for each repo. Only while
 * the ticket is in review, and only for a human or admin actor. Never bumps updated_at:
 * the Review queue re-renders on it. A measurement only; nothing gates on it.
 */
export function recordReviewOpened(
  host: TicketRecordsHost,
  internals: TicketRecordsInternals,
  ref: string,
  actor: Actor,
  seenRound: string | null = null,
): ReviewOpenResult {
  assertMayRecordReviewOpen(actor);
  const ticket = host.resolveTicket(ref);
  return recordReviewOpen(host, internals, ticket, actor, seenRound, REVIEW_OPENED_EVENT, null);
}

/**
 * REVIEW TELEMETRY: a person opened a raw log, the evidence in full or the full diff of
 * a ticket in review. Once per round and kind; the same rules as recordReviewOpened.
 */
export function recordReviewRawOpened(
  host: TicketRecordsHost,
  internals: TicketRecordsInternals,
  ref: string,
  what: RawOpenKind,
  actor: Actor,
  seenRound: string | null = null,
): ReviewOpenResult {
  assertMayRecordReviewOpen(actor);
  const ticket = host.resolveTicket(ref);
  return recordReviewOpen(host, internals, ticket, actor, seenRound, REVIEW_RAW_OPENED_EVENT, what);
}

/**
 * BLINDING: a person opened the eval judge's collapsed view ("Show the judge's view") of a
 * ticket in review, before deciding. Once per round; the same rules as recordReviewOpened.
 * `wg judge-agreement` counts a decision made after this as revealed, apart from the blind
 * ones its headline comes from. A measurement only; nothing gates on it.
 */
export function recordJudgeRevealed(
  host: TicketRecordsHost,
  internals: TicketRecordsInternals,
  ref: string,
  actor: Actor,
  seenRound: string | null = null,
): ReviewOpenResult {
  assertMayRecordReviewOpen(actor);
  const ticket = host.resolveTicket(ref);
  return recordReviewOpen(
    host,
    internals,
    ticket,
    actor,
    seenRound,
    REVIEW_JUDGE_REVEALED_EVENT,
    "judge",
  );
}

/** What revealJudge answers: the reveal's record, and the grade it unlocked. */
export type JudgeRevealResult = ReviewOpenResult & { judge: RecordedEvalJudgment | null };

/**
 * BLINDING (review14/2): open the eval judge's view in ONE step that records before it
 * shows. Records the reveal (recordJudgeRevealed: a person, the ticket in review, once per
 * round) and only then returns the grade of the current delivery. The grade is returned
 * when the reveal is on record for this round (recorded now or already) or when the
 * ticket is not in review (nothing is blinded then). Any other outcome (the caller's
 * round is stale, or the ticket has no recorded entry into review) writes nothing and
 * returns NO grade: a STATE_CONFLICT the caller shows, so a reviewer can never see the
 * grade while being counted blind. The Review view and `wg review judge-view` both use it.
 */
export function revealJudge(
  host: TicketRecordsHost,
  internals: TicketRecordsInternals,
  ref: string,
  actor: Actor,
  seenRound: string | null = null,
): JudgeRevealResult {
  const r = recordJudgeRevealed(host, internals, ref, actor, seenRound);
  if (!(r.recorded || r.reason === "already_recorded" || r.reason === "not_in_review"))
    throw new DispatchError(
      "STATE_CONFLICT",
      r.reason === "stale_round"
        ? "The ticket went back into review since this page loaded, so the judge's view was not opened: reload it and try again."
        : "The ticket has no recorded entry into review, so opening the judge's view cannot be recorded; it stays hidden until the ticket leaves review.",
      { reason: r.reason, round_entered_at: r.roundEnteredAt },
    );
  const events = listEvents(host.db, "ticket", r.ticketId);
  return { ...r, judge: currentJudgment(events, enteredReviewAt(r.ticketId, events)) };
}

export function recordReviewOpen(
  host: Pick<TicketRecordsHost, "db" | "events" | "repoDeliveries" | "resolveTicket">,
  internals: TicketRecordsInternals,
  ticket: Ticket,
  actor: Actor,
  seenRound: string | null,
  eventType:
    | typeof REVIEW_OPENED_EVENT
    | typeof REVIEW_RAW_OPENED_EVENT
    | typeof REVIEW_JUDGE_REVEALED_EVENT,
  what: RawOpenKind | "judge" | null,
): ReviewOpenResult {
  return inTransaction(host.db, () => {
    const current = host.resolveTicket(ticket.id);
    if (current.status !== "in_review")
      return {
        ticketId: ticket.id,
        recorded: false,
        reason: "not_in_review",
        eventId: null,
        roundEnteredAt: null,
      };
    const round = host.events.enteredStatusAt(ticket.id, "in_review")?.at ?? null;
    if (round === null)
      return {
        ticketId: ticket.id,
        recorded: false,
        reason: "no_review_round",
        eventId: null,
        roundEnteredAt: null,
      };
    if (seenRound !== null && seenRound !== round)
      return {
        ticketId: ticket.id,
        recorded: false,
        reason: "stale_round",
        eventId: null,
        roundEnteredAt: round,
      };
    const seen = host.db
      .prepare(
        `SELECT 1 FROM work_events
          WHERE entity_type = 'ticket' AND entity_id = ? AND event_type = ?
            AND json_extract(payload_json, '$.round_entered_at') = ?
            AND (? IS NULL OR json_extract(payload_json, '$.what') = ?)
          LIMIT 1`,
      )
      .get(ticket.id, eventType, round, what, what);
    if (seen)
      return {
        ticketId: ticket.id,
        recorded: false,
        reason: "already_recorded",
        eventId: null,
        roundEnteredAt: round,
      };
    const payload =
      what === null
        ? {
            round_entered_at: round,
            head_shas: host.repoDeliveries
              .listForTicket(ticket.id)
              .filter((d) => d.commit_sha)
              .map((d) => ({ repo: d.repo_name, sha: d.commit_sha })),
            // What the Behavioural surface's callers row showed for this ticket when the
            // server last computed it IN THIS ROUND (listed / none_changed / not_analysed);
            // absent when it has not (Health counts only known rows).
            ...(internals.lastCallersRow.get(ticket.id)?.round === round
              ? { impact_callers: internals.lastCallersRow.get(ticket.id)!.status }
              : {}),
          }
        : { what, round_entered_at: round };
    const eventId = writeEvent(host.db, {
      entity_type: "ticket",
      entity_id: ticket.id,
      actor,
      event_type: eventType,
      payload,
    });
    return { ticketId: ticket.id, recorded: true, reason: null, eventId, roundEnteredAt: round };
  });
}

/**
 * LANE VERDICT: what a judging lane (the reviewer agent, the security reviewer, the
 * tester, the eval judge) concluded about one candidate, recorded by the runner as a
 * system event so whether a lane changed the decision can be computed. System/admin
 * only; an agent is refused. Nothing gates on it, and it never bumps updated_at.
 */
export function recordLaneVerdict(
  host: TicketRecordsHost,
  ref: string,
  input: Record<string, unknown>,
  actor: Actor,
): { ticketId: string; eventId: string; verdict: LaneVerdict } {
  assertMayRecordLaneVerdict(actor);
  const ticket = host.resolveTicket(ref);
  const verdict = normalizeLaneVerdict(input, actor);
  const eventId = writeEvent(host.db, {
    entity_type: "ticket",
    entity_id: ticket.id,
    actor,
    event_type: LANE_VERDICT_EVENT,
    payload: verdict,
  });
  return { ticketId: ticket.id, eventId, verdict };
}

/**
 * PRE-WORK SCOUT: the runner's scout packet summary for one delivery attempt (the risk
 * it classified, the signals that raised it, its coverage), recorded as a system event
 * for the Review backing rows and Health's scout read model. System/admin only; an
 * agent is refused. Nothing gates on it, and it never bumps updated_at.
 */
export function recordScout(
  host: TicketRecordsHost,
  ref: string,
  input: unknown,
  actor: Actor,
): { ticketId: string; eventId: string; scout: ScoutRecord } {
  assertMayRecordScout(actor);
  const ticket = host.resolveTicket(ref);
  const packet =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  // The declared level is the ticket's own, not the packet's copy of it.
  const scout = normalizeScoutRecord(packet, actor, ticket.risk_level);
  const eventId = writeEvent(host.db, {
    entity_type: "ticket",
    entity_id: ticket.id,
    actor,
    event_type: SCOUT_RECORDED_EVENT,
    payload: scout,
  });
  return { ticketId: ticket.id, eventId, scout };
}

/**
 * DELIVERY-DOSSIER: assemble the tamper-evident evidence dossier for a ticket from
 * EXISTING recorded state. Pure read — no write, no lifecycle change. Deterministic:
 * unchanged ticket state always yields the same {@link Dossier.hash}.
 */
export function dossier(host: TicketRecordsHost, ref: string): Dossier {
  const ticket = host.resolveTicket(ref);
  return host.dossierSvc.assemble(ticket);
}

/**
 * REVIEW PACKET: the runner-verified facts the Review view draws above the agent's
 * words (gates, tester, cost, attempts, risk, the review pin, per-criterion check
 * results, test-count disagreements). Pure read; outside the dossier's hash.
 */
export function reviewPacket(
  host: TicketRecordsHost,
  ref: string,
  costFor: CostReader,
): ReviewPacket {
  return host.reviewPacketSvc.assemble(host.resolveTicket(ref), costFor);
}

/**
 * DELIVERY-DOSSIER: assemble the dossier AND record its hash against the control
 * plane as a `ticket.dossier_recorded` work-event, so the dossier can later be
 * verified. This is the ONLY write on the dossier path. Idempotent: when the freshly
 * computed hash equals the most recently recorded one, no new event is written
 * (`eventId` is null). Recording NEVER changes ticket status or any lifecycle state.
 */
export function recordDossier(
  host: TicketRecordsHost,
  ref: string,
  actor: Actor,
): { dossier: Dossier; eventId: string | null } {
  const ticket = host.resolveTicket(ref);
  const dossier = host.dossierSvc.assemble(ticket);
  const previous = host.events.latestDossierHash(ticket.id);
  if (previous === dossier.hash) {
    return { dossier, eventId: null };
  }
  const eventId = writeEvent(host.db, {
    entity_type: "ticket",
    entity_id: ticket.id,
    actor,
    event_type: DOSSIER_EVENT_TYPE,
    payload: {
      dossier_hash: dossier.hash,
      hash_algo: dossier.hash_algo,
      schema: dossier.schema,
    },
  });
  return { dossier, eventId };
}

/**
 * AUTONOMY STEP-DOWN (the safety half of the autonomy ladder). When the evidence turns bad
 * for a repo x risk x gate that worked automatically, autonomy is taken back at once and
 * visibly; giving it back is a person's act.
 *
 * Triggers (each runs right after the act that carries it, in Dispatch):
 *   (a) `regression`: a person links a later ticket as a regression of an accepted change
 *       that was approved or landed automatically;
 *   (b) `reopened`: a person reopens for review a change that landed automatically (the
 *       one "this was not accepted" act there is);
 *   (c) `tester_failures`: N tester FAILs or UNPROVABLE holds (N = STEP_DOWN_TESTER_FAILS,
 *       2, a named constant beside MIN_SAMPLES, not a setting) on automatically approved
 *       changes at one repo x risk inside the window (30 days, and never before the row's
 *       last step-down or lift).
 *
 * Effect: one `autonomy.stepped_down` event per (repo x risk x gate) on the chain (see
 * autonomyStepDownStore.ts), naming the trigger, the tickets and who or what caused it.
 * From that moment the gate holds the row for a person whatever the policy row or the
 * mode's env floor says (autonomyPolicyService.ts autonomyHold), and the evidence count
 * for the row restarts. A MERGE step-down at one risk also steps merge down at every
 * HIGHER risk in that repo (if low is not trusted, high is not either).
 *
 * Which gates were automatic for a change: `approve` when its latest review approval was
 * not a person's; `merge` when it landed (done) and the approval it landed on (its latest
 * move into ready_for_merge) was not a person's. Counting a person's merge of an agent's
 * approval as automatic errs toward taking autonomy back (fail closed).
 *
 * Lifting (liftStepDown) is a person's act only, through the same gates as the other
 * person-only verbs (approve, a waiver, `principal resign`): the actor must be a person
 * (human or admin), never an agent or the runner (system); a principal must be active and
 * hold full capability (REST and the CLI also require admin for this repo-level change,
 * api/scopeGate.ts and cli/principalGate.ts). The shared operator token and the tokenless
 * CLI are the operator; an agent's shell never reaches `wg autonomy lift` (the safety
 * hook's control-plane rules refuse it) and MCP has no such tool. Two ways: re-enable once
 * the evidence since the step-down clears the bar again, or an explicit override with a
 * reason. Both are events.
 */
import { inTransaction, type Db } from "../db/connection.js";
import { RISK_LEVELS, type Actor, type RiskLevel, type Ticket } from "../domain/types.js";
import { writeEvent } from "../events/eventWriter.js";
import { sealLift } from "../events/autonomySeal.js";
import { GateKeyError, type GateKeyring } from "../events/gateSeal.js";
import type { PrincipalView } from "../repositories/principalRepository.js";
import type { ReviewDecisionRow } from "../repositories/eventRepository.js";
import { DispatchError, notFound } from "../util/errors.js";
import { distanceText, rowEvidence } from "./autonomyLadderService.js";
import type { AutonomyGate } from "./autonomyRecommendationService.js";
import { STEP_DOWN_TESTER_FAILS, STEP_DOWN_WINDOW_DAYS } from "./autonomyRecommendationService.js";
import {
  AUTONOMY_STEP_DOWN_LIFTED_EVENT,
  AUTONOMY_STEPPED_DOWN_EVENT,
  readStepDowns,
  stepDownInForce,
  stepDownKey,
  type StepDownTicket,
  type StepDownTrigger,
} from "./autonomyStepDownStore.js";
import { LANE_VERDICT_EVENT } from "./reviewTelemetry.js";
import { reviewApprovalActor } from "./reviewGate/landing.js";

/** What the step-down functions read from the facade. */
export interface StepDownHost {
  readonly db: Db;
  /** A ticket's active write repositories (the rows a step-down applies to). */
  writeRepoIds(ticket: Ticket): string[];
  resolveTicket(ref: string): Ticket;
  reviewDecisions(): ReviewDecisionRow[];
  repoExists(repoId: string): boolean;
  /** SEALED AUTONOMY: the factory key a lift is sealed with. */
  readonly gateKeyring: GateKeyring;
  /** SEALED AUTONOMY: which lift events count (sealed ones). */
  liftCounts(eventId: string): boolean;
}

/** The reasons the approve path stamps on a review approval. */
const APPROVE_REASONS = ["review_approved", "review_approved_to_testing"];

function isPerson(actorType: string | null | undefined): boolean {
  return actorType === "human" || actorType === "admin";
}

/** Which gates worked automatically for this change (see the header). */
export function automaticGates(
  db: Db,
  ticketId: string,
  beforeRowid?: number,
): { approve: boolean; merge: boolean } {
  const before = beforeRowid === undefined ? "" : " AND rowid < @before";
  const approval = db
    .prepare(
      `SELECT actor_type FROM work_events
        WHERE entity_type = 'ticket' AND entity_id = @id AND event_type = 'ticket.transitioned'
          AND json_extract(payload_json, '$.reason') IN ('${APPROVE_REASONS.join("','")}')${before}
        ORDER BY rowid DESC LIMIT 1`,
    )
    .get({ id: ticketId, ...(beforeRowid === undefined ? {} : { before: beforeRowid }) }) as
    { actor_type: string } | undefined;
  const toMerge = db
    .prepare(
      `SELECT actor_type FROM work_events
        WHERE entity_type = 'ticket' AND entity_id = @id AND event_type = 'ticket.transitioned'
          AND json_extract(payload_json, '$.to') = 'ready_for_merge'${before}
        ORDER BY rowid DESC LIMIT 1`,
    )
    .get({ id: ticketId, ...(beforeRowid === undefined ? {} : { before: beforeRowid }) }) as
    { actor_type: string } | undefined;
  const status = (
    db.prepare(`SELECT status FROM tickets WHERE id = ?`).get(ticketId) as
      { status: string } | undefined
  )?.status;
  const landed =
    status === "done" ||
    (db
      .prepare(
        `SELECT 1 FROM work_events WHERE entity_type = 'ticket' AND entity_id = ?
            AND event_type = 'ticket.transitioned' AND json_extract(payload_json, '$.to') = 'done'
          LIMIT 1`,
      )
      .get(ticketId) as unknown) !== undefined;
  // Merge was automatic unless BOTH the move into ready_for_merge and the review approval on
  // the path it landed on were a person's (a person's tester PASS carries an agent's approval
  // forward; the landing check reads it the same way, reviewGate/landing.ts).
  const onPath = reviewApprovalActor(db, ticketId, beforeRowid);
  return {
    approve: approval !== undefined && !isPerson(approval.actor_type),
    merge: landed && toMerge !== undefined && (!isPerson(toMerge.actor_type) || !isPerson(onPath)),
  };
}

/**
 * Run an act and the step-down it causes in ONE transaction: `act` records the act and
 * returns its result with `then`, the step-down; a throw from `then` rolls the act back
 * too. A throw from `act` itself is a REFUSAL that may have recorded evidence of its own
 * before it threw (a stale tester verdict): it is caught inside the transaction, what was
 * written commits, and the error is thrown again after (a nested transaction rolled its
 * own writes back already).
 */
export function withRefusalKept<T>(db: Db, act: () => { result: T; then: () => unknown }): T {
  let refused: { error: unknown } | null = null;
  const out = inTransaction(db, () => {
    let done: { result: T; then: () => unknown };
    try {
      done = act();
    } catch (error) {
      refused = { error };
      return null;
    }
    done.then();
    return { value: done.result };
  });
  if (out === null) throw (refused as { error: unknown } | null)?.error;
  return out.value;
}

/** One row a step-down wrote. */
export interface SteppedDownRow {
  repoId: string;
  riskLevel: string;
  gate: AutonomyGate;
  trigger: StepDownTrigger;
  eventId: string;
}

function ticketRef(t: Ticket): StepDownTicket {
  return { id: t.id, number: t.number ?? null };
}

function num(t: StepDownTicket): string {
  return t.number === null ? "?" : `#${t.number}`;
}

function who(actor: Actor): string {
  return actor.id ? `${actor.type}:${actor.id}` : actor.type;
}

/**
 * Write the step-downs for these rows (one event each), plus the merge cascade to every
 * higher risk. A row already stepped down is left as it is (one standing step-down per
 * row). Runs in one transaction: every row or none.
 */
export function recordStepDowns(
  host: Pick<StepDownHost, "db">,
  input: {
    repoIds: readonly string[];
    riskLevel: string;
    gates: readonly AutonomyGate[];
    trigger: Exclude<StepDownTrigger, "cascade">;
    why: string;
    tickets: StepDownTicket[];
  },
  actor: Actor,
): SteppedDownRow[] {
  return inTransaction(host.db, () => {
    const out: SteppedDownRow[] = [];
    const write = (
      repoId: string,
      risk: string,
      gate: AutonomyGate,
      trigger: StepDownTrigger,
      why: string,
      cascadeFrom: string | null,
    ): void => {
      if (stepDownInForce(host.db, repoId, risk, gate)) return;
      const eventId = writeEvent(host.db, {
        entity_type: "repository",
        entity_id: repoId,
        actor,
        event_type: AUTONOMY_STEPPED_DOWN_EVENT,
        payload: {
          risk_level: risk,
          gate,
          trigger,
          why,
          tickets: input.tickets,
          cascade_from: cascadeFrom,
        },
      });
      out.push({ repoId, riskLevel: risk, gate, trigger, eventId });
    };
    for (const repoId of input.repoIds) {
      for (const gate of input.gates) {
        write(repoId, input.riskLevel, gate, input.trigger, input.why, null);
        if (gate !== "merge") continue;
        const at = (RISK_LEVELS as readonly string[]).indexOf(input.riskLevel);
        if (at < 0) continue;
        for (const higher of RISK_LEVELS.slice(at + 1)) {
          write(
            repoId,
            higher,
            "merge",
            "cascade",
            `Follows the merge step-down at ${input.riskLevel} risk (${input.why}) If ${input.riskLevel} is not trusted, ${higher} is not either.`,
            input.riskLevel,
          );
        }
      }
    }
    return out;
  });
}

function gatesOf(g: { approve: boolean; merge: boolean }): AutonomyGate[] {
  return [...(g.approve ? (["approve"] as const) : []), ...(g.merge ? (["merge"] as const) : [])];
}

function how(g: { approve: boolean; merge: boolean }): string {
  if (g.approve && g.merge) return "approved and landed automatically";
  return g.merge ? "landed automatically" : "approved automatically";
}

/** Trigger (a): `defect` was just linked as a regression of the accepted change `of`. */
export function stepDownForRegression(
  host: StepDownHost,
  defectRef: string,
  ofRef: string,
  actor: Actor,
): SteppedDownRow[] {
  const defect = host.resolveTicket(defectRef);
  const original = host.resolveTicket(ofRef);
  const gates = automaticGates(host.db, original.id);
  if (!gates.approve && !gates.merge) return [];
  const tickets = [ticketRef(defect), ticketRef(original)];
  return recordStepDowns(
    host,
    {
      repoIds: host.writeRepoIds(original),
      riskLevel: original.risk_level,
      gates: gatesOf(gates),
      trigger: "regression",
      why: `${num(tickets[0]!)} was linked by ${who(actor)} as a regression of ${num(tickets[1]!)}, a ${original.risk_level}-risk change ${how(gates)}.`,
      tickets,
    },
    actor,
  );
}

/** Trigger (b): a person reopened `ref` for review; `fromStatus` is where it was. */
export function stepDownForReopen(
  host: StepDownHost,
  ref: string,
  fromStatus: string,
  actor: Actor,
): SteppedDownRow[] {
  // Only a PERSON reopening a change that LANDED: the runner's own reopen (system: the
  // conflict resolver) and a reopen before landing are not a verdict on the change.
  if (!isPerson(actor.type) || fromStatus !== "done") return [];
  const ticket = host.resolveTicket(ref);
  const gates = automaticGates(host.db, ticket.id);
  if (!gates.approve && !gates.merge) return [];
  const tickets = [ticketRef(ticket)];
  return recordStepDowns(
    host,
    {
      repoIds: host.writeRepoIds(ticket),
      riskLevel: ticket.risk_level,
      gates: gatesOf(gates),
      trigger: "reopened",
      why: `${num(tickets[0]!)} was reopened for review by ${who(actor)} after it was ${how(gates)} (${ticket.risk_level} risk).`,
      tickets,
    },
    actor,
  );
}

const DAY_MS = 86_400_000;

/**
 * Trigger (c): a tester FAIL or an UNPROVABLE hold was just recorded on `ref`. Counts, per
 * write repo of the ticket at its risk, the FAILs and UNPROVABLE holds on automatically
 * approved changes inside the window; at N or more, the approve gate steps down.
 * Event times are wall-clock (eventWriter), so the window is too.
 */
export function stepDownForTesterVerdict(
  host: StepDownHost,
  ref: string,
  actor: Actor,
): SteppedDownRow[] {
  const ticket = host.resolveTicket(ref);
  if (!automaticGates(host.db, ticket.id).approve) return [];
  const limit = STEP_DOWN_TESTER_FAILS;
  const windowStart = new Date(Date.now() - STEP_DOWN_WINDOW_DAYS * DAY_MS).toISOString();
  const states = readStepDowns(host.db, (id) => host.liftCounts(id));
  const out: SteppedDownRow[] = [];
  for (const repoId of host.writeRepoIds(ticket)) {
    const state = states.get(stepDownKey(repoId, ticket.risk_level, "approve"));
    if (state?.inForce) continue;
    let since = windowStart;
    for (const t of [state?.lastStepDown?.at, state?.lastLift?.at]) if (t && t > since) since = t;
    const rows = host.db
      .prepare(
        `SELECT e.rowid AS rowid, e.entity_id AS ticket_id, t.number AS number
           FROM work_events e
           JOIN tickets t ON t.id = e.entity_id
           JOIN ticket_repos tr ON tr.ticket_id = t.id AND tr.repo_id = @repoId AND tr.access = 'write'
          WHERE e.entity_type = 'ticket' AND e.created_at > @since AND t.risk_level = @risk
            AND (e.event_type = 'ticket.tester_failed'
                 OR (e.event_type = @lane
                     AND json_extract(e.payload_json, '$.lane') = 'tester'
                     AND json_extract(e.payload_json, '$.verdict') = 'held'
                     AND json_extract(e.payload_json, '$.held_code') = 'tester_unprovable'))
          ORDER BY e.rowid`,
      )
      .all({ repoId, since, risk: ticket.risk_level, lane: LANE_VERDICT_EVENT }) as Array<{
      rowid: number;
      ticket_id: string;
      number: number | null;
    }>;
    const counted = rows.filter((r) => automaticGates(host.db, r.ticket_id, r.rowid).approve);
    if (counted.length < limit) continue;
    const seen = new Set<string>();
    const tickets: StepDownTicket[] = [];
    for (const r of counted) {
      if (seen.has(r.ticket_id)) continue;
      seen.add(r.ticket_id);
      tickets.push({ id: r.ticket_id, number: r.number });
    }
    out.push(
      ...recordStepDowns(
        host,
        {
          repoIds: [repoId],
          riskLevel: ticket.risk_level,
          gates: ["approve"],
          trigger: "tester_failures",
          why: `${counted.length} tester FAILs or unprovable holds on automatically approved ${ticket.risk_level}-risk changes (${tickets.map(num).join(", ")}) within ${STEP_DOWN_WINDOW_DAYS} days; the limit is ${limit}.`,
          tickets,
        },
        actor,
      ),
    );
  }
  return out;
}

/** Who is lifting: the principal the call authenticated as, if any. */
export interface LiftAuthority {
  /** The principal (REST principal token, CLI GAFFER_PRINCIPAL_TOKEN); absent for the operator. */
  principal?: PrincipalView | null;
}

/** One sentence for every refusal of a lift by the wrong caller. */
const LIFT_PERSON_ONLY =
  "Giving autonomy back is a person's act: the operator (the shared token, or the CLI without a principal token), or an active principal with full capability; never an agent, the runner or MCP.";

function assertLifter(db: Db, actor: Actor, authority: LiftAuthority): void {
  const refuse = (why: string): never => {
    throw new DispatchError("ACTOR_NOT_PERMITTED", `${LIFT_PERSON_ONLY} ${why}`, {
      reason: "person_required",
      actor_type: actor.type,
    });
  };
  if (!isPerson(actor.type)) refuse(`This call is ${actor.type}.`);
  const p = authority.principal ?? null;
  if (!p) return;
  // Re-read the row: the caller's view may be older than a revocation.
  const row = db
    .prepare(
      `SELECT name, capability, actor_type, actor_id, revoked_at FROM api_principals WHERE id = ?`,
    )
    .get(p.id) as
    | {
        name: string;
        capability: string;
        actor_type: string;
        actor_id: string;
        revoked_at: string | null;
      }
    | undefined;
  if (!row) return refuse("The principal is unknown.");
  if (row.revoked_at) refuse(`Principal '${row.name}' is revoked.`);
  if (!isPerson(row.actor_type)) refuse(`Principal '${row.name}' is not a person.`);
  if (row.capability !== "full") refuse(`Principal '${row.name}' is read-only.`);
  if (row.actor_type !== actor.type || row.actor_id !== (actor.id ?? "")) {
    refuse(`The actor is not principal '${row.name}'.`);
  }
}

/**
 * Give autonomy back for one row: `reenable` once the evidence since the step-down clears
 * the bar again, or `override` with a reason. A person's act only (see the header). A
 * merge row cannot be lifted while a LOWER risk's merge row in the same repo is still
 * stepped down (the cascade's own rule, read the other way).
 */
export function liftStepDown(
  host: StepDownHost,
  input: {
    repoId: string;
    riskLevel: RiskLevel;
    gate: AutonomyGate;
    how: "reenable" | "override";
    reason?: string | null;
  },
  actor: Actor,
  authority: LiftAuthority,
): { eventId: string; how: "reenabled" | "override" } {
  assertLifter(host.db, actor, authority);
  if (!host.repoExists(input.repoId)) throw notFound("repository", input.repoId);
  const reason = (input.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (input.how === "override" && reason.length < 3) {
    throw new DispatchError(
      "VALIDATION_ERROR",
      "An override needs a reason: say why autonomy is given back before the evidence clears the bar.",
    );
  }
  return inTransaction(host.db, () => {
    const states = readStepDowns(host.db, (id) => host.liftCounts(id), input.repoId);
    const state = states.get(stepDownKey(input.repoId, input.riskLevel, input.gate));
    if (!state?.inForce) {
      throw new DispatchError(
        "STATE_CONFLICT",
        `No step-down is in force for ${input.riskLevel}/${input.gate} on this repository; there is nothing to lift.`,
        { reason: "not_stepped_down" },
      );
    }
    if (input.gate === "merge") {
      const at = (RISK_LEVELS as readonly string[]).indexOf(input.riskLevel);
      const lower = RISK_LEVELS.slice(0, Math.max(0, at)).find(
        (r) => states.get(stepDownKey(input.repoId, r, "merge"))?.inForce,
      );
      if (lower) {
        throw new DispatchError(
          "STATE_CONFLICT",
          `Merge is still stepped down at ${lower} risk on this repository; lift ${lower} first (if ${lower} is not trusted, ${input.riskLevel} is not either).`,
          { reason: "lower_risk_stepped_down", lower },
        );
      }
    }
    const since = state.lastStepDown?.at ?? null;
    const evidence = rowEvidence(
      host.reviewDecisions(),
      input.repoId,
      input.riskLevel,
      input.gate,
      since,
    );
    if (input.how === "reenable" && evidence.more > 0) {
      throw new DispatchError(
        "STATE_CONFLICT",
        `The evidence since the step-down does not clear the bar yet (${distanceText(evidence.evidence, evidence.more)}). Re-enable when it does, or override with a reason.`,
        { reason: "evidence_short", more: evidence.more },
      );
    }
    const done = input.how === "override" ? "override" : "reenabled";
    const eventId = writeEvent(host.db, {
      entity_type: "repository",
      entity_id: input.repoId,
      actor,
      event_type: AUTONOMY_STEP_DOWN_LIFTED_EVENT,
      payload: {
        risk_level: input.riskLevel,
        gate: input.gate,
        how: done,
        reason: reason || null,
        step_down_event: state.inForce.eventId,
        evidence: {
          k: evidence.evidence.k,
          n: evidence.evidence.n,
          rate: evidence.evidence.rate,
          since,
        },
      },
    });
    // SEALED AUTONOMY: a lift counts only with this seal (bound to the event, its place in
    // the chain and what it gives back). A key this process may not use rolls it back.
    try {
      sealLift(host.db, host.gateKeyring, eventId, new Date().toISOString());
    } catch (e) {
      if (e instanceof GateKeyError) {
        throw new DispatchError(
          "GATE_KEY_REFUSED",
          `Nothing was lifted: ${e.message}. A lift is signed with the factory key on the host (gaffer setup creates it).`,
          { reason: e.why },
        );
      }
      throw e;
    }
    return { eventId, how: done };
  });
}

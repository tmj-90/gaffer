/**
 * Planning on the facade: an epic created from a plan (carrying the clarification answers
 * of its plan session), spec clause lookups, and the durable plan-session chat (H9).
 */
import { inTransaction } from "../db/connection.js";
import { type Actor, type PlanMessage, type PlanSession } from "../domain/types.js";
import { type CreateEpicResult } from "./epicsService.js";
import { notFound } from "../util/errors.js";
import { newId } from "../util/id.js";
import { agreedRequirementsFromTurns } from "../util/planClarifications.js";
import type { Dispatch } from "../core.js";

/** What these functions read from the {@link Dispatch} facade they are handed. */
export type PlanningHost = Pick<
  Dispatch,
  "clock" | "db" | "epicsSvc" | "getPlanSession" | "planSessions"
>;

/**
 * Create an epic atomically (all-or-nothing): a scope node of type `epic` that
 * `contains` every created ticket, the N tickets themselves (each `draft`, with
 * ACs, per-ticket priority/risk/policy, an optional repo link + access boundary
 * and an optional bootstrap marker), and the dependency edges declared by index
 * within the plan. `tickets[i].dependsOn` lists OTHER ticket indexes in the same
 * array; they're resolved to the created ticket ids after all tickets exist, so
 * a self-contained dependency-ordered plan is created in one call. Returns the
 * epic node id and the created ticket numbers in plan order.
 *
 * Validation (besides the Zod schema): every dependsOn index must be in range
 * and not self-referential; the dependency edges must form a DAG (a cycle is
 * rejected). The whole thing runs in one transaction — any failure rolls back
 * the node, the tickets and the edges.
 */
export function createEpic(host: PlanningHost, raw: unknown, actor: Actor): CreateEpicResult {
  // PLANNING CLARIFICATIONS: a plan confirmed from a plan session carries the answers
  // the human gave during clarification into the acceptance contract, unless the
  // caller sent its own (reviewed) list. An unknown session id is refused — the
  // caller asked for answers that cannot be found.
  const body = raw as { plan_session_id?: unknown; epic?: { agreed_requirements?: unknown } };
  if (
    body &&
    typeof body === "object" &&
    typeof body.plan_session_id === "string" &&
    body.plan_session_id.trim() !== "" &&
    body.epic &&
    typeof body.epic === "object" &&
    body.epic.agreed_requirements === undefined
  ) {
    const session = host.getPlanSession(body.plan_session_id.trim());
    if (!session) throw notFound("plan_session", body.plan_session_id);
    let turns: Array<{ role: "user" | "assistant"; content: string }> = [];
    try {
      const parsed = JSON.parse(session.messages_json) as unknown;
      if (Array.isArray(parsed)) turns = parsed as typeof turns;
    } catch {
      turns = [];
    }
    raw = {
      ...body,
      epic: { ...body.epic, agreed_requirements: agreedRequirementsFromTurns(turns) },
    };
  }
  return host.epicsSvc.createEpic(raw, actor);
}

/**
 * cli-wg/F-16: does any spec carry a clause with this (namespaced) id? `ac add
 * --clause` checks it so an AC's spec_clause_id provenance always points at a clause.
 */
export function specClauseExists(host: PlanningHost, clauseId: string): boolean {
  const row = host.db
    .prepare(
      `SELECT 1 AS hit FROM specs s, json_each(s.clauses_json) c
        WHERE json_extract(c.value, '$.clause_id') = ? LIMIT 1`,
    )
    .get(clauseId) as { hit: number } | undefined;
  return row !== undefined;
}

/**
 * Create a fresh active plan session. Any currently active session is
 * archived as 'abandoned' first so only one session is active at a time.
 */
export function createPlanSession(host: PlanningHost): PlanSession {
  const now = host.clock.now();
  host.planSessions.archiveAllActive(now);
  return host.planSessions.create({ id: newId(), created_at: now, updated_at: now });
}

/**
 * Append a message to a plan session and optionally update the brief / stored
 * plan. Returns the updated session, or null when the id is not found.
 *
 * `brief` should be supplied only on the first user turn (the opening line).
 * `plan` should be supplied when the decompose helper returns a plan phase, as
 * the raw plan JSON so the panel can restore the full proposal on reload.
 */
export function appendPlanMessage(
  host: PlanningHost,
  id: string,
  message: Omit<PlanMessage, "ts">,
  opts: { brief?: string | null; plan?: unknown } = {},
): PlanSession | null {
  return host.planSessions.appendMessage({
    id,
    message: { ...message, ts: host.clock.now() },
    ...(opts.brief !== undefined ? { brief: opts.brief } : {}),
    ...(opts.plan !== undefined ? { plan_json: JSON.stringify(opts.plan) } : {}),
    updated_at: host.clock.now(),
  });
}

/**
 * Archive a plan session. `status` must be 'confirmed' (the user approved the
 * plan and tickets are being created) or 'abandoned' (the user started fresh or
 * closed the panel without confirming). A no-op on an already-archived session.
 */
export function archivePlanSession(
  host: PlanningHost,
  id: string,
  status: "confirmed" | "abandoned",
): void {
  host.planSessions.archive({ id, status, updated_at: host.clock.now() });
}

/**
 * Record a plan conversation that happened elsewhere (`gaffer plan` in the terminal)
 * as a finished session, so it sits in the plan-session history the dashboard reads
 * (GET /plan-sessions) beside the panel's own. The messages are the panel's shape (a
 * user turn's text; an assistant turn is the POST /plan-build reply as JSON) and the
 * stored plan is the one created. Written in one transaction straight into its final
 * status, so it is never the active session and never archives the one a dashboard
 * panel has open (createPlanSession would abandon it).
 */
export function recordPlanSession(
  host: PlanningHost,
  input: {
    brief: string;
    messages: ReadonlyArray<Omit<PlanMessage, "ts">>;
    plan: unknown;
    status: "confirmed" | "abandoned";
  },
): PlanSession {
  return inTransaction(host.db, () => {
    const now = host.clock.now();
    const id = newId();
    host.planSessions.create({ id, created_at: now, updated_at: now });
    input.messages.forEach((m, i) => {
      host.planSessions.appendMessage({
        id,
        message: { role: m.role, content: m.content, ts: now },
        ...(i === 0 ? { brief: input.brief } : {}),
        ...(i === input.messages.length - 1 ? { plan_json: JSON.stringify(input.plan) } : {}),
        updated_at: now,
      });
    });
    host.planSessions.archive({ id, status: input.status, updated_at: now });
    return host.planSessions.getById(id)!;
  });
}

/**
 * The facade's read models: a ticket's full view, the batched ticket details, the board
 * and the human queue stamped with each approved ticket's landing state, and the agent
 * lists carrying each agent's presentation. Reads only.
 */
import { readLatestWaiver } from "./reviewGate/waiver.js";
import {
  type AcceptanceCriterion,
  type Agent,
  type Decision,
  type Evidence,
  type ReworkAttempt,
  type TestContract,
  type Ticket,
  type TicketDependencyView,
  type WorkEvent,
  parseTestContract,
} from "../domain/types.js";
import { listEvents } from "../events/eventWriter.js";
import { type AgentDisplay } from "./squadService.js";
import { type ActiveClaimView } from "../repositories/claimRepository.js";
import { type ActivityEvent, type ActivityQuery } from "../repositories/eventRepository.js";
import { type TicketRepoLink } from "../repositories/repoRepository.js";
import { ReworkAttemptRepository } from "../repositories/reworkAttemptRepository.js";
import { type TicketScopeWithNode } from "../repositories/ticketScopeNodeRepository.js";
import { TICKET_SUMMARY_COLUMNS, type TicketSummary } from "../repositories/ticketRepository.js";
import { computeLandingStatus, type LandingStatus } from "./landingStatus.js";
import { type ReviewCommentView } from "./reviewCommentService.js";
import { currentJudgment, EVAL_JUDGED_EVENT, type RecordedEvalJudgment } from "./evalJudgment.js";
import { enteredReviewAt } from "./reviewPacketService.js";
import { LANE_VERDICT_EVENT, REVIEW_JUDGE_REVEALED_EVENT } from "./reviewTelemetry.js";
import { type BoardCard, type BoardView, type BoardWindow } from "./boardService.js";
import { type HumanQueue } from "./humanQueueService.js";
import { type LandingState } from "./landingState.js";
import type { RegressionLinkView } from "./regressionService.js";
import type { Dispatch } from "../core.js";
import { regressionLinksOf } from "./regressionService.js";

/** What these functions read from the {@link Dispatch} facade they are handed. */
export type TicketReadHost = Pick<
  Dispatch,
  | "acs"
  | "agents"
  | "boardSvc"
  | "claimsRepo"
  | "db"
  | "decisions"
  | "evidence"
  | "humanQueueSvc"
  | "landingState"
  | "regressionLinkRows"
  | "repos"
  | "resolveTicket"
  | "reviewCommentSvc"
  | "reworkAttempts"
  | "squadSvc"
  | "ticketDependencies"
  | "ticketScopes"
  | "tickets"
>;

/**
 * An evidence row enriched with derived provenance for the reviewer surface.
 * `recorded_by_agent` is TRUE iff the row's recording actor type was "agent"
 * (`recorded_by_actor_type === "agent"`) — i.e. evidence SELF-REPORTED by a
 * delivery agent, which the reviewer should weigh with more skepticism than
 * evidence recorded by a trusted principal (a human operator or the factory
 * system). Derived from the real recorded actor type — never fabricated; legacy
 * rows (null type) read as false, so no agent chip and no trust claim is asserted.
 */
export interface EvidenceView extends Evidence {
  recorded_by_agent: boolean;
}

/** The parts GET /tickets/details can return per ticket (the ticket row always comes). */
export const TICKET_DETAIL_PARTS = [
  "repositories",
  "scopes",
  "dependencies",
  "rework_trail",
  "events",
  "evidence",
] as const;

export type TicketDetailPart = (typeof TICKET_DETAIL_PARTS)[number];

/** One ticket of a {@link Dispatch.ticketDetailsBatch} read: the summary row + the asked parts. */
export interface TicketDetailBatchItem {
  ticket: TicketSummary;
  repositories?: TicketRepoLink[];
  scopes?: TicketScopeWithNode[];
  dependencies?: TicketDependencyView[];
  rework_trail?: ReturnType<ReworkAttemptRepository["listForTicket"]>;
  events?: WorkEvent[];
  evidence?: EvidenceView[];
}

export interface TicketView {
  ticket: Ticket;
  acceptanceCriteria: AcceptanceCriterion[];
  repositories: TicketRepoLink[];
  /** Confirmed (primary/secondary/implicit_repo) + suggested scope links. */
  scopes: TicketScopeWithNode[];
  blockingDecisions: Decision[];
  /**
   * Decisions linked to this ticket that a human has RESOLVED (accepted/rejected),
   * with the relation they were linked by. Carries `resolved_answer` — the answer
   * the agent reads (via get_ticket's `resolved_decisions`).
   */
  resolvedDecisions: Array<Decision & { relation: string }>;
  /**
   * EP-001: tickets this one must wait for, each with the depended-on ticket's
   * number/title/status and a `satisfied` flag (true once it's `done`). An
   * unsatisfied dependency blocks this ticket from being claimed.
   */
  dependencies: TicketDependencyView[];
  /** Recorded evidence rows (oldest first), so reviewers can judge inline. */
  evidence: EvidenceView[];
  events: WorkEvent[];
  /**
   * BBT-001: the parsed test_contract (or null). Surfaced as a structured object
   * so CLI callers and the API never receive a JSON-in-JSON string.
   */
  testContract: TestContract | null;
  /**
   * FAILURE-DIAGNOSIS: the full ordered rework failure trail (attempt 1 → 2 → …),
   * each with the distilled failing test + assertion/stack. Empty for a ticket that
   * never bounced. Powers the ticket-detail "why did #N fail" history.
   */
  reworkTrail: ReworkAttempt[];
  /**
   * REVIEW COMMENTS (A1): the reviewer's comments on this ticket, oldest first, with the
   * delivery agent's replies (claims). No git here: the anchor state is computed by
   * {@link Dispatch.listReviewComments} with `anchors`. Outside the hashed dossier subject.
   */
  reviewComments: ReviewCommentView[];
  /**
   * PER-REPOSITORY LANDING: the approved commit of each write repo (its current review
   * pin) and whether that commit has landed on the repo's default branch. A ticket is
   * done only when every one has; `partial` marks a held, partly merged ticket.
   */
  landing: LandingStatus;
  /**
   * EVAL JUDGE: the delivery-quality judge's verdict on the current delivery (the latest
   * `ticket.eval_judged` event since the ticket last entered review), or null when the
   * judge is off (the runner default), failed, or graded only an earlier attempt.
   * Advisory: no gate reads it.
   */
  evalJudgment: RecordedEvalJudgment | null;
  /**
   * ESCAPED DEFECTS (MF5): the accepted changes a person said this ticket regresses, and
   * the later tickets a person linked to this one as its regressions. Current links only.
   */
  regression: { regression_of: RegressionLinkView[]; regressed_by: RegressionLinkView[] };
  /**
   * A PERSON'S WAIVER (package H1): when the ticket's latest tester verdict is a person's
   * PASS, what it waived and the one sentence every surface shows ("tester verdict waived
   * by <principal> for criteria <...> on <sha>: <summary>", plus "recorded without OS
   * isolation" when agents ran without an OS sandbox); null otherwise.
   */
  testerWaiver: TesterWaiverView | null;
}

/** A person's waiver as the ticket view shows it (see TicketView.testerWaiver). */
export type TesterWaiverView = NonNullable<ReturnType<typeof readLatestWaiver>>;

export function view(host: TicketReadHost, ref: string): TicketView {
  const ticket = host.resolveTicket(ref);
  const events = listEvents(host.db, "ticket", ticket.id);
  return {
    ticket,
    acceptanceCriteria: host.acs.listForTicket(ticket.id),
    repositories: host.repos.listForTicket(ticket.id),
    // WG-001: ticket detail includes confirmed + suggested scopes. The repo
    // listForTicket already excludes nothing, so 'rejected' scopes are retained
    // and visible too (audit), but the listForTicket ordering puts the useful
    // ones (primary/secondary/suggested/implicit) first.
    scopes: host.ticketScopes.listForTicket(ticket.id),
    blockingDecisions: host.decisions.blockingForTicket(ticket.id),
    resolvedDecisions: host.decisions.resolvedForTicket(ticket.id),
    dependencies: host.ticketDependencies.listForTicket(ticket.id),
    evidence: enrichEvidenceProvenance(host.evidence.listForTicket(ticket.id)),
    events,
    // BBT-001: parse the JSON-encoded test_contract to a structured object so
    // consumers (CLI, API) never receive a JSON-in-JSON string.
    testContract: parseTestContract(ticket.test_contract),
    // FAILURE-DIAGNOSIS: the full ordered "why did #N fail" trail.
    reworkTrail: host.reworkAttempts.listForTicket(ticket.id),
    reviewComments: host.reviewCommentSvc.listViews(ticket.id),
    // PER-REPOSITORY LANDING: each write repo's approved commit and whether it landed.
    landing: computeLandingStatus(host.db, ticket.id),
    evalJudgment: currentJudgment(events, enteredReviewAt(ticket.id, events)),
    regression: regressionLinksOf(host, ticket.id),
    testerWaiver: readLatestWaiver(host.db, ticket.id),
  };
}

/**
 * The parts of many tickets' detail in one read (GET /tickets/details): what the
 * dashboard's Map, Overview and Epics need from each ticket, without one
 * GET /tickets/:id per ticket. `ids` names the tickets (unknown ones are listed in
 * `missing`); without it a page of every ticket is read (`limit`/`offset`). Each
 * ticket row is the summary row (no description, test contract or review feedback).
 */
export function ticketDetailsBatch(
  host: TicketReadHost,
  select: { ids: readonly string[] } | { limit: number; offset: number },
  include: ReadonlySet<TicketDetailPart>,
  /**
   * PRINCIPAL SCOPES: a scoped principal's ticket filter. A ticket it may not see is
   * reported in `missing` (asked by id) or left out of the page and the total.
   */
  visible?: ((ticketId: string) => boolean) | null,
): { details: TicketDetailBatchItem[]; missing: string[]; total: number } {
  let rows: TicketSummary[];
  let total: number;
  const missing: string[] = [];
  if ("ids" in select) {
    const byId = new Map<string, TicketSummary>();
    const unique = [...new Set(select.ids)];
    const get = host.db.prepare(
      `SELECT ${TICKET_SUMMARY_COLUMNS.join(", ")} FROM tickets WHERE id = ?`,
    );
    for (const id of unique) {
      const row = get.get(id) as TicketSummary | undefined;
      if (row && (!visible || visible(row.id))) byId.set(id, row);
      else missing.push(id);
    }
    rows = unique.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
    total = rows.length;
  } else if (visible) {
    // The whole list filtered, then windowed, so `total` counts what it may see.
    const all = (host.tickets.listPage({}, { summary: true }).tickets as TicketSummary[]).filter(
      (t) => visible(t.id),
    );
    rows = all.slice(select.offset, select.offset + select.limit);
    total = all.length;
  } else {
    const page = host.tickets.listPage(
      {},
      { limit: select.limit, offset: select.offset, summary: true },
    );
    rows = page.tickets as TicketSummary[];
    total = page.total;
  }
  const details = rows.map((ticket) => {
    const item: TicketDetailBatchItem = { ticket };
    if (include.has("repositories")) item.repositories = host.repos.listForTicket(ticket.id);
    if (include.has("scopes")) item.scopes = host.ticketScopes.listForTicket(ticket.id);
    if (include.has("dependencies"))
      item.dependencies = host.ticketDependencies.listForTicket(ticket.id);
    if (include.has("rework_trail"))
      item.rework_trail = host.reworkAttempts.listForTicket(ticket.id);
    if (include.has("events"))
      item.events = hideJudgeInReview(ticket, listEvents(host.db, "ticket", ticket.id)).events;
    if (include.has("evidence"))
      item.evidence = enrichEvidenceProvenance(host.evidence.listForTicket(ticket.id));
    return item;
  });
  return { details, missing, total };
}

/**
 * Stamp each evidence row with `recorded_by_agent` for the reviewer's trust
 * surface, derived from the RECORDING ACTOR'S TYPE captured at record time
 * (`recorded_by_actor_type`). A row is agent self-reported iff that type is
 * "agent"; a human operator or the factory/system actor is a trusted principal.
 * This is the dependable signal — `created_by` cannot be used because an agent's
 * `created_by` is a runner-supplied id (e.g. "mcp-agent"), never the registered
 * agent identity. Legacy rows carry a null type (recorded before this column);
 * their flag is left `false` (⇒ no agent chip, no trust claim asserted). Never
 * fabricated — always the real recorded actor type.
 */
export function enrichEvidenceProvenance(rows: Evidence[]): EvidenceView[] {
  return rows.map((e) => ({
    ...e,
    recorded_by_agent: e.recorded_by_actor_type === "agent",
  }));
}

/** Events for a ticket (resolved by id or number), the judge's grade hidden while in review. */
export function listTicketEvents(host: TicketReadHost, ref: string): WorkEvent[] {
  const ticket = host.resolveTicket(ref);
  return hideJudgeInReview(ticket, listEvents(host.db, "ticket", ticket.id)).events;
}

/**
 * BLINDING: while a ticket is in review and nobody has opened the judge's view in this
 * round (`ticket.review_judge_revealed`), the eval judge's grade stays out of the ticket
 * reads a reviewer can see before deciding (GET /tickets/:id and its events, the batched
 * details, `wg ticket show`): each `ticket.eval_judged` event and the eval judge's
 * `ticket.lane_verdict` keep their row but carry `{ hidden: true }` in place of the grade.
 * Otherwise a reviewer could read the grade on the ticket page and still be counted blind
 * by judge agreement. The Review view's "Show the judge's view" (or `wg review judge-view`)
 * records the reveal and then the reads show it again. The stored events are unchanged.
 */
export function hideJudgeInReview<E extends WorkEvent>(
  ticket: Pick<Ticket, "id" | "status">,
  events: readonly E[],
): { events: E[]; hidden: boolean } {
  if (ticket.status !== "in_review") return { events: [...events], hidden: false };
  const since = enteredReviewAt(ticket.id, events);
  const revealed = events.some(
    (e) =>
      e.event_type === REVIEW_JUDGE_REVEALED_EVENT && (since === null || e.created_at >= since),
  );
  if (revealed) return { events: [...events], hidden: false };
  let hidden = false;
  const out = events.map((e) => {
    if (e.event_type === EVAL_JUDGED_EVENT) {
      hidden = true;
      return { ...e, payload_json: JSON.stringify({ hidden: true }) };
    }
    if (e.event_type === LANE_VERDICT_EVENT) {
      let lane: unknown = null;
      try {
        lane = (JSON.parse(e.payload_json || "{}") as { lane?: unknown }).lane;
      } catch {
        /* a malformed payload is not the judge's */
      }
      if (lane === "eval-judge") {
        hidden = true;
        return { ...e, payload_json: JSON.stringify({ lane: "eval-judge", hidden: true }) };
      }
    }
    return e;
  });
  return { events: out, hidden };
}

/**
 * FAILURE-DIAGNOSIS: the "why did #N fail" read model — the full ordered rework
 * failure trail for one ticket (attempt 1 → 2 → …), each with the distilled
 * failing test + assertion/stack. Resolves by ticket id or number.
 */
export function reworkTrail(host: TicketReadHost, ref: string): ReworkAttempt[] {
  const ticket = host.resolveTicket(ref);
  return host.reworkAttempts.listForTicket(ticket.id);
}

/**
 * Active claims joined to their ticket + agent (human "active factory" view).
 * SQUAD: each row also carries the agent's presentation (`agent_display`).
 */
export function listActiveClaims(
  host: TicketReadHost,
): Array<ActiveClaimView & { agent_display: AgentDisplay | null }> {
  const displays = host.squadSvc.displayMap();
  return host.claimsRepo
    .listActive()
    .map((c) => ({ ...c, agent_display: displays.get(c.agent_id) ?? null }));
}

/** All registered agents, newest first, each with its presentation (`agent_display`). */
export function listAgents(
  host: TicketReadHost,
): Array<Agent & { agent_display: AgentDisplay | null }> {
  const displays = host.squadSvc.displayMap();
  return host.agents.list().map((a) => ({ ...a, agent_display: displays.get(a.id) ?? null }));
}

/**
 * The presentation of each REGISTERED agent among `ids`, keyed by id. Ids that
 * are not registered agents (a human actor, "mcp-agent", …) are left out.
 */
export function agentDisplayFor(
  host: TicketReadHost,
  ids: Iterable<string | null | undefined>,
): Record<string, AgentDisplay> {
  const displays = host.squadSvc.displayMap();
  const out: Record<string, AgentDisplay> = {};
  for (const id of ids) {
    if (!id) continue;
    const d = displays.get(id);
    if (d) out[id] = d;
  }
  return out;
}

/**
 * Kanban board: tickets grouped into columns, AC progress enriched. Read-only.
 *
 * @param repo Optional repository name/id — when supplied, only tickets
 *   linked to that repo are included. Omit for the full board.
 */
export function board(
  host: TicketReadHost,
  repo?: string,
  window?: BoardWindow,
  visible?: (ticketId: string) => boolean,
): BoardView {
  const view = host.boardSvc.board(repo, window, visible);
  // Approved and held cards carry where their landing is (one read per such ticket).
  const states = new Map<string, LandingState>();
  const stamp = (c: BoardCard): BoardCard => {
    if (c.status !== "ready_for_merge" && c.status !== "blocked") return c;
    if (!states.has(c.id)) {
      const ls = host.landingState(c.id);
      if (ls) states.set(c.id, ls);
    }
    const ls = states.get(c.id);
    return ls ? { ...c, landing_state: ls } : c;
  };
  return {
    ...view,
    columns: view.columns.map((col) => ({ ...col, cards: col.cards.map(stamp) })),
    closed: view.closed.map(stamp),
    wontDo: view.wontDo.map(stamp),
    readyForMerge: view.readyForMerge.map(stamp),
  };
}

/**
 * Cross-ticket activity feed. SQUAD: an event whose actor is a registered agent
 * carries that agent's presentation as `agent_display` (null otherwise).
 */
export function activity(
  host: TicketReadHost,
  query: ActivityQuery,
): {
  events: Array<ActivityEvent & { agent_display: AgentDisplay | null }>;
  total: number;
} {
  const page = host.boardSvc.activity(query);
  const displays = host.squadSvc.displayMap();
  return {
    total: page.total,
    events: page.events.map((e) => ({
      ...e,
      agent_display: (e.actor_id !== null && displays.get(e.actor_id)) || null,
    })),
  };
}

/**
 * The HUMAN's queue (Track 2a): everything the operator owns — pending
 * decisions the agent delegated (WITH reasons), tickets awaiting review
 * sign-off, and regulated tickets awaiting ready-approval / reviewer
 * assignment — each with what it is, which ticket, the reason and how long it
 * has waited. A read model only: EXCLUDES agent-owned `blocked`/rework churn,
 * changes no semantics and adds no gate. Read-only.
 */
export function humanQueue(host: TicketReadHost): HumanQueue {
  const q = host.humanQueueSvc.build();
  return {
    ...q,
    items: q.items.map((it) => {
      const t = it.ticket;
      if (!t || (t.status !== "ready_for_merge" && t.status !== "blocked")) return it;
      const ls = host.landingState(t.id);
      return ls ? { ...it, ticket: { ...t, landing_state: ls } } : it;
    }),
  };
}

import type { DecisionSeverity, TicketStatus } from "../domain/types.js";
import type { DecisionRepository } from "../repositories/decisionRepository.js";
import type { EventRepository } from "../repositories/eventRepository.js";
import type { TicketRepository } from "../repositories/ticketRepository.js";
import type { Clock } from "../util/clock.js";

/**
 * What KIND of thing the human owns. Each maps to a distinct action the operator
 * (not the agent) must take:
 *  - `decision`            — answer a genuine unmade decision the agent delegated;
 *  - `review`              — sign off a delivered ticket sitting in `in_review`;
 *  - `ready_approval`      — grant the human ready-approval a `regulated` ticket needs;
 *  - `reviewer_assignment` — assign a reviewer a `regulated` ticket needs to be ready.
 */
export type HumanQueueKind = "decision" | "review" | "ready_approval" | "reviewer_assignment";

/** The ticket a human-queue item concerns (null for a decision with no link). */
export interface HumanQueueTicketRef {
  id: string;
  number: number | null;
  title: string;
  status: TicketStatus;
}

/**
 * One thing the HUMAN owns — a decision/approval the agent delegated to them,
 * WITH the reason. Explicitly NOT agent-owned churn (a `blocked`/rework ticket
 * is the agent's problem, not the human's queue), so those never appear here.
 */
export interface HumanQueueItem {
  kind: HumanQueueKind;
  /** A short label for what is owed (e.g. "Decision", "Review sign-off"). */
  label: string;
  /**
   * WHY the human owns this — the decision question (why the agent needs a human),
   * the submit reason for a review, or the policy gate for a regulated approval.
   */
  reason: string;
  /** The ticket this concerns, or null (a decision may be raised with no ticket). */
  ticket: HumanQueueTicketRef | null;
  /** Decision items only: the decision id (so a caller can resolve it). */
  decisionId: string | null;
  /** Decision items only: the severity (human_required / human_preferred / …). */
  severity: DecisionSeverity | null;
  /** When the wait started (ISO instant). */
  since: string;
  /** How long the item has waited, in ms, relative to the service clock. */
  waitedMs: number;
}

/** Counts of the human-owned queue, partitioned by kind. */
export interface HumanQueueCounts {
  total: number;
  decisions: number;
  reviews: number;
  readyApprovals: number;
  reviewerAssignments: number;
}

/** The aggregated human-owned queue: everything waiting on the OPERATOR. */
export interface HumanQueue {
  items: HumanQueueItem[];
  counts: HumanQueueCounts;
  /** The instant the queue was computed (ISO), so a caller can render "as of". */
  generatedAt: string;
}

export interface HumanQueueServiceDeps {
  readonly clock: Clock;
  readonly decisions: DecisionRepository;
  readonly tickets: TicketRepository;
  readonly events: EventRepository;
}

const REVIEW_REASON_FALLBACK = "Delivered by the agent — awaiting your review sign-off.";
const READY_APPROVAL_REASON =
  "Regulated ticket — needs your ready-approval before it can enter the queue.";
const REVIEWER_ASSIGNMENT_REASON =
  "Regulated ticket — assign a reviewer before it can be made ready.";

/**
 * Aggregates the HUMAN's queue: the decisions and approvals the agent delegated
 * to the operator, each with its REASON and how long it has waited. This is a
 * pure read model over existing dispatch data — it changes no decision/approval
 * semantics and adds no gate. It EXCLUDES agent-owned `blocked`/rework tickets:
 * those are the agent's churn, surfaced elsewhere (the board, the bouncing
 * panel), not something the human owns.
 */
export class HumanQueueService {
  private readonly clock: Clock;
  private readonly decisions: DecisionRepository;
  private readonly tickets: TicketRepository;
  private readonly events: EventRepository;

  constructor(deps: HumanQueueServiceDeps) {
    this.clock = deps.clock;
    this.decisions = deps.decisions;
    this.tickets = deps.tickets;
    this.events = deps.events;
  }

  /** Build the human-owned queue, oldest-waited first (the operator's priority). */
  build(): HumanQueue {
    const now = this.clock.now();
    const nowMs = Date.parse(now);
    const waited = (iso: string): number => {
      const ms = nowMs - Date.parse(iso);
      return Number.isFinite(ms) && ms > 0 ? ms : 0;
    };

    const items: HumanQueueItem[] = [];

    // --- Pending decisions the agent delegated to a human (WITH the reason) ---
    for (const d of this.decisions.listPendingWithTicket()) {
      const ticket: HumanQueueTicketRef | null =
        d.ticket_id !== null && d.ticket_status !== null
          ? {
              id: d.ticket_id,
              number: d.ticket_number,
              title: d.ticket_title ?? "(untitled)",
              status: d.ticket_status,
            }
          : null;
      items.push({
        kind: "decision",
        label: "Decision",
        // The question IS the reason the agent needs a human.
        reason: d.question,
        ticket,
        decisionId: d.id,
        severity: d.severity,
        since: d.created_at,
        waitedMs: waited(d.created_at),
      });
    }

    // --- Tickets awaiting the human's review sign-off (`in_review`) -----------
    for (const t of this.tickets.list("in_review")) {
      const entered = this.events.enteredStatusAt(t.id, "in_review");
      const since = entered?.at ?? t.updated_at;
      const reason =
        entered?.reason && entered.reason.trim().length > 0
          ? entered.reason
          : REVIEW_REASON_FALLBACK;
      items.push({
        kind: "review",
        label: "Review sign-off",
        reason,
        ticket: { id: t.id, number: t.number, title: t.title, status: t.status },
        decisionId: null,
        severity: null,
        since,
        waitedMs: waited(since),
      });
    }

    // --- Regulated tickets awaiting a human gate before they can be ready -----
    // Scoped to `draft`: the pre-ready window where the human ready-approval and
    // reviewer-assignment gates apply. This deliberately excludes `refining`/
    // `blocked` (agent-owned rework churn) — those are NOT the human's queue.
    for (const t of this.tickets.list("draft")) {
      if (t.policy_pack !== "regulated") continue;
      if (!this.events.hasTicketEvent(t.id, "ticket.ready_approved")) {
        items.push({
          kind: "ready_approval",
          label: "Ready-approval",
          reason: READY_APPROVAL_REASON,
          ticket: { id: t.id, number: t.number, title: t.title, status: t.status },
          decisionId: null,
          severity: null,
          since: t.created_at,
          waitedMs: waited(t.created_at),
        });
      }
      if (t.reviewer === null || t.reviewer.trim().length === 0) {
        items.push({
          kind: "reviewer_assignment",
          label: "Reviewer",
          reason: REVIEWER_ASSIGNMENT_REASON,
          ticket: { id: t.id, number: t.number, title: t.title, status: t.status },
          decisionId: null,
          severity: null,
          since: t.created_at,
          waitedMs: waited(t.created_at),
        });
      }
    }

    // Oldest-waited first — the item that has waited longest leads the queue.
    items.sort((a, b) => Date.parse(a.since) - Date.parse(b.since));

    const counts: HumanQueueCounts = {
      total: items.length,
      decisions: items.filter((i) => i.kind === "decision").length,
      reviews: items.filter((i) => i.kind === "review").length,
      readyApprovals: items.filter((i) => i.kind === "ready_approval").length,
      reviewerAssignments: items.filter((i) => i.kind === "reviewer_assignment").length,
    };

    return { items, counts, generatedAt: now };
  }
}

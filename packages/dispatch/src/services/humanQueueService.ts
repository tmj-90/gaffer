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
 *  - `reviewer_assignment` — assign the reviewer a `factory_strict`/`regulated`
 *                            ticket needs to be ready (mirrors the policy gate's
 *                            REVIEWER_REQUIRED profile set);
 *  - `parked`              — a runner/human PARKED ticket (`blocked`, or `refining`
 *                            that carries a runner park reason_code) waiting on a
 *                            human to unpark/refine/cancel it.
 */
export type HumanQueueKind =
  "decision" | "review" | "ready_approval" | "reviewer_assignment" | "parked";

/** The ticket a human-queue item concerns (null for a decision with no link). */
export interface HumanQueueTicketRef {
  id: string;
  number: number | null;
  title: string;
  status: TicketStatus;
}

/**
 * One thing the HUMAN owns — a decision/approval the agent delegated to them,
 * WITH the reason. Runner/human PARKED tickets (`blocked`, and `refining` that
 * carries a runner park reason_code) ARE surfaced here as the `parked` kind,
 * since they wait on a human. Ordinary agent-owned `refining` churn (no park
 * reason_code) is NOT the human's queue and never appears here.
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
  /** Parked items only: the structured runner park reason_code (null = none recorded). */
  reasonCode?: string | null;
  /** Parked items only: advisory next action — "unpark" | "refine" | "cancel". */
  suggestedAction?: "unpark" | "refine" | "cancel" | null;
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
  parked: number;
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
  "Policy gate (factory_strict/regulated) — assign a reviewer before it can be made ready.";
const PARKED_NO_CODE_LABEL = "blocked (no reason recorded)";
// The structured runner park reason_codes the factory runner writes onto a
// `ticket.blocked` event (via runnerRelease): rework_exhausted, bootstrap_failed,
// strict_require_unavailable, budget_exhausted. Any non-null reason_code is a
// coded park (→ unpark/refine); a human/agent block with no code → cancel.
/**
 * Advisory next-action for a parked ticket (rendered as a hint only — the unpark
 * action itself is a future slice). A coded `refining` park suggests `refine`; a
 * coded `blocked` park suggests `unpark`; a no-code human block suggests `cancel`.
 */
function parkedAction(
  status: TicketStatus,
  reasonCode: string | null,
): "unpark" | "refine" | "cancel" {
  if (status === "refining") return "refine";
  return reasonCode === null ? "cancel" : "unpark";
}

/**
 * Aggregates the HUMAN's queue: the decisions and approvals the agent delegated
 * to the operator, each with its REASON and how long it has waited. This is a
 * pure read model over existing dispatch data — it changes no decision/approval
 * semantics and adds no gate. It surfaces runner/human PARKED tickets (`blocked`,
 * and `refining` that carries a runner park reason_code) as the `parked` kind so
 * nothing waiting on a human is hidden, while EXCLUDING ordinary agent-owned
 * `refining` churn (no park reason_code) — that stays the agent's problem,
 * surfaced elsewhere (the board, the bouncing panel).
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

    // --- Policy-gated drafts awaiting a human gate before they can be ready ---
    // Scoped to `draft`: the pre-ready window where the human ready-approval and
    // reviewer-assignment gates apply. Parked tickets (`blocked`, and coded
    // `refining` parks) are handled by the dedicated parked loop below as the
    // `parked` kind; only UNcoded `refining` churn stays out of the human's queue.
    // Which packs owe which gate mirrors the policy ready-gate (policy.ts):
    // REVIEWER_REQUIRED fires for factory_strict AND regulated, while the human
    // ready-approval (HUMAN_APPROVAL_REQUIRED) is regulated-only.
    for (const t of this.tickets.list("draft")) {
      const pack = t.policy_pack;
      if (pack !== "factory_strict" && pack !== "regulated") continue;
      if (pack === "regulated" && !this.events.hasTicketEvent(t.id, "ticket.ready_approved")) {
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

    // --- Runner/human PARKED tickets waiting on a human (blocked, + refining that
    // carries a runner park reason_code). Blocked ALWAYS lists (nothing waiting on a
    // human is hidden); refining lists ONLY when a park reason_code is present, so
    // ordinary agent-owned refining churn stays excluded (preserving the prior intent).
    for (const status of ["blocked", "refining"] as const) {
      for (const t of this.tickets.list(status)) {
        const park = this.events.latestParkEvent(t.id);
        if (status === "refining" && (park === null || park.reasonCode === null)) continue;
        const reasonCode = park?.reasonCode ?? null;
        const since = park?.at ?? t.updated_at;
        const reason =
          reasonCode === null
            ? PARKED_NO_CODE_LABEL
            : park?.reason && park.reason.trim().length > 0
              ? park.reason // UNTRUSTED free text — passed through as-is (rendered as a text node).
              : PARKED_NO_CODE_LABEL;
        items.push({
          kind: "parked",
          label: "Parked",
          reason,
          ticket: { id: t.id, number: t.number, title: t.title, status: t.status },
          decisionId: null,
          severity: null,
          reasonCode,
          suggestedAction: parkedAction(status, reasonCode),
          since,
          waitedMs: waited(since),
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
      parked: items.filter((i) => i.kind === "parked").length,
    };

    return { items, counts, generatedAt: now };
  }
}

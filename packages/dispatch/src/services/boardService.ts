import { type Db } from "../db/connection.js";
import {
  TICKET_STATUSES,
  parseReviewFeedback,
  type ReviewFeedback,
  type RiskLevel,
  type TicketStatus,
} from "../domain/types.js";
import { AcRepository } from "../repositories/acRepository.js";
import { ClaimRepository, type ActiveClaimView } from "../repositories/claimRepository.js";
import { DecisionRepository } from "../repositories/decisionRepository.js";
import {
  EventRepository,
  type ActivityEvent,
  type ActivityQuery,
  type TransitionRow,
} from "../repositories/eventRepository.js";
import { TicketRepository } from "../repositories/ticketRepository.js";
import { DispatchError } from "../util/errors.js";
import type { Clock } from "../util/clock.js";
import type { Ticket } from "../domain/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Column keys for the kanban board (claimed+in_progress collapse to one). */
export const BOARD_COLUMNS = [
  "draft",
  "ready",
  "in_progress",
  "blocked",
  "in_review",
  // BBT-001: the independent black-box testing lane, between review and merge.
  "in_testing",
  "ready_for_merge",
  "done",
] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

/** Hours a ticket may hold a non-terminal state before it is flagged as stuck. */
export const STUCK_THRESHOLD_HOURS = 24;

/** Statuses that close a ticket — work in them is done, never "stuck". */
export const TERMINAL_STATUSES: ReadonlySet<TicketStatus> = new Set([
  "done",
  "failed",
  "cancelled",
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Claim summary surfaced on a board card. Never carries a token. */
export interface BoardCardClaim {
  agentId: string;
  agentDisplayName: string | null;
  expiresAt: string;
  /** True when the claim's lease has passed its expiry (stale/recoverable). */
  stale: boolean;
}

/** A single kanban card: the ticket plus the at-a-glance rollups. */
export interface BoardCard {
  id: string;
  number: number | null;
  title: string;
  status: TicketStatus;
  priority: number;
  risk_level: RiskLevel;
  updated_at: string;
  /** Total acceptance criteria. */
  acTotal: number;
  /** Acceptance criteria in a satisfied state. */
  acSatisfied: number;
  /** Acceptance criteria that require evidence AND are satisfied. */
  acEvidenced: number;
  /** Acceptance criteria that require evidence (the denominator for evidenced). */
  acEvidenceRequired: number;
  /** Count of open blocking decisions. */
  blockingCount: number;
  /** Active claim holder, when the ticket is claimed/in_progress. */
  claim: BoardCardClaim | null;
  /**
   * Latest review-rejection feedback (WG-049), so a human triaging the board sees
   * WHY a ticket in `refining`/rework was sent back. `null` when there is none.
   */
  lastReviewFeedback: ReviewFeedback | null;
}

/** A board column: the column key and its ordered cards. */
export interface BoardColumnView {
  column: BoardColumn;
  cards: BoardCard[];
}

/**
 * The full kanban board: ordered live columns, a closed (failed) area, and a
 * terminal won't-do bucket (cancelled tickets — work that will NOT be built,
 * distinct from rework). Won't-do tickets are reopenable, so they get their own
 * visible bucket rather than being hidden in the closed area.
 */
export interface BoardView {
  columns: BoardColumnView[];
  closed: BoardCard[];
  wontDo: BoardCard[];
  /**
   * Approved-and-merging tickets (`ready_for_merge`): approved by a human, the
   * merge runner is doing the git merge. Surfaced as a dedicated array (mirroring
   * the `ready_for_merge` column in `columns`) so a caller can render the
   * "Approved · merging" column without re-scanning the column list.
   */
  readyForMerge: BoardCard[];
}

/** Median time (ms) tickets spent in a state, over completed intervals. */
export interface CycleTimeStat {
  /** The state held between two transitions. */
  status: TicketStatus;
  /** Median duration in the state, in milliseconds. */
  medianMs: number;
  /** Number of completed intervals the median is computed over. */
  samples: number;
}

/** A ticket flagged as stuck: sitting in a non-terminal state too long. */
export interface StuckTicket {
  id: string;
  number: number | null;
  title: string;
  status: TicketStatus;
  /** How long the ticket has held its current state, in milliseconds. */
  stuckForMs: number;
  /** When the ticket entered its current state (ISO instant). */
  since: string;
}

/** Per-repository delivery progress for the Overview "Progress by repository". */
export interface RepoProgress {
  /** Repository name. */
  repo: string;
  /** Tickets linked to this repo (any status). */
  total: number;
  /** Of those, how many are `done`. */
  done: number;
  /** Of those, how many are actively in flight (claimed → ready_for_merge). */
  inFlight: number;
  /** Of those, how many are blocked. */
  blocked: number;
  /** done / total as a 0–100 integer percentage. */
  pct: number;
}

/** Dashboard summary tiles — counts plus cycle-time/stuck analytics. */
export interface DashboardSummary {
  /** Ticket counts keyed by status (every status present, zero-filled). */
  ticketsByStatus: Record<TicketStatus, number>;
  /** Tickets delivered (→in_review/done) since the start of today (UTC). */
  deliveredToday: number;
  /** Tickets currently blocked. */
  blocked: number;
  /** Open (unresolved) decisions awaiting a human. */
  openDecisions: number;
  /** Active claims right now. */
  activeClaims: number;
  /** Active claims whose lease has passed expiry (stale). */
  staleClaims: number;
  /** Median cycle time per state, in TICKET_STATUSES order (states with data). */
  cycleTimeByState: CycleTimeStat[];
  /** Tickets stuck in a non-terminal state beyond the threshold, longest first. */
  stuckTickets: StuckTicket[];
  /** The age (hours) past which a non-terminal ticket is flagged as stuck. */
  stuckThresholdHours: number;
  /** Per-repository delivery progress (mapped repos with ≥1 linked ticket). */
  repoProgress: RepoProgress[];
}

// ---------------------------------------------------------------------------
// Module-level helpers (exported for moveTicket in Dispatch)
// ---------------------------------------------------------------------------

export function isTicketStatus(value: string): value is TicketStatus {
  return (TICKET_STATUSES as readonly string[]).includes(value);
}

export function isBoardColumn(value: string): value is BoardColumn {
  return (BOARD_COLUMNS as readonly string[]).includes(value);
}

/** Map a ticket status to its board column, or null for the closed area. */
export function columnFor(status: TicketStatus): BoardColumn | null {
  switch (status) {
    case "draft":
    case "refining":
      return "draft";
    case "ready":
      return "ready";
    case "claimed":
    case "in_progress":
      return "in_progress";
    case "blocked":
      return "blocked";
    case "in_review":
      return "in_review";
    case "in_testing":
      return "in_testing";
    case "ready_for_merge":
      return "ready_for_merge";
    case "done":
      return "done";
    case "cancelled":
    case "failed":
      return null;
  }
}

/**
 * Resolve a board-move target into the canonical TicketStatus to transition to.
 * Accepts either a real status or a BoardColumn key. Throws VALIDATION_ERROR for
 * anything that is neither a status nor a column.
 */
export function resolveMoveTarget(target: string): TicketStatus {
  if (isTicketStatus(target)) return target;
  if (isBoardColumn(target)) {
    return target as TicketStatus;
  }
  throw new DispatchError(
    "VALIDATION_ERROR",
    `'${target}' is not a valid status or board column.`,
    { target },
  );
}

/** Start-of-day (UTC) ISO instant for the day containing `nowIso`. */
export function startOfUtcDay(nowIso: string): string {
  const d = new Date(nowIso);
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
  return start.toISOString();
}

/**
 * Median time spent in each state, computed from consecutive transition pairs.
 */
export function cycleTimeByState(transitions: TransitionRow[]): CycleTimeStat[] {
  const durations = new Map<TicketStatus, number[]>();
  let prev: TransitionRow | undefined;
  for (const tr of transitions) {
    if (prev && prev.ticket_id === tr.ticket_id && isTicketStatus(prev.to_status ?? "")) {
      const state = prev.to_status as TicketStatus;
      const ms = Date.parse(tr.created_at) - Date.parse(prev.created_at);
      if (ms >= 0) {
        const ds = durations.get(state) ?? [];
        ds.push(ms);
        durations.set(state, ds);
      }
    }
    prev = tr;
  }
  return TICKET_STATUSES.filter((s) => durations.has(s)).map((status) => {
    const ds = durations.get(status)!;
    return { status, medianMs: medianMs(ds), samples: ds.length };
  });
}

/** Median of a non-empty number array (mean of the two middles when even). */
export function medianMs(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface BoardServiceDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly tickets: TicketRepository;
  readonly acs: AcRepository;
  readonly decisions: DecisionRepository;
  readonly claimsRepo: ClaimRepository;
  readonly events: EventRepository;
}

export class BoardService {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly tickets: TicketRepository;
  private readonly acs: AcRepository;
  private readonly decisions: DecisionRepository;
  private readonly claimsRepo: ClaimRepository;
  private readonly events: EventRepository;

  constructor(deps: BoardServiceDeps) {
    this.db = deps.db;
    this.clock = deps.clock;
    this.tickets = deps.tickets;
    this.acs = deps.acs;
    this.decisions = deps.decisions;
    this.claimsRepo = deps.claimsRepo;
    this.events = deps.events;
  }

  /**
   * Kanban board: every ticket grouped into a fixed set of columns
   * (claimed+in_progress collapse into "in_progress"), each card enriched with
   * AC progress, blocking-decision count and active-claim/lease state.
   * cancelled/failed tickets are returned separately as a "closed" area.
   * Read-only — no mutation.
   *
   * @param repo Optional repository name/id — when supplied, only tickets
   *   linked to that repo are included. Omit (or pass undefined) for the
   *   full board (back-compat).
   */
  board(repo?: string): BoardView {
    const now = this.clock.now();
    const tickets = this.tickets.listFiltered(repo ? { repo } : {});

    // Index active claims by ticket so each card resolves its holder in O(1).
    const claimsByTicket = new Map<string, ActiveClaimView>();
    for (const claim of this.claimsRepo.listActive()) {
      claimsByTicket.set(claim.ticket_id, claim);
    }

    const empty = (): BoardColumnView[] =>
      BOARD_COLUMNS.map((column) => ({ column, cards: [] as BoardCard[] }));
    const columns = empty();
    const byColumn = new Map<BoardColumn, BoardCard[]>(columns.map((c) => [c.column, c.cards]));
    const closed: BoardCard[] = [];
    const wontDo: BoardCard[] = [];

    for (const ticket of tickets) {
      const card = this.toBoardCard(ticket, claimsByTicket.get(ticket.id), now);
      // `cancelled` is the terminal won't-do bucket (reopenable); `failed` stays in
      // the closed area; everything else maps to a live column.
      if (ticket.status === "cancelled") {
        wontDo.push(card);
        continue;
      }
      const column = columnFor(ticket.status);
      if (column === null) {
        closed.push(card);
        continue;
      }
      byColumn.get(column)!.push(card);
    }

    // The `ready_for_merge` column's cards, surfaced as a dedicated array too.
    const readyForMerge = byColumn.get("ready_for_merge") ?? [];

    return { columns, closed, wontDo, readyForMerge };
  }

  /** Build a single board card, computing AC progress + claim/lease state. */
  toBoardCard(ticket: Ticket, claim: ActiveClaimView | undefined, nowIso: string): BoardCard {
    const acs = this.acs.listForTicket(ticket.id);
    const acSatisfied = acs.filter((a) => a.status === "satisfied").length;
    const evidenceRequired = acs.filter((a) => a.evidence_required === 1);
    const acEvidenced = evidenceRequired.filter((a) => a.status === "satisfied").length;
    const blockingCount = this.decisions.blockingForTicket(ticket.id).length;

    const claimCard: BoardCardClaim | null = claim
      ? {
          agentId: claim.agent_id,
          agentDisplayName: claim.agent_display_name,
          expiresAt: claim.expires_at,
          stale: claim.expires_at < nowIso,
        }
      : null;

    return {
      id: ticket.id,
      number: ticket.number,
      title: ticket.title,
      status: ticket.status,
      priority: ticket.priority,
      risk_level: ticket.risk_level,
      updated_at: ticket.updated_at,
      acTotal: acs.length,
      acSatisfied,
      acEvidenced,
      acEvidenceRequired: evidenceRequired.length,
      blockingCount,
      claim: claimCard,
      lastReviewFeedback: parseReviewFeedback(ticket.last_review_feedback),
    };
  }

  /**
   * Cross-ticket activity feed: newest-first page of work_events across all
   * entities, enriched with the ticket number/title where applicable. Returns the
   * page plus the total for simple pagination.
   */
  activity(query: ActivityQuery): { events: ActivityEvent[]; total: number } {
    return {
      events: this.events.listActivity(query),
      total: this.events.countActivity(),
    };
  }

  /** Dashboard summary tiles — counts only, safe to render wholesale. */
  dashboard(): DashboardSummary {
    const now = this.clock.now();
    const startOfToday = startOfUtcDay(now);

    const ticketsByStatus = Object.fromEntries(TICKET_STATUSES.map((s) => [s, 0])) as Record<
      TicketStatus,
      number
    >;
    for (const { status, count } of this.events.ticketCountsByStatus()) {
      if (isTicketStatus(status)) ticketsByStatus[status] = count;
    }

    const activeClaims = this.claimsRepo.listActive();
    const staleClaims = activeClaims.filter((c) => c.expires_at < now).length;

    const transitions = this.events.stateTransitions();

    return {
      ticketsByStatus,
      deliveredToday: this.events.deliveredSince(startOfToday),
      blocked: ticketsByStatus.blocked,
      openDecisions: this.decisions.listPending().length,
      activeClaims: activeClaims.length,
      staleClaims,
      cycleTimeByState: cycleTimeByState(transitions),
      stuckTickets: this.stuckTickets(transitions, now),
      stuckThresholdHours: STUCK_THRESHOLD_HOURS,
      repoProgress: this.repoProgress(),
    };
  }

  /**
   * Per-repository delivery progress, computed from the ticket↔repo links: for
   * each non-hidden repo with at least one linked ticket, how many are done,
   * in flight or blocked, and the done-share. Drives the Overview repo panel.
   */
  private repoProgress(): RepoProgress[] {
    const rows = this.db
      .prepare(
        `SELECT r.name AS repo,
                COUNT(*) AS total,
                SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS done,
                SUM(CASE WHEN t.status IN
                  ('claimed','in_progress','in_review','in_testing','ready_for_merge')
                  THEN 1 ELSE 0 END) AS inflight,
                SUM(CASE WHEN t.status = 'blocked' THEN 1 ELSE 0 END) AS blocked
         FROM repositories r
         JOIN ticket_repos tr ON tr.repo_id = r.id
         JOIN tickets t ON t.id = tr.ticket_id
         WHERE r.hidden = 0
         GROUP BY r.id, r.name
         ORDER BY total DESC, r.name ASC`,
      )
      .all() as Array<{
      repo: string;
      total: number;
      done: number;
      inflight: number;
      blocked: number;
    }>;
    return rows.map((r) => ({
      repo: r.repo,
      total: r.total,
      done: r.done,
      inFlight: r.inflight,
      blocked: r.blocked,
      pct: r.total > 0 ? Math.round((r.done / r.total) * 100) : 0,
    }));
  }

  /**
   * Tickets sitting in a non-terminal state longer than STUCK_THRESHOLD_HOURS.
   */
  private stuckTickets(transitions: TransitionRow[], nowIso: string): StuckTicket[] {
    // Last transition per ticket = when it entered its current state.
    const enteredAt = new Map<string, string>();
    for (const tr of transitions) enteredAt.set(tr.ticket_id, tr.created_at);

    const nowMs = Date.parse(nowIso);
    const thresholdMs = STUCK_THRESHOLD_HOURS * 3_600_000;
    const stuck: StuckTicket[] = [];
    for (const t of this.tickets.listFiltered({})) {
      if (TERMINAL_STATUSES.has(t.status)) continue;
      const since = enteredAt.get(t.id) ?? t.created_at;
      const stuckForMs = nowMs - Date.parse(since);
      if (stuckForMs <= thresholdMs) continue;
      stuck.push({
        id: t.id,
        number: t.number,
        title: t.title,
        status: t.status,
        stuckForMs,
        since,
      });
    }
    return stuck.sort((a, b) => b.stuckForMs - a.stuckForMs);
  }
}

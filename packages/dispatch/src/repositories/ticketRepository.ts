import type { Db } from "../db/connection.js";
import type { RiskLevel, Ticket, TicketStatus } from "../domain/types.js";

/** Optional filters for the human backlog list. */
export interface TicketListFilter {
  status?: TicketStatus | undefined;
  /** Repository name OR id — tickets linked to this repo. */
  repo?: string | undefined;
  risk?: RiskLevel | undefined;
}

/** Data access for tickets and ticket↔repo links. No business rules here. */
export class TicketRepository {
  constructor(private readonly db: Db) {}

  insert(ticket: Ticket): void {
    this.db
      .prepare(
        `INSERT INTO tickets
          (id, number, title, description, status, priority, risk_level, policy_pack,
           source, created_by, reviewer, branch_name, pr_url, attempt_count, row_version,
           scheduled_after, due_at, bootstrap, last_review_feedback, can_be_tested,
           test_contract, human_owner, human_delivered, delivery_budget_usd, created_at, updated_at)
         VALUES
          (@id, @number, @title, @description, @status, @priority, @risk_level, @policy_pack,
           @source, @created_by, @reviewer, @branch_name, @pr_url, @attempt_count, @row_version,
           @scheduled_after, @due_at, @bootstrap, @last_review_feedback, @can_be_tested,
           @test_contract, @human_owner, @human_delivered, @delivery_budget_usd, @created_at, @updated_at)`,
      )
      .run(ticket);
  }

  /** Next ticket number (1-based), computed within the caller's transaction. */
  nextNumber(): number {
    const row = this.db.prepare(`SELECT COALESCE(MAX(number), 0) AS n FROM tickets`).get() as {
      n: number;
    };
    return row.n + 1;
  }

  findById(id: string): Ticket | undefined {
    return this.db.prepare(`SELECT * FROM tickets WHERE id = ?`).get(id) as Ticket | undefined;
  }

  findByNumber(number: number): Ticket | undefined {
    return this.db.prepare(`SELECT * FROM tickets WHERE number = ?`).get(number) as
      | Ticket
      | undefined;
  }

  /**
   * Optimistic-concurrency status update: only succeeds if the row still matches
   * the expected version. Returns true when a row was updated.
   */
  updateStatus(
    id: string,
    toStatus: TicketStatus,
    expectedRowVersion: number,
    patch: Partial<Pick<Ticket, "branch_name" | "pr_url" | "reviewer" | "attempt_count">> = {},
    nowIso: string,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE tickets SET
            status = @status,
            row_version = row_version + 1,
            attempt_count = COALESCE(@attempt_count, attempt_count),
            branch_name = COALESCE(@branch_name, branch_name),
            pr_url = COALESCE(@pr_url, pr_url),
            reviewer = COALESCE(@reviewer, reviewer),
            updated_at = @updated_at
         WHERE id = @id AND row_version = @expected_row_version`,
      )
      .run({
        id,
        status: toStatus,
        expected_row_version: expectedRowVersion,
        attempt_count: patch.attempt_count ?? null,
        branch_name: patch.branch_name ?? null,
        pr_url: patch.pr_url ?? null,
        reviewer: patch.reviewer ?? null,
        updated_at: nowIso,
      });
    return result.changes === 1;
  }

  /**
   * Set (or, with `null`, clear) the ticket's `last_review_feedback` (WG-049).
   * A plain write — no row_version bump — since callers run it inside the same
   * transaction as the guarded status change it accompanies (reject sets it;
   * entering `in_review` clears it).
   */
  setReviewFeedback(id: string, value: string | null): void {
    this.db
      .prepare(`UPDATE tickets SET last_review_feedback = @value WHERE id = @id`)
      .run({ id, value });
  }

  /**
   * TRACK-2b: set (or, with `null`, clear) the ticket's `human_owner` marker. A
   * plain write — no row_version bump — since callers run it inside the same
   * transaction as the guarded status change it accompanies (the human-claim path
   * stamps it right after `ready -> in_progress`; the transition service clears it
   * whenever a human-owned ticket leaves `in_progress`).
   */
  setHumanOwner(id: string, value: string | null): void {
    this.db.prepare(`UPDATE tickets SET human_owner = @value WHERE id = @id`).run({ id, value });
  }

  /**
   * TRACK-2b: set (or, with `null`, clear) the ticket's durable `human_delivered`
   * marker. A plain write — no row_version bump — since callers run it inside the
   * same transaction as the guarded status change it accompanies (the transition
   * service stamps it when a human-owned ticket submits `in_progress -> in_review`
   * and clears it whenever the ticket re-enters the delivery pipeline).
   */
  setHumanDelivered(id: string, value: string | null): void {
    this.db
      .prepare(`UPDATE tickets SET human_delivered = @value WHERE id = @id`)
      .run({ id, value });
  }

  /**
   * TRACK-3a: set (or, with `null`, clear) the ticket's per-ticket delivery-budget
   * ceiling in USD. A plain write — no row_version bump — since the budget is
   * independent of the status machine (it only bounds cumulative delivery spend).
   */
  setDeliveryBudget(id: string, value: number | null, nowIso: string): void {
    this.db
      .prepare(`UPDATE tickets SET delivery_budget_usd = @value, updated_at = @now WHERE id = @id`)
      .run({ id, value, now: nowIso });
  }

  /** True when the ticket currently has any active claim (TRACK-2b reuse guard). */
  hasActiveClaim(id: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM ticket_claims WHERE ticket_id = ? AND status = 'active' LIMIT 1`)
      .get(id);
    return row !== undefined;
  }

  /**
   * BBT-001: set the ticket's `can_be_tested` flag (0/1). A plain write — no
   * row_version bump — since it is independent of the status machine (it only
   * GATES future transitions); callers run it inside their own transaction.
   */
  setCanBeTested(id: string, value: boolean, nowIso: string): void {
    this.db
      .prepare(`UPDATE tickets SET can_be_tested = @value, updated_at = @now WHERE id = @id`)
      .run({ id, value: value ? 1 : 0, now: nowIso });
  }

  /**
   * BBT-001: set (or, with `null`, clear) the ticket's `test_contract` JSON. A
   * plain write — no row_version bump — for the same reason as
   * {@link setCanBeTested}: the contract is handover metadata, not a status change.
   */
  setTestContract(id: string, value: string | null, nowIso: string): void {
    this.db
      .prepare(`UPDATE tickets SET test_contract = @value, updated_at = @now WHERE id = @id`)
      .run({ id, value, now: nowIso });
  }

  list(status?: TicketStatus): Ticket[] {
    if (status) {
      return this.db
        .prepare(`SELECT * FROM tickets WHERE status = ? ORDER BY priority DESC, created_at ASC`)
        .all(status) as Ticket[];
    }
    return this.db
      .prepare(`SELECT * FROM tickets ORDER BY priority DESC, created_at ASC`)
      .all() as Ticket[];
  }

  /**
   * Filtered backlog list. `repo` matches a linked repository by name or id.
   * Conditions are ANDed; an absent filter is ignored.
   */
  listFiltered(filter: TicketListFilter): Ticket[] {
    const where: string[] = [];
    const params: Record<string, string> = {};
    if (filter.status) {
      where.push("t.status = @status");
      params.status = filter.status;
    }
    if (filter.risk) {
      where.push("t.risk_level = @risk");
      params.risk = filter.risk;
    }
    if (filter.repo) {
      where.push(
        `EXISTS (
           SELECT 1 FROM ticket_repos tr
           JOIN repositories r ON r.id = tr.repo_id
           WHERE tr.ticket_id = t.id AND (r.name = @repo OR r.id = @repo)
         )`,
      );
      params.repo = filter.repo;
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    return this.db
      .prepare(`SELECT t.* FROM tickets t ${clause} ORDER BY t.priority DESC, t.created_at ASC`)
      .all(params) as Ticket[];
  }
}

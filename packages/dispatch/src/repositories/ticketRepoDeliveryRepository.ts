import type { Db } from "../db/connection.js";
import type { Repository, TicketRepoDelivery, TicketRepoDeliveryStatus } from "../domain/types.js";

/** A delivery row joined to its repository (for the per-repo delivery list). */
export type TicketRepoDeliveryWithRepo = TicketRepoDelivery & {
  repo_name: string;
};

/** Fields used to upsert a per-(ticket,repo) delivery artifact (WG-005). */
export interface TicketRepoDeliveryUpsert {
  ticketId: string;
  repoId: string;
  branchName: string | null;
  commitSha: string | null;
  prUrl: string | null;
  status: TicketRepoDeliveryStatus;
  evidenceRef: string | null;
}

/** Data access for ticket_repo_delivery (WG-005 per-repo delivery artifacts). */
export class TicketRepoDeliveryRepository {
  constructor(private readonly db: Db) {}

  /**
   * Upsert a per-(ticket,repo) delivery row. The (ticket_id, repo_id) PK makes
   * this idempotent: re-recording the same repo PATCHES only the columns the
   * caller supplied — a `null` field leaves the stored value untouched via
   * COALESCE, so an early branch row is enriched (commit/pr/status/evidence) on
   * later calls rather than being clobbered. `created_at` is preserved on update.
   */
  upsert(input: TicketRepoDeliveryUpsert, nowIso: string): void {
    this.db
      .prepare(
        `INSERT INTO ticket_repo_delivery
          (ticket_id, repo_id, branch_name, commit_sha, pr_url, status, evidence_ref,
           created_at, updated_at)
         VALUES
          (@ticket_id, @repo_id, @branch_name, @commit_sha, @pr_url, @status, @evidence_ref,
           @now, @now)
         ON CONFLICT(ticket_id, repo_id) DO UPDATE SET
           branch_name  = COALESCE(excluded.branch_name, branch_name),
           commit_sha   = COALESCE(excluded.commit_sha, commit_sha),
           pr_url       = COALESCE(excluded.pr_url, pr_url),
           status       = excluded.status,
           evidence_ref = COALESCE(excluded.evidence_ref, evidence_ref),
           updated_at   = excluded.updated_at`,
      )
      .run({
        ticket_id: input.ticketId,
        repo_id: input.repoId,
        branch_name: input.branchName,
        commit_sha: input.commitSha,
        pr_url: input.prUrl,
        status: input.status,
        evidence_ref: input.evidenceRef,
        now: nowIso,
      });
  }

  find(ticketId: string, repoId: string): TicketRepoDelivery | undefined {
    return this.db
      .prepare(`SELECT * FROM ticket_repo_delivery WHERE ticket_id = ? AND repo_id = ?`)
      .get(ticketId, repoId) as TicketRepoDelivery | undefined;
  }

  /** All delivery rows for a ticket joined to the repo name, oldest first. */
  listForTicket(ticketId: string): TicketRepoDeliveryWithRepo[] {
    return this.db
      .prepare(
        `SELECT d.*, r.name AS repo_name
         FROM ticket_repo_delivery d JOIN repositories r ON r.id = d.repo_id
         WHERE d.ticket_id = ?
         ORDER BY d.created_at ASC, r.name ASC`,
      )
      .all(ticketId) as TicketRepoDeliveryWithRepo[];
  }

  /** True when the named repo is linked to the ticket via ticket_repos. */
  isRepoLinkedToTicket(ticketId: string, repoId: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM ticket_repos WHERE ticket_id = ? AND repo_id = ? LIMIT 1`)
      .get(ticketId, repoId);
    return row !== undefined;
  }

  /** Repos (id+name) the ticket would deliver into, joined for a status roll-up. */
  reposForTicket(ticketId: string): Array<Pick<Repository, "id" | "name">> {
    return this.db
      .prepare(
        `SELECT r.id AS id, r.name AS name
         FROM ticket_repos tr JOIN repositories r ON r.id = tr.repo_id
         WHERE tr.ticket_id = ?`,
      )
      .all(ticketId) as Array<Pick<Repository, "id" | "name">>;
  }
}

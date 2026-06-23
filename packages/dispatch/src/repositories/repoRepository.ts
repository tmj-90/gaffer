import type { Db } from "../db/connection.js";
import type {
  Repository,
  TicketRepoAccess,
  TicketRepoRelation,
  TicketRepoSource,
} from "../domain/types.js";

/** A ticket↔repo link joined to the repo, carrying the WG-002 access boundary. */
export type TicketRepoLink = Repository & {
  role: string;
  access: TicketRepoAccess;
  relation: TicketRepoRelation;
  source: TicketRepoSource;
  confidence: number | null;
  reasons_json: string | null;
};

/** Fields used to upsert a ticket↔repo access boundary (WG-002). */
export interface TicketRepoAccessUpsert {
  ticketId: string;
  repoId: string;
  access: TicketRepoAccess;
  relation: TicketRepoRelation;
  source: TicketRepoSource;
  confidence: number | null;
  reasons: string | null;
}

/** Data access for repositories and ticket↔repo links. */
export class RepoRepository {
  constructor(private readonly db: Db) {}

  insert(repo: Repository): void {
    this.db
      .prepare(
        `INSERT INTO repositories
          (id, name, local_path, remote_url, default_branch, stack, risk_level,
           test_command, lint_command, coverage_command, created_at, updated_at)
         VALUES
          (@id, @name, @local_path, @remote_url, @default_branch, @stack, @risk_level,
           @test_command, @lint_command, @coverage_command, @created_at, @updated_at)`,
      )
      .run(repo);
  }

  findById(id: string): Repository | undefined {
    return this.db.prepare(`SELECT * FROM repositories WHERE id = ?`).get(id) as
      | Repository
      | undefined;
  }

  findByName(name: string): Repository | undefined {
    return this.db.prepare(`SELECT * FROM repositories WHERE name = ?`).get(name) as
      | Repository
      | undefined;
  }

  /**
   * Registered repositories ordered by name. WG-006: hidden repos are excluded by
   * default; pass `includeHidden` to get every repo (used by the "Hidden repos"
   * page and any caller that genuinely needs the full set).
   */
  list(includeHidden = false): Repository[] {
    const where = includeHidden ? "" : "WHERE hidden = 0";
    return this.db
      .prepare(`SELECT * FROM repositories ${where} ORDER BY name ASC`)
      .all() as Repository[];
  }

  /** Only the hidden repositories, ordered by name (for the "Hidden repos" page). */
  listHidden(): Repository[] {
    return this.db
      .prepare(`SELECT * FROM repositories WHERE hidden = 1 ORDER BY name ASC`)
      .all() as Repository[];
  }

  /** Set (or clear) a repo's hidden flag and bump updated_at. Idempotent. */
  setHidden(repoId: string, hidden: boolean, nowIso: string): void {
    this.db
      .prepare(`UPDATE repositories SET hidden = ?, updated_at = ? WHERE id = ?`)
      .run(hidden ? 1 : 0, nowIso, repoId);
  }

  linkTicket(ticketId: string, repoId: string, role: string, nowIso: string): void {
    this.db
      .prepare(
        `INSERT INTO ticket_repos (ticket_id, repo_id, role, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(ticket_id, repo_id) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at`,
      )
      .run(ticketId, repoId, role, nowIso, nowIso);
  }

  listForTicket(ticketId: string): TicketRepoLink[] {
    return this.db
      .prepare(
        `SELECT r.*, tr.role AS role, tr.access AS access, tr.relation AS relation,
                tr.source AS source, tr.confidence AS confidence, tr.reasons_json AS reasons_json
         FROM ticket_repos tr JOIN repositories r ON r.id = tr.repo_id
         WHERE tr.ticket_id = ? ORDER BY tr.role ASC, r.name ASC`,
      )
      .all(ticketId) as TicketRepoLink[];
  }

  countForTicket(ticketId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM ticket_repos WHERE ticket_id = ?`)
      .get(ticketId) as { n: number };
    return row.n;
  }

  /**
   * Upsert a ticket↔repo access boundary (WG-002). Inserts a new link or patches
   * the access/relation/source/confidence/reasons of an existing one, preserving
   * the legacy role/branch/status columns. The (ticket_id, repo_id) PK makes this
   * idempotent.
   */
  upsertAccess(input: TicketRepoAccessUpsert, nowIso: string): void {
    this.db
      .prepare(
        `INSERT INTO ticket_repos
          (ticket_id, repo_id, access, relation, source, confidence, reasons_json, created_at, updated_at)
         VALUES
          (@ticket_id, @repo_id, @access, @relation, @source, @confidence, @reasons_json, @now, @now)
         ON CONFLICT(ticket_id, repo_id) DO UPDATE SET
           access = excluded.access,
           relation = excluded.relation,
           source = excluded.source,
           confidence = excluded.confidence,
           reasons_json = excluded.reasons_json,
           updated_at = excluded.updated_at`,
      )
      .run({
        ticket_id: input.ticketId,
        repo_id: input.repoId,
        access: input.access,
        relation: input.relation,
        source: input.source,
        confidence: input.confidence,
        reasons_json: input.reasons,
        now: nowIso,
      });
  }

  /** All ticket↔repo links with their access boundary (for the work packet). */
  accessLinksForTicket(ticketId: string): TicketRepoLink[] {
    return this.listForTicket(ticketId);
  }

  /**
   * The per-repo delivery branch recorded directly on the ticket_repos link
   * (`tr.branch_name`), if any. This is the legacy/back-compat column the runner
   * trusts first when resolving a delivery branch; callers fall back to the
   * ticket's top-level `branch_name` when this is null. Returns undefined when no
   * link exists for the pair.
   */
  ticketRepoBranch(ticketId: string, repoId: string): string | null | undefined {
    const row = this.db
      .prepare(`SELECT branch_name FROM ticket_repos WHERE ticket_id = ? AND repo_id = ?`)
      .get(ticketId, repoId) as { branch_name: string | null } | undefined;
    return row === undefined ? undefined : row.branch_name;
  }
}

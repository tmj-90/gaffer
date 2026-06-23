import type { Db } from "../db/connection.js";
import type { Repository, ScopeNode, ScopeRepo, ScopeRepoRelation } from "../domain/types.js";

/** A repo linked to a scope, joined to the full repository row. */
export type ScopeRepoWithRepo = Repository & {
  association_id: string;
  relation: ScopeRepoRelation;
  default_access: string;
  confidence: number | null;
  role_description: string | null;
};

/** A scope a repo belongs to, joined to the full scope-node row. */
export type RepoScopeWithNode = ScopeNode & {
  association_id: string;
  relation: ScopeRepoRelation;
  default_access: string;
  confidence: number | null;
  role_description: string | null;
};

/** Data access for scope_repos (the many-to-many scope↔repo mapping). */
export class ScopeRepoRepository {
  constructor(private readonly db: Db) {}

  insert(link: ScopeRepo): void {
    this.db
      .prepare(
        `INSERT INTO scope_repos
          (id, scope_node_id, repo_id, relation, default_access, confidence,
           role_description, reasons_json, created_at, updated_at)
         VALUES
          (@id, @scope_node_id, @repo_id, @relation, @default_access, @confidence,
           @role_description, @reasons_json, @created_at, @updated_at)`,
      )
      .run(link);
  }

  findById(id: string): ScopeRepo | undefined {
    return this.db.prepare(`SELECT * FROM scope_repos WHERE id = ?`).get(id) as
      | ScopeRepo
      | undefined;
  }

  exists(scopeNodeId: string, repoId: string, relation: ScopeRepoRelation): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM scope_repos WHERE scope_node_id = ? AND repo_id = ? AND relation = ?`)
      .get(scopeNodeId, repoId, relation);
    return row !== undefined;
  }

  /** Count associations for a scope node — used to block node deletion. */
  countForNode(scopeNodeId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM scope_repos WHERE scope_node_id = ?`)
      .get(scopeNodeId) as { n: number };
    return row.n;
  }

  update(id: string, fields: Partial<ScopeRepo>, nowIso: string): void {
    const allowed: Array<keyof ScopeRepo> = [
      "default_access",
      "confidence",
      "role_description",
      "reasons_json",
    ];
    const sets: string[] = [];
    const params: Record<string, unknown> = { id, updated_at: nowIso };
    for (const key of allowed) {
      if (key in fields) {
        sets.push(`${key} = @${key}`);
        params[key] = fields[key] ?? null;
      }
    }
    sets.push(`updated_at = @updated_at`);
    this.db.prepare(`UPDATE scope_repos SET ${sets.join(", ")} WHERE id = @id`).run(params);
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM scope_repos WHERE id = ?`).run(id);
  }

  /** Repos linked to a scope node, with each association's relation + access. */
  reposForScope(scopeNodeId: string): ScopeRepoWithRepo[] {
    return this.db
      .prepare(
        `SELECT r.*, sr.id AS association_id, sr.relation AS relation,
                sr.default_access AS default_access, sr.confidence AS confidence,
                sr.role_description AS role_description
         FROM scope_repos sr JOIN repositories r ON r.id = sr.repo_id
         WHERE sr.scope_node_id = ?
         ORDER BY sr.relation ASC, r.name ASC`,
      )
      .all(scopeNodeId) as ScopeRepoWithRepo[];
  }

  /** Scope nodes a repo belongs to, with each association's relation + access. */
  scopesForRepo(repoId: string): RepoScopeWithNode[] {
    return this.db
      .prepare(
        `SELECT n.*, sr.id AS association_id, sr.relation AS relation,
                sr.default_access AS default_access, sr.confidence AS confidence,
                sr.role_description AS role_description
         FROM scope_repos sr JOIN scope_nodes n ON n.id = sr.scope_node_id
         WHERE sr.repo_id = ?
         ORDER BY n.type ASC, n.name ASC`,
      )
      .all(repoId) as RepoScopeWithNode[];
  }

  /**
   * Repositories with NO scope_repos row — implicit single-repo scopes. WG-006:
   * hidden repos are excluded by default (so a hidden repo disappears from the
   * Factory Map's unmapped list); pass `includeHidden` to get every unmapped repo.
   */
  listUnmappedRepos(includeHidden = false): Repository[] {
    const hiddenClause = includeHidden ? "" : "AND r.hidden = 0";
    return this.db
      .prepare(
        `SELECT r.* FROM repositories r
         WHERE NOT EXISTS (SELECT 1 FROM scope_repos sr WHERE sr.repo_id = r.id)
         ${hiddenClause}
         ORDER BY r.name ASC`,
      )
      .all() as Repository[];
  }
}

import type { Db } from "../db/connection.js";
import type { ScopeNode } from "../domain/types.js";

/** Data access for scope_nodes (Factory Map product/system areas). */
export class ScopeNodeRepository {
  constructor(private readonly db: Db) {}

  insert(node: ScopeNode): void {
    this.db
      .prepare(
        `INSERT INTO scope_nodes
          (id, name, type, description, risk_level, owner, tags_json, lore_tags_json,
           created_at, updated_at)
         VALUES
          (@id, @name, @type, @description, @risk_level, @owner, @tags_json, @lore_tags_json,
           @created_at, @updated_at)`,
      )
      .run(node);
  }

  findById(id: string): ScopeNode | undefined {
    return this.db.prepare(`SELECT * FROM scope_nodes WHERE id = ?`).get(id) as
      | ScopeNode
      | undefined;
  }

  /** Newest-defined first within a type isn't meaningful; order by name for the UI. */
  list(): ScopeNode[] {
    return this.db
      .prepare(`SELECT * FROM scope_nodes ORDER BY type ASC, name ASC`)
      .all() as ScopeNode[];
  }

  /**
   * Apply a partial update. `fields` keys must be column names; an empty patch
   * still bumps updated_at. Returns the refreshed row.
   */
  update(id: string, fields: Partial<ScopeNode>, nowIso: string): void {
    const allowed: Array<keyof ScopeNode> = [
      "name",
      "type",
      "description",
      "risk_level",
      "owner",
      "tags_json",
      "lore_tags_json",
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
    this.db.prepare(`UPDATE scope_nodes SET ${sets.join(", ")} WHERE id = @id`).run(params);
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM scope_nodes WHERE id = ?`).run(id);
  }
}

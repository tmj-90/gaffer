import type { Db } from "../db/connection.js";
import type { Spec, SpecStatus } from "../domain/types.js";

/**
 * Data access for specs (Spec-Driven Development, Phase 1a). Pure persistence —
 * the draft-only / immutable-after-freeze invariants live in {@link SpecsService},
 * mirroring how {@link AcRepository} leaves status rules to its service.
 */
export class SpecRepository {
  constructor(private readonly db: Db) {}

  insert(spec: Spec): void {
    this.db
      .prepare(
        `INSERT INTO specs
          (id, title, brief, clauses_json, status, target_repo, scope_node_id,
           created_at, updated_at, frozen_at)
         VALUES
          (@id, @title, @brief, @clauses_json, @status, @target_repo, @scope_node_id,
           @created_at, @updated_at, @frozen_at)`,
      )
      .run(spec);
  }

  findById(id: string): Spec | undefined {
    return this.db.prepare(`SELECT * FROM specs WHERE id = ?`).get(id) as Spec | undefined;
  }

  /** All specs newest-first, optionally filtered by status. */
  list(status?: SpecStatus): Spec[] {
    if (status !== undefined) {
      return this.db
        .prepare(`SELECT * FROM specs WHERE status = ? ORDER BY created_at DESC`)
        .all(status) as Spec[];
    }
    return this.db.prepare(`SELECT * FROM specs ORDER BY created_at DESC`).all() as Spec[];
  }

  /** Replace a spec's clauses. The service gates this to `draft` specs only. */
  updateClauses(id: string, clausesJson: string, nowIso: string): void {
    this.db
      .prepare(`UPDATE specs SET clauses_json = @clauses_json, updated_at = @now WHERE id = @id`)
      .run({ id, clauses_json: clausesJson, now: nowIso });
  }

  /** Freeze a spec (draft→frozen): stamp status + frozen_at. Service gates to draft. */
  freeze(id: string, nowIso: string): void {
    this.db
      .prepare(
        `UPDATE specs SET status = 'frozen', frozen_at = @now, updated_at = @now WHERE id = @id`,
      )
      .run({ id, now: nowIso });
  }

  /** Mark a spec superseded (a newer spec replaced it). */
  markSuperseded(id: string, nowIso: string): void {
    this.db
      .prepare(`UPDATE specs SET status = 'superseded', updated_at = @now WHERE id = @id`)
      .run({ id, now: nowIso });
  }
}

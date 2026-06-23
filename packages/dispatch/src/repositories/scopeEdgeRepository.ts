import type { Db } from "../db/connection.js";
import type { ScopeEdge, ScopeEdgeRelation } from "../domain/types.js";

/** Data access for scope_edges (the directed graph between scope nodes). */
export class ScopeEdgeRepository {
  constructor(private readonly db: Db) {}

  insert(edge: ScopeEdge): void {
    this.db
      .prepare(
        `INSERT INTO scope_edges
          (id, from_node_id, to_node_id, relation, confidence, reasons_json, created_at)
         VALUES
          (@id, @from_node_id, @to_node_id, @relation, @confidence, @reasons_json, @created_at)`,
      )
      .run(edge);
  }

  findById(id: string): ScopeEdge | undefined {
    return this.db.prepare(`SELECT * FROM scope_edges WHERE id = ?`).get(id) as
      | ScopeEdge
      | undefined;
  }

  exists(fromNodeId: string, toNodeId: string, relation: ScopeEdgeRelation): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM scope_edges WHERE from_node_id = ? AND to_node_id = ? AND relation = ?`,
      )
      .get(fromNodeId, toNodeId, relation);
    return row !== undefined;
  }

  /** All edges, optionally filtered to those touching `nodeId` (either end). */
  list(nodeId?: string): ScopeEdge[] {
    if (nodeId) {
      return this.db
        .prepare(
          `SELECT * FROM scope_edges
           WHERE from_node_id = ? OR to_node_id = ?
           ORDER BY created_at ASC`,
        )
        .all(nodeId, nodeId) as ScopeEdge[];
    }
    return this.db
      .prepare(`SELECT * FROM scope_edges ORDER BY created_at ASC`)
      .all() as ScopeEdge[];
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM scope_edges WHERE id = ?`).run(id);
  }
}

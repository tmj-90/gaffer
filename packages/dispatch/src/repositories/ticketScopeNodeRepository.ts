import type { Db } from "../db/connection.js";
import type { ScopeNode, TicketScopeNode, TicketScopeRelation } from "../domain/types.js";

/** A ticket↔scope link joined to the full scope-node row (for ticket detail). */
export type TicketScopeWithNode = ScopeNode & {
  relation: TicketScopeRelation;
  confidence: number | null;
  reasons_json: string | null;
};

/** Data access for ticket_scope_nodes (WG-001 ticket↔scope links). */
export class TicketScopeNodeRepository {
  constructor(private readonly db: Db) {}

  /**
   * Upsert a ticket↔scope link. The (ticket_id, scope_node_id) pair is unique, so
   * re-linking the same node updates its relation/confidence/reasons rather than
   * inserting a duplicate.
   */
  upsert(link: TicketScopeNode): void {
    this.db
      .prepare(
        `INSERT INTO ticket_scope_nodes
          (ticket_id, scope_node_id, relation, confidence, reasons_json, created_at, updated_at)
         VALUES
          (@ticket_id, @scope_node_id, @relation, @confidence, @reasons_json, @created_at, @updated_at)
         ON CONFLICT(ticket_id, scope_node_id) DO UPDATE SET
           relation = excluded.relation,
           confidence = excluded.confidence,
           reasons_json = excluded.reasons_json,
           updated_at = excluded.updated_at`,
      )
      .run(link);
  }

  find(ticketId: string, scopeNodeId: string): TicketScopeNode | undefined {
    return this.db
      .prepare(`SELECT * FROM ticket_scope_nodes WHERE ticket_id = ? AND scope_node_id = ?`)
      .get(ticketId, scopeNodeId) as TicketScopeNode | undefined;
  }

  /** Set every existing 'primary' link on a ticket back to 'secondary'. */
  demotePrimaries(ticketId: string, nowIso: string): void {
    this.db
      .prepare(
        `UPDATE ticket_scope_nodes SET relation = 'secondary', updated_at = ?
         WHERE ticket_id = ? AND relation = 'primary'`,
      )
      .run(nowIso, ticketId);
  }

  /** The ticket's current primary scope link, if any. */
  findPrimary(ticketId: string): TicketScopeNode | undefined {
    return this.db
      .prepare(
        `SELECT * FROM ticket_scope_nodes WHERE ticket_id = ? AND relation = 'primary' LIMIT 1`,
      )
      .get(ticketId) as TicketScopeNode | undefined;
  }

  delete(ticketId: string, scopeNodeId: string): void {
    this.db
      .prepare(`DELETE FROM ticket_scope_nodes WHERE ticket_id = ? AND scope_node_id = ?`)
      .run(ticketId, scopeNodeId);
  }

  /** All scope links for a ticket joined to the node, primary first then by name. */
  listForTicket(ticketId: string): TicketScopeWithNode[] {
    return this.db
      .prepare(
        `SELECT n.*, tsn.relation AS relation, tsn.confidence AS confidence,
                tsn.reasons_json AS reasons_json
         FROM ticket_scope_nodes tsn JOIN scope_nodes n ON n.id = tsn.scope_node_id
         WHERE tsn.ticket_id = ?
         ORDER BY CASE tsn.relation WHEN 'primary' THEN 0 WHEN 'secondary' THEN 1
                                    WHEN 'suggested' THEN 2 WHEN 'implicit_repo' THEN 3
                                    ELSE 4 END,
                  n.name ASC`,
      )
      .all(ticketId) as TicketScopeWithNode[];
  }

  /** Count links for a scope node — used to block node deletion (see core.ts). */
  countForNode(scopeNodeId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM ticket_scope_nodes WHERE scope_node_id = ?`)
      .get(scopeNodeId) as { n: number };
    return row.n;
  }
}

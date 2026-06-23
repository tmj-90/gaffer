import type { Db } from "../db/connection.js";

/**
 * Data access for `ticket_required_capabilities` — the capabilities a ticket
 * demands of any claiming agent. No business rules here; eligibility is enforced
 * in the claim path (see ClaimService / ClaimRepository.candidateTickets).
 */
export class RequiredCapabilityRepository {
  constructor(private readonly db: Db) {}

  /** Capabilities required by a ticket, alphabetically ordered. */
  listForTicket(ticketId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT capability FROM ticket_required_capabilities
         WHERE ticket_id = ? ORDER BY capability ASC`,
      )
      .all(ticketId) as Array<{ capability: string }>;
    return rows.map((r) => r.capability);
  }

  /**
   * Replace the full set of required capabilities for a ticket. Runs delete +
   * inserts; callers should wrap in a transaction with the surrounding event.
   * Duplicate capabilities in the input are de-duplicated by the primary key.
   */
  setForTicket(ticketId: string, capabilities: readonly string[]): void {
    this.db.prepare(`DELETE FROM ticket_required_capabilities WHERE ticket_id = ?`).run(ticketId);
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO ticket_required_capabilities (ticket_id, capability) VALUES (?, ?)`,
    );
    for (const capability of capabilities) {
      insert.run(ticketId, capability);
    }
  }
}

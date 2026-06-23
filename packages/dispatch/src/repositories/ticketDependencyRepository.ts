import type { Db } from "../db/connection.js";
import type { TicketDependency, TicketDependencyView } from "../domain/types.js";

/**
 * Data access for ticket_dependencies (EP-001). No business rules here — the
 * cycle guard and self-dependency rejection live in the core facade. A row means
 * "`ticket_id` must wait for `depends_on_ticket_id` to be done before it can be
 * claimed".
 */
export class TicketDependencyRepository {
  constructor(private readonly db: Db) {}

  /** Insert a dependency edge. The (ticket, depends_on) pair is the primary key. */
  insert(dep: TicketDependency): void {
    this.db
      .prepare(
        `INSERT INTO ticket_dependencies (ticket_id, depends_on_ticket_id, created_at)
         VALUES (@ticket_id, @depends_on_ticket_id, @created_at)`,
      )
      .run(dep);
  }

  /** True when this exact dependency edge already exists. */
  exists(ticketId: string, dependsOnTicketId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM ticket_dependencies
         WHERE ticket_id = ? AND depends_on_ticket_id = ?`,
      )
      .get(ticketId, dependsOnTicketId);
    return row !== undefined;
  }

  /** Delete one dependency edge. Returns true when a row was removed. */
  delete(ticketId: string, dependsOnTicketId: string): boolean {
    const result = this.db
      .prepare(
        `DELETE FROM ticket_dependencies
         WHERE ticket_id = ? AND depends_on_ticket_id = ?`,
      )
      .run(ticketId, dependsOnTicketId);
    return result.changes === 1;
  }

  /** The ids this ticket depends on (the tickets that must be done first). */
  dependsOn(ticketId: string): string[] {
    return (
      this.db
        .prepare(`SELECT depends_on_ticket_id FROM ticket_dependencies WHERE ticket_id = ?`)
        .all(ticketId) as Array<{ depends_on_ticket_id: string }>
    ).map((r) => r.depends_on_ticket_id);
  }

  /**
   * This ticket's dependencies joined to the depended-on ticket's number/title/
   * status, with a `satisfied` flag (the depended-on ticket is `done`). Ordered
   * by the depended-on ticket's number so the read surface is stable. Used by
   * `ticket show` / get_ticket and the blocked-by reason.
   */
  listForTicket(ticketId: string): TicketDependencyView[] {
    return this.db
      .prepare(
        `SELECT
            d.depends_on_ticket_id           AS depends_on_ticket_id,
            t.number                         AS number,
            t.title                          AS title,
            t.status                         AS status,
            CASE WHEN t.status = 'done' THEN 1 ELSE 0 END AS satisfied_int
         FROM ticket_dependencies d
         JOIN tickets t ON t.id = d.depends_on_ticket_id
         WHERE d.ticket_id = ?
         ORDER BY t.number ASC`,
      )
      .all(ticketId)
      .map((row) => {
        const r = row as {
          depends_on_ticket_id: string;
          number: number | null;
          title: string;
          status: TicketDependencyView["status"];
          satisfied_int: number;
        };
        return {
          depends_on_ticket_id: r.depends_on_ticket_id,
          number: r.number,
          title: r.title,
          status: r.status,
          satisfied: r.satisfied_int === 1,
        };
      });
  }

  /**
   * The depended-on tickets that are NOT yet `done` — i.e. the edges still
   * blocking this ticket from being claimed. Empty ⇒ dependency-clear. Used to
   * build the `DEPENDENCY_BLOCKED` error's "blocked by #N" reason.
   */
  unsatisfiedDependencies(ticketId: string): TicketDependencyView[] {
    return this.listForTicket(ticketId).filter((d) => !d.satisfied);
  }

  /** Whether `ticketId` has at least one not-yet-`done` dependency. */
  hasUnsatisfiedDependencies(ticketId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM ticket_dependencies d
         JOIN tickets t ON t.id = d.depends_on_ticket_id
         WHERE d.ticket_id = ? AND t.status <> 'done'
         LIMIT 1`,
      )
      .get(ticketId);
    return row !== undefined;
  }
}

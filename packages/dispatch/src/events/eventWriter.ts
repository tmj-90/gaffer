import { inTransaction, type Db } from "../db/connection.js";
import type { Actor, WorkEvent } from "../domain/types.js";
import { newId } from "../util/id.js";
import { eventHash, latestEventHash } from "./eventChain.js";

export interface WriteEventInput {
  entity_type: string;
  entity_id: string;
  actor: Actor;
  event_type: string;
  payload?: unknown;
  correlation_id?: string;
}

/**
 * Append a row to the work_events log. Append-only by convention — nothing in the
 * codebase updates or deletes events — and TAMPER-EVIDENT by construction: each
 * row links to its predecessor through a SHA-256 hash chain (see eventChain.ts).
 * The read-latest + insert pair runs in an IMMEDIATE transaction (a savepoint
 * when the caller already holds one) so two writers cannot fork the chain.
 * Returns the new event id so write paths can surface it to callers (CLI / MCP).
 */
export function writeEvent(db: Db, input: WriteEventInput): string {
  const id = newId();
  const fields = {
    id,
    entity_type: input.entity_type,
    entity_id: input.entity_id,
    actor_type: input.actor.type,
    actor_id: input.actor.id ?? null,
    event_type: input.event_type,
    payload_json: input.payload === undefined ? null : JSON.stringify(input.payload),
    correlation_id: input.correlation_id ?? null,
    // Explicit (not the column default) because the hash covers it — the same
    // `YYYY-MM-DDTHH:MM:SS.mmmZ` shape strftime('%Y-%m-%dT%H:%M:%fZ') produced.
    created_at: new Date().toISOString(),
  };
  inTransaction(db, () => {
    const prev_hash = latestEventHash(db);
    const hash = eventHash(prev_hash, fields);
    db.prepare(
      `INSERT INTO work_events (id, entity_type, entity_id, actor_type, actor_id, event_type, payload_json, correlation_id, created_at, prev_hash, hash)
       VALUES (@id, @entity_type, @entity_id, @actor_type, @actor_id, @event_type, @payload_json, @correlation_id, @created_at, @prev_hash, @hash)`,
    ).run({ ...fields, prev_hash, hash });
  });
  return id;
}

export function listEvents(db: Db, entityType: string, entityId: string): WorkEvent[] {
  // Order by rowid (insertion order) — created_at can tie at sub-ms resolution.
  return db
    .prepare(`SELECT * FROM work_events WHERE entity_type = ? AND entity_id = ? ORDER BY rowid ASC`)
    .all(entityType, entityId) as WorkEvent[];
}

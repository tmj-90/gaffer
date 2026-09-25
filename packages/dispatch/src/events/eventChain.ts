import { createHash } from "node:crypto";

import type { Db } from "../db/connection.js";

/**
 * TAMPER-EVIDENT EVENT LOG — a SHA-256 hash chain over `work_events`.
 *
 * `work_events` is append-only by convention: nothing in the codebase updates or
 * deletes a row. Convention is not evidence, though — an operator with the sqlite
 * file (or a bug) can rewrite a `ticket.transitioned` payload and the board, the
 * cycle-time rollup and the graduated-autonomy recommendations silently follow.
 *
 * Every event now carries `prev_hash` (the previous row's `hash`, or the genesis
 * constant for the first row) and `hash = sha256(prev_hash ‖ the row's own
 * fields)`. Rewriting, deleting or re-ordering any row breaks every hash after
 * it; {@link verifyEventChain} walks the log in rowid order and names the first
 * broken row. `dispatch events verify` and `dispatch doctor` expose it.
 *
 * The hash covers exactly the columns the writer controls (id, entity, actor,
 * event type, payload, correlation id, created_at). It is a per-database chain,
 * not a signature: it proves the log was not altered after being written, not
 * WHO wrote it (actor authentication is a separate concern).
 */

/** `prev_hash` of the first event in an empty log. */
export const EVENT_CHAIN_GENESIS = "0".repeat(64);

/** The row fields the chain hash covers, in the shape the table stores them. */
export interface ChainedEventFields {
  id: string;
  entity_type: string;
  entity_id: string;
  actor_type: string;
  actor_id: string | null;
  event_type: string;
  payload_json: string | null;
  correlation_id: string | null;
  created_at: string;
}

/** sha256 over a canonical JSON array of `prevHash` followed by the covered fields. */
export function eventHash(prevHash: string, f: ChainedEventFields): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        prevHash,
        f.id,
        f.entity_type,
        f.entity_id,
        f.actor_type,
        f.actor_id ?? null,
        f.event_type,
        f.payload_json ?? null,
        f.correlation_id ?? null,
        f.created_at,
      ]),
    )
    .digest("hex");
}

/** The newest row's hash — the `prev_hash` for the next append. Genesis on an empty log. */
export function latestEventHash(db: Db): string {
  const row = db.prepare("SELECT hash FROM work_events ORDER BY rowid DESC LIMIT 1").get() as
    { hash: string | null } | undefined;
  return row?.hash ?? EVENT_CHAIN_GENESIS;
}

export interface ChainVerification {
  /** True when every row hashes to its stored value and links to its predecessor. */
  ok: boolean;
  /** Rows examined (all of them when ok; up to and including the broken one otherwise). */
  checked: number;
  /** rowid of the first row that fails, or null. */
  brokenAtSeq: number | null;
  /** id of the first row that fails, or null. */
  brokenEventId: string | null;
  /** Why it fails: `unhashed`, `link` (prev_hash ≠ predecessor's hash) or `content` (row altered). */
  reason: "unhashed" | "link" | "content" | null;
}

type ChainRow = ChainedEventFields & { seq: number; prev_hash: string | null; hash: string | null };

const CHAIN_SELECT = `SELECT rowid AS seq, id, entity_type, entity_id, actor_type, actor_id, event_type,
                             payload_json, correlation_id, created_at, prev_hash, hash
                        FROM work_events ORDER BY rowid ASC`;

/** Walk the whole log in insertion order and re-derive every hash. Read-only. */
export function verifyEventChain(db: Db): ChainVerification {
  let expectedPrev = EVENT_CHAIN_GENESIS;
  let checked = 0;
  for (const row of db.prepare(CHAIN_SELECT).iterate() as IterableIterator<ChainRow>) {
    checked++;
    const broken = (reason: ChainVerification["reason"]): ChainVerification => ({
      ok: false,
      checked,
      brokenAtSeq: row.seq,
      brokenEventId: row.id,
      reason,
    });
    if (row.hash === null || row.prev_hash === null) return broken("unhashed");
    if (row.prev_hash !== expectedPrev) return broken("link");
    if (eventHash(row.prev_hash, row) !== row.hash) return broken("content");
    expectedPrev = row.hash;
  }
  return { ok: true, checked, brokenAtSeq: null, brokenEventId: null, reason: null };
}

/**
 * Hash every row that has none yet (a pre-v23 log, or rows restored from an older
 * export bundle), chaining from the last hashed predecessor. Rows that already
 * carry a hash are kept as-is — this fills gaps, it never rewrites history.
 * Returns the number of rows hashed. Idempotent; cheap when nothing is missing.
 */
export function backfillEventChain(db: Db): number {
  const missing = db
    .prepare("SELECT COUNT(*) AS n FROM work_events WHERE hash IS NULL OR prev_hash IS NULL")
    .get() as { n: number };
  if (!missing.n) return 0;
  const update = db.prepare("UPDATE work_events SET prev_hash = ?, hash = ? WHERE rowid = ?");
  return db.transaction(() => {
    let prev = EVENT_CHAIN_GENESIS;
    let filled = 0;
    for (const row of db.prepare(CHAIN_SELECT).all() as ChainRow[]) {
      if (row.hash !== null && row.prev_hash !== null) {
        prev = row.hash;
        continue;
      }
      const hash = eventHash(prev, row);
      update.run(prev, hash, row.seq);
      prev = hash;
      filled++;
    }
    return filled;
  })();
}

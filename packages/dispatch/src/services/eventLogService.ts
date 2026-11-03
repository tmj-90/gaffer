/**
 * TAMPER-EVIDENT LOG on the facade: the explicit, logged repair of unhashed work_events rows.
 */
import { inTransaction } from "../db/connection.js";
import { type Actor } from "../domain/types.js";
import {
  backfillEventChain,
  latestEventHash,
  verifyEventChain,
  type ChainVerification,
} from "../events/eventChain.js";
import { writeEvent } from "../events/eventWriter.js";
import type { Dispatch } from "../core.js";

/** What these functions read from the {@link Dispatch} facade they are handed. */
export type EventLogHost = Pick<Dispatch, "db">;

/**
 * The EXPLICIT repair path for unhashed work_events rows (`dispatch events rechain
 * --confirm`). Opening the DB no longer re-chains them: on a chained DB a NULL
 * hash means the row was blanked, and silently re-hashing it is what let an edit
 * plus "blank the hashes after it" verify clean. An operator who has checked the
 * rows can re-anchor the chain here; the re-anchor is itself appended to the log
 * (`events.rechained`, with the old and new head hashes and what was broken), so
 * it never happens without a trace. Rows that already carry a hash are untouched.
 */
export function rechainEventLog(
  host: EventLogHost,
  actor: Actor,
): {
  rechained: number;
  oldHead: string;
  newHead: string;
  verification: ChainVerification;
} {
  return inTransaction(host.db, () => {
    const before = verifyEventChain(host.db);
    const oldHead = latestEventHash(host.db);
    const rechained = backfillEventChain(host.db);
    const newHead = latestEventHash(host.db);
    writeEvent(host.db, {
      entity_type: "event_log",
      entity_id: "work_events",
      actor,
      event_type: "events.rechained",
      payload: {
        rechained,
        old_head: oldHead,
        new_head: newHead,
        was_broken_at_seq: before.brokenAtSeq,
        was_reason: before.reason,
      },
    });
    return { rechained, oldHead, newHead, verification: verifyEventChain(host.db) };
  });
}

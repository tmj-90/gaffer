import type { Database } from "better-sqlite3";

/**
 * Run `fn` as ONE write transaction that takes the database write lock at BEGIN
 * (`BEGIN IMMEDIATE`), so everything `fn` reads is still true when it writes.
 *
 * Every ledger writer here validates the current row before it changes it (a
 * forward-only lifecycle, a dedupe by name, a merge into the existing digest). A
 * read taken BEFORE the write transaction, or inside a deferred one, can be stale
 * by the time the write runs: two callers on two connections both saw `backlog` and
 * both claimed the feature, and a stale claim or release moved a `shipped` feature
 * backwards (external review 17). With the lock taken first, a second writer waits
 * (busy_timeout) until the first commits and then validates against what it wrote,
 * so the loser gets the same typed refusal a sequential caller gets.
 */
export function inWriteTx<T>(db: Database, fn: () => T): T {
  return db.transaction(fn).immediate();
}

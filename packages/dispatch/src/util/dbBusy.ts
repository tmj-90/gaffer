import { BUSY_TIMEOUT_MS } from "../db/connection.js";
import { DispatchError } from "./errors.js";

/**
 * True for SQLite's "database is locked" family (SQLITE_BUSY, SQLITE_LOCKED and their
 * extended codes): another process held the write lock for longer than the
 * connection's busy timeout.
 */
export function isDbBusyError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code !== "string") return false;
  return ["SQLITE_BUSY", "SQLITE_LOCKED"].some((c) => code === c || code.startsWith(`${c}_`));
}

/**
 * The structured form of a busy database, shared by the CLI (exit 1, one JSON line)
 * and the REST surface (503): a transient condition to retry, not a crash
 * (exploratory findings cli-wg/F-07, cli-runner/F-13).
 */
export function dbBusyError(): DispatchError {
  return new DispatchError(
    "DB_BUSY",
    `The Dispatch database is locked: another process holds the database; retry ` +
      `(waited ${BUSY_TIMEOUT_MS / 1000} s for its write lock).`,
    { busy_timeout_ms: BUSY_TIMEOUT_MS },
  );
}

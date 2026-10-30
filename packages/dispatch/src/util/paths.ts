import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { DispatchError } from "./errors.js";

/**
 * Resolve the Dispatch SQLite path. Precedence: explicit `--db` flag →
 * `DISPATCH_DB` env → `.dispatch/dispatch.sqlite` under the current directory.
 */
export function resolveDbPath(explicit?: string): string {
  // Treat an empty-string explicit path as unset (a blank --db flag is not a valid path).
  if (explicit != null && explicit !== "") return resolve(explicit);
  if (process.env.DISPATCH_DB) return resolve(process.env.DISPATCH_DB);
  return resolve(process.cwd(), ".dispatch", "dispatch.sqlite");
}

/**
 * True when the path came from neither `--db` nor `DISPATCH_DB` — the cwd-relative
 * `.dispatch/dispatch.sqlite` fallback.
 */
export function isImplicitDbPath(explicit?: string): boolean {
  return (explicit == null || explicit === "") && !process.env.DISPATCH_DB;
}

/**
 * The CLI's guard against a stray database: with no `--db` and no `DISPATCH_DB`, a
 * command other than `init` refuses to CREATE `./.dispatch/dispatch.sqlite`. Copying a
 * docs snippet that lacked `--db` used to answer NOT_FOUND from a brand-new empty
 * database (left behind in whatever directory it ran in) instead of reaching the
 * factory's. An explicit path keeps the old open-or-create behaviour.
 */
export function assertCliDbExists(explicit?: string): void {
  const path = resolveDbPath(explicit);
  if (!isImplicitDbPath(explicit) || existsSync(path)) return;
  throw new DispatchError(
    "DB_NOT_FOUND",
    `No Dispatch database at ${path} (no --db, no DISPATCH_DB). Pass --db <path>, set ` +
      "DISPATCH_DB, or use `runner/gaffer wg …` (pinned to the factory's database); " +
      "`dispatch init` creates one here.",
    { path },
  );
}

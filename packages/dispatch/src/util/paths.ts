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
 * The CLI's guard against a stray database: a command other than `init` refuses to
 * CREATE the database it was pointed at. Copying a docs snippet that lacked `--db`
 * used to answer NOT_FOUND from a brand-new empty `./.dispatch/dispatch.sqlite` left
 * in whatever directory it ran in; and because `runner/gaffer wg` always passes an
 * explicit `--db`, a mistyped GAFFER_DATA silently created a new empty board that the
 * next `ticket create` wrote into (exploratory finding cli-wg/F-09). Only `init`
 * (and `:memory:`) open-or-create now.
 */
export function assertCliDbExists(explicit?: string): void {
  const path = resolveDbPath(explicit);
  if (explicit === ":memory:" || existsSync(path)) return;
  const implicit = isImplicitDbPath(explicit);
  throw new DispatchError(
    "DB_NOT_FOUND",
    `no database at ${path}: run \`runner/gaffer setup\` (or \`wg init\`)` +
      (implicit
        ? ". No --db and no DISPATCH_DB were given, so this is the current directory's " +
          "fallback: pass --db <path>, set DISPATCH_DB, or use `runner/gaffer wg …` " +
          "(pinned to the factory's database)."
        : `. Check the path (GAFFER_DATA for \`runner/gaffer wg\`); nothing was created.`),
    { path },
  );
}

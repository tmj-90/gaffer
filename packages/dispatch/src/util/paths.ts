import { resolve } from "node:path";

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

import { Dispatch } from "../core.js";
import { assertCliDbExists, resolveDbPath } from "../util/paths.js";

// The CLI helpers that need the database. A command module never imports this file
// statically: it reaches open() through runtime.ts, which loads it when an action
// runs. The light helpers are re-exported for callers that used to find them here.
export * from "./helpers.js";

/**
 * Open the CLI's database. Only `init` passes `create: true`; every other command
 * refuses a database file that does not exist, wherever the path came from (--db,
 * DISPATCH_DB or the cwd fallback; see assertCliDbExists).
 */
export function open(
  opts: { db?: string },
  { create = false }: { create?: boolean } = {},
): Dispatch {
  if (!create) assertCliDbExists(opts.db);
  return Dispatch.open(resolveDbPath(opts.db), undefined, undefined, {
    requireRegisteredAgentApprover: true,
  });
}

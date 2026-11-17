import { Dispatch } from "../core.js";
import { hostGateKeyring } from "../events/gateSeal.js";
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
  const path = resolveDbPath(opts.db);
  const wg = Dispatch.open(path, undefined, undefined, {
    requireRegisteredAgentApprover: true,
    // SIGNED GATE EVENTS: the CLI is a trusted host entry point; it signs and verifies
    // with the factory key (created on the first approval when `gaffer setup` did not).
    gateKeyring: hostGateKeyring(path),
  });
  opened.add(wg);
  return wg;
}

/** Every handle open() returned since the last closeOpenedHandles(). */
const opened = new Set<Dispatch>();

/**
 * Close every handle a command opened and did not close. A one-shot CLI process
 * closes them by exiting; the tick's long-lived server (serveCore.ts) calls this
 * after each command, so no connection (or a transaction left on one) outlives it.
 * Returns how many were still open.
 */
export function closeOpenedHandles(): number {
  let left = 0;
  for (const wg of opened) {
    if (wg.db.open) {
      left += 1;
      try {
        wg.db.close();
      } catch {
        // closing is all that is left to do
      }
    }
  }
  opened.clear();
  return left;
}

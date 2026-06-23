import { spawn } from "node:child_process";

/**
 * Fires the configured auto-merge command when a ticket is approved (the human
 * has reviewed the diff and pressed approve, taking the ticket to `done`).
 *
 * The runner's `bin/merge-ticket.mjs` attempts the merge of the ticket's
 * delivery branch; on a CONFLICT it spawns a resolver agent that fixes the branch
 * and calls back `wg ticket reopen-for-review …` so the human re-reviews the
 * resolved diff. This module only *starts* that command — fire-and-gaffert, like
 * the product-owner runner — and logs the outcome; it never blocks the approve
 * response on the (slow) merge finishing.
 *
 * Safety (mirrors planBuild's spawn): NO shell — the operator-configured command
 * is parsed into argv tokens, and the only request-derived value (`--ticket
 * <number>`) is appended as discrete argv elements, so nothing the caller controls
 * reaches a shell. Dispatch's own bearer token is STRIPPED from the child env as
 * defence-in-depth so a misbehaving merge helper can never echo it back. Errors
 * are logged, never fatal: a failed merge leaves the ticket `done` for a manual
 * merge, exactly as before this feature existed.
 */

/** Env var holding the operator-provided merge command (e.g. `node …/merge-ticket.mjs`). */
export const MERGE_CMD_ENV = "DISPATCH_MERGE_CMD";

export interface MergeTriggerResult {
  /** True when a merge command was configured and spawned. */
  triggered: boolean;
  /** OS process id of the spawned merge, or null (unconfigured / withheld). */
  pid: number | null;
  /** Reason a merge was NOT triggered (e.g. "not_configured"), when applicable. */
  skipped?: string;
}

export interface MergeRunner {
  /** Trigger the merge for an approved ticket (by its number). */
  trigger(input: { ticketNumber: number }): MergeTriggerResult;
}

/** A logger seam so tests can assert the logged outcome without stderr noise. */
export type MergeLogger = (message: string) => void;

const defaultLogger: MergeLogger = (message) => {
  // Operational breadcrumb for an async merge.
  console.error(`[dispatch:merge] ${message}`);
};

/**
 * Parse a configured command string into argv tokens.
 *
 * Two forms are supported, so a checkout path containing spaces never breaks:
 *   1. JSON array — if the trimmed value parses as a JSON array of strings, it is
 *      used VERBATIM as argv (e.g. `["node","/Users/My Repo/merge.mjs"]` yields a
 *      single argv element for the space-containing path). This is the robust form.
 *   2. Whitespace split — the legacy back-compat form: the string is split on
 *      runs of whitespace. Fine for space-free paths, lossy for paths with spaces.
 *
 * There is no shell in either path — the result is spawned as discrete argv. The
 * command is a FIXED operator-controlled value (never request input). An empty or
 * blank value (or an empty/invalid JSON array) yields an empty array, treated as
 * "unconfigured" by the caller.
 */
export function parseCommand(command: string): string[] {
  const trimmed = command.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.every((token) => typeof token === "string")) {
        // Verbatim argv: each element is preserved exactly, spaces and all.
        return (parsed as string[]).filter((token) => token.length > 0);
      }
      // Parsed but not a string[] — fall through to the whitespace split so a
      // stray `[` in a legacy string command can't silently drop the command.
    } catch {
      // Not valid JSON — treat as a legacy whitespace-delimited string.
    }
  }
  return trimmed.split(/\s+/).filter((token) => token.length > 0);
}

/** Strip Dispatch's bearer token from the child env (defence-in-depth). */
function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { DISPATCH_API_TOKEN: _omitToken, ...rest } = env;
  void _omitToken;
  return rest;
}

/**
 * Build the default merge runner. Spawns {@link MERGE_CMD_ENV} detached (so the
 * slow merge outlives the HTTP request) with `--ticket <number>` appended. When
 * the env var is unset/blank it skips silently — preserving today's manual-merge
 * behaviour.
 */
export function createMergeRunner(
  env: NodeJS.ProcessEnv = process.env,
  log: MergeLogger = defaultLogger,
): MergeRunner {
  return {
    trigger({ ticketNumber }) {
      const tokens = parseCommand(env[MERGE_CMD_ENV] ?? "");
      if (tokens.length === 0) {
        // Unconfigured: skip silently — manual merge stays the default.
        return { triggered: false, pid: null, skipped: "not_configured" };
      }
      const [bin, ...rest] = tokens;
      const args = [...rest, "--ticket", String(ticketNumber)];
      try {
        // No shell: argv is [bin, ...args]; the ticket number is a discrete argv
        // element, never interpolated into a command line. The child env has
        // Dispatch's bearer token stripped.
        const child = spawn(bin!, args, {
          detached: true,
          stdio: "ignore",
          env: childEnv(env),
        });
        child.on("error", (err) => {
          log(
            `merge command failed to start for ticket #${ticketNumber}: ` +
              `${err instanceof Error ? err.message : String(err)} — ticket left done for manual merge`,
          );
        });
        child.unref();
        return { triggered: true, pid: child.pid ?? null };
      } catch (err) {
        // A synchronous spawn failure must not break the approve response — log
        // and fall through to the manual-merge default.
        log(
          `could not spawn merge command for ticket #${ticketNumber}: ` +
            `${err instanceof Error ? err.message : String(err)} — ticket left done for manual merge`,
        );
        return { triggered: false, pid: null, skipped: "spawn_error" };
      }
    },
  };
}

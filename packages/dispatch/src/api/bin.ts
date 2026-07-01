#!/usr/bin/env node
import { Command } from "commander";

import { authConfigured, ensureApiToken } from "./auth.js";
import { Dispatch } from "../core.js";
import { resolveDbPath } from "../util/paths.js";
import { DEFAULT_API_PORT, assertSafeBind, createApiServer } from "./server.js";

/**
 * Resolve the unsafe-bind opt-in. True when the `--unsafe-bind` flag is set or
 * `DISPATCH_UNSAFE_BIND` is a truthy value (`1` / `true`, case-insensitive).
 */
function resolveUnsafeBind(flag?: boolean): boolean {
  if (flag) return true;
  const env = process.env.DISPATCH_UNSAFE_BIND?.trim().toLowerCase();
  return env === "1" || env === "true";
}

/**
 * Resolve the listen port. Precedence: --port flag → DISPATCH_API_PORT env →
 * {@link DEFAULT_API_PORT}. Invalid values fall back to the default.
 */
function resolvePort(explicit?: string): number {
  const raw = explicit ?? process.env.DISPATCH_API_PORT;
  if (!raw) return DEFAULT_API_PORT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(`Invalid port: ${raw}`);
  }
  return parsed;
}

const program = new Command();
program
  .name("dispatch-api")
  .description("Dispatch human REST API server")
  .option("--db <path>", "SQLite database path (or DISPATCH_DB)")
  .option("--port <port>", "Port to listen on (or DISPATCH_API_PORT)")
  .option("--host <host>", "Host to bind", "127.0.0.1")
  .option(
    "--unsafe-bind",
    "Allow binding to a non-loopback host despite the API having no auth (or DISPATCH_UNSAFE_BIND=1)",
  )
  .action((opts: { db?: string; port?: string; host: string; unsafeBind?: boolean }) => {
    // Guarantee a bearer token before anything else so the control-plane
    // mutations (review approve/reject, merge, every state-change) are gated BY
    // DEFAULT, not merely by the loopback bind. When the operator has not set
    // DISPATCH_API_TOKEN, a token is generated, persisted 0600 to
    // $GAFFER_DATA/dashboard-token, and exported into the process env — so the
    // human operator can authenticate while the delivery agent (whose child env
    // the runner scrubs of the token) structurally cannot approve its own work.
    const ensured = ensureApiToken(process.env);

    // Refuse to expose the API on a public interface unless it is safe: a bearer
    // token is configured (always true now — see ensureApiToken above), the
    // operator opted in (--unsafe-bind), or it is a loopback bind. Runs before
    // opening DB or socket.
    assertSafeBind(opts.host, resolveUnsafeBind(opts.unsafeBind), authConfigured());

    const dbPath = resolveDbPath(opts.db);
    const port = resolvePort(opts.port);
    const wg = Dispatch.open(dbPath);
    // RUN-ACTIVITY: reconcile orphaned runs left `running` by a previous API
    // process that died mid-run (its child's exit listener died with it). Any
    // such row whose pid is no longer alive is flipped to `unknown` so the
    // dashboard never shows a wedged "running" run after a restart.
    const swept = wg.sweepStaleRuns();
    if (swept.length > 0) {
      process.stdout.write(`dispatch-api: reconciled ${swept.length} orphaned run(s)\n`);
    }
    // Pass the bind host so the server emits HSTS only for a non-loopback bind.
    const server = createApiServer(wg, undefined, undefined, undefined, undefined, opts.host);

    server.listen(port, opts.host, () => {
      process.stdout.write(
        `dispatch-api listening on http://${opts.host}:${port} (db: ${dbPath}, token-auth)\n`,
      );
      // Tell the operator how to authenticate. A freshly generated token is
      // printed once so it can be copied into the dashboard / curl; a reused or
      // env-supplied token is only referenced, never echoed.
      if (ensured.source === "generated") {
        process.stdout.write(
          `dispatch-api: generated a new dashboard token (saved 0600 to ${ensured.path}).\n` +
            `  Authenticate mutating requests with:  Authorization: Bearer ${ensured.token}\n`,
        );
      } else if (ensured.source === "file") {
        process.stdout.write(
          `dispatch-api: using the saved dashboard token at ${ensured.path} ` +
            `(delete it to rotate).\n`,
        );
      } else {
        process.stdout.write(`dispatch-api: using DISPATCH_API_TOKEN from the environment.\n`);
      }
    });

    const shutdown = (): void => {
      server.close(() => {
        wg.db.close();
        process.exit(0);
      });
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`dispatch-api failed to start: ${String(err)}\n`);
  process.exitCode = 1;
});

import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { Command } from "commander";

import { authConfigured, deriveReadToken, describeApiToken, ensureApiToken } from "./auth.js";
import { Dispatch } from "../core.js";
import { hostGateKeyring } from "../events/gateSeal.js";
import { setUnsignedPrincipalLog } from "../services/principalAdminService.js";
import { resolveDbPath } from "../util/paths.js";
import { DEFAULT_API_PORT, assertSafeBind, createApiServer, endEventStreams } from "./server.js";
import { refreshIsolationStatus } from "./isolation.js";
import { applySettingsToEnv } from "./settings.js";

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

/**
 * The pid file the launcher records this server in: `DISPATCH_PID_FILE`, else
 * `$GAFFER_DATA/dashboard.pid` (what `runner/gaffer dashboard` writes,
 * runner/lib/dashboard.sh). Null when neither is known.
 */
function resolvePidFile(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = (env.DISPATCH_PID_FILE ?? "").trim();
  if (explicit !== "") return explicit;
  const data = (env.GAFFER_DATA ?? "").trim();
  return data !== "" ? join(data, "dashboard.pid") : null;
}

/**
 * Remove the pid file on the way out, but only when it names THIS process: a newer
 * launch may already have recorded its own server there (`gaffer dashboard
 * --restart`), and that record must survive the old server's exit. Best-effort.
 */
function removeOwnPidFile(): void {
  const file = resolvePidFile();
  if (file === null) return;
  try {
    if (readFileSync(file, "utf8").trim() === String(process.pid)) unlinkSync(file);
  } catch {
    // No pid file (a server not started by the launcher) or not ours to remove.
  }
}

/** How long a graceful stop waits for in-flight requests before it drops them (ms). */
const SHUTDOWN_GRACE_MS = 1500;

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
    // The fourteen settings and what the runner's own config derives from them become
    // this process's env (never over the operator's real environment, never an old
    // settings.json key as it stands), each with the runner's re-source record, so the
    // API's own gates agree with the tick and every runner this server starts derives
    // them from settings.json itself, as a run from the command line does.
    applySettingsToEnv(process.env);
    // The agent isolation posture the Settings page shows, probed once at startup
    // (and again on each settings load). Never blocks the start: it runs in the background.
    void refreshIsolationStatus(process.env);
    const ensured = ensureApiToken(process.env);
    // CLI IDENTITY: the runners this server spawns (poll, merge, onboarding, planning)
    // write as the operator and the system. A principal token in the shell that started
    // the dashboard must not make their wg calls a principal's.
    delete process.env.GAFFER_PRINCIPAL_TOKEN;

    // Refuse to expose the API on a public interface unless it is safe: a bearer
    // token is configured (always true now — see ensureApiToken above), the
    // operator opted in (--unsafe-bind), or it is a loopback bind. Runs before
    // opening DB or socket.
    assertSafeBind(opts.host, resolveUnsafeBind(opts.unsafeBind), authConfigured());

    const dbPath = resolveDbPath(opts.db);
    const port = resolvePort(opts.port);
    const wg = Dispatch.open(dbPath, undefined, undefined, {
      requireRegisteredAgentApprover: true,
      // SIGNED GATE EVENTS: the REST server is a trusted host entry point.
      gateKeyring: hostGateKeyring(dbPath),
    });
    // RUN-ACTIVITY: reconcile orphaned runs left `running` by a previous API
    // process that died mid-run (its child's exit listener died with it). Any
    // such row whose pid is no longer alive is flipped to `unknown` so the
    // dashboard never shows a wedged "running" run after a restart.
    const swept = wg.sweepStaleRuns();
    if (swept.length > 0) {
      process.stdout.write(`dispatch-api: reconciled ${swept.length} orphaned run(s)\n`);
    }
    // SEALED PRINCIPALS: a sign-in refused because the principal is not signed by this
    // factory is logged here (once per principal and reason), beside the 401 it gets.
    setUnsignedPrincipalLog((line) => process.stderr.write(`${line}\n`));
    const unsigned = wg.listUnsignedPrincipals();
    if (unsigned.length > 0) {
      process.stderr.write(
        `dispatch-api: ${unsigned.length} principal(s) are not signed by this factory and cannot sign in (${unsigned
          .map((u) => u.name)
          .join(
            ", ",
          )}): review them with \`gaffer wg principal unsigned\`, then \`gaffer wg principal resign\` (or in the dashboard's Settings).\n`,
      );
    }
    // SEALED AUTONOMY: what is not signed grants nothing; say so once at start.
    try {
      for (const line of wg.autonomySealSummary().messages) {
        process.stderr.write(`dispatch-api: ${line}.\n`);
      }
    } catch {
      // a startup notice never stops the server
    }
    // Pass the bind host so the server emits HSTS only for a non-loopback bind.
    const server = createApiServer(wg, undefined, undefined, undefined, undefined, opts.host);

    server.listen(port, opts.host, () => {
      process.stdout.write(
        `dispatch-api listening on http://${opts.host}:${port} (db: ${dbPath}, token-auth)\n`,
      );
      // Tell the operator how to authenticate — by reference only. The token is
      // never echoed: this stdout is the dashboard.log the runner writes.
      process.stdout.write(describeApiToken(ensured));
    });

    // A graceful stop that finishes within ~2 s: end the live event streams (each
    // would otherwise hold server.close() open for up to an hour), drop idle
    // keep-alive sockets, give in-flight requests a short grace, then drop the rest.
    // The pid file the launcher wrote is removed when it names this process.
    let stopping = false;
    const shutdown = (): void => {
      if (stopping) return;
      stopping = true;
      removeOwnPidFile();
      server.close(() => {
        wg.db.close();
        process.exit(0);
      });
      endEventStreams();
      server.closeIdleConnections();
      // A just-ended stream's keep-alive socket goes idle a beat later.
      setTimeout(() => server.closeIdleConnections(), 100).unref();
      setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS).unref();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

// Mint the read-scoped token for the current API token. The full token grants
// everything (read + approve/reject/merge/onboard/run); the read token can browse
// the dashboard and read models but is refused (403) on every mutating/gate route.
// Hand this string to a phone / read-only viewer / `?token=` login — a leaked read
// token cannot recover merge rights (the derivation is one-way HMAC). Resolves the
// full token via the same env → file → generated precedence the server uses, so the
// printed value is exactly what the running server will accept as read-scoped.
program
  .command("print-read-token")
  .description("Print the read-scoped token derived from the current API token")
  .action(() => {
    const { token } = ensureApiToken(process.env);
    process.stdout.write(`${deriveReadToken(token)}\n`);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`dispatch-api failed to start: ${String(err)}\n`);
  process.exitCode = 1;
});

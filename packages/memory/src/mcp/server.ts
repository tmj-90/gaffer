import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Database } from "better-sqlite3";

import { defaultDbPath, openDb } from "../db/index.js";
import { DatabaseTooNewError } from "../db/migrations.js";
import { registerAbsenceTools } from "./tools/absence.js";
import { registerBoundaryTools } from "./tools/boundaries.js";
import { registerCardTools } from "./tools/cards.js";
import { registerDigestTools } from "./tools/digest.js";
import { registerFeatureTools } from "./tools/features.js";
import { registerLoreTools } from "./tools/lore.js";
import { VERSION } from "../version.js";

/**
 * R1 — MCP server. Stdio transport only (no network listener). The tool
 * handlers themselves live under `./tools/*` grouped by domain (lore,
 * absence, boundaries, digest, features, cards); this file stays the thin
 * shell — open the DB, wire the tool groups, connect stdio.
 *
 * The headline knowledge tools are:
 *
 *   - search_lore  — brief-by-default; default-filtered to active records,
 *                    excludes drafts/deprecated/superseded/restricted unless
 *                    explicitly opted in via flags. The token-saving entry.
 *   - get_lore     — full body of one record by id. Use this AFTER a
 *                    search hit to spend tokens on detail only when needed.
 *   - suggest_lore — agent-authored knowledge lands as a DRAFT
 *                    (status='draft'). Hidden from default search until
 *                    a human runs `memory approve <id>`. Agents cannot
 *                    promote their own records.
 *
 * Every tool call is recorded to `~/.memory/audit.jsonl` with the request
 * args, result count, and result ids — never the full result bodies.
 */
export async function runMcpServer(): Promise<void> {
  // Open the DB before wiring tools. If it fails (locked by another process,
  // corrupt file, unwritable dir) the agent's client would otherwise see a
  // raw SqliteError stack and a bare "server failed to start". Emit an
  // actionable diagnostic to stderr — which MCP clients surface on launch
  // failure — and exit cleanly instead.
  let db: Database;
  try {
    db = openDb();
  } catch (err) {
    if (err instanceof DatabaseTooNewError) {
      process.stderr.write(`memory-mcp: ${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    const dbPath = defaultDbPath();
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `memory-mcp: could not open the lore database at ${dbPath}\n` +
        `  reason: ${reason}\n` +
        `  • If another process holds a write lock, close it and relaunch.\n` +
        `  • If the file is corrupt, restore a backup or re-run \`memory init\`.\n` +
        `  • Check the directory is writable and you have free disk space.\n`,
    );
    process.exitCode = 1;
    return;
  }

  const server = buildMcpServer(db);

  // Connect on stdio. The MCP client (Claude Code, Cursor, etc.) is the
  // parent process; we read JSON-RPC framed messages on stdin, reply on
  // stdout. Logs go to stderr.
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Block forever — connect() returns once the transport is bound; the
  // server runs as long as stdin stays open. Closing stdin (client
  // disconnect) exits the process.
}

/**
 * Wire all memory MCP tools onto a fresh `McpServer` backed by the
 * given database. Split out of `runMcpServer` so tests can drive the
 * real server (and its real handlers, redaction gates, and audit calls)
 * over an in-memory transport against a temp DB — no stdio subprocess,
 * no production `~/.memory` paths. `runMcpServer` is the thin shell:
 * open the default DB, build, connect stdio.
 *
 * Each `register*Tools` call registers one domain's tools; keeping them in
 * separate modules mirrors how the CLI splits its commands.
 */
export function buildMcpServer(db: Database): McpServer {
  const server = new McpServer({
    name: "memory",
    version: VERSION,
  });

  registerLoreTools(server, db);
  registerAbsenceTools(server, db);
  registerBoundaryTools(server, db);
  registerDigestTools(server, db);
  registerFeatureTools(server, db);
  registerCardTools(server, db);

  return server;
}

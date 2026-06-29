#!/usr/bin/env node
// Gaffer factory — idempotent MCP-trust seeding.
//
// Claude Code 2.1.x added a project-scoped approval gate for MCP servers declared
// in a project `.mcp.json`: until the operator interactively approves "trust this
// server?", the server's tools are withheld. The approved-server list lives in
// `~/.claude.json` under `projects[<repoPath>].enabledMcpjsonServers` (an array of
// approved server names). In a headless `claude -p` run there is no approver, so a
// closed gate (`[]`) silently denies the factory's dispatch/memory tools for ANY
// code path that relies on project `.mcp.json` discovery — the agent then "files
// into the void" (exit 0, zero tickets).
//
// This helper pre-seeds that trust for our two known-local servers (dispatch +
// memory) so every repo the factory drives is approved up front — WITHOUT weakening
// `acceptEdits`, the permission allow-list, or the safety hook. It is scoped
// strictly to those two server names: it never enables anything else and never
// removes a server the operator already trusts.
//
// NOTE (verified on Claude Code 2.1.195): servers supplied on the CLI via
// `--mcp-config <file>` are auto-trusted and are NOT gated by
// `enabledMcpjsonServers`. The whole factory (tick.sh, decompose, tester, the
// product-owner runner) loads its MCP via `--mcp-config`, so this seeding is the
// DOCUMENTED mechanism for project `.mcp.json` discovery and a forward-defensive
// guard (a future version could extend the gate to `--mcp-config`); it is
// deliberately idempotent and side-effect-minimal.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

/** The two local MCP servers the factory delivers through. */
export const FACTORY_MCP_SERVERS = ["dispatch", "memory"];

/** Default trust-store path: the per-user `~/.claude.json`. */
export function defaultClaudeJsonPath() {
  return resolve(homedir(), ".claude.json");
}

/**
 * Ensure `projects[<repoPath>].enabledMcpjsonServers` contains each of `servers`.
 *
 * Idempotent and additive: it APPENDS only the missing server names, preserving any
 * the operator already trusts and every other project entry untouched. Creates the
 * `~/.claude.json` file / the `projects` map / the per-repo entry when absent.
 *
 * Returns `{ changed, added, path }`. Throws only when `repoPath` is blank or the
 * existing trust store is present-but-unparseable (we refuse to clobber a corrupt
 * file). Callers in setup/onboard treat a throw as best-effort and continue.
 *
 * @param {string} repoPath absolute repo path (the project key Claude Code uses)
 * @param {{ servers?: string[], claudeJsonPath?: string, log?: (m: string) => void }} [opts]
 */
export function seedMcpTrust(repoPath, opts = {}) {
  const servers = opts.servers ?? FACTORY_MCP_SERVERS;
  const claudeJsonPath = opts.claudeJsonPath ?? defaultClaudeJsonPath();
  const log = opts.log ?? (() => {});

  const raw = String(repoPath ?? "").trim();
  if (!raw) throw new Error("seedMcpTrust: repoPath is required");
  // Canonicalise to an absolute path so the key matches the cwd Claude Code records.
  const repo = resolve(raw);

  let root = {};
  if (existsSync(claudeJsonPath)) {
    let text;
    try {
      text = readFileSync(claudeJsonPath, "utf8");
    } catch (e) {
      throw new Error(`seedMcpTrust: cannot read ${claudeJsonPath}: ${e?.message ?? e}`, {
        cause: e,
      });
    }
    if (text.trim() !== "") {
      try {
        root = JSON.parse(text);
      } catch (e) {
        // Refuse to overwrite a file we can't parse — clobbering it would wipe the
        // operator's real Claude Code state.
        throw new Error(
          `seedMcpTrust: ${claudeJsonPath} is not valid JSON (refusing to clobber): ${e?.message ?? e}`,
          { cause: e },
        );
      }
    }
  }
  if (root === null || typeof root !== "object" || Array.isArray(root)) {
    throw new Error(`seedMcpTrust: ${claudeJsonPath} root is not a JSON object`);
  }

  if (!root.projects || typeof root.projects !== "object" || Array.isArray(root.projects)) {
    root.projects = {};
  }
  const existing = root.projects[repo];
  const entry =
    existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
  const current = Array.isArray(entry.enabledMcpjsonServers)
    ? entry.enabledMcpjsonServers.slice()
    : [];

  const present = new Set(current);
  const added = [];
  for (const s of servers) {
    if (!present.has(s)) {
      present.add(s);
      current.push(s);
      added.push(s);
    }
  }

  if (added.length === 0) {
    log(`${servers.join("+")} MCP already pre-approved for headless runs in ${repo}`);
    return { changed: false, added: [], path: claudeJsonPath };
  }

  entry.enabledMcpjsonServers = current;
  root.projects[repo] = entry;

  // Write via a temp file + atomic rename so a concurrent reader never sees a torn
  // file. (A lost-update race with a live Claude session is inherent to this shared
  // store; setup/onboard run outside an interactive session, so the window is tiny.)
  const tmp = `${claudeJsonPath}.gaffer-tmp-${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(root, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, claudeJsonPath);
  } catch (e) {
    throw new Error(`seedMcpTrust: failed to write ${claudeJsonPath}: ${e?.message ?? e}`, {
      cause: e,
    });
  }

  log(`pre-approving ${servers.join("+")} MCP for headless runs in ${repo}`);
  return { changed: true, added, path: claudeJsonPath };
}

// CLI: `mcp-trust.mjs <repoPath> [<repoPath> ...]` — used by setup.sh. Best-effort
// per path; a failure on one path is logged and yields a non-zero exit, but never
// throws out of the loop.
if (import.meta.url === `file://${process.argv[1]}`) {
  const paths = process.argv.slice(2).filter((p) => p && p.trim() !== "");
  if (paths.length === 0) {
    process.stderr.write("usage: mcp-trust.mjs <repoPath> [<repoPath> ...]\n");
    process.exit(2);
  }
  let code = 0;
  for (const p of paths) {
    try {
      seedMcpTrust(p, { log: (m) => process.stderr.write(`[mcp-trust] ${m}\n`) });
    } catch (e) {
      process.stderr.write(`[mcp-trust] WARN: ${e?.message ?? e}\n`);
      code = 1;
    }
  }
  process.exit(code);
}

#!/usr/bin/env node
// Gaffer factory — idempotent MCP-trust seeding.
//
// Claude Code 2.1.x added a per-WORKSPACE trust gate. Until a workspace is trusted
// (the interactive "do you trust this folder?" dialog), Claude Code IGNORES every
// `permissions.allow` entry from that repo's `.claude/settings.json` (verified on
// 2.1.195: "Ignoring N permissions.allow entries … this workspace has not been
// trusted"). A headless `claude -p` run has no way to accept that dialog, so on an
// untrusted factory repo the ENTIRE allow-list is dropped and
// `mcp__dispatch__create_ticket` (plus Bash and the rest) is denied — the
// product-owner then "files into the void" (exit 0, zero tickets). This is why the
// PO worked in the operator's interactively-trusted cwd but failed on a repo the
// factory only ever drives headlessly.
//
// The trust flag lives in `~/.claude.json` under
// `projects[<repoPath>].hasTrustDialogAccepted`. This helper seeds it to `true` for
// the repos the factory drives — exactly the trust the CLI's own error message tells
// operators to set — and (belt-and-braces) also pre-approves the dispatch/memory
// project `.mcp.json` servers via `enabledMcpjsonServers`. It does NOT weaken
// `acceptEdits`, the allow-list, or the safety hook: it only lets the allow-list the
// operator already wrote take effect in a headless run. Idempotent; scoped to our
// two known-local servers; never removes anything the operator already trusts.

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

  // THE actual fix: Claude Code 2.1.x ignores EVERY `permissions.allow` entry from
  // `.claude/settings.json` until the workspace is *trusted*. A headless `claude -p`
  // run can't accept the interactive trust dialog, so an untrusted factory repo has
  // its whole allow-list silently dropped — `mcp__dispatch__create_ticket` (and Bash,
  // etc.) is then denied (the product-owner files 0). Seeding
  // `hasTrustDialogAccepted: true` is exactly the trust the CLI's own error message
  // instructs operators to set, granted up front for repos the factory drives.
  // acceptEdits + the allow-list + the safety hook all still apply — this only lets
  // the allow-list the operator already wrote take effect headlessly.
  const trustChanged = entry.hasTrustDialogAccepted !== true;

  if (added.length === 0 && !trustChanged) {
    log(`workspace trust + ${servers.join("+")} MCP already seeded for headless runs in ${repo}`);
    return { changed: false, added: [], path: claudeJsonPath };
  }

  entry.enabledMcpjsonServers = current;
  entry.hasTrustDialogAccepted = true;
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

  log(`trusting workspace + pre-approving ${servers.join("+")} MCP for headless runs in ${repo}`);
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

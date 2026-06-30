/**
 * runner/lib/context-primer.mjs — shared file-card context primer (JS side).
 *
 * Single implementation of: canonical derivation + cards-for-scope retrieval
 * + block formatting.  Every JS entry point that wants a "PRIOR CONTEXT (file
 * cards)" block imports primeContextBlock from here instead of inlining the
 * logic.
 *
 * Exports:
 *   repoCanonical(repoPath)  — canonical repo identity (mirrors onboard + tick.sh)
 *   primeContextBlock({ realRepoPath, repo, query, paths?, env? })
 *                           — formatted block string; "" on any error (fail-soft)
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const _HERE = dirname(fileURLToPath(import.meta.url)); // runner/lib
const _RUNNER_DIR = resolve(_HERE, ".."); // runner
const _GAFFER_HOME = resolve(_RUNNER_DIR, ".."); // repo root
const _DATA_DEFAULT = resolve(_GAFFER_HOME, ".gaffer");

/**
 * Derive the CANONICAL repo identity — MUST match onboard's repoCanonical and
 * tick.sh's bash derivation EXACTLY:
 *   1. remote.origin.url  (if the repo has a remote)
 *   2. else realpathSync (pwd -P equivalent)
 *
 * The repoKey that onboard keyed its cards under is derived from this value,
 * so any deviation here silently produces a cache miss.
 */
export function repoCanonical(repoPath) {
  try {
    const url = execFileSync("git", ["-C", repoPath, "config", "--get", "remote.origin.url"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (url) return url;
  } catch {
    /* not a git repo / no remote — fall through to realpath */
  }
  try {
    return realpathSync(repoPath);
  } catch {
    return resolve(repoPath);
  }
}

/**
 * Pull a file-card context block for the given repo + query and return it as
 * a formatted "PRIOR CONTEXT (file cards)" string.
 *
 * Returns "" on any error: missing CLI binary, MEMORY_DB not set, non-zero
 * cards-for-scope exit, bad JSON, zero cards AND no digest.  FAIL-SOFT by
 * design — callers must treat "" as "no context" and proceed exactly as
 * before.
 *
 * The block's framing emphasises cards are RETRIEVAL AIDS, never authoritative
 * source.
 *
 * @param {object} opts
 * @param {string}   opts.realRepoPath  — absolute path to the real (non-worktree) repo
 * @param {string}   opts.repo          — display name (repo identifier in memory)
 * @param {string}   opts.query         — free-text query to scope card selection
 * @param {string[]} [opts.paths]       — optional path hints to narrow selection
 * @param {NodeJS.ProcessEnv} [opts.env] — environment (defaults to process.env)
 */
export function primeContextBlock({ realRepoPath, repo, query, paths = [], env = process.env }) {
  try {
    const cliBin =
      env.MEMORY_CLI_BIN ?? resolve(_GAFFER_HOME, "packages", "memory", "dist", "bin", "memory.js");
    const db = env.MEMORY_DB ?? resolve(_DATA_DEFAULT, "memory.sqlite");

    if (!cliBin || !db || !existsSync(cliBin)) return "";

    const canonical = repoCanonical(realRepoPath);

    const argv = [
      cliBin,
      "cards-for-scope",
      "--canonical",
      canonical,
      "--repo",
      repo,
      "--query",
      query,
      "--max-cards",
      "12",
      "--max-tokens",
      "1800",
      "--per-card-max-tokens",
      "160",
    ];
    for (const p of paths) {
      argv.push("--paths", p);
    }
    argv.push("--json");

    const res = spawnSync(process.execPath, argv, {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      env: { ...env, MEMORY_DB: db },
    });
    if (res.error || (res.status ?? 0) !== 0 || !res.stdout) return "";

    let packet;
    try {
      packet = JSON.parse(res.stdout);
    } catch {
      return "";
    }

    const cards = Array.isArray(packet.cards) ? packet.cards : [];
    const tiers = new Map(
      (Array.isArray(packet.selectionOrder) ? packet.selectionOrder : []).map((e) => [
        e.path,
        e.tier,
      ]),
    );

    const lines = [];
    if (packet.digest?.overview) {
      lines.push(`Repo digest: ${String(packet.digest.overview).trim()}`);
    }
    for (const c of cards) {
      const tier = tiers.get(c.path) ?? "fts";
      let head = `  - [${tier}] ${c.path}`;
      if (c.tldr) head += ` — ${String(c.tldr).trim()}`;
      lines.push(head);
      const syms = Array.isArray(c.symbols) ? c.symbols : [];
      if (syms.length > 0) {
        lines.push(`      symbols: ${syms.slice(0, 8).join(", ")}`);
      }
    }

    const cov = packet.coverage ?? {};
    const missing = Array.isArray(cov.missing) ? cov.missing : [];
    const tr = packet.truncationReason;
    const foot = [];
    if (missing.length > 0) foot.push(`no card yet for: ${missing.slice(0, 8).join(", ")}`);
    if (tr) foot.push(String(tr));

    if (lines.length === 0) return "";

    // The exact phrase "a card is a guide, never authoritative source" must
    // appear as a single contiguous string on one output line — it is asserted
    // verbatim by the test suite.
    return [
      "",
      "PRIOR CONTEXT (file cards) — the runner pre-selected these from the repo's",
      "file-card index to orient you. Read the real file before editing;",
      "a card is a guide, never authoritative source. Pull more via the memory",
      "MCP (`cards_for_scope` / `card get` / `card search`) when you need them.",
      ...lines,
      ...(foot.length > 0 ? [`  (${foot.join("; ")})`] : []),
      "",
    ].join("\n");
  } catch {
    return "";
  }
}

/**
 * `memory setup` — collapse the three "make Claude use memory" steps
 * into one idempotent command:
 *
 *   1. register the MCP server with Claude Code (`claude mcp add ...`)
 *   2. append the retrieval rule to CLAUDE.md (project or user-global) so
 *      agents actually call `search_lore` at the right moments
 *   3. install the `/memory-onboard` skill into ~/.claude/skills/
 *
 * Each step is idempotent and reports `created` / `already-present` /
 * `skipped` distinctly. The pure file-level helpers are exported so they
 * can be unit-tested without mocking `child_process`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CLAUDE_INSTRUCTIONS } from "./instructions.js";

/**
 * HTML-comment markers wrap the retrieval rule inside CLAUDE.md. They are
 * invisible in the rendered Markdown but unique enough to detect when the
 * block has already been installed (so a second `memory setup` doesn't
 * append a duplicate copy).
 */
export const BEGIN_MARKER = "<!-- memory:retrieval-rule begin -->";
export const END_MARKER = "<!-- memory:retrieval-rule end -->";

export function instructionsBlock(): string {
  return `${BEGIN_MARKER}\n${CLAUDE_INSTRUCTIONS}\n${END_MARKER}\n`;
}

// ── CLAUDE.md retrieval rule ──────────────────────────────────────────

export type ClaudeMdScope = "project" | "user";

export function claudeMdPath(scope: ClaudeMdScope, cwd?: string): string {
  if (scope === "user") return join(homedir(), ".claude", "CLAUDE.md");
  return resolve(cwd ?? process.cwd(), "CLAUDE.md");
}

export type AppendAction =
  | "created"
  | "appended"
  | "already-present"
  | "replaced"
  | "skipped-partial";

export interface AppendResult {
  readonly path: string;
  readonly action: AppendAction;
}

/**
 * Idempotently append the retrieval rule to `path`. Four shapes the
 * function handles:
 *
 *   - file doesn't exist     → create it with the block
 *   - file has no markers    → append the block (with a blank-line gap)
 *   - file has both markers  → no-op, return `already-present`
 *   - file has one marker    → corrupted state, refuse unless `force`;
 *                              with `force`, the whole block (begin → end
 *                              or end → file-tail) is replaced. This is
 *                              the only place the function ever overwrites
 *                              existing bytes inside the file.
 */
export function appendInstructionsToFile(path: string, force = false): AppendResult {
  const block = instructionsBlock();
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, block);
    return { path, action: "created" };
  }
  const existing = readFileSync(path, "utf8");
  const beginAt = existing.indexOf(BEGIN_MARKER);
  const endAt = existing.indexOf(END_MARKER);
  const hasBegin = beginAt !== -1;
  const hasEnd = endAt !== -1;

  if (hasBegin && hasEnd) {
    // Both markers — verify the inner content matches the current rule.
    // If it does, no-op. If it doesn't (the rule was edited upstream),
    // re-render under `force`.
    const innerStart = beginAt + BEGIN_MARKER.length + 1; // skip newline
    const inner = existing.slice(innerStart, endAt).trimEnd();
    if (inner === CLAUDE_INSTRUCTIONS) {
      return { path, action: "already-present" };
    }
    if (!force) {
      return { path, action: "already-present" };
    }
    const before = existing.slice(0, beginAt);
    const after = existing.slice(endAt + END_MARKER.length);
    writeFileSync(path, before + block + after);
    return { path, action: "replaced" };
  }
  if ((hasBegin || hasEnd) && !force) {
    return { path, action: "skipped-partial" };
  }
  const sep = existing.endsWith("\n") ? "\n" : "\n\n";
  writeFileSync(path, existing + sep + block);
  return { path, action: "appended" };
}

// ── /memory-onboard skill ──────────────────────────────────────────

export type SkillCopyAction = "copied" | "already-present" | "differs-skipped" | "overwritten";

export interface SkillCopyResult {
  readonly src: string;
  readonly dest: string;
  readonly action: SkillCopyAction;
}

/**
 * Resolve the bundled SKILL.md inside the installed package. The compiled
 * bin runs from `<pkg-root>/dist/bin/memory.js`, so the skill lives at
 * `<pkg-root>/skills/memory-onboard/SKILL.md` — three levels up from
 * the compiled setup module (`dist/cli/setup.js`).
 *
 * We probe a couple of relative paths to be robust against `tsx` dev runs
 * (where this module is `src/cli/setup.ts`) and packaged installs.
 */
export function findBundledSkillPath(): string {
  const here = fileURLToPath(import.meta.url);
  const candidates = [
    resolve(dirname(here), "..", "..", "skills", "memory-onboard", "SKILL.md"),
    resolve(dirname(here), "..", "..", "..", "skills", "memory-onboard", "SKILL.md"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    "could not locate bundled skill (expected at <pkg-root>/skills/memory-onboard/SKILL.md)",
  );
}

export function skillDestPath(home?: string): string {
  return join(home ?? homedir(), ".claude", "skills", "memory-onboard", "SKILL.md");
}

/**
 * Copy `src` → `dest`. Same idempotency rules as the CLAUDE.md case:
 * already-identical is a no-op, different content is left alone unless
 * `force` is set.
 */
export function copySkillFile(src: string, dest: string, force = false): SkillCopyResult {
  const newContent = readFileSync(src, "utf8");
  if (existsSync(dest)) {
    const existing = readFileSync(dest, "utf8");
    if (existing === newContent) {
      return { src, dest, action: "already-present" };
    }
    if (!force) {
      return { src, dest, action: "differs-skipped" };
    }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, newContent);
    return { src, dest, action: "overwritten" };
  }
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, newContent);
  return { src, dest, action: "copied" };
}

// ── Claude Code MCP registration ──────────────────────────────────────

export type McpAddAction = "registered" | "already-present" | "claude-cli-missing" | "failed";

export interface McpAddResult {
  readonly action: McpAddAction;
  readonly detail?: string;
}

/**
 * Probe whether the Claude Code CLI is on PATH. Separated so a future
 * uninstall path can reuse the same probe.
 */
function probeClaudeCli(): boolean {
  try {
    execFileSync("claude", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function isMemoryRegistered(): boolean {
  try {
    const out = execFileSync("claude", ["mcp", "list"], {
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
    return /(^|\s)memory(\s|:)/i.test(out);
  } catch {
    // Older Claude CLIs may not implement `mcp list` — assume not present
    // and let `mcp add` itself error if it's a real conflict.
    return false;
  }
}

export function addMcpServer(): McpAddResult {
  if (!probeClaudeCli()) {
    return {
      action: "claude-cli-missing",
      detail:
        "`claude` CLI not on PATH. Install Claude Code, or register the MCP server manually (see README).",
    };
  }
  if (isMemoryRegistered()) {
    return { action: "already-present" };
  }
  try {
    execFileSync("claude", ["mcp", "add", "memory", "memory-mcp"], {
      stdio: "pipe",
    });
    return { action: "registered" };
  } catch (err) {
    return {
      action: "failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Cold-start source detection ───────────────────────────────────────

/**
 * Result of `detectIngestSources` — knowledge-doc paths in the working
 * directory worth pointing the agent at. Used by the [4/4] step of
 * `memory setup` to make the `/memory-onboard` cold-start nudge
 * concrete ("I found CLAUDE.md and 2 ADR dirs — run /memory-onboard").
 */
export interface IngestSources {
  /** Path to the first agent-instruction file found (CLAUDE.md /
   *  AGENTS.md / .claude/CLAUDE.md), if any. */
  readonly claudeMd?: string;
  /** Paths to ADR-style directories under `./docs/`. */
  readonly adrDirs: ReadonlyArray<string>;
  /** Other top-level *.md files (excluding common non-lore files). */
  readonly otherDocs: ReadonlyArray<string>;
}

/**
 * Files at the repo root that are NOT useful as lore sources, so we
 * exclude them from `otherDocs` to keep the recommendation focused.
 * Case-insensitive match against the basename.
 */
const NON_LORE_DOC_NAMES = new Set([
  "readme.md",
  "license.md",
  "license",
  "changelog.md",
  "contributing.md",
  "code_of_conduct.md",
  "security.md",
  "support.md",
  "authors.md",
  "maintainers.md",
]);

/**
 * Best-effort, read-only scan of the working directory for files we
 * could nudge the user toward ingesting. Never reads file contents —
 * just looks at names — so it's safe to run inside `setup` without
 * any side effects beyond fs.readdirSync.
 */
export function detectIngestSources(cwd?: string): IngestSources {
  const root = cwd ?? process.cwd();
  const adrSubdirNames = new Set([
    "adr",
    "adrs",
    "decisions",
    "architecture",
    "architectural-decisions",
  ]);
  const claudeMdCandidates = [
    join(root, "CLAUDE.md"),
    join(root, "AGENTS.md"),
    join(root, ".claude", "CLAUDE.md"),
  ];
  let claudeMd: string | undefined;
  for (const p of claudeMdCandidates) {
    if (existsSync(p)) {
      claudeMd = p;
      break;
    }
  }
  const adrDirs: string[] = [];
  const docsRoot = join(root, "docs");
  if (existsSync(docsRoot)) {
    try {
      for (const name of readdirSync(docsRoot)) {
        if (!adrSubdirNames.has(name.toLowerCase())) continue;
        const full = join(docsRoot, name);
        if (statSync(full).isDirectory()) adrDirs.push(full);
      }
    } catch {
      // best-effort — unreadable dirs / permission errors etc.
    }
  }
  const otherDocs: string[] = [];
  try {
    for (const name of readdirSync(root)) {
      if (!name.toLowerCase().endsWith(".md")) continue;
      if (NON_LORE_DOC_NAMES.has(name.toLowerCase())) continue;
      // Don't double-count the CLAUDE.md / AGENTS.md hit.
      const full = join(root, name);
      if (full === claudeMd) continue;
      if (statSync(full).isFile()) otherDocs.push(full);
    }
  } catch {
    // best-effort
  }
  return { claudeMd, adrDirs, otherDocs };
}

/**
 * Best-effort short repo name from a git remote URL. Used by the CLI's
 * repo autodetection (e.g. `memory suggest --from-commit` tagging).
 *
 *   git@github.com:owner/memory-mcp.git  → memory-mcp
 *   https://github.com/owner/memory-mcp  → memory-mcp
 *   https://gitlab.com/g/sub/proj.git  → proj
 *
 * Returns null when the input doesn't look like a remote we can parse;
 * the CLI then falls back to the cwd basename or asking the user.
 */
export function shortRepoNameFromRemote(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  // Strip trailing .git
  const noGit = trimmed.replace(/\.git\/?$/, "");
  // SSH form: git@host:owner/name
  const sshMatch = /:([^/]+\/)*([^/]+)$/.exec(noGit);
  if (noGit.startsWith("git@") && sshMatch) {
    return sshMatch[2] ?? null;
  }
  // HTTPS form: https://host/owner/name
  try {
    const u = new URL(noGit);
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length === 0) return null;
    return parts[parts.length - 1] ?? null;
  } catch {
    // Last resort — take the final path segment
    const parts = noGit.split("/").filter(Boolean);
    return parts.length > 0 ? (parts[parts.length - 1] ?? null) : null;
  }
}

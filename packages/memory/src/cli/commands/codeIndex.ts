/**
 * Code-index CLI commands: `memory index build | neighbours | stats`.
 *
 * The index is a deterministic map of a repo's TypeScript / JavaScript / Python modules
 * (files -> top-level symbols -> imports -> tests), built from the files' text. Answers are
 * labelled "by import text (index)" and are lower bounds. The runner builds it at onboard
 * and refreshes it after a merge; the dispatch Review and the delivery file cards read it
 * through `neighbours --json`.
 *
 * ISOLATION: no imports from dispatch or crew.
 */
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";

import {
  buildCodeIndex,
  codeIndexStats,
  codeNeighbours,
  gitHead,
  INDEX_MAX_BYTES_PER_FILE_DEFAULT,
  INDEX_MAX_FILES_DEFAULT,
  type IndexBuildRecord,
  type NeighboursResult,
} from "../../core/codeIndex.js";
import { repoKey } from "../../core/fileCards.js";
import { canonicalizeRepo } from "../../core/repoIdentity.js";
import { openDb } from "../../db/index.js";
import { getBool, getString, getStringArray } from "../args.js";
import type { parseArgs } from "../args.js";

type Args = ReturnType<typeof parseArgs>;

/** The repo's canonical: --canonical, else remote.origin.url of --repo-root, else its realpath. */
function canonicalOf(args: Args, root: string | undefined): string | null {
  const explicit = getString(args.flags, "canonical");
  if (explicit) return explicit;
  if (!root) return null;
  try {
    const url = execFileSync("git", ["-C", root, "config", "--get", "remote.origin.url"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (url) return url;
  } catch {
    /* no remote: the realpath fallback, as onboard and the primer derive it */
  }
  try {
    return realpathSync(root);
  } catch {
    return resolve(root);
  }
}

function positiveInt(args: Args, flag: string, fallback: number): number | null {
  const raw = getString(args.flags, flag);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    process.stderr.write(`memory index: --${flag} must be a positive integer\n`);
    return null;
  }
  return n;
}

function describeBuild(r: IndexBuildRecord): string {
  const s = r.stats;
  const langs = Object.entries(s.languages)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  return (
    `CODE INDEX for '${r.repo}' (${r.mode}) at ${r.commit ? r.commit.slice(0, 12) : "an unknown commit"}, built ${r.builtAt}\n` +
    `  files:    ${s.files} (${langs || "none"}), ${s.testFiles} test files\n` +
    `  symbols:  ${s.symbols} top-level, ${s.exportedSymbols} exported\n` +
    `  imports:  ${s.imports} (${s.refs} resolved to repo files, ${s.unresolved} unresolved, ${s.external} to dependencies)\n` +
    `  tests:    ${s.testLinks} test links, ${s.modulesWithTests} modules with a test\n` +
    `  this build: ${s.extracted} re-read, ${s.removed} removed, ${s.skippedGenerated} generated skipped` +
    (s.capsHit.length ? `; caps hit: ${s.capsHit.join(", ")}` : "") +
    "\n  Counts are by import text: a lower bound (dynamic imports, undeclared aliases and other languages are not seen).\n"
  );
}

/**
 * `memory index build --repo-root <abs> [--canonical <c>] [--repo <name>] [--commit <sha>]
 *   [--full] [--max-files N] [--max-bytes-per-file N] [--json]`
 *
 * Build or refresh the index from the checkout at --repo-root (a throwaway worktree of
 * the merged commit is the runner's case: pass --canonical for the real repo then). With
 * a previous build at a known commit, only the files `git diff` names are re-read; else
 * the tree is walked, and a file whose content hash is unchanged is not re-extracted.
 */
async function cmdIndexBuild(args: Args): Promise<number> {
  const rootRaw = getString(args.flags, "repo-root");
  if (!rootRaw || !isAbsolute(rootRaw)) {
    process.stderr.write("memory index build requires --repo-root <absolute-path>\n");
    return 2;
  }
  const root = resolve(rootRaw);
  const canonical = canonicalOf(args, root);
  if (!canonical) {
    process.stderr.write("memory index build: could not derive the repo's canonical\n");
    return 2;
  }
  const maxFiles = positiveInt(args, "max-files", INDEX_MAX_FILES_DEFAULT);
  const maxBytes = positiveInt(args, "max-bytes-per-file", INDEX_MAX_BYTES_PER_FILE_DEFAULT);
  if (maxFiles === null || maxBytes === null) return 2;
  const repo = getString(args.flags, "repo") ?? basename(canonicalizeRepo(canonical));
  const commit = getString(args.flags, "commit") ?? gitHead(root);
  const db = openDb();
  try {
    const record = buildCodeIndex(db, {
      repoKey: repoKey(canonical),
      repo,
      canonical: canonicalizeRepo(canonical),
      repoRoot: root,
      commit,
      full: getBool(args.flags, "full"),
      maxFiles,
      maxBytesPerFile: maxBytes,
    });
    if (getBool(args.flags, "json")) process.stdout.write(JSON.stringify(record) + "\n");
    else process.stdout.write(describeBuild(record));
    return 0;
  } finally {
    db.close();
  }
}

function renderNeighbours(r: NeighboursResult): string {
  if (r.status === "missing")
    return "code index: missing for this repo (run `memory index build`)\n";
  const lines: string[] = [
    `code index: ${r.status}${r.build ? ` (built at ${r.build.commit?.slice(0, 12) ?? "?"}, ${r.build.builtAt})` : ""}; ${r.method}, a lower bound`,
  ];
  for (const it of r.items) {
    const head = it.symbol ? `${it.symbol} (${it.path ?? "?"})` : (it.path ?? it.query);
    if (it.note && it.callersTotal === 0 && it.testsTotal === 0) {
      lines.push(`  ${head}: ${it.note}`);
      continue;
    }
    lines.push(
      `  ${head}: ${it.callersTotal} importing files (${it.callersTested} with a test), ${it.testsTotal} tests` +
        (it.note ? ` (${it.note})` : ""),
    );
    for (const c of it.callers)
      lines.push(
        `    caller ${c.path}:${c.line}${c.through ? ` through ${c.through}` : ""}${c.tested ? "" : " (no test imports it)"}`,
      );
    for (const t of it.tests)
      lines.push(`    test   ${t.path} (${t.via}${t.through ? ` through ${t.through}` : ""})`);
  }
  return lines.join("\n") + "\n";
}

/**
 * `memory index neighbours (--repo-root <abs> | --canonical <c>) [--paths p ...]
 *   [--symbols name|path#name ...] [--per-item N] [--commit <sha>] [--json]`
 *
 * Direct callers (files importing it) and tests of each named path / symbol. --commit is
 * the commit the caller's tree is at: the status says fresh when it is the build's, stale
 * otherwise, missing when the repo has no index. Read-only.
 */
async function cmdIndexNeighbours(args: Args): Promise<number> {
  const root = getString(args.flags, "repo-root");
  const canonical = canonicalOf(args, root);
  if (!canonical) {
    process.stderr.write("memory index neighbours requires --repo-root <abs> or --canonical <c>\n");
    return 2;
  }
  const perItem = positiveInt(args, "per-item", 5);
  if (perItem === null) return 2;
  const db = openDb();
  try {
    const r = codeNeighbours(db, {
      repoKey: repoKey(canonical),
      paths: getStringArray(args.flags, "paths"),
      symbols: getStringArray(args.flags, "symbols"),
      perItem,
      commit: getString(args.flags, "commit") ?? null,
    });
    if (getBool(args.flags, "json")) process.stdout.write(JSON.stringify(r) + "\n");
    else process.stdout.write(renderNeighbours(r));
    return 0;
  } finally {
    db.close();
  }
}

/** `memory index stats [--repo-root <abs> | --canonical <c>] [--json]`: coverage per repo. */
async function cmdIndexStats(args: Args): Promise<number> {
  const root = getString(args.flags, "repo-root");
  const canonical = root || getString(args.flags, "canonical") ? canonicalOf(args, root) : null;
  const db = openDb();
  try {
    const rows = codeIndexStats(db, canonical ? repoKey(canonical) : undefined);
    if (getBool(args.flags, "json")) {
      process.stdout.write(JSON.stringify({ repos: rows }) + "\n");
      return 0;
    }
    if (rows.length === 0) {
      process.stdout.write("No code index yet (run `memory index build --repo-root <abs>`).\n");
      return 0;
    }
    for (const r of rows) process.stdout.write(describeBuild(r) + "\n");
    return 0;
  } finally {
    db.close();
  }
}

export async function cmdIndex(args: Args): Promise<number> {
  const [sub, ...rest] = args.positionals;
  const inner: Args = { positionals: rest, flags: args.flags };
  switch (sub) {
    case "build":
      return cmdIndexBuild(inner);
    case "neighbours":
    case "neighbors":
      return cmdIndexNeighbours(inner);
    case "stats":
      return cmdIndexStats(inner);
    default:
      process.stderr.write("memory index: expected build | neighbours | stats\n");
      return 2;
  }
}

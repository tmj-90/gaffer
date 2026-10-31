#!/usr/bin/env node
// =====================================================================
// GATE INTEGRITY — the runner's seam into dispatch's one classifier
// (dispatch/test-integrity). runner/lib/dod.sh calls this for every write repo
// whose gate row names a base ref:
//
//   node gateIntegrityCli.js resolve --worktree <wt> --base <commit> --cmd <command>
//     → ONE line: <source>\t<note>\t<command-to-run>
//       The gate command's package.json script is read from the BASE commit, not
//       the worktree, so a delivery that rewrites `scripts.test`, adds a `pretest`, or
//       changes a script `test` runs cannot redirect the gate (source `base-pinned`:
//       the base expansion runs). See resolveGateCommand. <commit> is the SHA tick.sh
//       recorded when it cut the worktree, never a movable branch name.
//
//   node gateIntegrityCli.js scan --worktree <wt> --base <commit> --label <repo>
//                                 [--allow 1] [--cmd <command>]...
//     → ONE results-file row:
//       GATE\tintegrity\t<repo>\tPASS|FLAG\t0\t<reason>\t<source>
//       FLAG when base..worktree deleted/renamed a test file, added a skip/only
//       marker, changed/removed/added a script a gate script reaches (its hooks and
//       the scripts it runs), touched test-runner config, or touched (added too) a
//       package-manager rc file (.npmrc, .yarnrc, .yarnrc.yml, bunfig.toml), on disk
//       as well as in git (an ignored .npmrc still reconfigures the gate) — or
//       when the scan could not see the whole change. PASS-with-note when a human
//       set allow_test_changes on the ticket (`--allow 1`). NEVER FAIL: this slice
//       only flags; dispatch's `test-modified` risk annotation (computed server-side
//       from the same classifier) is what holds an auto-approve.
//
// The head side is the WORKING TREE (committed + uncommitted), because that is what
// the gate commands actually run against.
//
// FAIL TOWARD A HUMAN, never toward a pass: any error in `scan` prints a FLAG row
// naming it; any error in `resolve` prints `unresolved` and the registered command
// (the runner then runs today's command, and `scan` flags the same condition).
// Exit status is always 0 so a broken seam cannot crash a tick.
// =====================================================================

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  collectTestIntegrity,
  extraTestPathRe,
  GATE_RC_NAMES,
  gateScriptNamesOf,
  hasIntegrityFindings,
  hiddenIndexPaths,
  resolveGateCommand,
  summarizeIntegrity,
  type ConfigChange,
  type IntegrityGit,
  type TestIntegrityFindings,
} from "dispatch/test-integrity";

/** One TAB-safe field: tabs/newlines in a reason would shift the results columns. */
function field(s: string): string {
  return s.replace(/[\t\r\n]+/g, " ").trim();
}

/**
 * Repo config that would make git skip looking at the working tree is switched off for
 * every scan call: an fsmonitor that reports nothing changed, core.ignoreStat.
 */
const SCAN_GIT_CONFIG = ["-c", "core.fsmonitor=false", "-c", "core.ignoreStat=false"] as const;

function gitIn(wt: string): IntegrityGit {
  return (args, opts) => {
    const r = spawnSync("git", [...SCAN_GIT_CONFIG, "-C", wt, ...args], {
      encoding: "utf8",
      maxBuffer: opts?.maxBuffer ?? 16 * 1024 * 1024,
      timeout: 60_000,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const err = r.error as NodeJS.ErrnoException | undefined;
    if (err?.code === "ENOBUFS") return { status: 0, stdout: r.stdout ?? "", truncated: true };
    if (err) return { status: null, stdout: "" };
    return { status: r.status, stdout: r.stdout ?? "" };
  };
}

function readOrNull(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** At most this many package dirs are checked for an rc file on disk. */
const MAX_RC_DIRS = 500;

/**
 * Package-manager rc files ON DISK that the git diff cannot see: an `.npmrc` the
 * delivery wrote but `.gitignore` keeps out of the auto-commit still reconfigures the
 * gate (npm/pnpm read it from the worktree). Checks the root and every tracked
 * package.json's directory; an rc file absent at base is `added`, one whose bytes
 * differ from base is `modified`. Paths the diff already reported are skipped.
 */
function untrackedRcChanges(
  wt: string,
  git: IntegrityGit,
  base: string,
  seen: ReadonlySet<string>,
): ConfigChange[] {
  const dirs = new Set<string>([""]);
  const ls = git(["ls-files", "-z", "--", "package.json", ":(glob)**/package.json"]);
  if (ls.status === 0) {
    for (const f of ls.stdout.split("\0")) {
      if (!f || /(?:^|\/)node_modules\//.test(f)) continue;
      const i = f.lastIndexOf("/");
      dirs.add(i < 0 ? "" : f.slice(0, i));
      if (dirs.size >= MAX_RC_DIRS) break;
    }
  }
  const out: ConfigChange[] = [];
  for (const d of dirs) {
    for (const name of GATE_RC_NAMES) {
      const p = d ? `${d}/${name}` : name;
      if (seen.has(p)) continue;
      const disk = readOrNull(join(wt, p));
      if (disk === null) continue;
      const atBase = git(["show", `${base}:${p}`], { maxBuffer: 1024 * 1024 });
      if (atBase.status !== 0) out.push({ path: p, change: "added" });
      else if (atBase.truncated || atBase.stdout !== disk)
        out.push({ path: p, change: "modified" });
    }
  }
  return out;
}

function withRcOnDisk(
  f: TestIntegrityFindings,
  wt: string,
  git: IntegrityGit,
  base: string,
): TestIntegrityFindings {
  const extra = untrackedRcChanges(wt, git, base, new Set(f.configs.map((c) => c.path)));
  return extra.length ? { ...f, configs: [...f.configs, ...extra] } : f;
}

/**
 * Index entries git does not compare with the working tree (skip-worktree,
 * assume-unchanged, a sparse checkout): whatever is on disk under them is what the gate
 * ran, and the diff above could not see it. Any such entry makes the scan incomplete.
 */
function withHiddenIndexEntries(
  f: TestIntegrityFindings,
  git: IntegrityGit,
): TestIntegrityFindings {
  const ls = git(["ls-files", "-v", "-z"], { maxBuffer: 64 * 1024 * 1024 });
  if (ls.status !== 0 || ls.truncated) {
    return {
      ...f,
      incomplete: [...f.incomplete, "git could not list the index to check for hidden files"],
    };
  }
  const hidden = hiddenIndexPaths(ls.stdout);
  if (hidden.length === 0) return f;
  const shown =
    hidden.slice(0, 3).join(", ") + (hidden.length > 3 ? `, +${hidden.length - 3} more` : "");
  return {
    ...f,
    incomplete: [
      ...f.incomplete,
      `${hidden.length} tracked file${hidden.length === 1 ? " is" : "s are"} hidden from git's change check (skip-worktree / assume-unchanged): ${shown}`,
    ],
  };
}

interface Args {
  mode: string;
  worktree: string;
  base: string;
  label: string;
  allow: boolean;
  cmds: string[];
}

function parseArgs(argv: readonly string[]): Args {
  const a: Args = {
    mode: argv[0] ?? "",
    worktree: "",
    base: "",
    label: "-",
    allow: false,
    cmds: [],
  };
  for (let i = 1; i < argv.length; i += 1) {
    const k = argv[i];
    const v = argv[i + 1] ?? "";
    if (k === "--worktree") a.worktree = v;
    else if (k === "--base") a.base = v;
    else if (k === "--label") a.label = v;
    else if (k === "--allow") a.allow = v === "1" || v === "true";
    else if (k === "--cmd") a.cmds.push(v);
    else continue;
    i += 1;
  }
  return a;
}

function resolve(a: Args): string {
  const cmd = a.cmds[0] ?? "";
  if (!a.worktree || !/^[0-9a-f]{7,64}$/.test(a.base)) {
    return `unresolved\tno base commit to read the gate scripts from; ran the delivery's\t${cmd}`;
  }
  const git = gitIn(a.worktree);
  const shown = git(["show", `${a.base}:package.json`], { maxBuffer: 1024 * 1024 });
  const basePkg = shown.status === 0 && !shown.truncated ? shown.stdout : null;
  const headPkg = readOrNull(join(a.worktree, "package.json"));
  const r = resolveGateCommand(cmd, basePkg, headPkg, a.base);
  return `${r.source}\t${field(r.note)}\t${field(r.command)}`;
}

function scan(a: Args): string {
  const row = (status: "PASS" | "FLAG", reason: string, source: string): string =>
    `GATE\tintegrity\t${field(a.label) || "-"}\t${status}\t0\t${field(reason)}\t${field(source)}`;
  if (!a.worktree || !/^[0-9a-f]{7,64}$/.test(a.base)) {
    return row(
      "FLAG",
      "could not resolve the base commit, so test changes could not be checked",
      "unresolved",
    );
  }
  const git = gitIn(a.worktree);
  // Head = the WORKING TREE: `git diff <base>` (no second rev) compares base with it,
  // and the package.json head text is read from disk.
  const wtGit: IntegrityGit = (args, opts) => {
    if (args[0] === "diff") {
      const i = args.indexOf("@WORKTREE@");
      return git(i === -1 ? args : [...args.slice(0, i), ...args.slice(i + 1)], opts);
    }
    if (args[0] === "show" && typeof args[1] === "string" && args[1].startsWith("@WORKTREE@:")) {
      const text = readOrNull(join(a.worktree, args[1].slice("@WORKTREE@:".length)));
      return text === null ? { status: 128, stdout: "" } : { status: 0, stdout: text };
    }
    return git(args, opts);
  };
  const findings = withHiddenIndexEntries(
    withRcOnDisk(
      collectTestIntegrity(wtGit, a.base, "@WORKTREE@", {
        gateScriptNames: gateScriptNamesOf(a.cmds),
        extraTestPathRe: extraTestPathRe(process.env.GAFFER_TEST_PATH_RE),
      }),
      a.worktree,
      git,
      a.base,
    ),
    git,
  );
  const source = `base ${a.base.slice(0, 12)} vs worktree`;
  if (!hasIntegrityFindings(findings)) return row("PASS", summarizeIntegrity(findings), source);
  const summary = summarizeIntegrity(findings);
  if (a.allow)
    return row("PASS", `test changes allowed on this ticket by a human: ${summary}`, source);
  return row("FLAG", summary, source);
}

function main(): void {
  const a = parseArgs(process.argv.slice(2));
  let out: string;
  try {
    if (a.mode === "resolve") out = resolve(a);
    else if (a.mode === "scan") out = scan(a);
    else return;
  } catch (e) {
    const why = field(e instanceof Error ? e.message : String(e)).slice(0, 200);
    out =
      a.mode === "scan"
        ? `GATE\tintegrity\t${field(a.label) || "-"}\tFLAG\t0\tthe integrity scan errored (${why})\tunresolved`
        : `unresolved\tthe gate-script resolver errored (${why}); ran the delivery's\t${field(a.cmds[0] ?? "")}`;
  }
  process.stdout.write(`${out}\n`);
}

main();

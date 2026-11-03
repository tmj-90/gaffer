/**
 * Git and refs: branch creation only inside a write root, branch ref rewrites, and the
 * files that change what git executes (hooks, repository git config, driver assignments).
 *
 * Part of the safety hook's decision, split out of runner/safety-hook-core.mjs (the one
 * module the hook and the tests import); see the map in its header.
 */

import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import {
  canonicalize,
  classifyRootAccess,
  expandTildePath,
  expandTildeWord,
  replayCd,
} from "./paths.mjs";
import { UNVERIFIABLE_TARGET, normalizeVerb, tokenizeSegment } from "./shell.mjs";
import { extractShellDashCBodies, resolveEffectiveTokens } from "./verbs.mjs";

// Branch-creation forms that must only occur inside a write-root:
//   `git checkout -b|-B [<flags>] <branch>`   `git checkout --orphan <branch>`
//   `git switch -c|-C|--create|--orphan <branch>`
//   `git branch <branch>`                      (not the list/delete/show forms)
//   `git worktree add … -b|-B <branch> …`      (creates the branch in the -C/cwd repo)
// Previously only `checkout -B`, `switch -c|--create` and `branch` matched: the
// lowercase `checkout -b` (the far more common form), a `-b` after another flag
// (`checkout -q -b`), and `worktree add -b` all created a branch in a READ-ONLY
// repo unnoticed.
const BRANCH_CREATE =
  /\bgit\s+(?:-C\s+("[^"]+"|'[^']+'|\S+)\s+)?(?:checkout(?:\s+-[^\s;&|]+)*\s+(?:-[bB]|--orphan)\b|switch(?:\s+-[^\s;&|]+)*\s+(?:-[cC]|--create|--orphan)\b|branch\b(?!\s+(?:-[dD]|--delete|--list|-a|-r|-v|--show-current))|worktree\s+add(?:\s+[^\s;&|]+)*?\s+-[bB]\b)/;

/**
 * Enforce branch creation only inside a write-root. The relevant location is
 * the repo the branch is created in: `git -C <dir> …` names it explicitly,
 * otherwise it is the EFFECTIVE cwd — the hook's cwd as relocated by any
 * preceding `cd`/`pushd` in the same command (a leading `cd <read-root> &&`
 * used to move the write into a read root unnoticed, because the target was
 * resolved against the process cwd). Scanned per segment, left to right, with
 * the same cwd replay the write-target extractor uses; a dynamic/unknown cd
 * (`cd $VAR`, `cd -`, `popd`) makes a later relative target unprovable → fail
 * closed. Recurses into `sh -c '…'` bodies. Returns a block reason or null.
 */
function branchCreationBoundaryReason(cmd, roots) {
  let effectiveCwd = process.cwd();
  for (const segment of cmd.split(/(?:&&|\|\||;|\n|(?<![>&])&(?!>)|(?<!>)\|)/)) {
    const tokens = tokenizeSegment(segment.trim());
    if (tokens.length === 0) continue;
    const effective = resolveEffectiveTokens(tokens);
    // Replay `cd`/`pushd`/`popd` exactly as extractBashWriteTargets does.
    if (effective && (effective.verb === "cd" || effective.verb === "pushd")) {
      effectiveCwd = replayCd(effective, effectiveCwd);
      continue;
    }
    if (effective && effective.verb === "popd") {
      effectiveCwd = null;
      continue;
    }
    const m = segment.match(BRANCH_CREATE);
    if (!m) continue;
    // `git -C ~ …` names $HOME (bash expands the unquoted tilde); `~user` fails closed.
    const dir = m[1] ? expandTildeWord(m[1], effectiveCwd) : ".";
    if (dir === UNVERIFIABLE_TARGET) {
      return `branch creation in an unverifiable repo (unresolvable ~ target): ${m[1]} [write-roots: ${roots.writeRoots.join(", ")}]`;
    }
    // A `-C` dir carrying shell interpolation is not a provable literal → fail closed.
    if (/[$`]|\$\{/.test(dir)) {
      return `branch creation in an unverifiable repo (dynamic -C target): ${dir} [write-roots: ${roots.writeRoots.join(", ")}]`;
    }
    // A relative repo (the bare cwd, or a relative -C) under an unknown cwd is
    // unprovable → fail closed. Absolute -C targets ignore the cwd.
    if (!dir.startsWith("/") && effectiveCwd === null) {
      return `branch creation in an unverifiable repo (cwd relocated by a dynamic cd): ${dir} [write-roots: ${roots.writeRoots.join(", ")}]`;
    }
    const abs = canonicalize(resolve(effectiveCwd ?? "/", dir));
    if (classifyRootAccess(abs, roots) !== "write") {
      return `branch creation outside write-roots (target repo is not writable): ${dir} [write-roots: ${roots.writeRoots.join(", ")}]`;
    }
  }
  // A `sh -c '<body>'` nested program can carry its own branch creation.
  for (const body of extractShellDashCBodies(cmd)) {
    const nested = branchCreationBoundaryReason(body, roots);
    if (nested) return nested;
  }
  return null;
}

// =====================================================================
// GATE INTEGRITY: BRANCH REF REWRITES (token-based)
// ---------------------------------------------------------------------
// A delivery worktree shares refs with the real repo, so a ref rewrite from inside it
// (`git branch -f main HEAD`) moves the operator's base branch onto the agent's own
// commits. lib/dangerous-commands.mjs denies the plain spellings by regex; this check
// reads the TOKENS so the forms git also accepts are caught: combined short flags
// (`-fq`), a flag after the arguments (`branch main HEAD --force`), global options
// before the subcommand (`git -c k=v -C dir branch …`), `--`, an abbreviated long
// option (`--forc`), a redirect between the arguments, and `xargs`-fed arguments.
// The rule: a force / copy flag on `git branch`, `checkout -B`, `switch -C` is allowed
// only when EVERY argument is a runner-owned `gaffer/…` branch or a HEAD start point
// (`git branch -f gaffer/ticket-5-x HEAD`); `git branch -m/-M` (rename) is always
// denied; a `symbolic-ref` WRITE (two arguments, or -d) is denied unless it points at
// refs/heads/gaffer/…; push/fetch into a local path (`.`, `./`, `$PWD`, `/abs`) is
// denied; and a `-c alias.…` / `git config alias.…` that would smuggle any of these
// behind an alias is denied. Fails closed on anything it cannot read literally
// (`$VAR`, a glob, a command substitution as an argument). HONEST RESIDUAL: a script
// file the hook never sees can still run git — the structural guarantee is that the
// runner records the delivery's base commit itself and dispatch checks it (SECURITY.md).
// =====================================================================

// git's global options that take their value as the NEXT token.
const GIT_GLOBAL_VALUE_OPTS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--config-env",
  "--super-prefix",
  "--exec-path",
  "--list-cmds",
  "--attr-source",
]);
// A shell redirection token; `bare` when the target is the NEXT token (`2>`, `>`).
const REDIRECT_TOKEN = /^\d*(?:&>>?|>>?|<<?<?|>&|<&|>\|)(.*)$/;
const REF_REWRITE_VERBS = /\b(?:branch|update-ref|symbolic-ref|checkout|switch|push|fetch)\b/;

/** A literal word as bash would pass it (quotes / backslashes removed), or null if dynamic. */
function literalWord(token) {
  if (/[$`*?[{}()]/.test(token)) return null;
  return token.replace(/['"\\]/g, "");
}

/** An argument a force/copy may name: a runner-owned gaffer/ branch, or a HEAD start point. */
function safeRefArg(token) {
  const w = literalWord(token);
  if (w === null) return false;
  return /^(?:refs\/heads\/)?gaffer\/[A-Za-z0-9._/-]+$/.test(w) || /^HEAD(?:[~^]\d*)*$/.test(w);
}

/** Split a git subcommand's tokens into flags and positionals (redirections dropped). */
function gitArgsOf(tokens) {
  const flags = [];
  const positionals = [];
  let endOfOpts = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    const r = REDIRECT_TOKEN.exec(t);
    if (r) {
      if (r[1] === "") i += 1; // `>` `2>`: the target is the next token
      continue;
    }
    if (!endOfOpts && t === "--") {
      endOfOpts = true;
      continue;
    }
    if (!endOfOpts && literalWord(t)?.startsWith("-")) flags.push(literalWord(t));
    else positionals.push(t);
  }
  return { flags, positionals };
}

const isPrefixOf = (flag, long, min) =>
  flag.startsWith("--") && flag.length - 2 >= min && long.startsWith(flag.slice(2));
const shortCluster = (flag, letters) =>
  /^-[A-Za-z]+$/.test(flag) && [...flag.slice(1)].some((c) => letters.includes(c));

/** Why one git invocation (tokens after `git`) rewrites a non-gaffer ref, or null. */
function gitRefRewriteReason(after, fedByXargs) {
  // Global options before the subcommand (`-C dir`, `-c k=v`, `--git-dir=x`, `-P`…).
  let i = 0;
  const aliases = [];
  while (i < after.length && literalWord(after[i])?.startsWith("-")) {
    const opt = literalWord(after[i]);
    if (GIT_GLOBAL_VALUE_OPTS.has(opt)) {
      if (opt === "-c" && i + 1 < after.length) aliases.push(after[i + 1]);
      i += 2;
    } else {
      if (/^--config-env=/.test(opt) || /^-c.+/.test(opt)) aliases.push(opt);
      i += 1;
    }
  }
  for (const a of aliases) {
    const w = (literalWord(a) ?? a).replace(/^-c/, "");
    if (
      /^alias\./i.test(w) &&
      (REF_REWRITE_VERBS.test(w) || /=\s*!/.test(w) || literalWord(a) === null)
    ) {
      return "a git alias that runs a ref-rewriting command";
    }
  }
  if (i >= after.length) return null;
  const sub = literalWord(after[i]);
  if (sub === null) return null; // `git $SUB …`: the verb rules elsewhere govern dynamic commands
  const { flags, positionals } = gitArgsOf(after.slice(i + 1));
  const allSafe = () => !fedByXargs && positionals.every(safeRefArg);
  if (sub === "branch") {
    const move = flags.some((f) => shortCluster(f, "mM") || isPrefixOf(f, "move", 1));
    if (move) return "git branch -m/-M (renaming a branch)";
    const force = flags.some(
      (f) => shortCluster(f, "fcC") || isPrefixOf(f, "force", 1) || isPrefixOf(f, "copy", 1),
    );
    if (force && !allSafe()) return "git branch -f/-c/-C of a non-gaffer branch";
    return null;
  }
  if (sub === "checkout") {
    if (flags.some((f) => shortCluster(f, "B")) && !allSafe()) {
      return "git checkout -B of a non-gaffer branch";
    }
    return null;
  }
  if (sub === "switch") {
    const recreate = flags.some(
      (f) => shortCluster(f, "C") || (f.startsWith("--force-") && isPrefixOf(f, "force-create", 7)),
    );
    if (recreate && !allSafe()) return "git switch -C of a non-gaffer branch";
    return null;
  }
  if (sub === "symbolic-ref") {
    const del = flags.some((f) => shortCluster(f, "d") || isPrefixOf(f, "delete", 1));
    if (del) return "git symbolic-ref --delete";
    if (positionals.length >= 2) {
      const target = literalWord(positionals[1]);
      if (
        fedByXargs ||
        target === null ||
        !/^refs\/heads\/gaffer\/[A-Za-z0-9._/-]+$/.test(target)
      ) {
        return "git symbolic-ref pointing a ref at a non-gaffer branch";
      }
    }
    if (fedByXargs) return "git symbolic-ref with arguments from stdin";
    return null;
  }
  if (sub === "update-ref") return "git update-ref";
  if (sub === "push" || sub === "fetch") {
    if (positionals.length === 0) return null;
    const repo = literalWord(positionals[0]);
    if (repo === null || /^(?:\.|\.\.|~)(?:\/|$)|^\/|^file:/.test(repo)) {
      return `git ${sub} into a local repository (${positionals[0]})`;
    }
    return null;
  }
  if (sub === "config") {
    const key = positionals.length > 0 ? literalWord(positionals[0]) : "";
    if (key !== null && /^alias\./i.test(key) && positionals.length >= 2) {
      const val = positionals
        .slice(1)
        .map((t) => literalWord(t) ?? t)
        .join(" ");
      if (
        REF_REWRITE_VERBS.test(val) ||
        /^!/.test(val) ||
        positionals.slice(1).some((t) => literalWord(t) === null)
      ) {
        return "git config of an alias that runs a ref-rewriting command";
      }
    }
    return null;
  }
  return null;
}

/**
 * GATE INTEGRITY: a block reason when the command rewrites a branch ref other than a
 * runner-owned gaffer/ branch (see the section comment), or null. Scanned per segment
 * and inside `sh -c '…'` bodies.
 */
function refRewriteReason(cmd) {
  for (const segment of cmd.split(/(?:&&|\|\||;|\n|(?<![>&])&(?!>)|(?<!>)\|)/)) {
    const tokens = tokenizeSegment(segment.trim());
    for (let g = 0; g < tokens.length; g += 1) {
      if (basename(normalizeVerb(tokens[g])) !== "git") continue;
      const fedByXargs = tokens.slice(0, g).some((t) => basename(normalizeVerb(t)) === "xargs");
      const why = gitRefRewriteReason(tokens.slice(g + 1), fedByXargs);
      if (why) {
        return `branch ref rewrite (${why}) — the agent commits on its ticket branch and never moves, renames or force-resets another branch`;
      }
    }
  }
  for (const body of extractShellDashCBodies(cmd)) {
    const nested = refRewriteReason(body);
    if (nested) return nested;
  }
  return null;
}

// =====================================================================
// GIT EXECUTION SURFACE (external review #9, finding 2)
// ---------------------------------------------------------------------
// Git runs code that its configuration names, and in many repositories that code is a
// TRACKED file: hook scripts under a relative core.hooksPath (husky's `.husky/`,
// `.githooks/`), hook-manager configs (lefthook, pre-commit, overcommit) whose entries
// are commands, and git config files pulled in by include.path (`.gitconfig`) or read by
// git-lfs (`.lfsconfig`), which can set hooksPath, filters, diff/merge drivers and
// helpers. `.gitattributes` selects which configured filter/diff/merge driver runs on a
// path. An agent edit to any of these is an edit to what git executes. The runner's own
// host git runs with hooks and in-repo drivers neutralised (lib/git-safe.mjs); this is
// the second layer: the agent may not edit them at all. A person changes them.
const HOOK_SURFACE_DIR = /(^|\/)(\.husky|\.githooks|\.git-hooks)(\/|$)/;
const HOOK_SURFACE_FILE =
  /(^|\/)(\.?lefthook(-local)?\.ya?ml|\.pre-commit-config\.ya?ml|\.overcommit\.ya?ml|\.gitconfig|[\w.-]+\.gitconfig|\.lfsconfig)$/i;
const DRIVER_SELECTION = /(^|[\s!-])(filter|diff|merge)=/;

/** git output for a lookup in `dir` (never runs hooks or fsmonitor), or "". */
function gitLookup(dir, args) {
  try {
    const r = spawnSync(
      "git",
      ["-C", dir, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
      { encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"] },
    );
    return r.status === 0 ? String(r.stdout ?? "") : "";
  } catch {
    return "";
  }
}
/** The nearest existing directory at or above `abs` (git needs a real cwd). */
function existingDir(abs) {
  let d = abs;
  for (let i = 0; i < 64; i++) {
    try {
      if (lstatSync(d).isDirectory()) return d;
    } catch {
      /* keep walking up */
    }
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
  return null;
}
const insidePath = (p, root) => p === root || p.startsWith(root.endsWith("/") ? root : root + "/");

/**
 * Why writing `abs` would change what git executes, or null. `content` is the text being
 * written (Write content / Edit new_string), or null when it is not known (a bash write).
 */
function gitExecSurfaceReason(abs, content) {
  if (HOOK_SURFACE_DIR.test(abs)) {
    return `edit to a git hook script (${abs}): hooks run on every commit, checkout and merge, so a person changes them`;
  }
  if (HOOK_SURFACE_FILE.test(abs)) {
    return `edit to repository git config or a hook manager's config (${abs}): it can name programs git runs (hooksPath, filters, diff/merge drivers, helpers), so a person changes it`;
  }
  if (/(^|\/)\.gitattributes$/.test(abs) && (content === null || DRIVER_SELECTION.test(content))) {
    return `edit to .gitattributes that assigns a filter, diff or merge driver (${abs}): a driver is a program git runs, so a person changes it`;
  }
  // The repository's own configuration: its core.hooksPath directory and every file it
  // includes, mapped onto this checkout (a linked worktree shares the primary's config).
  const dir = existingDir(dirname(abs));
  if (!dir) return null;
  const rp = gitLookup(dir, [
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
    "--git-common-dir",
  ])
    .split("\n")
    .map((l) => l.trim());
  const top = rp[0];
  if (!top) return null;
  let topC = top;
  try {
    topC = realpathSync(top);
  } catch {
    /* keep the spelling git gave */
  }
  const common = rp[1] ?? "";
  const primary = common && basename(common) === ".git" ? dirname(common) : topC;
  // Map a path in the primary checkout onto this checkout (same relative path).
  const onto = (p) =>
    insidePath(p, primary) && p !== primary ? resolve(topC, p.slice(primary.length + 1)) : p;
  const cfg = gitLookup(dir, [
    "config",
    "--show-origin",
    "--get-regexp",
    "^(core\\.hookspath|include(if\\..*)?\\.path)$",
  ]);
  for (const line of cfg.split("\n")) {
    const m = /^file:(\S+)\s+(\S+)\s+(.+)$/.exec(line.trim());
    if (!m) continue;
    const [, originRel, key, value] = m;
    const v = expandTildePath(value) ?? value;
    if (key.toLowerCase() === "core.hookspath") {
      if (v === "/dev/null") continue;
      const h = resolve(topC, v);
      if (insidePath(abs, h) || insidePath(abs, onto(h))) {
        return `edit to a git hook script in core.hooksPath (${abs}): hooks run on every commit, checkout and merge, so a person changes them`;
      }
    } else {
      const inc = resolve(dirname(resolve(dir, originRel)), v);
      if (abs === inc || abs === onto(inc)) {
        return `edit to a git config file the repository includes (${abs}): it can name programs git runs, so a person changes it`;
      }
    }
  }
  return null;
}

export { DRIVER_SELECTION, branchCreationBoundaryReason, gitExecSurfaceReason, refRewriteReason };

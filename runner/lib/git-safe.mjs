#!/usr/bin/env node
// runner/lib/git-safe.mjs — the git configuration every HOST bookkeeping git command
// runs under (external review #9, finding 2).
//
// The runner runs git on the host for its own bookkeeping: the auto-commit, worktree
// add/remove, fetch, merge, push, status, rev-parse… in tick.sh, lib/*.sh, land.sh,
// bin/merge-ticket.mjs, json-tool and the crew/memory CLIs. Those commands run in a
// repository an agent has just edited. Git executes code named by configuration, and
// several of those settings commonly point INTO the repository:
//   • hooks: core.hooksPath set to a tracked dir (husky's `.husky/_`, `.githooks`), so
//     an agent's edit to `.githooks/pre-commit` ran on the host at the next auto-commit;
//   • core.fsmonitor: a hook-like program git runs on status/add/commit;
//   • drivers and helpers whose command is a tracked script: filter.<d>.clean/smudge/
//     process, diff.<d>.textconv/command, diff.external, merge.<d>.driver,
//     core.sshCommand, core.askPass, core.editor, sequence.editor, core.pager, pager.*,
//     core.gitProxy, core.alternateRefsCommand, credential[.<url>].helper,
//     gpg[.<fmt>].program, trailer.<t>.command/cmd, remote.<r>.uploadpack/receivepack,
//     submodule.<s>.update, lfs.customtransfer.<n>.path, lfs.extension.<n>.clean/smudge;
//   • any of the above coming from a TRACKED file pulled in by include.path/includeIf.
//
// So host bookkeeping git always runs with core.hooksPath=/dev/null and
// core.fsmonitor=false, and every code-running key above whose value names a path in
// the repository (a relative path, an absolute path under the checkout, or a bare word
// that is a file there), or that was read from a file inside the checkout, is
// overridden with an inert value. The overrides travel in git's environment channel
// (GIT_CONFIG_COUNT / GIT_CONFIG_KEY_<n> / GIT_CONFIG_VALUE_<n>), which beats every
// config file, so they reach every git child of the process that exports them, node
// or bash, without editing each call site. A driver neutralised this way fails closed
// (a merge driver that cannot run is a conflict; a filter that cannot run is skipped),
// never runs the repository's code. Operator-wide settings that point outside the
// repository (git-lfs, a signing program in /usr/bin) are left alone.
//
//   import { hardenGitEnv } from "./git-safe.mjs";
//   hardenGitEnv(process.env, [repoDir]);            // in place, returns the env
//   node git-safe.mjs env [repo...]                  // shell `export` lines (lib/git-safe.sh)
//   node git-safe.mjs overrides [repo...]            // key=value lines (tests, diagnostics)

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Always set for host bookkeeping git. */
export const STATIC_GIT_OVERRIDES = Object.freeze([
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", "false"],
]);

/** Code-running keys (git lower-cases section and variable names, keeps subsections). */
const CODE_KEYS = [
  [/^filter\..+\.(?:clean|smudge|process)$/i, () => ""],
  [/^diff\..+\.(?:textconv|command)$/i, () => ""],
  [/^diff\.external$/i, () => ""],
  [/^merge\..+\.driver$/i, () => ""],
  [/^core\.sshcommand$/i, () => "ssh"],
  [/^core\.askpass$/i, () => ""],
  [/^core\.(?:editor)$/i, () => ":"],
  [/^sequence\.editor$/i, () => ":"],
  [/^core\.pager$/i, () => "cat"],
  [/^pager\..+$/i, () => "cat"],
  [/^core\.gitproxy$/i, () => ""],
  [/^core\.alternaterefscommand$/i, () => ""],
  [/^credential\.(?:.+\.)?helper$/i, () => ""],
  [/^gpg\.program$/i, () => "gpg"],
  [/^gpg\.ssh\.program$/i, () => "ssh-keygen"],
  [/^gpg\.x509\.program$/i, () => "gpgsm"],
  [/^gpg\.openpgp\.program$/i, () => "gpg"],
  [/^trailer\..+\.(?:command|cmd)$/i, () => ""],
  [/^remote\..+\.uploadpack$/i, () => "git-upload-pack"],
  [/^remote\..+\.receivepack$/i, () => "git-receive-pack"],
  [/^submodule\..+\.update$/i, () => "checkout"],
  [/^lfs\.customtransfer\..+\.path$/i, () => ""],
  [/^lfs\.extension\..+\.(?:clean|smudge)$/i, () => ""],
];

const BASE_ARGS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

function canon(p) {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}
function under(p, root) {
  return p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}
function git(dir, args) {
  const r = spawnSync("git", ["-C", dir, ...BASE_ARGS, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 16 * 1024 * 1024,
  });
  return r.status === 0 ? r.stdout : null;
}

/** The checkout roots a repository's code can live in: its toplevel and its primary checkout. */
function repoRoots(dir) {
  const roots = new Set();
  const top = git(dir, ["rev-parse", "--show-toplevel"]);
  if (top && top.trim()) roots.add(canon(top.trim()));
  const common = git(dir, ["rev-parse", "--git-common-dir"]);
  if (common && common.trim()) {
    const c = canon(path.resolve(dir, common.trim()));
    if (path.basename(c) === ".git") roots.add(path.dirname(c));
  }
  return [...roots];
}

/** True when the command value names something inside one of the roots. */
export function valuePointsInto(value, cwd, roots) {
  const tokens = String(value)
    .replace(/^!/, "")
    .split(/[\s;&|()<>`]+/)
    .map((t) => t.replace(/^['"]+|['"]+$/g, ""))
    .filter(Boolean);
  for (const t of tokens) {
    if (t.startsWith("-") || t.startsWith("%") || t.startsWith("$")) continue;
    const isAbs = path.isAbsolute(t);
    if (!isAbs && t.includes("/")) return true; // a relative path: resolved in the checkout
    const abs = isAbs ? t : path.resolve(cwd, t);
    if (!isAbs && !existsSync(abs)) continue; // a bare word git finds on PATH
    const c = canon(abs);
    if (roots.some((r) => under(c, r))) return true;
  }
  return false;
}

/** Overrides for one repository: [[key, value], …] for every code-running key that points in. */
export function repoOverrides(dir) {
  if (!dir || !existsSync(dir)) return [];
  const raw = git(dir, ["config", "--show-origin", "-z", "--list"]);
  if (raw == null) return [];
  const roots = repoRoots(dir);
  if (roots.length === 0) return [];
  const cwd = canon(dir);
  const out = [];
  const parts = raw.split("\0");
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const origin = parts[i];
    const entry = parts[i + 1];
    const nl = entry.indexOf("\n");
    const key = nl === -1 ? entry : entry.slice(0, nl);
    const value = nl === -1 ? "" : entry.slice(nl + 1);
    const rule = CODE_KEYS.find(([re]) => re.test(key));
    if (!rule) continue;
    let fromRepoFile = false;
    if (origin.startsWith("file:")) {
      const f = canon(path.resolve(dir, origin.slice(5)));
      // A config file inside a checkout's working tree is a tracked (agent-editable)
      // file; the repository's own .git/config is not.
      fromRepoFile = roots.some((r) => under(f, r) && !under(f, path.join(r, ".git")));
    }
    if (fromRepoFile || valuePointsInto(value, cwd, roots)) {
      out.push([key, rule[1](key)]);
      const m = /^filter\.(.+)\.(?:clean|smudge|process)$/i.exec(key);
      if (m) out.push([`filter.${m[1]}.required`, "false"]);
    }
  }
  return out;
}

/**
 * Add the bookkeeping overrides to `env` (in place) for the given repositories and
 * return it. Entries the caller's environment already carried (GIT_CONFIG_* set by the
 * operator) are kept in front; calling it again rebuilds only Gaffer's own entries.
 */
export function hardenGitEnv(env = process.env, repos = []) {
  const base = Number.parseInt(env.GIT_CONFIG_GAFFER_BASE ?? env.GIT_CONFIG_COUNT ?? "0", 10) || 0;
  const prevCount = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10) || 0;
  for (let i = base; i < Math.max(prevCount, base); i++) {
    delete env[`GIT_CONFIG_KEY_${i}`];
    delete env[`GIT_CONFIG_VALUE_${i}`];
  }
  const seen = new Map();
  for (const [k, v] of STATIC_GIT_OVERRIDES) seen.set(k.toLowerCase(), [k, v]);
  // Repositories hardened earlier in this process stay hardened.
  const known = (env.GIT_CONFIG_GAFFER_REPOS ?? "").split("\n").filter(Boolean);
  const all = [...new Set([...known, ...repos.filter(Boolean).map((r) => path.resolve(r))])];
  for (const r of all) for (const [k, v] of repoOverrides(r)) seen.set(k, [k, v]);
  let n = base;
  for (const [k, v] of seen.values()) {
    env[`GIT_CONFIG_KEY_${n}`] = k;
    env[`GIT_CONFIG_VALUE_${n}`] = v;
    n++;
  }
  env.GIT_CONFIG_COUNT = String(n);
  env.GIT_CONFIG_GAFFER_BASE = String(base);
  if (all.length) env.GIT_CONFIG_GAFFER_REPOS = all.join("\n");
  return env;
}

function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

const isMain = (() => {
  try {
    return (
      process.argv[1] &&
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
})();
if (isMain) {
  const [, , cmd, ...repos] = process.argv;
  if (cmd === "env") {
    const before = { ...process.env };
    const env = hardenGitEnv({ ...process.env }, repos);
    const lines = [];
    for (const k of Object.keys(before)) {
      if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k) && !(k in env)) lines.push(`unset ${k}`);
    }
    for (const [k, v] of Object.entries(env)) {
      if (!/^(GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)|GIT_CONFIG_GAFFER_(BASE|REPOS))$/.test(k))
        continue;
      if (before[k] === v) continue;
      lines.push(`export ${k}=${shq(v)}`);
    }
    process.stdout.write(lines.join("\n") + (lines.length ? "\n" : ""));
  } else if (cmd === "overrides") {
    for (const r of repos)
      for (const [k, v] of repoOverrides(r)) process.stdout.write(`${k}=${v}\n`);
  } else {
    process.stderr.write("usage: git-safe.mjs env|overrides [repo...]\n");
    process.exit(2);
  }
}

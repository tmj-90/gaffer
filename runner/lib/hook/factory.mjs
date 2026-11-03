/**
 * The factory front door: a command that runs or sources the live factory's own code
 * (RUNNER_DIR, a package dist/) is refused however it is spelled.
 *
 * Part of the safety hook's decision, split out of runner/safety-hook-core.mjs (the one
 * module the hook and the tests import); see the map in its header.
 */

import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize, expandTildeWord, isInsideAny, isInsideRoot, replayCd } from "./paths.mjs";
import {
  UNVERIFIABLE_TARGET,
  splitRedirectToken,
  substituteVars,
  tokenizeSegment,
  unquote,
} from "./shell.mjs";
import { ASSIGNMENT_TOKEN, extractShellDashCBodies, resolveEffectiveTokens } from "./verbs.mjs";

// =====================================================================
// FACTORY FRONT DOOR (the agent must not run the factory's own code)
// ---------------------------------------------------------------------
// The live factory checkout holds the privileged entry points: `runner/gaffer
// approve|merge` records a HUMAN approval / lands a branch, `bin/merge-ticket.mjs`
// merges, `tick.sh` / `loop.sh` spawn agents, `factory.config.sh` derives the
// real DB paths from its own location, and packages/*/dist is the control plane.
// The hook knows where that checkout is — it lives in it — so any command that
// EXECUTES or SOURCES a file inside this RUNNER_DIR, or inside a package `dist/`
// next to it, is refused, however the path is spelled (absolute, `cd … && ./x`,
// `bash x`, `node x`, `nohup`/`setsid`/subshell-deferred, `sh -c '…'`). A delivery
// worktree is a separate checkout, so `node runner/test/x.test.mjs` or
// `bash scripts/x.sh` inside the agent's own worktree is unaffected.
// lib/dangerous-commands.mjs carries the path-less forms (`gaffer approve` via
// PATH, `node …/merge-ticket.mjs`) as regex defence in depth.
// HONEST RESIDUAL: a script path the hook cannot see (`G=…; $G approve`, a copy
// of the script elsewhere) is not caught here; the structural gate for that is
// the human credential on approval (see the work-package report).
// =====================================================================
// This file sits in runner/lib/hook/; the runner directory is the one the public core
// (../../safety-hook-core.mjs) lives in, so the paths are taken from the core's URL.
const CORE_URL = new URL("../../safety-hook-core.mjs", import.meta.url).href;
const HOOK_RUNNER_DIR = canonicalize(dirname(fileURLToPath(CORE_URL)));
const FACTORY_HOME = dirname(HOOK_RUNNER_DIR);
// Interpreters (and `exec`) whose operands include the script they run.
const SCRIPT_INTERPRETERS = new Set([
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  "node",
  "nodejs",
  "deno",
  "bun",
  "python",
  "python3",
  "perl",
  "ruby",
  "source",
  ".",
  "exec",
]);

// Launchers that run their operands as a command (`watch x`, `flock f x`): like an
// interpreter, every operand is checked.
const COMMAND_LAUNCHERS = new Set([
  "busybox",
  "toybox",
  "watch",
  "flock",
  "taskset",
  "chrt",
  "unbuffer",
  "strace",
  "ltrace",
]);
// Non-shell interpreters' inline-program flags (`node -e`, `perl -e`, `python -c`):
// a factory path NAMED inside the program (`system("…/gaffer approve")`) counts.
const INLINE_CODE_FLAGS = new Set(["-e", "-E", "-c", "-p", "--eval", "--print", "-r"]);
const SHELL_INTERPRETERS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
// xargs options that take their value as the NEXT token.
const XARGS_VALUE_FLAGS = new Set([
  "-I",
  "-n",
  "-P",
  "-L",
  "-d",
  "-s",
  "-a",
  "-E",
  "--max-args",
  "--max-procs",
  "--max-lines",
  "--delimiter",
  "--max-chars",
  "--arg-file",
  "--eof",
  "--replace",
  "--process-slot-var",
]);

/**
 * The raw tokens a resolved segment would EXECUTE (or source), for the factory
 * check. Matched on the verb's basename (`/bin/bash`, `/usr/bin/env`): a path-qualified
 * verb is a candidate itself; an interpreter, `exec` or launcher contributes EVERY
 * non-flag operand (an option's value such as `bash -o pipefail` must not hide the
 * script that follows it), plus the absolute paths named in a non-shell inline
 * program; `xargs` and `find -exec|-execdir|-ok|-okdir` are unwrapped to the
 * command they run.
 */
function factoryExecCandidates(effective, depth = 0) {
  if (!effective || depth > 8) return [];
  const out = [];
  const verb = effective.verb;
  const base = basename(verb);
  const args = effective.rest.slice(1);
  if (verb.includes("/")) out.push(verb);
  if (SCRIPT_INTERPRETERS.has(base) || COMMAND_LAUNCHERS.has(base)) {
    for (let k = 0; k < args.length; k += 1) {
      const tk = args[k];
      if (tk.startsWith("-")) {
        const code = args[k + 1];
        if (INLINE_CODE_FLAGS.has(tk) && code !== undefined && !SHELL_INTERPRETERS.has(base)) {
          for (const m of unquote(code).matchAll(/(?:^|[^\w./~-])(\/[^\s'"`;|&()<>,]+)/g)) {
            out.push(m[1]);
          }
        }
        continue;
      }
      out.push(tk);
    }
  } else if (base === "xargs") {
    let k = 0;
    while (k < args.length && args[k].startsWith("-")) k += XARGS_VALUE_FLAGS.has(args[k]) ? 2 : 1;
    out.push(...factoryExecCandidates(resolveEffectiveTokens(args.slice(k)), depth + 1));
  } else if (base === "find") {
    for (let k = 0; k < args.length; k += 1) {
      if (!/^-(?:exec|execdir|ok|okdir)$/.test(args[k])) continue;
      let end = k + 1;
      while (end < args.length && !/^(?:\\?;|['"];['"]|\+)$/.test(args[end])) end += 1;
      out.push(...factoryExecCandidates(resolveEffectiveTokens(args.slice(k + 1, end)), depth + 1));
      k = end;
    }
  }
  return out;
}

/** True when `abs` is the live factory's code: RUNNER_DIR or a package dist/. */
function isFactoryCode(abs) {
  if (isInsideRoot(HOOK_RUNNER_DIR, abs)) return true;
  const pkgs = FACTORY_HOME + "/packages/";
  return abs.startsWith(pkgs) && /^[^/]+\/dist(?:\/|$)/.test(abs.slice(pkgs.length));
}

// Builtins that set a shell variable for the rest of the command (`export G=…`).
const VAR_DECLARE_VERBS = new Set(["export", "declare", "typeset", "local", "readonly"]);
// Verbs that run a command the hook cannot read off the segment (`eval "$X"`, a
// command line assembled by xargs from stdin).
const INDIRECT_EXEC_VERBS = new Set(["eval", "xargs"]);
// An operand an interpreter would read its program from without naming the file:
// an fd or stdin path, a find/xargs `{}` placeholder.
const INDIRECT_SCRIPT_OPERAND = /^(?:\/dev\/fd\/|\/dev\/stdin$|\/proc\/|-$|.*\{\})/;

// The live factory's code paths as an agent could spell them: absolute (canonical
// and as installed), and `~/…` / `$HOME/…` when the factory sits under HOME.
const FACTORY_CODE_TEXT = (() => {
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const homes = new Set([FACTORY_HOME, dirname(dirname(fileURLToPath(CORE_URL)))]);
  const forms = [];
  const home = homedir();
  for (const h of homes) {
    forms.push(esc(h));
    if (home && h.startsWith(home + "/")) {
      const rel = esc(h.slice(home.length));
      forms.push(`~${rel}`, `\\$HOME${rel}`, `\\$\\{HOME\\}${rel}`);
    }
  }
  const runner = esc(basename(HOOK_RUNNER_DIR));
  return new RegExp(
    String.raw`(?:${forms.join("|")})\/(?:${runner}|packages\/[^/\s'"]+\/dist)(?![\w.-])`,
  );
})();

/**
 * Refuse a command that RUNS the live factory's code (RUNNER_DIR, or a sibling
 * `packages/*\/dist`): `gaffer approve`, `merge-ticket.mjs`, `tick.sh`, the dispatch
 * CLI. Candidates are judged after the same-command shell variables are filled in
 * (`G=<runner>/gaffer; $G approve 3` runs exactly that path), with `cd` replayed
 * (`cd ~/gaffer/runner && bash tick.sh`). And when the command NAMES factory code
 * at all — literally, via a variable, or by running inside it — any execution the
 * hook cannot resolve (`$X` still unknown, `eval`, `xargs`, an interpreter reading
 * stdin, an fd, `/proc` or `{}`) fails closed: `exec 3<<runner>/gaffer; bash
 * /dev/fd/3 approve 3` and `cat <runner>/gaffer | bash -s approve 3` are the same
 * front door.
 */
function factoryExecutionReason(cmd, roots) {
  // An agent whose write-roots contain the live runner can already rewrite it; this
  // guard adds nothing there (and the hook's own test harness runs from RUNNER_DIR).
  if (isInsideAny(roots.writeRoots, HOOK_RUNNER_DIR)) return null;
  const why =
    "approving, merging, ticking and the control plane are the runner's and the human's job, never the agent's";
  let effectiveCwd = process.cwd();
  const vars = new Map();
  let namesFactory = FACTORY_CODE_TEXT.test(cmd);
  let indirect = null;
  const isFactoryWord = (word) => {
    const p = expandTildeWord(word, effectiveCwd);
    if (p === UNVERIFIABLE_TARGET || !p || /[$`]/.test(p)) return false;
    if (!p.startsWith("/") && effectiveCwd === null) return false;
    return isFactoryCode(canonicalize(resolve(effectiveCwd ?? "/", p.replace(/[)}]+$/, ""))));
  };
  for (const segment of cmd.split(/(?:&&|\|\||;|\n|(?<![>&])&(?!>)|(?<!>)\|)/)) {
    const raw = tokenizeSegment(segment.trim().replace(/^[({]+\s*/, "")).flatMap(
      splitRedirectToken,
    );
    if (raw.length === 0) continue;
    const tokens = raw.map((tk) => substituteVars(tk, vars));
    // Does this segment name factory code (an operand, a redirect target, an
    // assignment's value, or the cwd it runs in)?
    if (effectiveCwd !== null && isFactoryCode(effectiveCwd)) namesFactory = true;
    for (const tk of tokens) {
      const word = ASSIGNMENT_TOKEN.test(tk) ? tk.slice(tk.indexOf("=") + 1) : tk;
      if (/^\d*[<>]/.test(word) || word.startsWith("-")) continue;
      if (isFactoryWord(word)) namesFactory = true;
    }
    const effective = resolveEffectiveTokens(tokens);
    // `G=…` alone, or `export G=…`: a shell variable for the rest of the command.
    const declares = !effective
      ? tokens
      : VAR_DECLARE_VERBS.has(effective.verb)
        ? effective.rest.slice(1)
        : [];
    for (const tk of declares) {
      const m = tk.match(/^([A-Za-z_]\w*)=([\s\S]*)$/);
      if (!m) continue;
      const value = expandTildeWord(m[2], effectiveCwd);
      vars.set(m[1], value === UNVERIFIABLE_TARGET ? "$" : value.replace(/^['"]|['"]$/g, ""));
    }
    if (!effective) continue;
    if (effective.verb === "cd" || effective.verb === "pushd") {
      effectiveCwd = replayCd(effective, effectiveCwd);
      continue;
    }
    if (effective.verb === "popd") {
      effectiveCwd = null;
      continue;
    }
    const candidates = factoryExecCandidates(effective);
    for (const script of candidates) {
      if (isFactoryWord(script)) {
        const p = expandTildeWord(script, effectiveCwd);
        const abs = canonicalize(resolve(effectiveCwd ?? "/", p.replace(/[)}]+$/, "")));
        return `runs the factory's own code (${abs}) — ${why}`;
      }
    }
    // Remember the first execution the hook cannot resolve (judged below).
    const base = basename(effective.verb);
    const runsProgram =
      SCRIPT_INTERPRETERS.has(base) || COMMAND_LAUNCHERS.has(base) || base === "busybox";
    if (indirect) continue;
    if (/[$`]/.test(effective.verb) || INDIRECT_EXEC_VERBS.has(base)) indirect = segment;
    else if (candidates.some((c) => /[$`]/.test(c) || INDIRECT_SCRIPT_OPERAND.test(unquote(c))))
      indirect = segment;
    else if (runsProgram && !candidates.some((c) => !/^\d*[<>]/.test(c))) indirect = segment;
    else if (runsProgram && effective.rest.slice(1).includes("-s")) indirect = segment;
  }
  if (namesFactory && indirect) {
    return `runs code the hook cannot resolve (${indirect.trim().slice(0, 80)}) in a command that names the factory's own code — ${why}`;
  }
  for (const body of extractShellDashCBodies(cmd)) {
    const nested = factoryExecutionReason(body, roots);
    if (nested) return nested;
  }
  return null;
}

export { XARGS_VALUE_FLAGS, factoryExecutionReason };

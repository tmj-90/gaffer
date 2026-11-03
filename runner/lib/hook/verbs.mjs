/**
 * Effective-verb resolution: leading assignments, no-op wrappers and package runners
 * peeled off so the real program is the verb, the privileged CLI names, and the nested
 * programs of `sh -c` / `bash -lc`.
 *
 * Part of the safety hook's decision, split out of runner/safety-hook-core.mjs (the one
 * module the hook and the tests import); see the map in its header.
 */

import { basename } from "node:path";
import { normalizeVerb, unquote } from "./shell.mjs";

// =====================================================================
// EFFECTIVE-VERB RESOLUTION (P0 verb-bypass fix)
// ---------------------------------------------------------------------
// The verb-style extractors below used to take `tokens[0]` as THE verb. Any
// prefix that demotes the real verb (a `VAR=value` assignment, or a no-op
// wrapper like `env`, `command`, `nice`, `nohup`, `timeout 5`, …) made the
// real mutating/read verb sit at tokens[1+], so it was never recognised and the
// write/read-root boundary was skipped entirely. We now resolve the EFFECTIVE
// verb+operands by stripping those leading no-op prefixes before dispatch.
// =====================================================================

// Transparent wrapper commands that exec their argument program unchanged.
// After stripping the wrapper (and its own flags/args), the NEXT token is the
// real verb. `time`, `timeout`, `ionice`, `nice`, `stdbuf` may take their own
// option/argument tokens; we skip leading `-flags` (and the VALUE of the ones
// in WRAPPER_VALUE_FLAGS) and, conservatively, a single numeric/duration
// argument for the ones that take one. A wrapper is matched by its basename, so
// `/usr/bin/env cmd` is the same as `env cmd`.
const WRAPPER_COMMANDS = new Set([
  "env",
  "command",
  "builtin",
  "nice",
  "nohup",
  "stdbuf",
  "setsid",
  "time",
  "timeout",
  "ionice",
  "doas",
]);
// A wrapper's options that take their value as the NEXT token (`timeout -s KILL 5`,
// `env -u VAR`, `nice -n 5`): the value is not the verb.
const WRAPPER_VALUE_FLAGS = {
  env: new Set(["-u", "--unset", "-C", "--chdir"]),
  timeout: new Set(["-s", "--signal", "-k", "--kill-after"]),
  nice: new Set(["-n", "--adjustment"]),
  ionice: new Set(["-c", "--class", "-n", "--classdata", "-p", "--pid"]),
  stdbuf: new Set(["-i", "--input", "-o", "--output", "-e", "--error"]),
  doas: new Set(["-u", "-C"]),
  time: new Set(["-f", "--format", "-o", "--output"]),
};

// Package runners (see resolveEffectiveTokens) and the options of theirs that take
// their value as the NEXT token (`npx -p pkg cmd`, `pnpm exec --filter x cmd`).
const PKG_RUNNER_WORDS = new Set(["npx", "bunx", "pnpx"]);
const PKG_MANAGER_WORDS = new Set(["pnpm", "npm", "yarn"]);
const PKG_RUNNER_VALUE_FLAGS = new Set([
  "-p",
  "--package",
  "--filter",
  "-F",
  "-C",
  "--dir",
  "-w",
  "--workspace",
  "--prefix",
]);

// `VAR=value` leading assignment (one or more, space-separated) — these set
// environment for the command that follows and are NOT the verb.
const ASSIGNMENT_TOKEN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Given the raw tokens of a single command segment, peel off leading
 * `VAR=value` assignments and known no-op wrapper commands (re-resolving the
 * verb after each) and return the EFFECTIVE `{ verb, operands }`. Operands are
 * the remaining tokens with their `-flags` removed (matching how the verb
 * dispatch below consumes them). Returns null when nothing remains.
 *
 * Biased to deny on ambiguity: when an `xargs` is the effective wrapper, the
 * real verb is fed its target from STDIN, so the caller treats it specially
 * (see EFFECTIVE_VERB_UNVERIFIABLE).
 */
function resolveEffectiveTokens(tokens) {
  let i = 0;
  // Loop: strip assignments and wrappers until we hit a real verb.
  for (;;) {
    // (a) Leading `VAR=value` assignments.
    while (i < tokens.length && ASSIGNMENT_TOKEN.test(tokens[i])) i += 1;
    if (i >= tokens.length) return null;
    const word = basename(normalizeVerb(tokens[i]));
    // A PACKAGE RUNNER runs the program it is given: `npx X`, `bunx X`, `pnpx X`,
    // `pnpm exec X` / `pnpm dlx X`, `npm exec X` / `npm x X`, `yarn exec X` / `yarn dlx X`
    // (routing review: `pnpm exec <runner>/gaffer approve 3` and `npx bash <runner>/tick.sh`
    // read as the package manager's own verb and slipped past the front-door rules and
    // the factory-code guard). Peel it with its flags (and the value of the ones that
    // take one) so the real program is the verb. `pnpm test` / `npm run x` stay as they are.
    const skipPkgFlags = (k) => {
      while (k < tokens.length && (tokens[k].startsWith("-") || ASSIGNMENT_TOKEN.test(tokens[k])))
        k += PKG_RUNNER_VALUE_FLAGS.has(normalizeVerb(tokens[k])) ? 2 : 1;
      return k;
    };
    if (PKG_RUNNER_WORDS.has(word)) {
      i = skipPkgFlags(i + 1);
      continue;
    }
    if (PKG_MANAGER_WORDS.has(word)) {
      const k = skipPkgFlags(i + 1);
      const sub = normalizeVerb(tokens[k] ?? "");
      if (/^(?:exec|dlx|x)$/.test(sub)) {
        i = skipPkgFlags(k + 1);
        continue;
      }
      // `pnpm gaffer …` / `yarn wg …` run a binary of that name when it is no script.
      if (sub && PRIV_CLIS.has(basename(sub))) {
        i = k;
        continue;
      }
    }
    if (!WRAPPER_COMMANDS.has(word)) break;
    // (b) Skip the wrapper word itself…
    i += 1;
    // …then its own leading `-flags` (with the value of a value-taking one) and any
    // further `VAR=` (env supports both: `env -i`, `env -u X`, `env VAR=1 cmd`).
    const valueFlags = WRAPPER_VALUE_FLAGS[word];
    while (i < tokens.length && (tokens[i].startsWith("-") || ASSIGNMENT_TOKEN.test(tokens[i]))) {
      i += valueFlags?.has(tokens[i]) ? 2 : 1;
    }
    // For wrappers that take a single leading numeric/duration argument
    // (`timeout 5 cmd`, `nice 10 cmd`, `ionice 3 cmd`), skip one such token.
    if (
      (word === "timeout" || word === "nice" || word === "ionice") &&
      i < tokens.length &&
      /^[0-9]/.test(tokens[i])
    ) {
      i += 1;
    }
    // Continue the loop to re-resolve (handles `env VAR=1 command nice cmd`).
  }
  const verb = normalizeVerb(tokens[i]);
  const operands = tokens.slice(i + 1).filter((t) => !t.startsWith("-"));
  return { verb, operands, rest: tokens.slice(i) };
}

/**
 * Resolve the effective verb of a token list that may begin with leading
 * `-flags` (e.g. the tokens after `xargs`). Skips `-flags`, then strips
 * assignments/wrappers via resolveEffectiveTokens. Returns the verb string, or
 * "" when none resolves. Biased to deny: an empty/ambiguous result lets the
 * caller treat it as unverifiable.
 */
function effectiveVerbAfter(tokens) {
  let i = 0;
  while (i < tokens.length && tokens[i].startsWith("-")) i += 1;
  const eff = resolveEffectiveTokens(tokens.slice(i));
  return eff ? eff.verb : "";
}

// Inline-shell wrappers (`sh -c '<prog>'`, `bash -lc "<prog>"`, …): the quoted
// body is a NESTED program that must be re-scanned by the same extractor.
const SHELL_DASH_C =
  /\b(?:sh|bash|zsh|dash)\b\s+(?:-[A-Za-z]*c[A-Za-z]*|--command)\s+("[^"]*"|'[^']*')/g;

/** Pull every `sh -c '<body>'` / `bash -lc "<body>"` nested program body. */
function extractShellDashCBodies(cmd) {
  const bodies = [];
  for (const m of cmd.matchAll(SHELL_DASH_C)) {
    const body = unquote(m[1]);
    if (body) bodies.push(body);
  }
  return bodies;
}

// The privileged CLIs by name, and the dist/bin paths that are the same programs.
const PRIV_CLIS = new Set(["wg", "dispatch", "fg", "crew", "gaffer", "memory"]);
const PRIV_CLI_PATHS = [
  [/(?:^|\/)dispatch\/dist\/cli\/index\.js$/, "dispatch"],
  [/(?:^|\/)crew\/dist\/cli\/index\.js$/, "crew"],
  [/(?:^|\/)memory\/dist\/bin\/memory\.js$|(?:^|\/)memory\.js$/, "memory"],
  [/(?:^|\/)gaffer$/, "gaffer"],
  [/(?:^|\/)wg$/, "wg"],
];

export {
  ASSIGNMENT_TOKEN,
  PRIV_CLIS,
  PRIV_CLI_PATHS,
  effectiveVerbAfter,
  extractShellDashCBodies,
  resolveEffectiveTokens,
};

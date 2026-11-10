/**
 * Control-plane CLIs: the verbs and CP_PAIRS the privileged CLIs take, their verb slots
 * (runtime-built or xargs-fed verbs are refused), and the normalised views of a command
 * the deny list is run over (spellings, variables, wrappers, eval / sh -c / inline
 * interpreter bodies).
 *
 * Part of the safety hook's decision, split out of runner/safety-hook-core.mjs (the one
 * module the hook and the tests import); see the map in its header.
 */

import { basename } from "node:path";
import { XARGS_VALUE_FLAGS } from "./factory.mjs";
import {
  normalizeWord,
  shellWord,
  splitSegmentsQuoteAware,
  stripRedirects,
  substituteVars,
  tokenizeSegment,
  unquote,
} from "./shell.mjs";
import { ASSIGNMENT_TOKEN, PRIV_CLIS, PRIV_CLI_PATHS, resolveEffectiveTokens } from "./verbs.mjs";

// =====================================================================
// SPELLING NORMALISATION FOR THE DENY LIST
// ---------------------------------------------------------------------
// The deny-list regexes in lib/dangerous-commands.mjs match command NAMES. A shell
// runs the same program for `wg`, `w\g`, `'wg'`, `w''g`, `$X` after `X=wg`, and for
// `xargs wg` or `env A=1 wg`; three reviews found those spellings slipping past rules
// that matched the raw text only. checkCommand now also runs every deny rule over
// NORMALISED VIEWS of the command: each segment re-tokenised, quotes and backslashes
// stripped from every word (a program or verb name never legitimately contains them),
// same-command `NAME=value` assignments substituted into later `$NAME` uses, no-op
// wrappers and `xargs` peeled off so the real program sits in command position, the
// bodies of `eval`, `sh -c` and friends re-scanned as commands of their own, the
// bodies of inline interpreters (`node -e`, `python3 -c`, `perl -e`, `ruby -e`)
// flattened so a program name inside them is seen, and the privileged CLIs reached
// by file path mapped to their names. A view never INVENTS a command boundary: a
// separator that came from inside a quoted word is replaced, so `echo "x; wg …"`
// stays one word and is judged exactly as the raw text was.
//
// Fail closed where the name is still unknowable: a program name built at runtime
// (`$(…)`, a variable the command never assigns, an array expansion) in command
// position, followed by a control-plane verb, is refused outright; so is a
// privileged CLI whose verb would arrive on stdin through `xargs`, and one whose verb
// slot holds a word the shell builds at run time (see cpVerbSlotReason).
// =====================================================================

// A control-plane verb close to the program word, as the privileged CLIs take it:
// `wg ticket approve 3`, `gaffer merge 3`, `gaffer plan --yes`, `wg principal create`.
// Only these shapes count, so `$GIT merge origin/main`, `$TF plan`, `$EDITOR plan` and
// `pytest -k approve` keep working when the program name is unknown to the hook.
const CP_SINGLE_VERBS = new Set([
  "approve",
  "approve-ready",
  "mark-merged",
  "record-landing",
  "landing-begin",
  "record-tester-replay",
  "ci-result",
  "eval-score",
  "lane-verdict",
  "scout-record",
  "tester-route",
  "attach-evidence",
  "acceptance-profile",
  "acceptance-evidence",
  "wont-do",
  "set-testable",
  "allow-test-changes",
  "set-commands",
  "test-contract",
  "tester-pass",
  "tester-fail",
  "repo-delivery",
  "require-cap",
  "set-reviewer",
  "reject",
  // Package H1: the other hand routes around the tester's verdict.
  "reopen-for-review",
  "unblock",
  "human-claim",
  "human-release",
]);
const CP_PAIRS = [
  ["principal", /^(?:create|revoke)$/],
  ["decisions", /^resolve$/],
  ["agent", /^rename$/],
  ["club", /^set$/],
  ["lore", /^(?:approve|reject)$/],
  ["plan", /^--yes$/],
  ["merge", /^(?:T-)?[0-9]+$/],
  // Review comments (A1/A2): writing, listing, resolving, reopening or withdrawing a
  // reviewer's comment, and Fix these, are the reviewer's acts, never a delivery agent's;
  // so is opening the eval judge's view (judge-view), which marks the person's decision
  // as revealed in judge agreement.
  ["review", /^(?:comment|comments|resolve|reopen-comment|withdraw-comment|fix|judge-view)$/],
  // Escaped defects (MF5): linking a ticket to the accepted change it regresses, or taking
  // the link back, is a person's judgement; an agent would blame another change or hide
  // its own. Review-rule drafts (D6) are proposed from a person's feedback by the server
  // or a person, never by an agent shell.
  ["ticket", /^regression-of$/],
  // Package H1: a board move, ready and a hold change where a ticket stands around the
  // tester's verdict; `block` only as the ticket verb (a word too common to stand alone).
  ["ticket", /^(?:move|ready|hold)$/],
  ["review-rules", /^propose$/],
  // The code index the Review's callers row is read from (memory `index build`): only the
  // runner rebuilds it; `index neighbours` / `index stats` stay open.
  ["index", /^build$/],
  // A matched experiment (`gaffer eval experiment`, routing gap 4): a person starts one;
  // its live mode spends the factory's budget. `eval replay` and `eval agreement` are reads.
  ["eval", /^experiment$/],
];
function cpVerbNear(words) {
  // words: everything after the program word; the verb sits within the first three.
  const head = words.slice(0, 3);
  if (head.some((w) => CP_SINGLE_VERBS.has(w))) return true;
  if (words.some((w) => w === "--as-principal" || w.startsWith("--as-principal="))) return true;
  // A person's credential handed to a program the hook cannot name (package H1).
  if (words.some((w) => /^GAFFER_PRINCIPAL_TOKEN=/.test(w))) return true;
  for (let i = 0; i < Math.min(words.length, 4); i += 1) {
    for (const [first, second] of CP_PAIRS) {
      if (words[i] === first && words.slice(i + 1).some((w) => second.test(w))) return true;
    }
  }
  return false;
}

const INLINE_INTERPRETERS = new Set([
  "node",
  "nodejs",
  "python",
  "python3",
  "perl",
  "ruby",
  "deno",
  "bun",
]);
const SHELL_NAMES = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const MAX_VIEW_DEPTH = 3;

// A privileged CLI reached by path: `node …/dispatch/dist/cli/index.js`, `…/gaffer`.
function privCliByPath(word) {
  for (const [re, name] of PRIV_CLI_PATHS) if (re.test(word)) return name;
  return null;
}

// A name the hook cannot resolve from the command text alone.
function unresolvedName(word) {
  return /[$`]/.test(word);
}

// ---------------------------------------------------------------------
// THE VERB SLOTS OF A PRIVILEGED CLI (lane-hook R2)
// The deny rules read a control-plane verb off the command text. Two shapes put the
// verb somewhere the text does not show it: a verb word the shell builds at run time
// (`wg ticket tester-r$(printf o)ute 5`, `wg ticket $V 5` with V set by `read`, a glob
// or a brace expansion), and a verb the CLI only receives from xargs or parallel
// (`echo approve | xargs wg ticket`, `xargs -I{} wg ticket {} 5`, the same through
// `sh -c` or `find -exec … {}`). Both are refused: in the words that name what the CLI
// does (the noun and verb for wg / dispatch / fg / crew, the verb for gaffer / memory)
// every word must be a plain literal, and when xargs or parallel feeds the CLI those
// words must all be on the command line already. Words after them (a ticket id, a
// file, `$T`) are not looked at, so `wg ticket show $T` and
// `cat ids | xargs -n1 wg ticket show` keep working.
// ---------------------------------------------------------------------
// How deep feeders, wrappers and shell bodies are followed before failing closed.
const CP_SLOT_MAX_DEPTH = 8;
const CP_VERB_SLOTS = { wg: 2, dispatch: 2, fg: 2, crew: 2, gaffer: 1, memory: 1 };
// Root options that take their value as the next word (`wg --db x.sqlite ticket show 3`,
// `crew -c crew.yaml scan`).
const CP_CLI_VALUE_FLAGS = new Set(["--db", "--as-principal"]);
const CP_CLI_EXTRA_VALUE_FLAGS = { crew: new Set(["-c", "--config"]) };
// A verb-slot word the shell passes through unchanged: no expansion, glob or brace.
const PLAIN_VERB_WORD = /^[A-Za-z0-9_.:@%+,=/~-]*$/;
// Shell keywords and builtins that put the next word in command position.
const SHELL_LEADS = new Set([
  "do",
  "then",
  "else",
  "elif",
  "if",
  "while",
  "until",
  "!",
  "{",
  "exec",
  "coproc",
]);
// Programs that run the rest of their arguments as a command (`watch wg …`,
// `strace -f wg …`, `taskset 1 wg …`), or a shell string they are given
// (`script -c "wg …"`, `su -c "…"`, `ssh host wg …`, `watchexec -- wg …`). Their own
// options vary, so the privileged CLI is looked for among their words (lane-hook review).
const CP_CMD_RUNNERS = new Set([
  "watch",
  "strace",
  "ltrace",
  "taskset",
  "chrt",
  "flock",
  "unbuffer",
  "catchsegv",
  "script",
  "su",
  "sudo",
  "runuser",
  "ssh",
  "watchexec",
  "chronic",
  "ts",
]);
const PKG_RUNNERS = new Set(["npx", "bunx", "pnpx"]);
const PKG_MANAGERS = new Set(["pnpm", "npm", "yarn"]);
const PARALLEL_VALUE_FLAGS = new Set([
  "-j",
  "--jobs",
  "-N",
  "-n",
  "--max-args",
  "-S",
  "--sshlogin",
  "-I",
  "--colsep",
  "-C",
  "-d",
  "--delimiter",
  "-a",
  "--arg-file",
  "--delay",
  "--timeout",
  "--joblog",
  "--results",
  "--tmpdir",
  "-E",
  "--env",
  "--tag-string",
  "--rpl",
  "--sshloginfile",
  "--workdir",
  "--wd",
]);

// `xargs [flags] …`: the index of the program word and the replace string, if any
// (`-I R`, `-IR`, `-i`, `-iR`, `--replace[=R]`, BSD `-J R`).
function xargsSplit(words) {
  let k = 1;
  let replace = null;
  while (k < words.length && words[k].startsWith("-") && words[k] !== "--") {
    const w = words[k];
    let m;
    if ((m = /^-[0prtx]*[IJ](.*)$/.exec(w))) {
      if (m[1]) {
        replace = m[1];
        k += 1;
      } else {
        replace = words[k + 1] ?? "";
        k += 2;
      }
      continue;
    }
    if ((m = /^-[0prtx]*i(.*)$/.exec(w))) {
      replace = m[1] || "{}";
      k += 1;
      continue;
    }
    if ((m = /^--replace(?:=(.*))?$/.exec(w))) {
      replace = m[1] || "{}";
      k += 1;
      continue;
    }
    k += XARGS_VALUE_FLAGS.has(w) || /^-[RS]$/.test(w) ? 2 : 1;
  }
  if (words[k] === "--") k += 1;
  return { at: k, replace };
}

/**
 * Why the command `words` (one segment: raw tokens, same-command variables filled in) runs a privileged CLI whose verb
 * slots the hook cannot read, or null. `feed` is set when xargs, parallel or find -exec
 * builds the command line: { placeholder } (a string the feeder replaces) and
 * { appends } (the feeder adds words of its own at the end).
 */
function cpVerbSlotReason(words, feed = null, depth = 0) {
  // Nesting past what is read (`xargs xargs … wg`, `{ { … wg`): fail closed when a
  // privileged CLI is still in the words.
  const tooDeep = (rest) =>
    rest.some((x) => PRIV_CLIS.has(basename(shellWord(x))) || privCliByPath(shellWord(x)))
      ? "a privileged CLI nested deeper than the hook reads (wrappers, xargs, shells, groups): the verb cannot be seen, so it is refused"
      : null;
  if (depth > CP_SLOT_MAX_DEPTH) return tooDeep(words);
  let w = words.slice();
  // Keywords, assignments, no-op wrappers and package runners in front of the program.
  for (let guard = 0; w.length; guard += 1) {
    if (guard >= 64) return tooDeep(w);
    if (/^\(/.test(w[0])) {
      // A subshell or group: `( prog …`, `((prog …`.
      const stripped = w[0].replace(/^\(+/, "");
      w = stripped ? [stripped, ...w.slice(1)] : w.slice(1);
      continue;
    }
    const first = shellWord(w[0]);
    if (first === "exec") {
      // `exec -a NAME prog …`, `exec -cl prog …`: the flags are exec's own.
      let k = 1;
      while (k < w.length && /^-[acl]+$/.test(shellWord(w[k]))) {
        k += /a/.test(w[k]) ? 2 : 1;
      }
      w = w.slice(k);
    } else if (first === "" || SHELL_LEADS.has(first)) w = w.slice(1);
    else if (first === "case" && w.length > 2 && shellWord(w[2]) === "in") {
      // `case WORD in PATTERN) prog …`: the command after the pattern runs.
      w = w.slice(3);
    } else if (/^\(?[^()]*\)$/.test(first)) {
      // A case pattern in front of its command: `x) prog …`, `*) prog …`.
      w = w.slice(1);
    } else if (first === "function" && w.length > 1) {
      // `function NAME { body`: the body runs when the function is called.
      w = w.slice(/^[^(){}]+$/.test(shellWord(w[1])) ? 2 : 1);
    } else if (/^[A-Za-z_][\w.:-]*\(\)\{?$/.test(first)) {
      // `NAME() { body` / `NAME(){ body`: likewise.
      w = w.slice(1);
    } else if (first.startsWith("{") && first.length > 1) {
      w = [first.slice(1), ...w.slice(1)];
    } else if (PKG_RUNNERS.has(basename(first))) {
      let k = 1;
      while (k < w.length && w[k].startsWith("-")) k += 1;
      w = w.slice(k);
    } else if (PKG_MANAGERS.has(basename(first))) {
      let k = 1;
      while (k < w.length && w[k].startsWith("-")) k += 1;
      const sub = shellWord(w[k] || "");
      // `pnpm wg …` / `yarn wg …` run a binary of that name when it is no script.
      if (PRIV_CLIS.has(basename(sub)) || privCliByPath(sub)) {
        w = w.slice(k);
        continue;
      }
      if (!/^(?:exec|dlx|x)$/.test(sub)) break;
      k += 1;
      while (k < w.length && w[k].startsWith("-")) k += 1;
      w = w.slice(k);
    } else {
      const eff = resolveEffectiveTokens(w);
      if (!eff || eff.rest.length === w.length) break;
      w = eff.rest;
    }
  }
  w = stripRedirects(w);
  if (w.length === 0) return null;
  const n = w.map(shellWord);
  const head = basename(n[0]);
  if (head === "xargs") {
    const { at, replace } = xargsSplit(n);
    return cpVerbSlotReason(w.slice(at), { placeholder: replace, appends: true }, depth + 1);
  }
  if (CP_CMD_RUNNERS.has(head)) {
    // The command among its words: a word that is itself a shell string, or the first
    // privileged CLI / feeder / shell / interpreter word from which the rest runs.
    for (let k = 1; k < w.length; k += 1) {
      const word = unquote(w[k]);
      if (/\s/.test(word)) {
        for (const segment of splitSegmentsQuoteAware(word)) {
          const why = cpVerbSlotReason(tokenizeSegment(segment.trim()), feed, depth + 1);
          if (why) return why;
        }
        continue;
      }
      const b = basename(n[k]);
      if (
        PRIV_CLIS.has(b) ||
        privCliByPath(n[k]) ||
        SHELL_NAMES.has(b) ||
        INLINE_INTERPRETERS.has(b) ||
        /^(?:xargs|parallel|find|fd|fdfind|env|nice|nohup|timeout|time|command)$/.test(b)
      ) {
        return cpVerbSlotReason(w.slice(k), feed, depth + 1);
      }
    }
    return null;
  }
  if (head === "fd" || head === "fdfind") {
    // `fd PATTERN -x CMD …` / `--exec`, `-X` / `--exec-batch`: CMD gets `{}`-style
    // placeholders, or the found path appended when it has none.
    const k = n.findIndex((x, idx) => idx > 0 && /^(?:-x|--exec|-X|--exec-batch)$/.test(x));
    if (k === -1) return null;
    let end = k + 1;
    while (end < n.length && n[end] !== ";") end += 1;
    return cpVerbSlotReason(w.slice(k + 1, end), { placeholder: "{", appends: true }, depth + 1);
  }
  if (head === "parallel") {
    let k = 1;
    let placeholder = "{";
    while (k < n.length && n[k].startsWith("-")) {
      // `-I R` / `-IR` / `--replace=R`: the replace string parallel fills in.
      const m = /^(?:-I(.+)|--replace=(.+))$/.exec(n[k]);
      if (m) placeholder = m[1] || m[2];
      else if (n[k] === "-I" && n[k + 1]) placeholder = n[k + 1];
      k += PARALLEL_VALUE_FLAGS.has(n[k]) ? 2 : 1;
    }
    let end = n.findIndex((x, idx) => idx >= k && /^:{3,4}\+?$/.test(x));
    if (end === -1) end = n.length;
    // A single quoted command string is split by the shell parallel runs it in.
    const inner = n.slice(k, end).join(" ").split(/\s+/).filter(Boolean);
    const why = cpVerbSlotReason(inner, { placeholder, appends: true }, depth + 1);
    if (why || placeholder === "{") return why;
    return cpVerbSlotReason(inner, { placeholder: "{", appends: true }, depth + 1);
  }
  if (head === "find") {
    for (let k = 1; k < n.length; k += 1) {
      if (!/^-(?:exec|execdir|ok|okdir)$/.test(n[k])) continue;
      let end = k + 1;
      while (end < n.length && !/^(?:;|\+)$/.test(n[end])) end += 1;
      const why = cpVerbSlotReason(
        w.slice(k + 1, end),
        { placeholder: "{}", appends: false },
        depth + 1,
      );
      if (why) return why;
      k = end;
    }
    return null;
  }
  const c = SHELL_NAMES.has(head)
    ? n.findIndex((x, idx) => idx > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(x))
    : -1;
  if (c !== -1) {
    // `sh -c BODY`: the body's commands, with the same feeder (its placeholder).
    if (!w[c + 1]) return null;
    for (const segment of splitSegmentsQuoteAware(unquote(w[c + 1]))) {
      const inner = tokenizeSegment(segment.trim());
      const why = cpVerbSlotReason(inner, feed && { placeholder: feed.placeholder }, depth + 1);
      if (why) return why;
    }
    return null;
  }
  let cli = PRIV_CLIS.has(head) ? head : privCliByPath(n[0]);
  let args = n.slice(1);
  if (!cli && (INLINE_INTERPRETERS.has(head) || SHELL_NAMES.has(head))) {
    let k = 1;
    while (k < n.length && n[k].startsWith("-")) k += 1;
    cli = privCliByPath(n[k] || "");
    args = n.slice(k + 1);
  }
  if (!cli || !CP_VERB_SLOTS[cli]) return null;
  const slots = [];
  for (let i = 0; i < args.length && slots.length < CP_VERB_SLOTS[cli]; i += 1) {
    if (args[i].startsWith("-")) {
      if (CP_CLI_VALUE_FLAGS.has(args[i]) || CP_CLI_EXTRA_VALUE_FLAGS[cli]?.has(args[i])) i += 1;
      continue;
    }
    slots.push(args[i]);
    // `wg help <command>` only prints help: what follows it is not a verb.
    if (slots.length === 1 && args[i] === "help") break;
  }
  for (const s of slots) {
    if (feed?.placeholder && s.includes(feed.placeholder)) {
      return `a privileged CLI (${cli}) whose verb is filled in by xargs, parallel or find from their input ("${s.slice(0, 40)}"): the verb cannot be seen, so it is refused`;
    }
    if (!PLAIN_VERB_WORD.test(s)) {
      return `a privileged CLI (${cli}) whose verb is built at run time ("${s.slice(0, 40)}"): the verb cannot be seen, so it is refused`;
    }
  }
  if (feed?.appends && slots.length < CP_VERB_SLOTS[cli]) {
    return `a privileged CLI (${cli}) fed its verb by xargs or parallel from their input: the verb cannot be seen, so it is refused`;
  }
  return null;
}

/**
 * Normalised views of `cmd`: strings the deny-list regexes are run over in addition
 * to the raw text. Returns { views, reasons }: `reasons` are fail-closed refusals
 * found on the way (a runtime-built program name before a control-plane verb, a
 * privileged CLI fed by xargs).
 */
function normalizedCommandViews(cmd, depth = 0) {
  const views = [];
  const reasons = [];
  if (depth > MAX_VIEW_DEPTH || typeof cmd !== "string" || cmd.length === 0) {
    return { views, reasons };
  }
  const vars = new Map();
  const outSegments = [];
  for (const segment of splitSegmentsQuoteAware(cmd)) {
    const raw = tokenizeSegment(segment.trim());
    if (raw.length === 0) continue;
    // Substitute the variables the command itself set, then normalise every word.
    const filled = raw.map((t) => substituteVars(t, vars));
    let words = filled.map(normalizeWord);
    // Record assignments for later segments/words: `X=wg`, `export X=wg`.
    let j = 0;
    if (["export", "declare", "local", "readonly", "typeset"].includes(words[0])) {
      j = 1;
      while (j < words.length && words[j].startsWith("-")) j += 1; // `declare -x`, `export -n`
    }
    while (j < words.length && ASSIGNMENT_TOKEN.test(words[j])) {
      const eq = words[j].indexOf("=");
      vars.set(words[j].slice(0, eq), words[j].slice(eq + 1));
      j += 1;
    }
    // A privileged CLI whose verb slots are built at run time or fed by xargs: refuse.
    const slotWhy = cpVerbSlotReason(filled.slice(j));
    if (slotWhy) reasons.push(slotWhy);
    // Peel assignments and wrappers so the program is in command position.
    const eff = resolveEffectiveTokens(words);
    if (!eff) {
      outSegments.push(words.join(" "));
      continue;
    }
    let rest = stripRedirects(eff.rest);
    // A package runner or wrapper with nothing runnable after it (`npx <tool>` reads as
    // `npx` plus a redirect): there is no program to judge, so the segment stands as is.
    if (rest.length === 0) {
      outSegments.push(words.join(" "));
      continue;
    }
    // `xargs [flags] prog …`: the program after xargs is what runs; its verb may come
    // from stdin. A privileged CLI with nothing after it is fail-closed.
    if (rest[0] === "xargs") {
      let k = 1;
      while (k < rest.length && rest[k].startsWith("-")) {
        k +=
          /^(?:-(?:n|L|P|s|I|d|E|a)|--(?:max-args|max-lines|max-procs|max-chars|replace|delimiter|eof|arg-file))$/.test(
            rest[k],
          )
            ? 2
            : 1;
      }
      rest = rest.slice(k);
      // `xargs node …/memory.js …` runs the same CLI as `xargs memory …`.
      const viaInterp =
        rest.length > 1 && INLINE_INTERPRETERS.has(basename(rest[0])) && privCliByPath(rest[1]);
      const xr = viaInterp ? [viaInterp, ...rest.slice(2)] : rest;
      const prog = xr[0] ? basename(xr[0]) : "";
      const priv = PRIV_CLIS.has(prog) || Boolean(privCliByPath(xr[0] || ""));
      if (priv && xr.length <= 1) {
        reasons.push(
          `a privileged CLI (${prog}) fed its arguments by xargs from stdin: the verb cannot be seen, so it is refused`,
        );
      } else if (priv && CP_PAIRS.some(([first]) => xr[xr.length - 1] === first)) {
        // `echo build | xargs memory index`: the pair's second word arrives on stdin.
        reasons.push(
          `a privileged CLI (${prog} ${xr[xr.length - 1]}) whose control-plane verb would arrive from stdin through xargs, so it is refused`,
        );
      }
      if (rest.length === 0) {
        outSegments.push(words.join(" "));
        continue;
      }
    }
    // Interpreters running a file that IS a privileged CLI: `node …/dist/cli/index.js`.
    if (
      (INLINE_INTERPRETERS.has(basename(rest[0])) || SHELL_NAMES.has(basename(rest[0]))) &&
      rest.length > 1
    ) {
      let k = 1;
      while (k < rest.length && rest[k].startsWith("-") && !/^-[ec]$/.test(rest[k])) k += 1;
      const mapped = privCliByPath(rest[k] || "");
      if (mapped) rest = [mapped, ...rest.slice(k + 1)];
    }
    // A privileged CLI by path in command position: `…/gaffer approve 3`.
    const direct = privCliByPath(rest[0] || "");
    if (direct) rest[0] = direct;
    // A program name built at runtime before a control-plane verb: refuse.
    if (unresolvedName(rest[0] || "") && cpVerbNear(rest.slice(1))) {
      reasons.push(
        `a program name built at runtime (${rest[0].slice(0, 40)}) in front of a control-plane verb: the hook cannot see which program runs, so it is refused`,
      );
    }
    // eval / sh -c bodies are commands of their own: scan them recursively.
    const prog = basename(rest[0] || "");
    if (prog === "eval" && rest.length > 1) {
      const nested = normalizedCommandViews(rest.slice(1).join(" "), depth + 1);
      views.push(...nested.views);
      reasons.push(...nested.reasons);
    } else if (SHELL_NAMES.has(prog)) {
      const c = rest.findIndex((w, idx) => idx > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(w));
      if (c !== -1 && rest[c + 1]) {
        const nested = normalizedCommandViews(rest[c + 1], depth + 1);
        views.push(...nested.views);
        reasons.push(...nested.reasons);
      }
    } else if (INLINE_INTERPRETERS.has(prog)) {
      // `node -e BODY`, `python3 -c BODY`, `perl -e`, `ruby -e`: flatten the body so a
      // program name called from inside it reads as a command of its own. Brackets
      // become separators and commas spaces (`run(["wg","ticket","approve"])`).
      const f = rest.findIndex(
        (w, idx) =>
          idx > 0 &&
          (/^-(?:e|c|p|r)$/.test(w) ||
            /^--(?:eval|print)$/.test(w) ||
            ((prog === "perl" || prog === "ruby") && /^-[a-zA-Z]*[eE][a-zA-Z]*$/.test(w))),
      );
      if (f !== -1 && rest[f + 1]) {
        const body = rest
          .slice(f + 1)
          .join(" ")
          .replace(/[()[\]{}]/g, " ; ")
          .replace(/,/g, " ");
        views.push(body);
      }
    }
    outSegments.push(rest.join(" "));
  }
  views.push(outSegments.join(" ; "));
  // Command substitutions and backticks are commands of their own too.
  for (const m of cmd.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) {
    const body = (m[1] ?? m[2] ?? "").trim();
    if (body) {
      const nested = normalizedCommandViews(body, depth + 1);
      views.push(...nested.views);
      reasons.push(...nested.reasons);
    }
  }
  return { views, reasons };
}

export { normalizedCommandViews };

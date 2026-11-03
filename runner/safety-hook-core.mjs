/**
 * Gaffer factory — the DECISION of the Claude Code PreToolUse safety hook (the
 * deterministic bouncer).
 *
 * runner/safety-hook.mjs is the hook Claude Code runs. It is a thin wrapper: it
 * reads the tool call JSON on stdin, hands it to decideRaw() below and exits 0
 * (allow) or 2 (BLOCK, the reason on stderr). Every rule lives here, so the tests
 * can run them in-process instead of paying a node start-up per check; the wrapper
 * adds no rule of its own and keeps the process contract (exit codes, stderr,
 * stdout flush, the fail-closed guards).
 *
 * Deny-by-default for the dangerous classes; everything else is allowed. The only
 * external dependency is the dangerous-command deny-list, loaded via a guarded
 * dynamic import that FAILS CLOSED (blocks) if the sibling is missing/broken — see
 * below. Everything else is self-contained so a change elsewhere can't weaken it.
 *
 * Mirrors Crew's safety classifiers (git/fs/command) but is intentionally
 * duplicated here: a security control should not depend on another build.
 *
 * SECRET BOUNDARY MODEL (see the block below checkWrite): the secret-read guard
 * is NOT a denylist of reader binaries. It treats the *secret path* as the
 * protected thing and over-blocks whenever a shell construct hides the data
 * flow. HONEST RESIDUAL LIMITATION: a fully-dynamic path (assembled at runtime,
 * never appearing literally and not routed through a read-ish tool or `$(...)`)
 * can still slip past a regex. This hook is defence-in-depth, not a jail — real
 * containment of a determined exfil needs an OS sandbox / permission boundary.
 *
 * INPUT-SIZE CAP (see MAX_INSPECTED_FIELD_BYTES below): before JSON.parse, and
 * again before any rule or regex reads a field, an oversized input BLOCKS with
 * "unverifiable: tool input too large (…)" (ledger category `oversized-input`).
 * Several rules are super-linear in the input length (a 100 KB deep path took
 * 60-70s), so the cap bounds the input every rule sees; it sits well above any
 * legitimate tool call seen. The caps are constants, never env-configurable: a
 * knob would only ever be a way to loosen the boundary.
 */
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { appendFileSync, lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DENY_COMMANDS } from "./lib/hook/deny-list.mjs";
import { bootstrapInstallDir, bootstrapInstallReason } from "./lib/hook/installs.mjs";
import { inlineReadBoundaryReason, inlineWriteBoundaryReason } from "./lib/hook/interpreters.mjs";
import {
  AGENT_SETTINGS,
  ENV_TEMPLATE,
  GIT_INTERNAL,
  SECRET_PATH,
  canonicalize,
  classifyRootAccess,
  expandTildePath,
  expandTildeWord,
  isInsideAny,
  isInsideRoot,
  replayCd,
  resolveRoots,
} from "./lib/hook/paths.mjs";
import {
  SECRET_GLOB,
  extractBashReadTargets,
  isTrackedEnvTemplate,
  maskTrackedEnvTemplates,
  secretBoundaryReason,
  stripSearchPatterns,
} from "./lib/hook/reads.mjs";
import {
  UNVERIFIABLE_TARGET,
  normalizeVerb,
  normalizeWord,
  shellWord,
  splitRedirectToken,
  splitSegmentsQuoteAware,
  stripRedirects,
  substituteVars,
  tokenizeSegment,
  unquote,
} from "./lib/hook/shell.mjs";
import {
  ASSIGNMENT_TOKEN,
  PRIV_CLIS,
  PRIV_CLI_PATHS,
  extractShellDashCBodies,
  resolveEffectiveTokens,
} from "./lib/hook/verbs.mjs";
import { extractBashWriteTargets } from "./lib/hook/writes.mjs";

// =====================================================================
// INPUT-SIZE CAP — an oversized tool input fails CLOSED before any rule runs
// ---------------------------------------------------------------------
// Several rules are polynomial in the input length (SECRET_PATH_FRAGMENT's
// `[\w./-]*\.pem\b`-style alternatives rescan to the end of the string from every
// position): `echo x > /` + "a/" x 50,000 (~100 KB) took 60-70s to decide (to a BLOCK)
// and a 41 KB `find` ~19s. Claude Code's 60s timeout with `onFailure: block` stops
// such a call anyway, but a slow path in a security boundary is a liability. So every field a rule reads is size-checked first, and anything
// over the cap is BLOCKED as unverifiable — the hook never ALLOWS what it did not
// fully analyse. These are deliberately constants and NOT env-configurable.
//
// MAX_INSPECTED_FIELD_BYTES = 64 KiB, per inspected field AND for all of them
// together (UTF-8 bytes). The inspected fields are exactly what runDecision reads:
// the tool name (tool_name / toolName) and tool_input's (or toolInput's) command,
// file_path, filePath, notebook_path, path, pattern and glob. Nothing else in the
// input reaches a rule: Write/Edit `content` / `new_string`, MCP arguments and
// WebFetch's `url` are never read (an MCP or non-file tool is decided by its NAME).
// Evidence for the number:
//   • the largest input any ALLOW case in the hook suites uses is a 1,407-byte Bash
//     command (safety-hook*.test.mjs, boundary-integration, the claude-settings /
//     agent-home / spawner / bootstrap tests, crew's safety-hook-parity,
//     safety-live-hook and root-access-parity); the only inputs over 6 KB in any
//     suite are the two ~100 KB deep-path BLOCK cases;
//   • real Claude Code agents write files through Bash heredocs (`cat > f <<'EOF'`,
//     `python3 - <<'EOF'` edit scripts): over 14,578 recorded Bash calls the largest
//     command was 29,795 bytes (p99 ≈ 6.6 KB, p99.9 ≈ 12.9 KB); the largest
//     file_path was 154 bytes and the largest Grep/Glob pattern 87;
//   • the runner itself writes no tool input; its own heredocs (tick.sh, lib/*)
//     are shell it runs, not tool calls the hook sees.
// 64 KiB is over twice the largest real heredoc and ~45x the largest test allow.
// HONEST RESIDUAL: the cap bounds the input, not every rule's cost. Under it the
// rules stay super-linear on adversarial shapes: at 64 KiB, `echo {a,{a,…` takes
// ~117s (the deny-list's command-position prefix restarts at every `{`) and the
// other pathological shapes measured 24–46s. The 60s hook timeout with
// `onFailure: block` still turns those into a BLOCK; a lower cap would instead
// refuse real heredocs (~30 KB seen).
export const MAX_INSPECTED_FIELD_BYTES = 64 * 1024;
// MAX_PAYLOAD_BYTES = 2 MiB, for the raw stdin JSON as a whole, checked before
// JSON.parse. It bounds what is parsed and copied (an allowed Grep echoes its whole
// input back) but must clear the fields no rule reads, chiefly a Write's `content`:
// the largest real Write payload seen was 86,694 bytes, and one tool call cannot
// exceed the model's output budget (~128K tokens ≈ 0.5 MB, plus JSON escaping), so
// 2 MiB never refuses a call a model can actually emit.
export const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const OVERSIZED_PREFIX = "unverifiable: tool input too large";
// The tool_input keys a rule reads (keep in step with runDecision and checkSearch).
const INSPECTED_INPUT_FIELDS = [
  "command",
  "file_path",
  "filePath",
  "notebook_path",
  "path",
  "pattern",
  "glob",
];

/** UTF-8 size of one field as a rule would see it (a non-string is measured as JSON). */
function fieldBytes(value) {
  if (value == null) return 0;
  return Buffer.byteLength(typeof value === "string" ? value : (JSON.stringify(value) ?? ""));
}

/**
 * BLOCK when the tool name or an inspected tool_input field is over the cap, or the
 * inspected tool_input fields are over it together (a Grep's path + glob + pattern).
 */
function checkInputSize(tool, input) {
  const over = (name, bytes) =>
    block(`${OVERSIZED_PREFIX} (${name}: ${bytes} bytes > ${MAX_INSPECTED_FIELD_BYTES}-byte cap)`);
  const toolBytes = fieldBytes(tool);
  if (toolBytes > MAX_INSPECTED_FIELD_BYTES) over("tool_name", toolBytes);
  if (!input || typeof input !== "object") return;
  let total = 0;
  for (const key of INSPECTED_INPUT_FIELDS) {
    const bytes = fieldBytes(input[key]);
    if (bytes > MAX_INSPECTED_FIELD_BYTES) over(`tool_input.${key}`, bytes);
    total += bytes;
  }
  if (total > MAX_INSPECTED_FIELD_BYTES) {
    block(
      `${OVERSIZED_PREFIX} (inspected fields together: ${total} bytes > ${MAX_INSPECTED_FIELD_BYTES}-byte cap)`,
    );
  }
}

// Captured at dispatch so a block can be logged with its tool/target context.
// Best-effort telemetry only — never read by the allow/block decision.
let CURRENT_TOOL = null;
let CURRENT_TARGET = null;
// True once the decision has identified the tool call (payload parsed): only then is
// the call written to the tool ledger, stamped with the verdict (see logToolCall).
let TOOL_OBSERVED = false;

// Coarse category for the block ledger, derived from the reason string so the
// trust report can group "what the agent kept trying" without parsing prose.
function blockCategory(reason) {
  // First: the size cap's reason says "unverifiable", which would read as a write.
  if (String(reason).startsWith(OVERSIZED_PREFIX)) return "oversized-input";
  const r = String(reason).toLowerCase();
  if (r.includes("secret") || r.includes(".env") || r.includes("credential")) return "secret-read";
  if (
    r.includes("control plane") ||
    r.includes("dispatch") ||
    r.includes("memory") ||
    r.includes("review approve") ||
    r.includes("mark-merged")
  )
    return "control-plane";
  if (r.includes("force") && r.includes("push")) return "force-push";
  if (r.includes("ignore-scripts") || r.includes("install")) return "supply-chain";
  if (
    r.includes("crontab") ||
    r.includes("launchctl") ||
    r.includes("hookspath") ||
    r.includes("git config") ||
    r.includes("fsmonitor") ||
    r.includes("sshcommand")
  )
    return "execution-hijack";
  if (
    r.includes("outside") ||
    r.includes("write-root") ||
    r.includes("write root") ||
    r.includes("scope") ||
    r.includes("unverifiable")
  )
    return "out-of-scope-write";
  return "other";
}

// Append one block to the structured ledger ($GAFFER_DATA/safety-blocks.jsonl).
// Gated on GAFFER_DATA so the test harness (which doesn't set it) is unaffected,
// and fully swallowed so a logging failure can never change the security
// decision or fail the hook. This is the data behind the end-of-run trust report.
function logBlock(reason) {
  try {
    const dir = process.env.GAFFER_DATA;
    if (!dir) return;
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      ticket: process.env.GAFFER_TICKET || null,
      tool: CURRENT_TOOL,
      category: blockCategory(reason),
      reason: String(reason).slice(0, 300),
      target: CURRENT_TARGET ? String(CURRENT_TARGET).slice(0, 240) : null,
    });
    appendFileSync(join(dir, "safety-blocks.jsonl"), entry + "\n");
  } catch {
    /* best-effort telemetry — must never affect the decision or fail the hook */
  }
}

// Append one tool-call observation to the per-run metrics ledger
// ($GAFFER_DATA/tool-metrics.jsonl). PURE TELEMETRY: this records WHAT tool was
// called (Read / Write / Bash / …) and its target so the end-of-run summary
// (run-summary.sh → json-tool summary-retrieval) can compute the chunk-2b
// "reads-before-first-write" proxy (unique files read + read count before the
// first Write, the real "unnecessary scans avoided" signal) and how many served
// file cards were then Read. It mirrors logBlock exactly: gated on GAFFER_DATA, fully swallowed,
// and NEVER read by the allow/block decision — it cannot weaken the hook.
//
// DECISION-STAMPED: the row is written AFTER the decision and carries it
// (`decision: "allow" | "block"`). Skill telemetry counts a skill as OPENED only from a
// row this hook ALLOWED (record-skill-usage.mjs detectOpened); a refused Read of a
// mounted skill used to be logged before the decision and so counted as use.
function logToolCall(tool, target, allowed) {
  try {
    const dir = process.env.GAFFER_DATA;
    if (!dir) return;
    const t = String(tool || "");
    const kind =
      t === "Read"
        ? "read"
        : t === "Write" || t === "Edit" || t === "MultiEdit" || t === "NotebookEdit"
          ? "write"
          : t === "Bash"
            ? "bash"
            : "other";
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      ticket: process.env.GAFFER_TICKET || null,
      tool: t,
      kind,
      target: target ? String(target).slice(0, 240) : null,
      decision: allowed ? "allow" : "block",
    });
    appendFileSync(join(dir, "tool-metrics.jsonl"), entry + "\n");
  } catch {
    /* best-effort telemetry — must never affect the decision or fail the hook */
  }
}

// block() / allow() END the decision. When this code ran inside the one-shot hook
// process they called process.exit() on the spot; now they THROW a HookVerdict,
// which unwinds exactly as far as the exit did: no check between here and
// runDecision() catches anything, and runDecision()'s crash catch passes a verdict
// through untouched. decideRaw() turns it into the result the wrapper maps to the
// same stderr line and exit code the exit produced.
class HookVerdict {
  constructor(allowed, reason) {
    this.allowed = allowed;
    this.reason = reason;
  }
}
function block(reason) {
  logBlock(reason);
  throw new HookVerdict(false, reason);
}
function allow() {
  throw new HookVerdict(true, undefined);
}

// Where the decision writes stdout (only an allowed Grep writes any: its rewritten
// input). Set per decision by decideRaw(); the wrapper passes a writeSync(1, …) sink.
let STDOUT_SINK = null;

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
const HOOK_RUNNER_DIR = canonicalize(dirname(fileURLToPath(import.meta.url)));
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
  const homes = new Set([FACTORY_HOME, dirname(dirname(fileURLToPath(import.meta.url)))]);
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
  // reviewer's comment, and Fix these, are the reviewer's acts, never a delivery agent's.
  ["review", /^(?:comment|comments|resolve|reopen-comment|withdraw-comment|fix)$/],
  // Escaped defects (MF5): linking a ticket to the accepted change it regresses, or taking
  // the link back, is a person's judgement; an agent would blame another change or hide
  // its own. Review-rule drafts (D6) are proposed from a person's feedback by the server
  // or a person, never by an agent shell.
  ["ticket", /^regression-of$/],
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

function checkCommand(cmd) {
  // A bootstrap tick (GAFFER_BOOTSTRAP_INSTALL=1) may relax ONLY the install-tagged
  // package-manager DENY rules, and ONLY for a command inside the fresh bootstrap dir. Compute it
  // once; every other rule (and the install rule itself, when not a scoped
  // bootstrap install) stays in force.
  const bootDir = bootstrapInstallDir();
  for (const rule of DENY_COMMANDS) {
    // On a bootstrap tick the install-tagged rules are judged per segment below.
    if (rule.install && bootDir) continue;
    if (rule.re.test(cmd)) block(`${rule.why} — "${cmd.slice(0, 120)}"`);
  }
  // The same rules over the command as the shell would resolve it (quotes, backslashes,
  // same-command variables, wrappers, nested shells and inline interpreters undone),
  // plus the fail-closed refusals the normaliser found on the way.
  const normalised = normalizedCommandViews(cmd);
  for (const why of normalised.reasons) block(`${why} — "${cmd.slice(0, 120)}"`);
  for (const view of normalised.views) {
    if (view === cmd) continue;
    for (const rule of DENY_COMMANDS) {
      // Install rules are judged on the raw text (and per segment on a bootstrap tick);
      // a rule marked `spellings: false` matches mentions anywhere and is raw-only too.
      if (rule.install || rule.spellings === false) continue;
      if (rule.re.test(view)) {
        block(
          `${rule.why} (as the shell would run it: "${view.slice(0, 100)}") — "${cmd.slice(0, 120)}"`,
        );
      }
    }
  }
  if (bootDir) {
    // The bootstrap allowance permits an install ONLY when every install segment is
    // scoped to the fresh repo and cannot run lifecycle scripts (postinstall ACE).
    const bootReason = bootstrapInstallReason(cmd, bootDir);
    if (bootReason) block(bootReason);
  }
  // Secret analysis runs on a VIEW of the command where a search tool's content
  // pattern and a tracked env template are masked (neither is a secret read).
  const reason = secretBoundaryReason(
    maskTrackedEnvTemplates(stripSearchPatterns(cmd)),
    process.cwd(),
  );
  if (reason) block(`${reason} — "${cmd.slice(0, 120)}"`);

  // Repo-access boundary for bash write ops and branch creation.
  const roots = resolveRoots();
  for (const target of extractBashWriteTargets(cmd)) {
    // BASH-vs-WRITE PARITY: a bash write op must obey the SAME `.git` protection
    // the Write tool applies in checkWrite — not just the write-root boundary. A
    // `.git/…` write (e.g. `echo … > .git/hooks/post-commit`, `cp evil
    // .git/hooks/post-commit`) was previously ALLOWED whenever the resolved
    // target sat inside the write-root, because only the root check ran here —
    // planting a git hook is arbitrary code execution on the next git operation.
    // (UNVERIFIABLE_TARGET is a sentinel, not a real path — only the root check
    // is meaningful for it, and it always classifies "outside".) Secret-file
    // CONTENT writes via bash (`echo … > .env`, `cp x .env`, `tee .env`) are
    // already denied by secretBoundaryReason above, so we do not re-check
    // SECRET_PATH here — doing so would wrongly block a bare `rm .env.local`
    // DELETION, which is intentionally allowed (a deletion is not an exfil).
    if (target !== UNVERIFIABLE_TARGET && GIT_INTERNAL.test(target)) {
      block(
        `bash write inside .git (hooks / exec-hijack surface): ${target} — "${cmd.slice(0, 120)}"`,
      );
    }
    if (target !== UNVERIFIABLE_TARGET) {
      // A bash write's content is not known: a .gitattributes write is judged on the
      // whole command (a driver assignment anywhere in it is refused).
      const why = gitExecSurfaceReason(target, DRIVER_SELECTION.test(cmd) ? null : "");
      if (why) block(`bash ${why} — "${cmd.slice(0, 120)}"`);
    }
    if (target !== UNVERIFIABLE_TARGET && AGENT_SETTINGS.test(target)) {
      block(
        `bash write to the agent settings file (safety-hook removal surface): ${target} — "${cmd.slice(0, 120)}"`,
      );
    }
    const access = classifyRootAccess(target, roots);
    if (access !== "write") {
      block(
        `write outside write-roots (bash write op targets ${access === "read" ? "a read-only root" : "outside all roots"}): ${target} — "${cmd.slice(0, 120)}"`,
      );
    }
  }

  // Inline-interpreter WRITE boundary (P0). Enforced whenever roots are
  // CONFIGURED — under the single-repo fallback this still applies (the cwd is
  // the write-root), which is never MORE permissive than today. Fail-closed on
  // dynamic destinations (see inlineWriteBoundaryReason).
  const inlineWrite = inlineWriteBoundaryReason(cmd, roots);
  if (inlineWrite) block(`${inlineWrite} — "${cmd.slice(0, 120)}"`);

  // Read boundary (P1) — only when roots are explicitly configured (the
  // fallback never restricted reads, and we must not become more restrictive).
  // The secret-path guard above already ran and takes precedence.
  // A resolved read target that IS a secret file is refused under every root mode:
  // after `cd ~/.config/gh` the operand `hosts.yml` carries no secret fragment, but
  // the file it names is the gh token store.
  const readTargets = extractBashReadTargets(cmd);
  for (const target of readTargets) {
    if (target === UNVERIFIABLE_TARGET) continue;
    if (
      (SECRET_PATH.test(target) || SECRET_PATH.test(target + "/")) &&
      !isTrackedEnvTemplate(target)
    ) {
      block(`bash read of a secret file: ${target} — "${cmd.slice(0, 120)}"`);
    }
  }
  if (roots.configured) {
    const inlineRead = inlineReadBoundaryReason(cmd, roots);
    if (inlineRead) block(`${inlineRead} — "${cmd.slice(0, 120)}"`);
    for (const target of readTargets) {
      if (classifyRootAccess(target, roots) === "outside") {
        block(
          `read outside allowed roots (bash read tool targets outside all roots): ${target} — "${cmd.slice(0, 120)}"`,
        );
      }
    }
  }

  const branchReason = branchCreationBoundaryReason(cmd, roots);
  if (branchReason) block(`${branchReason} — "${cmd.slice(0, 120)}"`);

  const refReason = refRewriteReason(cmd);
  if (refReason) block(`${refReason} — "${cmd.slice(0, 120)}"`);

  const frontDoor = factoryExecutionReason(cmd, roots);
  if (frontDoor) block(`${frontDoor} — "${cmd.slice(0, 120)}"`);

  allow();
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

/** The text a file tool would write, or null when the payload does not carry it. */
function writeContent(input) {
  if (!input || typeof input !== "object") return null;
  const parts = [];
  for (const k of ["content", "new_string", "new_source"]) {
    if (typeof input[k] === "string") parts.push(input[k]);
  }
  if (Array.isArray(input.edits)) {
    for (const e of input.edits)
      if (e && typeof e.new_string === "string") parts.push(e.new_string);
  }
  return parts.length ? parts.join("\n") : null;
}

function checkWrite(filePath, tool = "Write", input = null) {
  // Fail CLOSED on a missing/empty path: a legitimate Write/Edit tool call always
  // carries a non-empty file_path, so an absent one is malformed input to a security
  // boundary — allowing it would be an unbounded write escape.
  if (!filePath) block("write with an empty/missing file path — refusing (fail closed)");
  const roots = resolveRoots();
  // `~/.zshrc` is $HOME/.zshrc to the file tools, not <cwd>/~/.zshrc.
  const expanded = expandTildePath(filePath);
  if (expanded === null) block(`write to an unresolvable ~user path (fail closed): ${filePath}`);
  const abs = canonicalize(resolve(process.cwd(), expanded));
  // An env TEMPLATE may be written (the agent supplies the content). Edit /
  // MultiEdit / NotebookEdit echo the file back, so they need a TRACKED template.
  const template = ENV_TEMPLATE.test(abs) && (tool === "Write" || isTrackedEnvTemplate(abs));
  if (SECRET_PATH.test(abs) && !template) block(`write to a secret file: ${filePath}`);
  if (GIT_INTERNAL.test(abs)) block(`write inside .git: ${filePath}`);
  if (AGENT_SETTINGS.test(abs)) {
    block(`write to the agent settings file (would strip the safety hook): ${filePath}`);
  }
  {
    const why = gitExecSurfaceReason(abs, writeContent(input));
    if (why) block(why);
  }
  // Repo-access boundary: a write is allowed ONLY inside a write-root. A target
  // in a read-only root, or outside all roots, is denied.
  const access = classifyRootAccess(abs, roots);
  if (access !== "write") {
    block(
      `write outside write-roots (target is ${access === "read" ? "in a read-only root" : "outside all roots"}): ${filePath} [write-roots: ${roots.writeRoots.join(", ")}]`,
    );
  }
  allow();
}

function checkRead(filePath) {
  // Fail CLOSED on a missing/empty path (a legitimate Read always carries one): a
  // malformed empty path must not slip past the secret-read boundary.
  if (!filePath) block("read with an empty/missing file path — refusing (fail closed)");
  // `~/.config/gh/hosts.yml` is $HOME/…, not <cwd>/~/…; `~user` fails closed.
  const expanded = expandTildePath(filePath);
  if (expanded === null) block(`read of an unresolvable ~user path (fail closed): ${filePath}`);
  const abs = canonicalize(resolve(process.cwd(), expanded));
  // Existing secret-file denial takes precedence and is never weakened.
  if (SECRET_PATH.test(abs) && !isTrackedEnvTemplate(abs)) {
    block(`read of a secret file (keeps secrets out of model context): ${filePath}`);
  }
  // Repo-access boundary: reads are allowed inside (write-roots ∪ read-roots).
  // A read fully outside all roots is denied — but ONLY when roots are
  // explicitly configured. Under the single-repo fallback, reads stay
  // unrestricted (preserving today's behaviour, never more restrictive).
  const roots = resolveRoots();
  if (roots.configured && classifyRootAccess(abs, roots) === "outside") {
    block(
      `read outside allowed roots: ${filePath} [write-roots: ${roots.writeRoots.join(", ")}; read-roots: ${roots.readRoots.join(", ")}]`,
    );
  }
  allow();
}

// =====================================================================
// SEARCH-TOOL BOUNDARY (Grep / Glob / LS)
// ---------------------------------------------------------------------
// Grep and Glob read the filesystem as much as Read does: Claude Code runs
// ripgrep with --hidden for Grep (and --no-ignore --hidden for Glob), so a Grep
// over a directory prints the CONTENTS of nested `.env` files, the dashboard
// token and the mcp-runtime claim-token file. They used to have no matcher in
// settings.json and fell through this hook's `default: allow`. Now:
//   • the search ROOT (input.path, default cwd) is canonicalised like a Read
//     target: a secret path is denied, and with roots configured a root outside
//     (write ∪ read) roots is denied;
//   • a search rooted at, above or inside $HOME, $GAFFER_DATA or the MCP config
//     dir is denied unless it sits inside an allowed root (it would walk the
//     operator's credentials and the factory's token files);
//   • Grep's `glob` and Glob's `pattern` are tested against the secret families
//     (`.env*`, `**/.env`, `*.pem`, …). Grep's `pattern` is a CONTENT regex and is
//     deliberately NOT tested — searching source for the word "token" is normal;
//   • an allowed Grep is rewritten (hookSpecificOutput.updatedInput) to append
//     negated exclusion globs, so ripgrep never opens a secret file that sits
//     inside an otherwise allowed directory. A PreToolUse hook only sees the
//     tool INPUT, never its output, so the exclusion has to reach ripgrep itself.
//     (settings.json carries the same families as recursive Read deny rules,
//     which Claude Code also turns into --iglob excludes — defence in depth.)
// =====================================================================
const SEARCH_SECRET_EXCLUDES = [
  "!**/.env",
  "!**/.env.*",
  "!**/*.env",
  "!**/*.pem",
  "!**/*.key",
  "!**/*.p12",
  "!**/id_rsa*",
  "!**/id_ed25519*",
  "!**/id_ecdsa*",
  "!**/id_dsa*",
  "!**/.netrc",
  "!**/.npmrc",
  "!**/.pypirc",
  "!**/.pgpass",
  "!**/.git-credentials",
  "!**/credentials",
  "!**/credentials.json",
  "!**/.credentials.json",
  "!**/credentials.toml",
  "!**/credentials.tfrc.json",
  "!**/.vault-token",
  "!**/.claude.json",
  "!**/dashboard-token*",
  "!**/mcp-runtime*.json",
  "!**/*[-_.]token",
  "!**/*[-_.]tokens",
  "!**/.ssh/**",
  "!**/.aws/**",
  "!**/.gnupg/**",
  "!**/.kube/**",
  "!**/.azure/**",
  "!**/.config/gh/**",
  "!**/.config/gcloud/**",
  "!**/.docker/config.json",
];

/** Directories a search must not be rooted at or above (outside an allowed root). */
function searchSensitiveDirs() {
  const dirs = [];
  const mcp = process.env.MCP_CONFIG;
  for (const d of [homedir(), process.env.GAFFER_DATA, mcp ? dirname(mcp) : ""]) {
    if (d) dirs.push(canonicalize(resolve(d)));
  }
  return dirs;
}

/** Expand one level of `{a,b}` brace alternatives (enough to see `{.env,x}`). */
function braceVariants(piece) {
  const m = piece.match(/^(.*?)\{([^{}]*)\}(.*)$/);
  if (!m) return [piece];
  return m[2].split(",").map((alt) => m[1] + alt + m[3]);
}

/** True when a Grep `glob` / Glob `pattern` selects a secret-file family. */
function searchGlobNamesSecret(glob) {
  for (const piece of String(glob).split(/\s+/)) {
    // A negated piece (`!x`) EXCLUDES files — never a way to reach a secret.
    if (!piece || piece.startsWith("!")) continue;
    for (const variant of braceVariants(piece)) {
      for (const part of variant.split(",")) {
        if (part && (SECRET_GLOB.test(part) || SECRET_PATH.test(part))) return true;
      }
    }
  }
  return false;
}

/** The literal directory prefix of a glob (`/etc/**\/x` → `/etc`, `src/*.ts` → `src`). */
function globStaticBase(pattern) {
  const segs = pattern.split("/");
  const out = [];
  for (const seg of segs) {
    if (/[*?[{]/.test(seg)) break;
    out.push(seg);
  }
  // A pattern with no wildcard names a file: its directory is the base.
  if (out.length === segs.length) out.pop();
  const base = out.join("/");
  return base === "" && pattern.startsWith("/") ? "/" : base;
}

/** Deny a search root that is a secret, outside the roots, or at/above a sensitive dir. */
function checkSearchRoot(tool, abs, shown, roots) {
  if (SECRET_PATH.test(abs)) {
    block(`${tool} over a secret file (keeps secrets out of model context): ${shown}`);
  }
  const inRoots = isInsideAny([...roots.writeRoots, ...roots.readRoots], abs);
  if (roots.configured && !inRoots) {
    block(
      `${tool} outside allowed roots: ${shown} [write-roots: ${roots.writeRoots.join(", ")}; read-roots: ${roots.readRoots.join(", ")}]`,
    );
  }
  if (inRoots) return;
  // Only reachable under the unconfigured fallback (configured roots denied above):
  // a tree walk at, above or inside HOME / GAFFER_DATA / the MCP config dir that is
  // not the cwd repo itself reaches the operator's credentials and token files.
  for (const dir of searchSensitiveDirs()) {
    if (isInsideRoot(dir, abs) || abs === "/" || dir.startsWith(abs + "/")) {
      block(
        `${tool} over a home / factory-state directory outside the repo (it would walk credential and token files): ${shown}`,
      );
    }
  }
}

function checkSearch(tool, input) {
  const roots = resolveRoots();
  const rawPath = input.path == null ? "" : String(input.path);
  let base = canonicalize(process.cwd());
  if (rawPath) {
    const expanded = expandTildePath(rawPath);
    if (expanded === null)
      block(`${tool} over an unresolvable ~user path (fail closed): ${rawPath}`);
    base = canonicalize(resolve(process.cwd(), expanded));
  }
  checkSearchRoot(tool, base, rawPath || base, roots);

  const globField = tool === "Grep" ? input.glob : tool === "Glob" ? input.pattern : null;
  if (globField != null && globField !== "") {
    const glob = String(globField);
    if (searchGlobNamesSecret(glob)) {
      block(`${tool} glob selects a secret-file family: ${glob}`);
    }
    // Glob takes a pattern that may itself be absolute, `~/…` or climb with `..`:
    // its literal prefix is a second search root and gets the same checks.
    if (tool === "Glob") {
      const staticBase = globStaticBase(glob);
      if (staticBase) {
        const expanded = expandTildePath(staticBase);
        if (expanded === null) block(`Glob over an unresolvable ~user path (fail closed): ${glob}`);
        checkSearchRoot(tool, canonicalize(resolve(base, expanded)), glob, roots);
      }
    }
  }

  if (tool === "Grep") {
    // Allowed: rewrite the input so ripgrep skips secret files inside the tree.
    // ripgrep gives later globs precedence, so the negations appended here win
    // over any positive glob the agent passed. STDOUT_SINK: the wrapper's sink is
    // writeSync(1, …), because the decision JSON must be flushed before
    // process.exit, on every platform.
    const glob = [input.glob, ...SEARCH_SECRET_EXCLUDES].filter(Boolean).join(" ");
    STDOUT_SINK(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: { ...input, glob },
        },
      }),
    );
  }
  allow();
}

// Tools that reach this hook but carry no file or shell surface of their own.
// Anything else that reaches it — a new Claude Code tool someone routed with a
// broader matcher, a typo — is refused rather than waved through (fail closed).
const NON_FILE_TOOLS = new Set([
  "Task",
  "Agent",
  "TodoWrite",
  "TodoRead",
  "Skill",
  "ToolSearch",
  "SlashCommand",
  "ExitPlanMode",
  "EnterPlanMode",
  "AskUserQuestion",
  "BashOutput",
  "KillShell",
  "KillBash",
]);

// The decision for one raw stdin payload: the body of the hook's stdin "end"
// handler, moved here. Every path ends in block() or allow(), i.e. throws a
// HookVerdict.
function runDecision(raw) {
  // Wrap the WHOLE decision so any thrown error (e.g. canonicalize tripping its
  // depth/length guard on a pathological path) fails CLOSED with exit 2 rather
  // than escaping as exit 1 → ALLOW. block()/allow() throw a HookVerdict, which the
  // catch below passes through untouched, so the normal decision path is unaffected.
  try {
    // INPUT-SIZE CAP, part 1: the payload as a whole, before it is even parsed.
    const rawBytes = typeof raw === "string" ? Buffer.byteLength(raw) : 0;
    if (rawBytes > MAX_PAYLOAD_BYTES) {
      block(
        `${OVERSIZED_PREFIX} (hook payload: ${rawBytes} bytes > ${MAX_PAYLOAD_BYTES}-byte cap)`,
      );
    }
    let payload = {};
    let parsed = true;
    try {
      payload = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      parsed = false;
    }
    if (!parsed) {
      // If we can't parse the hook payload we cannot identify the tool/target, so
      // we cannot prove the call is safe — fail CLOSED (exit 2), matching every
      // other error path in this file (uncaughtException + outer-catch). NOTE: an
      // EMPTY payload is distinct: it parses as {} above and falls through to the
      // default allow (no mutating tool identified); only a genuine parse FAILURE
      // reaches here.
      block("unparseable hook payload — failing closed");
      return;
    }
    const tool = payload.tool_name ?? payload.toolName ?? "";
    const input = payload.tool_input ?? payload.toolInput ?? {};
    CURRENT_TOOL = tool;
    CURRENT_TARGET =
      input.command ??
      input.file_path ??
      input.filePath ??
      input.notebook_path ??
      input.path ??
      input.pattern ??
      null;
    // Chunk 2b metric: every observed tool call is recorded (telemetry only — never
    // read by the allow/block outcome below). decideRaw() writes the row once the
    // verdict exists, stamped with it, so a refused call never reads as an allowed one.
    TOOL_OBSERVED = true;
    // INPUT-SIZE CAP, part 2: every field a rule reads, before any rule reads it.
    checkInputSize(tool, input);
    switch (tool) {
      case "Bash":
        return checkCommand(String(input.command ?? ""));
      case "Write":
      case "Edit":
      case "MultiEdit":
      case "NotebookEdit":
        return checkWrite(
          String(input.file_path ?? input.filePath ?? input.notebook_path ?? ""),
          tool,
          input,
        );
      case "Read":
        return checkRead(String(input.file_path ?? input.filePath ?? ""));
      case "NotebookRead":
        return checkRead(String(input.notebook_path ?? input.file_path ?? ""));
      case "Grep":
      case "Glob":
      case "LS":
        return checkSearch(tool, input);
      default:
        // An EMPTY payload identifies no tool (it parses as {}) and stays allowed.
        if (tool === "") return allow();
        if (NON_FILE_TOOLS.has(tool) || /^mcp__(?:dispatch|memory)(?:__|$)/.test(tool)) {
          return allow();
        }
        return block(
          `tool "${tool}" reached the safety hook but is not on its allowlist (fail closed)`,
        );
    }
  } catch (err) {
    // A verdict is the decision itself, not a crash.
    if (err instanceof HookVerdict) throw err;
    // FAIL CLOSED: a crash while deciding must BLOCK, never exit 1/allow.
    block(
      `safety hook crashed while deciding — failing closed: ${err && err.message ? err.message : err}`,
    );
  }
}

/** The result the wrapper maps to the process contract. */
function verdictResult(verdict, stdout) {
  if (verdict.allowed) return { allow: true, exitCode: 0, stdout, stderr: "" };
  return {
    allow: false,
    exitCode: 2,
    reason: verdict.reason,
    stdout,
    stderr: `BLOCKED by gaffer safety hook: ${verdict.reason}\n`,
  };
}

/** Make process.env exactly `next` (an undefined value unsets, as for a spawn's env). */
function replaceEnv(next) {
  for (const key of Object.keys(process.env)) {
    if (next[key] === undefined) delete process.env[key];
  }
  for (const [key, value] of Object.entries(next)) {
    if (value !== undefined) process.env[key] = value;
  }
}

/**
 * Decide one tool call from the RAW stdin text, exactly as the hook does.
 *
 * Returns `{ allow, exitCode, reason?, stdout, stderr }`: exitCode 0 = allow, 2 =
 * BLOCK; `stderr` is the line the hook writes on a block and `reason` the text
 * after its prefix. An empty or whitespace-only `raw` parses as {} and is allowed;
 * unparseable JSON, and any crash while deciding, BLOCK (fail closed).
 *
 * Options (the live hook passes only `stdout`):
 *   stdout(text)  sink for what the decision writes to stdout (an allowed Grep's
 *                 rewritten input). Default: collected into the result's `stdout`.
 *   env           decide under this COMPLETE environment, as a child process
 *                 spawned with `{ env }` would (process.env is swapped in place, so
 *                 os.homedir() and the git the hook runs see it), then restored.
 *   cwd           decide with this working directory, then restore the old one.
 * The deny-list and the factory-code paths (FACTORY_CODE_TEXT, from os.homedir())
 * are fixed when this module loads; a decision with a different HOME keeps the
 * load-time value, so a test that varies HOME must spawn the hook.
 */
export function decideRaw(raw, { env, cwd, stdout } = {}) {
  const savedEnv = env === undefined ? null : { ...process.env };
  const savedCwd = cwd === undefined ? null : process.cwd();
  let collected = "";
  try {
    if (savedEnv) replaceEnv(env);
    if (savedCwd !== null) process.chdir(cwd);
    // A fresh hook process starts with no telemetry context: never carry the last
    // decision's tool/target into this one's ledger entries.
    CURRENT_TOOL = null;
    CURRENT_TARGET = null;
    TOOL_OBSERVED = false;
    STDOUT_SINK =
      stdout ??
      ((text) => {
        collected += text;
      });
    runDecision(raw);
    // Unreachable (every path throws a verdict). The old handler returning without
    // exiting would have ended the process with exit 0.
    return verdictResult(new HookVerdict(true, undefined), collected);
  } catch (err) {
    if (err instanceof HookVerdict) {
      if (TOOL_OBSERVED) logToolCall(CURRENT_TOOL, CURRENT_TARGET, err.allowed);
      return verdictResult(err, collected);
    }
    throw err;
  } finally {
    STDOUT_SINK = null;
    if (savedCwd !== null) process.chdir(savedCwd);
    if (savedEnv) replaceEnv(savedEnv);
  }
}

/** decideRaw() for a payload object, which the hook would receive as JSON.stringify(payload). */
export function decide(payload, options) {
  return decideRaw(JSON.stringify(payload) ?? "", options);
}

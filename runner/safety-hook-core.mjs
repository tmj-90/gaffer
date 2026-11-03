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
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { normalizedCommandViews } from "./lib/hook/control-plane.mjs";
import { DENY_COMMANDS } from "./lib/hook/deny-list.mjs";
import { factoryExecutionReason } from "./lib/hook/factory.mjs";
import {
  DRIVER_SELECTION,
  branchCreationBoundaryReason,
  gitExecSurfaceReason,
  refRewriteReason,
} from "./lib/hook/git.mjs";
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
  isInsideAny,
  isInsideRoot,
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
import { UNVERIFIABLE_TARGET } from "./lib/hook/shell.mjs";
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

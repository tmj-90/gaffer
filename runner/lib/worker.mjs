// Gaffer worker seam (mjs) — the ONE headless `claude` spawn AND the ONE
// Claude-JSON RESULT PARSER for the Node runners.
// =====================================================================
// WHAT THIS IS
// ---------------------------------------------------------------------
// Phase 1 (done): `deliver` encapsulates the ONE `claude -p` spawn boundary that
// decompose.mjs + product-owner-run.mjs share (each still builds its own argv/env;
// see the byte-identical contract below).
//
// Phase 2 (this file): `parseResult` is the ONE place that knows the shape of the
// `claude -p … --output-format json` envelope. Before this seam existed the schema
// knowledge was scattered — the mjs ledger re-derived tokens/cost/turns in
// usage-ledger.mjs, and the bash cap/spend guards each open-coded a tolerant JSON
// parse via `node -e` in delivery-recovery.sh. All of it now flows through the
// extractors here:
//   parseResult(text) -> { json, resultText, usage, capHit, stopReason, usageLimit }
//     resultText — the agent's `.result` text ("" when absent/unparseable)
//     usage      — { models, topLevelUsage, totalCostUsd, numTurns, durationMs }
//                  (tokens verbatim; dollars RELAYED, never computed — see honesty
//                   rules in usage-ledger.mjs, which shapes these into a ledger row)
//     capHit     — { numTurns, stopReasonIsMaxTurns } (turn-cap detection signals)
//     stopReason — the stop/finish reason string, or null
//     usageLimit — { kind, id, message, resetsAtMs, resetBasis } when the call was
//                  refused by a usage window or rate limit (USAGE_LIMIT_PATTERNS,
//                  the one table of matched strings), else null
// usage-ledger.mjs imports the same extractors (so a ledger row and parseResult can
// never diverge); delivery-recovery.sh's bash helpers call the `parse-result` CLI
// below (so bash cap/spend read the SAME parse). Honesty rule: a value the payload
// didn't carry is the string "unknown" (UNKNOWN), never 0.
//
// BYTE-IDENTICAL SPAWN CONTRACT (Phase 1 — unchanged)
// ---------------------------------------------------
// The seam changes only WHERE the spawn lives, never WHAT is spawned. Each caller
// still builds its OWN argv (decompose puts `--mcp-config` first and appends
// `--max-turns`; the product-owner appends `--allowedTools`) and its OWN
// credential-stripped `env`, then hands them here. Those genuine per-site
// differences stay behind the `argv` / `env` / `maxBuffer` parameters.
//
// INTERFACE (deliver)  {prompt, model, env, mcpConfig, cwd, timeout, maxTurns}
//   The semantic inputs are baked into `argv` by the caller (the two sites' argv
//   shapes are irreconcilable byte-for-byte). env / cwd / timeout map directly.
//     bin       — the claude binary (CLAUDE_BIN)
//     argv      — the fully-built argv (carries prompt/model/mcpConfig/maxTurns)
//     cwd       interface: cwd
//     timeoutMs interface: timeout
//     maxBuffer — per-site stdout ceiling (16MiB decompose / 32MiB product-owner)
//     env       interface: env — the credential-stripped child env
//   Returns the Node `SpawnSyncReturns` verbatim ({ status, stdout, stderr, error, … }).

import {
  BUDGET_REFUSED_STATUS,
  releasePendingReservation,
  reservePaidLaunch,
} from "./budget-admission.mjs";
import { pauseLine, readPause } from "./usage-pause.mjs";
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { platform } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// node:child_process costs about 10 ms to load, and `parse-result` (spawned several
// times per tick) never starts a process, so it is loaded on first use
// (exploratory finding testspeed/TS-5).
const childProcess = () => process.getBuiltinModule("node:child_process");
const spawn = (...args) => childProcess().spawn(...args);
const spawnSync = (...args) => childProcess().spawnSync(...args);

const RUNNER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const UNKNOWN = "unknown";

// ── PROVIDER DISPATCH ──────────────────────────────────────────────────────────
// The mjs runners (decompose, product-owner, tester, resolver, onboarding) pick
// their worker backend the same way the bash seam (worker.sh) and the sandbox seam
// (sandbox.sh) do: on an env var, defaulting to `claude-code`. Two providers are
// real: `claude-code` (BYTE-IDENTICAL to the historical spawn) and `command` (an
// operator-supplied program under the contract in docs/worker-providers.md). Any
// other value FAILS CLOSED (no spawn). See worker.sh's header and SECURITY.md.
export const DEFAULT_WORKER_PROVIDER = "claude-code";
export const COMMAND_WORKER_PROVIDER = "command";

/** The selected worker provider (trimmed), defaulting to claude-code. */
export function workerProvider(env = process.env) {
  const raw =
    env && typeof env.GAFFER_WORKER_PROVIDER === "string" ? env.GAFFER_WORKER_PROVIDER.trim() : "";
  return raw || DEFAULT_WORKER_PROVIDER;
}

/** The honest fail-closed message — word-for-word identical to the bash seam. */
export function unsupportedProviderMessage(provider) {
  return `worker provider ${provider} not yet supported; safety-hook containment unavailable`;
}

// A spawnSync-shaped result for the fail-closed path so callers' existing
// `res.error` / `res.status` handling treats it as a failed spawn — WITHOUT ever
// spawning. status 70 == EX_SOFTWARE-style "we refused"; error carries the message.
function failClosedResult(message) {
  return {
    pid: -1,
    status: 70,
    signal: null,
    stdout: "",
    stderr: message,
    output: [null, "", message],
    error: new Error(message),
  };
}

// ── THE COMMAND PROVIDER (GAFFER_WORKER_PROVIDER=command) ─────────────────────
// The runner runs an operator-supplied program (GAFFER_WORKER_COMMAND) instead of
// `claude -p`. The contract (docs/worker-providers.md, word for word what the bash
// seam does): no arguments, cwd = the call's directory, stdin empty, the scrubbed
// agent env plus the GAFFER_WORKER_* contract variables below, a JSON envelope on
// stdout, exit 0 when it finished. The helpers here are shared by both runtimes (the
// bash seam calls the `normalize-command-envelope` CLI below).
//
// CONTAINMENT: the PreToolUse safety hook runs INSIDE `claude -p`; a command worker
// has no such hook. So launching one REQUIRES an OS sandbox wrap (GAFFER_STRICT_REQUIRE
// semantics, whatever GAFFER_STRICT_REQUIRE says) unless the operator sets
// GAFFER_STRICT_REQUIRE=0 explicitly to assert containment out-of-band, which is
// logged loudly at every spawn.

/** Exit codes the runner itself returns for refusals; a worker returning one is remapped to 1. */
export const RESERVED_WORKER_EXIT_CODES = Object.freeze([70, 75, 76, 77]);

// The forms of a path a containment check must compare: as written (resolved), with its
// directory's symlinks resolved, and fully resolved. A program named through a symlink
// that lives in a write root is refused even when the link points somewhere safe: the
// agent could re-point the link.
function pathForms(p) {
  const out = new Set([resolve(p)]);
  try {
    out.add(resolve(realpathSync(dirname(resolve(p))), basename(p)));
  } catch {
    /* no such dir */
  }
  try {
    out.add(realpathSync(p));
  } catch {
    /* no such file */
  }
  return [...out];
}
const isInside = (p, root) => p === root || p.startsWith(root.endsWith("/") ? root : root + "/");

/**
 * The command provider's program: `{ ok: true, command }` for an absolute path to an
 * executable file the agent cannot rewrite, else `{ ok: false, message }` (the launch is
 * refused, status 70). The program is what runs every agent turn, so it must live
 * outside every directory the factory lets an agent write: not under $GAFFER_DATA (the
 * delivery worktrees live there, and settings.json), not under this call's write roots
 * or its working directory, not reached through a symlink in one of them, and not
 * writable by its group or others.
 */
export function commandWorkerConfig(env = process.env, { writeRoots = "", cwd = "" } = {}) {
  const cmd = String(env.GAFFER_WORKER_COMMAND ?? "").trim();
  const fix =
    "set GAFFER_WORKER_COMMAND to the absolute path of an executable worker program (docs/worker-providers.md)";
  if (!cmd)
    return {
      ok: false,
      message: `worker provider command: GAFFER_WORKER_COMMAND is not set; ${fix} — no agent spawned`,
    };
  if (!cmd.startsWith("/"))
    return {
      ok: false,
      message: `worker provider command: GAFFER_WORKER_COMMAND=${cmd} is not an absolute path; ${fix} — no agent spawned`,
    };
  let st;
  try {
    accessSync(cmd, fsConstants.X_OK);
    st = statSync(cmd);
    if (!st.isFile()) throw new Error("not a file");
  } catch {
    return {
      ok: false,
      message: `worker provider command: GAFFER_WORKER_COMMAND=${cmd} is not an executable file; ${fix} — no agent spawned`,
    };
  }
  const where =
    "keep the worker program outside every directory an agent can write ($GAFFER_DATA, the worktrees, the call's write roots), owned by you and not writable by others";
  const roots = [
    { root: env.GAFFER_DATA || resolve(RUNNER_DIR, "..", ".gaffer"), what: "$GAFFER_DATA" },
    ...String(writeRoots || "")
      .split("\n")
      .map((r) => ({ root: r.trim(), what: "a write root of this call" })),
    { root: String(cwd || "").trim(), what: "the call's working directory" },
  ].filter((r) => r.root.startsWith("/"));
  for (const c of pathForms(cmd)) {
    for (const { root, what } of roots) {
      if (pathForms(root).some((r) => isInside(c, r)))
        return {
          ok: false,
          message: `worker provider command: GAFFER_WORKER_COMMAND=${cmd} lives inside ${what} (${root}), where an agent can replace it; ${where} — no agent spawned`,
        };
    }
  }
  if (st.mode & 0o022)
    return {
      ok: false,
      message: `worker provider command: GAFFER_WORKER_COMMAND=${cmd} is writable by its group or others (mode ${(st.mode & 0o777).toString(8)}); run chmod go-w on it and ${where} — no agent spawned`,
    };
  try {
    const dst = statSync(dirname(realpathSync(cmd)));
    // A directory others may write lets them swap the program, unless it is sticky (/tmp).
    if (dst.mode & 0o002 && !(dst.mode & 0o1000))
      return {
        ok: false,
        message: `worker provider command: GAFFER_WORKER_COMMAND=${cmd} sits in a directory anyone can write; ${where} — no agent spawned`,
      };
  } catch {
    /* the stat above already proved the file exists */
  }
  return { ok: true, command: cmd };
}

/** True only for an EXPLICIT GAFFER_STRICT_REQUIRE=0|false|no|off: the operator's out-of-band assertion. */
export function strictRequireOptedOut(env = process.env) {
  if (env.GAFFER_STRICT_REQUIRE === undefined) return false;
  // Not trimmed: the bash readers (lib/worker.sh, lib/sandbox.sh, the config) take the
  // value as it is, so " 0" is no opt-out there and must not be one here either.
  const v = String(env.GAFFER_STRICT_REQUIRE).toLowerCase();
  return v === "0" || v === "false" || v === "no" || v === "off";
}

/**
 * The refusal when the command provider cannot get the containment it needs. Its only
 * accepted boundary is the docker sandbox WITH the host-side MCP bridge:
 *   • "none"         no OS sandbox at all on this host (or SANDBOX_PROVIDER=none/unknown);
 *   • "write-only"   SANDBOX_PROVIDER=sandbox-exec: a write-only boundary whose profile
 *                    still grants writes under $GAFFER_DATA (settings.json, the dispatch
 *                    and memory databases, the usage ledger). claude-code's in-process
 *                    hook refuses those writes; a command worker has none;
 *   • "not-docker"   a wrap that is not the docker wrapper reached the seam;
 *   • "legacy"       docker without the MCP bridge (GAFFER_MCP_BRIDGE off, the macOS
 *                    default): the databases are mounted read-write in the container.
 * The bash seam prints the same words (`node lib/worker.mjs command-refusal <why>`).
 */
export function commandSandboxRefusalMessage(why = "none") {
  const fix =
    "Fix: set SANDBOX_PROVIDER=docker with a running docker daemon on a host where the MCP bridge works (GAFFER_MCP_BRIDGE on: the default on Linux), " +
    "or set GAFFER_STRICT_REQUIRE=0 in the environment if you contain the whole runner out-of-band (a VM or container)";
  const head = {
    none: "has no in-process safety hook, so it needs the docker sandbox and no OS sandbox is available on this host",
    "write-only":
      "needs the docker sandbox: SANDBOX_PROVIDER=sandbox-exec only restricts writes, and its profile still lets the worker write $GAFFER_DATA (settings.json, the dispatch and memory databases, the usage ledger), which only claude-code's in-process safety hook guards",
    "not-docker":
      "needs the docker sandbox, and the wrap handed to the worker seam is not the docker wrapper",
    legacy:
      "needs the docker sandbox with the host-side MCP bridge: with GAFFER_MCP_BRIDGE off (the macOS default) the dispatch and memory databases are mounted read-write into the container, where the worker could change ticket state directly",
  };
  return `worker: GAFFER_WORKER_PROVIDER=command ${head[why] || head.none} — refusing to spawn the worker (fail closed). ${fix}`;
}

/**
 * Why the command worker may NOT launch under this sandbox configuration, or null when
 * it may (the docker provider, with the MCP bridge on or no MCP data plane at all).
 * `hasMcpServers` says whether this call's MCP config names any server. The docker
 * daemon's availability is the wrap's own check (sandbox_wrap_cmd under
 * GAFFER_STRICT_REQUIRE=1). Not consulted under the explicit opt-out.
 */
export function commandContainmentProblem(env = process.env, { hasMcpServers = true } = {}) {
  const sp = sandboxProvider(env);
  if (sp === "sandbox-exec") return "write-only";
  if (sp !== "docker") return "none";
  if (hasMcpServers && !mcpBridgeOn(env)) return "legacy";
  return null;
}

/** True when the MCP config file names at least one server (an unreadable one counts as yes: fail closed). */
export function mcpConfigHasServers(path) {
  if (!path) return false;
  try {
    return Object.keys(JSON.parse(readFileSync(path, "utf8")).mcpServers || {}).length > 0;
  } catch {
    return existsSync(path);
  }
}

// The largest prompt that also rides GAFFER_WORKER_PROMPT inline. One environment string
// is capped at 128 KiB on Linux (MAX_ARG_STRLEN) and macOS caps the whole argv plus env
// near 1 MiB, so a long prompt with big context blocks would fail to spawn at all. The
// prompt always reaches the worker through GAFFER_WORKER_PROMPT_FILE.
export const COMMAND_PROMPT_INLINE_MAX = 64 * 1024;

/**
 * Write this call's prompt to a private per-call file under $GAFFER_DATA (mode 600) and
 * return its path; the docker wrapper mounts it read-only. The caller removes it.
 */
export function writeCommandPromptFile(prompt, gafferData) {
  const dir = gafferData || resolve(RUNNER_DIR, "..", ".gaffer");
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `worker-prompt.${process.pid}.${randomBytes(6).toString("hex")}`);
  writeFileSync(file, String(prompt ?? ""), { mode: 0o600, flag: "wx" });
  return file;
}

/** The prompt's inline copy for GAFFER_WORKER_PROMPT: the text when it fits, else "". */
export function commandInlinePrompt(prompt) {
  const p = String(prompt ?? "");
  return Buffer.byteLength(p) <= COMMAND_PROMPT_INLINE_MAX ? p : "";
}

// The flat floor default when GAFFER_KILL_ESTIMATE_USD is unset (usage-ledger.mjs
// KILL_ESTIMATE_DEFAULT_USD and factory.config.sh carry the same figure).
const COMMAND_COST_FLOOR_DEFAULT_USD = 0.05;

/**
 * The least a command-worker call is booked at. The cost in its envelope is the
 * operator's program talking, so a figure it leaves out or puts low must not let the
 * daily and lifetime caps under-count. Precedence: GAFFER_WORKER_COMMAND_COST_USD when
 * set (0 = trust the worker's own figure), else this call's dollar cap
 * (GAFFER_WORKER_MAX_BUDGET_USD, when positive), else GAFFER_KILL_ESTIMATE_USD (when
 * positive), else $0.05. Only an explicit 0 trusts the worker's own figure.
 */
export function commandCostFloorUsd({ explicit, perCall, killFloor } = {}) {
  const num = (v) => {
    const t = String(v ?? "").trim();
    if (!/^(\d+\.?\d*|\.\d+)$/.test(t)) return null;
    const n = Number(t);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const e = num(explicit);
  if (e !== null) return e;
  const p = num(perCall);
  if (p !== null && p > 0) return p;
  // The kill floor only when above 0: GAFFER_KILL_ESTIMATE_USD=0 opts the killed-call
  // estimate out, it does not say this program's figure is to be trusted. Trusting it
  // (an unreported cost counted as $0) is GAFFER_WORKER_COMMAND_COST_USD=0 alone.
  const k = num(killFloor);
  if (k !== null && k > 0) return k;
  return COMMAND_COST_FLOOR_DEFAULT_USD;
}

/** The loud line logged at every command-worker spawn under the opt-out. Same words as worker.sh. */
export function commandOptOutWarning() {
  return "WARNING: GAFFER_WORKER_PROVIDER=command with GAFFER_STRICT_REQUIRE=0 — the command worker runs with no OS sandbox requirement and no in-process safety hook. Only safe if you contain the runner out-of-band (a VM or container).";
}

// Names the runner keeps to itself: never passed to a command worker, even when
// GAFFER_WORKER_COMMAND_ENV names them (the dispatch API token, the claim token, the
// repo host tokens, the notify channels).
const COMMAND_ENV_NEVER =
  /^(DISPATCH_API_TOKEN|GAFFER_CLAIM_TOKEN|GAFFER_PRINCIPAL_TOKEN|GITHUB_TOKEN|GH_TOKEN)$|^GAFFER_NOTIFY_|_WEBHOOK|_SLACK/;

/**
 * A PERSON'S CREDENTIAL (package H1): GAFFER_PRINCIPAL_TOKEN makes the dispatch CLI act
 * as a human or admin principal, and a person's tester verdict needs exactly that. It
 * never reaches an agent process, whatever env a launcher hands the seam (and when it
 * hands none, the inherited env loses it too). The bash seam's allowlist drops it the same
 * way (config/11-agent-env.sh).
 */
export const PERSON_CREDENTIAL_ENV = ["GAFFER_PRINCIPAL_TOKEN"];
export function withoutPersonCredentials(env) {
  const out = { ...(env || {}) };
  for (const k of PERSON_CREDENTIAL_ENV) delete out[k];
  return out;
}

/** The env names GAFFER_WORKER_COMMAND_ENV lets through to the command worker (validated). */
export function commandEnvPassNames(env = process.env) {
  return String(env.GAFFER_WORKER_COMMAND_ENV ?? "")
    .split(/[\s,]+/)
    .filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && !COMMAND_ENV_NEVER.test(n));
}

/**
 * The command worker's env, from the caller's already-scrubbed env: the claude-code auth
 * and config surface (ANTHROPIC_*, CLAUDE_*) is removed (it is not this worker's), the
 * names GAFFER_WORKER_COMMAND_ENV lists are added from the runner's env, and the
 * contract variables go on top.
 */
export function commandWorkerEnv(callerEnv, contract, env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(callerEnv || {})) {
    if (/^(ANTHROPIC_|CLAUDE_)/.test(k)) continue;
    out[k] = v;
  }
  for (const n of commandEnvPassNames(env)) if (env[n] !== undefined) out[n] = env[n];
  return { ...out, ...contract };
}

/**
 * Read the contract hints out of the claude-shaped argv the mjs launchers build, so
 * every launcher routes through the command provider unchanged:
 *   -p → prompt · --mcp-config → mcpConfig · --model → model · --max-turns → maxTurns
 *   · --max-budget-usd → maxBudgetUsd · `--tools ""` → tools "none"
 *   · --allowedTools / --disallowedTools → their tool names (hints, space-separated).
 */
export function commandArgvHints(argv) {
  const a = Array.isArray(argv) ? argv : [];
  const after = (flag) => {
    const i = a.indexOf(flag);
    return i >= 0 && i + 1 < a.length ? String(a[i + 1]) : "";
  };
  const list = (flag) => {
    const i = a.indexOf(flag);
    if (i < 0) return "";
    const names = [];
    for (let k = i + 1; k < a.length && !String(a[k]).startsWith("-"); k++) names.push(a[k]);
    return names.join(" ");
  };
  const i = a.indexOf("--tools");
  return {
    prompt: after("-p"),
    mcpConfig: after("--mcp-config"),
    model: after("--model"),
    maxTurns: /^[0-9]+$/.test(after("--max-turns")) ? after("--max-turns") : "",
    maxBudgetUsd: after("--max-budget-usd"),
    tools: i >= 0 && a[i + 1] === "" ? "none" : "all",
    allowedTools: list("--allowedTools"),
    disallowedTools: list("--disallowedTools"),
  };
}

/** The GAFFER_WORKER_* contract variables (all strings; "" = not set for this call). */
export function commandContractEnv({
  prompt = "",
  promptFile = "",
  mcpConfig = "",
  model = "",
  maxTurns = "",
  maxBudgetUsd = "",
  tools = "all",
  allowedTools = "",
  disallowedTools = "",
  kind = "worker",
  timeoutSecs = "",
} = {}) {
  return {
    GAFFER_WORKER_CONTRACT: "1",
    GAFFER_WORKER_PROMPT: commandInlinePrompt(prompt),
    GAFFER_WORKER_PROMPT_FILE: String(promptFile),
    GAFFER_WORKER_MCP_CONFIG: String(mcpConfig),
    GAFFER_WORKER_MODEL: String(model),
    GAFFER_WORKER_MAX_TURNS: String(maxTurns),
    GAFFER_WORKER_MAX_BUDGET_USD: String(maxBudgetUsd),
    GAFFER_WORKER_TOOLS: tools === "none" ? "none" : "all",
    GAFFER_WORKER_ALLOWED_TOOLS: String(allowedTools),
    GAFFER_WORKER_DISALLOWED_TOOLS: String(disallowedTools),
    GAFFER_WORKER_KIND: String(kind),
    GAFFER_WORKER_TIMEOUT_SECS: String(timeoutSecs),
  };
}

const finiteNonNeg = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

/**
 * THE PARSER ADAPTER for the command provider: turn the worker's envelope (stdout;
 * log noise tolerated, the last top-level JSON object wins) into the canonical
 * envelope every downstream reader already consumes — parseResult, the usage ledger,
 * the bash cap/spend guards — so `{resultText, usage, capHit, stopReason}` mean the
 * same thing for both providers. Only the documented fields are read; everything is
 * optional:
 *   result (string) · stop_reason (string) · cap_hit (boolean) · num_turns ·
 *   duration_ms · cost_usd (numbers) · model (string) · usage { input_tokens,
 *   output_tokens, cache_read_input_tokens, cache_creation_input_tokens }
 * Returns the canonical envelope as a JSON string, or "" when stdout held no JSON
 * object (the ledger then books the call as a killed one: a conservative estimate).
 *
 * Honesty: a cost the worker did not report stays "unknown" (gaffer_cost_basis
 * "unreported"), never an invented figure. The envelope is stamped
 * gaffer_worker_provider:"command", and such an envelope can NEVER read as a
 * usage-limit or auth-error outcome (detectUsageLimit / detectAuthError): those
 * release a ticket without counting an attempt, and the program writing this
 * envelope must not be able to buy that.
 */
export function normalizeCommandEnvelope(text, { costFloorUsd = 0 } = {}) {
  const raw = parseClaudeJson(text);
  if (!raw) return "";
  const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
  const stop = str(raw.stop_reason, 200);
  const capHit = raw.cap_hit === true || MAX_TURNS_RE.test(stop);
  const budgetStop = !capHit && MAX_BUDGET_RE.test(stop);
  const cost = finiteNonNeg(raw.cost_usd);
  // The per-call floor (commandCostFloorUsd): a cost left out or reported below it is
  // booked AT the floor, labelled basis "floor", with the worker's own figure kept.
  const floor = finiteNonNeg(costFloorUsd) ?? 0;
  const floored = floor > 0 && (cost === undefined || cost < floor);
  const out = {
    type: "result",
    subtype: capHit ? "error_max_turns" : budgetStop ? "error_max_budget_usd" : "success",
    is_error: capHit || budgetStop,
    result: typeof raw.result === "string" ? raw.result : "",
    gaffer_worker_provider: COMMAND_WORKER_PROVIDER,
    gaffer_cost_basis: floored ? "floor" : cost === undefined ? "unreported" : "reported",
  };
  if (floored) out.gaffer_reported_cost_usd = cost === undefined ? UNKNOWN : cost;
  if (stop) out.stop_reason = stop;
  if (finiteNonNeg(raw.num_turns) !== undefined) out.num_turns = raw.num_turns;
  if (finiteNonNeg(raw.duration_ms) !== undefined) out.duration_ms = raw.duration_ms;
  if (floored) out.total_cost_usd = floor;
  else if (cost !== undefined) out.total_cost_usd = cost;
  const u =
    raw.usage && typeof raw.usage === "object" && !Array.isArray(raw.usage) ? raw.usage : null;
  const tokens = {};
  if (u) {
    for (const k of [
      "input_tokens",
      "output_tokens",
      "cache_read_input_tokens",
      "cache_creation_input_tokens",
    ]) {
      if (finiteNonNeg(u[k]) !== undefined) tokens[k] = u[k];
    }
  }
  const model = str(raw.model, 80)
    .replace(/[^A-Za-z0-9 ._()+:/@[\]-]/g, "")
    .trim();
  if (model) {
    const m = {};
    if (tokens.input_tokens !== undefined) m.inputTokens = tokens.input_tokens;
    if (tokens.output_tokens !== undefined) m.outputTokens = tokens.output_tokens;
    if (tokens.cache_read_input_tokens !== undefined)
      m.cacheReadInputTokens = tokens.cache_read_input_tokens;
    if (tokens.cache_creation_input_tokens !== undefined)
      m.cacheCreationInputTokens = tokens.cache_creation_input_tokens;
    if (cost !== undefined) m.costUSD = cost;
    out.modelUsage = { [model]: m };
  } else if (Object.keys(tokens).length) {
    out.usage = tokens;
  }
  return JSON.stringify(out);
}

/** The adapter's parse: the command envelope → the same {resultText, usage, capHit, stopReason} parseResult returns. */
export function parseCommandEnvelope(text, opts) {
  const { json, resultText, usage, capHit, stopReason } = parseResult(
    normalizeCommandEnvelope(text),
    opts,
  );
  return { json, resultText, usage, capHit, stopReason, usageLimit: null };
}

/** True when a parsed envelope came from the command provider's adapter. */
function isCommandEnvelope(json) {
  return (
    !!json && typeof json === "object" && json.gaffer_worker_provider === COMMAND_WORKER_PROVIDER
  );
}

// ── OS-SANDBOX CONTAINMENT AT THE SEAM (parity with worker.sh's worker_deliver) ──
// The bash seam derives and enforces the OS-sandbox wrap for EVERY spawn site: when
// the sandbox is ON (STRICT_MODE=1) or REQUIRED (GAFFER_STRICT_REQUIRE, auto-set by
// every autonomy flag) it asks lib/sandbox.sh's `sandbox_wrap_cmd` for the provider
// prefix and FAILS CLOSED (rc 75, no spawn, empty envelope) when the host cannot
// supply one. The mjs seam used to spawn bare regardless — so the merge-conflict
// resolver, the product-owner, the tester and the onboarding analysis (which run
// exactly when autonomy is on) escaped the containment decision the delivery,
// reviewer, clarify and bootstrap spawns are subject to. `deliver` now makes the
// SAME decision from the SAME env, reusing the SAME provider scripts (sandbox.sh
// dispatch → sandbox-exec profile / sandbox-docker.sh), so the two runtimes cannot
// disagree about what "contained" means.

/**
 * True when the OS sandbox is REQUIRED — sandbox.sh's `_sandbox_strict_required`. It is
 * the DEFAULT for every launch: unset, empty or any value but an explicit
 * 0/false/no/off is required. Only the operator's environment carries the opt-out (the
 * dashboard never takes GAFFER_STRICT_REQUIRE from settings.json, nor does the runner).
 */
export function sandboxRequired(env = process.env) {
  // Not trimmed, exactly like sandbox.sh's _sandbox_strict_required and the config
  // (runner/config/15-modes.sh): " 0" or "0 " is not an opt-out in bash, so it must not
  // be one here (a launcher started without the config would otherwise run unwrapped).
  const v = String(env.GAFFER_STRICT_REQUIRE ?? "").toLowerCase();
  return !(v === "0" || v === "false" || v === "no" || v === "off");
}

/** True when `name` is an executable file in one of env.PATH's directories. */
function onPath(name, env = process.env) {
  for (const dir of String(env.PATH || "").split(":")) {
    if (!dir) continue;
    try {
      accessSync(resolve(dir, name), fsConstants.X_OK);
      return true;
    } catch {
      /* not here */
    }
  }
  return false;
}

/**
 * The sandbox provider in force: SANDBOX_PROVIDER, else the same auto-detection as
 * runner/config/16-sandbox.sh and sandbox.sh's gaffer_sandbox_default_provider
 * (sandbox-exec where the binary exists, else docker where the docker CLI exists, else
 * sandbox-exec). The dashboard's launchers often run with SANDBOX_PROVIDER unset.
 */
export function sandboxProvider(env = process.env) {
  const sp = String(env.SANDBOX_PROVIDER ?? "").trim();
  if (sp) return sp;
  if (onPath("sandbox-exec", env)) return "sandbox-exec";
  if (onPath("docker", env)) return "docker";
  return "sandbox-exec";
}

// The opt-out (GAFFER_STRICT_REQUIRE=0 in the environment) is said once per process.
let optOutNoticed = false;
function isolationOptOutNotice(env = process.env) {
  if (optOutNoticed || env._GAFFER_STRICT_OPTOUT_WARNED === "1") return;
  optOutNoticed = true;
  process.stderr.write(
    `WARNING: GAFFER_STRICT_REQUIRE=${env.GAFFER_STRICT_REQUIRE} in the environment: agents run without the required OS sandbox. ` +
      "Only the worktree and the safety hook contain them, so this is safe only when the runner already runs inside a VM or container you trust.\n",
  );
}

/** True when the sandbox is ON (STRICT_MODE=1) or REQUIRED — worker.sh's `_worker_sandbox_wanted`. */
export function sandboxWanted(env = process.env) {
  return String(env.STRICT_MODE ?? "0").trim() === "1" || sandboxRequired(env);
}

/**
 * Ask lib/sandbox.sh (the ONE provider seam) for the wrap prefix, exactly as
 * worker_deliver does: `sandbox_wrap_cmd <write-roots> <read-roots>`. Returns
 *   { ok: true, wrap: string[] }   — the prefix argv (possibly empty = no wrapping)
 *   { ok: false, message }         — the provider REFUSED (strict-require + no sandbox)
 * The prefix is word-split the way the bash seam expands `$wrap` unquoted.
 */
export function sandboxWrapArgv({ writeRoots, readRoots, env = process.env }) {
  const res = spawnSync(
    "bash",
    [
      "-c",
      // On a refusal the ONE actionable message (the host's situation, the fix, the
      // opt-out) follows the provider's own line, so a launcher shows the person what to do.
      'source "$0/lib/sandbox.sh" && { sandbox_wrap_cmd "$1" "$2" || { _rc=$?; printf "%s\\n" "$(gaffer_sandbox_unavailable_hint)" >&2; exit "$_rc"; }; }',
      RUNNER_DIR,
      writeRoots,
      readRoots ?? "",
    ],
    {
      encoding: "utf8",
      env: {
        ...env,
        RUNNER_DIR,
        GAFFER_DATA: env.GAFFER_DATA || resolve(RUNNER_DIR, "..", ".gaffer"),
      },
    },
  );
  const diag = (res.stderr || "").trim();
  if (res.error || res.status !== 0) {
    return {
      ok: false,
      diag,
      message:
        "worker: refusing to spawn the agent (fail closed): no OS sandbox for it on this host" +
        (diag ? `: ${diag}` : ""),
    };
  }
  return { ok: true, wrap: (res.stdout || "").trim().split(/\s+/).filter(Boolean), diag };
}

/**
 * PER-LANE TURN CAP: the `--max-turns` argv for a lane's effective cap (the tester's,
 * resolver's and PO's role cap, already clamped by roleTurnCap). A positive integer →
 * ["--max-turns", "N"]; anything else (unset, empty, 0, junk) → [] — the lane keeps its
 * wall-clock bound only. The ONE helper every mjs lane's argv builder uses, so the lanes
 * cannot drift apart (the bash lanes pass gaffer_role_turns to worker_deliver).
 */
export function maxTurnsArgv(raw) {
  const s = String(raw ?? "").trim();
  if (!/^[0-9]+$/.test(s)) return [];
  const n = parseInt(s, 10);
  return n > 0 ? ["--max-turns", String(n)] : [];
}

// The bash seam's refusal status for a required-but-unavailable sandbox.
const SANDBOX_REFUSED_STATUS = 75;
// A usage-window pause: `gaffer run` (loop.sh) and `gaffer plan`'s code for it. The same
// number as the sandbox refusal (both are "the runner refused, nothing spawned");
// `usagePaused` on the result tells them apart.
export const USAGE_PAUSED_STATUS = 75;
// The bash seam's refusal status when the MCP bridge cannot be rendered / started.
const BRIDGE_REFUSED_STATUS = 76;
const BRIDGE = resolve(RUNNER_DIR, "lib", "mcp-bridge.mjs");

/** worker.sh's `_worker_mcp_bridge_on`: auto ⇒ on except macOS (Docker Desktop cannot bind-mount a host unix socket). */
export function mcpBridgeOn(env = process.env) {
  const v = String(env.GAFFER_MCP_BRIDGE ?? "auto")
    .trim()
    .toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return platform() !== "darwin";
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * MCP DATA PLANE ON THE HOST for a docker-wrapped spawn — the mjs twin of the
 * lifecycle in lib/worker.sh (worker_deliver): render the token-free bridged config,
 * start `mcp-bridge.mjs serve` on a per-spawn unix socket, and hand back what the
 * spawn needs (the socket for the wrapper's env, the bridged path for the argv) plus
 * a `stop()` that tears it all down. An EMPTY data plane (no servers) needs no bridge
 * and reports `dataPlane: "none"` so the wrapper mounts no databases either.
 *   → { ok: true, socket, bridgedConfig, dataPlane: "bridge"|"none", stop() }
 *   → { ok: false, message }   (the caller refuses to spawn — fail closed)
 */
export function startMcpBridge({ mcpConfig, gafferData, env = process.env }) {
  const noop = () => {};
  if (!mcpConfig || !existsSync(mcpConfig)) return { ok: true, dataPlane: "none", stop: noop };
  // A SHORT private dir, not $GAFFER_DATA: unix socket paths are capped at 104 bytes on
  // macOS (108 on Linux) and a deep data dir pushed the path over, so `serve` could not
  // listen and every spawn was refused. mkdtemp ⇒ mode 700.
  void gafferData;
  let sockDir;
  try {
    sockDir = mkdtempSync("/tmp/gaffer-mcp.");
  } catch (e) {
    return {
      ok: false,
      message: `worker: mcp bridge: could not create a private socket dir under /tmp — refusing to spawn the agent (fail closed): ${e.message}`,
    };
  }
  const sock = resolve(sockDir, "b.sock");
  const rmDir = () => {
    try {
      rmSync(sockDir, { recursive: true, force: true });
    } catch {
      /* gone */
    }
  };
  const bridged = mcpConfig.replace(/\.json$/, "") + ".bridge.json";
  const r = spawnSync(
    process.execPath,
    [
      BRIDGE,
      "render",
      "--config",
      mcpConfig,
      "--out",
      bridged,
      "--socket",
      sock,
      "--bridge",
      BRIDGE,
    ],
    {
      encoding: "utf8",
      env,
    },
  );
  if (r.status !== 0) {
    rmDir();
    return {
      ok: false,
      message: `worker: mcp bridge: could not render the bridged MCP config from ${mcpConfig} — refusing to spawn the agent (fail closed): ${(r.stderr || "").trim()}`,
    };
  }
  let servers;
  try {
    servers = Object.keys(JSON.parse(readFileSync(bridged, "utf8")).mcpServers || {}).length;
  } catch {
    servers = 0;
  }
  if (servers === 0) {
    try {
      unlinkSync(bridged);
    } catch {
      /* gone */
    }
    rmDir();
    return { ok: true, dataPlane: "none", stop: noop };
  }
  const child = spawn(
    process.execPath,
    [BRIDGE, "serve", "--socket", sock, "--config", mcpConfig],
    {
      env,
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  const stop = () => {
    try {
      child.kill("SIGTERM");
    } catch {
      /* gone */
    }
    for (const f of [sock, bridged]) {
      try {
        unlinkSync(f);
      } catch {
        /* gone */
      }
    }
    rmDir();
  };
  for (let i = 0; i < 100 && !existsSync(sock); i++) sleepMs(50);
  if (!existsSync(sock)) {
    stop();
    return {
      ok: false,
      message: `worker: mcp bridge did not start on ${sock} — refusing to spawn the agent (fail closed)`,
    };
  }
  return { ok: true, socket: sock, bridgedConfig: bridged, dataPlane: "bridge", stop };
}

export function deliver({ bin, argv, cwd, timeoutMs, maxBuffer, env, kind = "worker" }) {
  const provider = workerProvider(process.env);
  const isCommand = provider === COMMAND_WORKER_PROVIDER;
  if (provider !== DEFAULT_WORKER_PROVIDER && !isCommand) {
    // codex / local / any other value — FAIL CLOSED. No spawn.
    return failClosedResult(unsupportedProviderMessage(provider));
  }
  // A person's principal token never reaches the agent (see withoutPersonCredentials).
  env = withoutPersonCredentials(env ?? process.env);
  // USAGE WINDOW (lib/usage-pause.mjs): while $GAFFER_DATA/usage-pause.json is in force
  // the bash seam starts no tick (tick.sh, worker.sh, loop.sh exit 75) and `gaffer plan`
  // starts no turn (exit 75). Every Node launcher (the dashboard's planner, Suggest work,
  // onboarding analysis, the tester, the merge resolver, the spec author) spawns here, so
  // the same refusal is here: NO spawn, status 75, empty stdout, nothing booked, before
  // any other check (a paused factory starts nothing, whatever else is configured).
  const pause = readPause(process.env);
  if (pause) {
    const message =
      `worker: the factory is ${pauseLine(pause)}; not starting the ${kind} call. ` +
      "It lifts on its own; node runner/lib/usage-pause.mjs clear lifts it now.";
    process.stderr.write(`${message}\n`);
    const r = failClosedResult(message);
    r.status = USAGE_PAUSED_STATUS;
    r.usagePaused = true;
    r.usagePause = pause;
    return r;
  }
  let command = null;
  if (isCommand) {
    command = commandWorkerConfig(process.env, {
      writeRoots: (env && env.GAFFER_WRITE_ROOTS) || cwd,
      cwd,
    });
    if (!command.ok) {
      process.stderr.write(`${command.message}\n`);
      return failClosedResult(command.message);
    }
  }
  // claude-code — the current path. With the sandbox off and no dollar cap configured
  // this is byte-identical. An opted-in per-call cap (GAFFER_MAX_CALL_USD, clamped to
  // GAFFER_BUDGET_REMAINING) bounds THIS call while it runs, not only between calls.
  argv = withCallBudget(argv, process.env);
  // BUDGET ADMISSION (external review #6): the ONE check every paid launch passes
  // immediately before it spawns (lib/budget-admission.mjs; the bash seam asks the same
  // module). Daily or lifetime budget exhausted, or the spend unknowable with a cap set
  // ⇒ NO spawn: status 77, empty stdout, nothing booked to the ledger. Both providers.
  // RESERVATION (external review 16): admitted under a cap, the launch books its worst
  // case (this call's --max-budget-usd, else the kill estimate) as a reservation row,
  // under the admission lock, so a concurrent launch sees it; the call's own ledger row
  // settles it (usage-ledger.mjs appendUsageRecord). Every refusal below this point
  // starts nothing and gives the reservation back (`unreserve`).
  const bi = argv.indexOf("--max-budget-usd");
  const admission = reservePaidLaunch({
    kind,
    env: process.env,
    worstUsd: bi >= 0 ? Number(argv[bi + 1]) : undefined,
    ticket: env && env.GAFFER_TICKET,
  });
  if (!admission.ok) {
    const r = failClosedResult(admission.reason);
    r.status = BUDGET_REFUSED_STATUS;
    r.budgetRefused = true;
    process.stderr.write(`worker: ${admission.reason}\n`);
    return r;
  }
  const reservationId = admission.reservation ? admission.reservation.id : null;
  const unreserve = (r, why) => {
    if (reservationId) releasePendingReservation(why || "the launch was refused before it started");
    return r;
  };
  let spawnBin = bin;
  let spawnArgv = argv;
  let spawnEnv = env;
  let bridgeStop = () => {};
  // The command provider: the same launch, a different program. The claude-shaped argv
  // the launcher built becomes the GAFFER_WORKER_* contract; the program gets no args.
  let contract = null;
  let hints = null;
  // THE CONTAINMENT DECISION. claude-code: wrap when the sandbox is ON or REQUIRED.
  // command: ALWAYS required (no in-process safety hook), unless the operator opted out
  // with an explicit GAFFER_STRICT_REQUIRE=0 — then logged loudly, and wrapped only when
  // STRICT_MODE=1 asks for it (degrading like claude-code does). The only boundary that
  // counts for it is the docker sandbox with the host-side MCP bridge
  // (commandContainmentProblem); anything else refuses before a file is written.
  if (!isCommand && !sandboxRequired(process.env)) isolationOptOutNotice(process.env);
  const optedOut = isCommand && strictRequireOptedOut(process.env);
  const commandNeedsWrap = isCommand && !optedOut;
  if (optedOut) process.stderr.write(`${commandOptOutWarning()}\n`);
  if (isCommand) {
    hints = commandArgvHints(argv);
    if (commandNeedsWrap) {
      const why = commandContainmentProblem(process.env, {
        hasMcpServers: mcpConfigHasServers(hints.mcpConfig),
      });
      if (why) {
        const message = commandSandboxRefusalMessage(why);
        process.stderr.write(`${message}\n`);
        const r = failClosedResult(message);
        r.status = SANDBOX_REFUSED_STATUS;
        return unreserve(r, "the sandbox refused the launch");
      }
    }
  }
  let promptFile = "";
  const dropPromptFile = () => {
    if (!promptFile) return;
    try {
      unlinkSync(promptFile);
    } catch {
      /* gone */
    }
  };
  if (isCommand) {
    try {
      promptFile = writeCommandPromptFile(
        hints.prompt,
        process.env.GAFFER_DATA || resolve(RUNNER_DIR, "..", ".gaffer"),
      );
    } catch (e) {
      const r = failClosedResult(
        `worker: could not write the command worker's prompt file (${e?.code ?? e}) — no agent spawned`,
      );
      return unreserve(r, "the command worker's prompt file could not be written");
    }
    contract = commandContractEnv({
      ...hints,
      promptFile,
      kind,
      timeoutSecs: timeoutMs > 0 ? String(Math.ceil(timeoutMs / 1000)) : "",
    });
    spawnBin = command.command;
    spawnArgv = [];
    spawnEnv = commandWorkerEnv(env, contract, process.env);
  }
  // From here on every early return must remove the prompt file.
  const refuse = (r) => {
    dropPromptFile();
    return unreserve(r);
  };
  if (commandNeedsWrap || sandboxWanted(process.env)) {
    // Derive the wrap from the per-call boundary vars (the cwd is the write root
    // when none is named), exactly like worker_deliver's WORKER_CALL_ENV scan.
    const writeRoots = (env && env.GAFFER_WRITE_ROOTS) || cwd;
    const readRoots = (env && env.GAFFER_READ_ROOTS) || "";
    const wrapEnv = commandNeedsWrap ? { ...process.env, GAFFER_STRICT_REQUIRE: "1" } : process.env;
    const wrapped = sandboxWrapArgv({ writeRoots, readRoots, env: wrapEnv });
    const notDocker =
      commandNeedsWrap &&
      wrapped.ok &&
      wrapped.wrap.length > 0 &&
      !wrapped.wrap.some((w) => /(^|\/)sandbox-docker\.sh$/.test(w));
    if (!wrapped.ok || (commandNeedsWrap && wrapped.wrap.length === 0) || notDocker) {
      // FAIL CLOSED: a required sandbox the host cannot supply means NO spawn —
      // status 75, empty stdout (no fabricated envelope), error set so callers'
      // existing error paths fire. Never a silent bare run.
      const message = commandNeedsWrap
        ? commandSandboxRefusalMessage(notDocker ? "not-docker" : "none") +
          (wrapped.diag ? ` (${wrapped.diag})` : "")
        : wrapped.message;
      if (commandNeedsWrap) process.stderr.write(`${message}\n`);
      const r = failClosedResult(message);
      r.status = SANDBOX_REFUSED_STATUS;
      return refuse(r);
    }
    if (wrapped.diag) process.stderr.write(wrapped.diag + "\n");
    if (wrapped.wrap.length > 0) {
      // The wrapper script itself (sandbox-docker.sh / sandbox-exec) needs the
      // factory's path vars to build its mounts; they are not secrets. The caller's
      // env wins where it already names them.
      spawnEnv = {
        RUNNER_DIR,
        GAFFER_HOME: process.env.GAFFER_HOME || resolve(RUNNER_DIR, ".."),
        GAFFER_DATA: process.env.GAFFER_DATA || resolve(RUNNER_DIR, "..", ".gaffer"),
        ...spawnEnv,
      };
      // Inside the `docker` provider the HOST's claude path / HOME / PATH do not
      // exist — the image ships `claude` on its own PATH and root's HOME is /root.
      // Substitute ONLY when a docker wrap is active, and only for the command
      // INSIDE the container (an `env HOME=… PATH=… claude` prefix, the shape the
      // bash seam's `env -i … HOME= PATH= claude` takes) — the wrapper script itself
      // still runs with the host PATH so it can find `docker`.
      let inner = [spawnBin, ...spawnArgv];
      if (wrapped.wrap.some((w) => /(^|\/)sandbox-docker\.sh$/.test(w))) {
        // ── MCP DATA PLANE ON THE HOST (same lifecycle as lib/worker.sh) ──────────
        // The wrapper never infers a layout from an absent socket: with the bridge on
        // and an MCP config in the argv it REFUSES unless the socket is set, so the
        // launcher must start the bridge (or declare the data plane empty) itself.
        let agentArgv = argv;
        const i = argv.indexOf("--mcp-config");
        const mcpConfig = i >= 0 ? argv[i + 1] : undefined;
        if (mcpBridgeOn(process.env) && mcpConfig) {
          const b = startMcpBridge({
            mcpConfig,
            gafferData: spawnEnv.GAFFER_DATA,
            env: process.env,
          });
          if (!b.ok) {
            const r = failClosedResult(b.message);
            r.status = BRIDGE_REFUSED_STATUS;
            return refuse(r);
          }
          bridgeStop = b.stop;
          if (b.dataPlane === "bridge") {
            spawnEnv = { ...spawnEnv, GAFFER_MCP_BRIDGE_SOCKET: b.socket };
            agentArgv = argv.map((a, k) => (k === i + 1 ? b.bridgedConfig : a));
            if (contract) contract = { ...contract, GAFFER_WORKER_MCP_CONFIG: b.bridgedConfig };
          } else {
            spawnEnv = { ...spawnEnv, GAFFER_SANDBOX_DATA_PLANE: "none" };
          }
        }
        const containerBase = [
          "env",
          `HOME=${process.env.GAFFER_SANDBOX_HOME || "/root"}`,
          `PATH=${process.env.GAFFER_SANDBOX_PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}`,
        ];
        if (isCommand) {
          // The same shape as the bash seam's `env -i <agent env> <call env> HOME= PATH=
          // <contract> <program>`: `env -i` drops whatever the container's own top level
          // carries, and the command worker gets exactly the scrubbed caller env, the
          // names GAFFER_WORKER_COMMAND_ENV passes and the contract (commandWorkerEnv),
          // with HOME and PATH rebased for the image.
          const innerEnv = {
            ...commandWorkerEnv(env, contract, process.env),
            HOME: process.env.GAFFER_SANDBOX_HOME || "/root",
            PATH:
              process.env.GAFFER_SANDBOX_PATH ||
              "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            ...contract,
          };
          inner = [
            "env",
            "-i",
            ...Object.entries(innerEnv).map(([k, v]) => `${k}=${v}`),
            process.env.GAFFER_SANDBOX_WORKER_COMMAND || command.command,
          ];
        } else {
          inner = [
            ...containerBase,
            process.env.GAFFER_SANDBOX_CLAUDE_BIN || "claude",
            ...agentArgv,
          ];
        }
      }
      spawnArgv = [...wrapped.wrap.slice(1), ...inner];
      spawnBin = wrapped.wrap[0];
    }
  }
  let res;
  try {
    res = spawnSync(spawnBin, spawnArgv, {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer,
      env: spawnEnv,
      // The command worker runs in its OWN process group (detached), so the timeout
      // can take down everything it started, as the bash seam's gaffer_timeout does: the
      // leader gets SIGKILL (a TERM-ignoring program would otherwise hold spawnSync
      // forever) and the group is swept below.
      ...(isCommand
        ? { stdio: ["ignore", "pipe", "pipe"], detached: true, killSignal: "SIGKILL" }
        : {}),
    });
  } finally {
    bridgeStop(); // the host-side servers, the socket and the bridged config go with the agent
    dropPromptFile();
  }
  // A program that could not be executed at all (ENOENT / EACCES at spawn) ran nothing,
  // so its reservation is given back; a call that ran (or timed out) keeps it until the
  // launcher books the call's row.
  if (
    reservationId &&
    res &&
    res.error &&
    !res.pid &&
    ["ENOENT", "EACCES"].includes(res.error.code)
  )
    unreserve(null, `the worker could not be started (${res.error.code})`);
  if (res && reservationId) res.reservationId = reservationId;
  if (isCommand && res && res.pid && (res.signal || res.error)) {
    try {
      process.kill(-res.pid, "SIGKILL");
    } catch {
      /* the group is already empty */
    }
  }
  if (isCommand && res) {
    // The parser adapter: callers read the canonical envelope, never the raw stdout.
    res.stdout = normalizeCommandEnvelope(res.stdout || "", {
      costFloorUsd: commandCostFloorUsd({
        explicit: process.env.GAFFER_WORKER_COMMAND_COST_USD,
        perCall: hints.maxBudgetUsd,
        killFloor: process.env.GAFFER_KILL_ESTIMATE_USD,
      }),
    });
    if (RESERVED_WORKER_EXIT_CODES.includes(res.status)) {
      process.stderr.write(
        `worker: the command worker exited ${res.status}, a code the runner reserves for its own refusals; recording it as a failed call (exit 1)\n`,
      );
      res.status = 1;
    }
  }
  return res;
}

// =====================================================================
// RESULT PARSER (Phase 2) — the ONE owner of the claude-JSON envelope schema.
// =====================================================================

/**
 * Parse the captured stdout of `claude -p … --output-format json`.
 * Returns the result OBJECT, or null when the text is missing/unparseable.
 *
 * Tolerant by design: a JSON object may be the whole stdout, or be embedded in
 * other log noise. We try a strict whole-string parse first, then fall back to the
 * LAST balanced top-level `{...}` block in the text (the final result object).
 * Anything we cannot parse → null → the caller records "unknown" (never 0).
 */
export function parseClaudeJson(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const trimmed = text.trim();
  try {
    const obj = JSON.parse(trimmed);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj;
  } catch {
    /* fall through to embedded-object scan */
  }
  const candidate = lastBalancedObject(trimmed);
  if (candidate) {
    try {
      const obj = JSON.parse(candidate);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj;
    } catch {
      /* not parseable — fall through to null */
    }
  }
  return null;
}

/** Return the last top-level balanced {…} substring, or null. Quote/escape aware. */
function lastBalancedObject(text) {
  let last = null;
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        last = text.slice(start, i + 1);
        start = -1;
      }
    }
  }
  return last;
}

/** The agent's text output (`.result`), or "" when absent/unparseable. */
export function extractResultText(json) {
  if (json && typeof json === "object" && typeof json.result === "string") {
    return json.result;
  }
  return "";
}

/**
 * A non-negative finite NUMBER, or UNKNOWN. We never coerce a missing/garbage
 * value to 0 — that would let an unmeasured call read as free.
 */
export function numOrUnknown(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return UNKNOWN;
}

/**
 * Build the per-model usage map from a parsed result object (tokens verbatim, cost
 * relayed from Claude Code's own costUSD, never computed). A field the payload
 * didn't carry is "unknown", not 0. Returns null when there is no usable
 * modelUsage object.
 */
export function buildModels(json) {
  const mu = json && typeof json === "object" ? json.modelUsage : null;
  if (!mu || typeof mu !== "object" || Array.isArray(mu)) return null;
  const models = {};
  for (const [model, u] of Object.entries(mu)) {
    if (!u || typeof u !== "object") continue;
    models[model] = {
      input: numOrUnknown(u.inputTokens),
      output: numOrUnknown(u.outputTokens),
      cache_read: numOrUnknown(u.cacheReadInputTokens),
      cache_create: numOrUnknown(u.cacheCreationInputTokens),
      // RELAYED — Claude Code's own per-model figure. Never computed here.
      cost_usd: numOrUnknown(u.costUSD),
    };
  }
  return Object.keys(models).length ? models : null;
}

/**
 * Extract the honest usage signals from a parsed result object. Numeric fields are
 * verbatim when present, UNKNOWN otherwise. `models` / `topLevelUsage` are the raw
 * split (null when absent) so the ledger can apply its "synthesise (unknown-model)
 * from top-level usage" rule. This is the ONE numeric extraction shared by
 * parseResult and usage-ledger.mjs's buildUsageRecord — they can never diverge.
 */
export function extractUsage(json) {
  if (!json || typeof json !== "object") {
    return {
      models: null,
      topLevelUsage: null,
      totalCostUsd: UNKNOWN,
      numTurns: UNKNOWN,
      durationMs: UNKNOWN,
    };
  }
  return {
    models: buildModels(json),
    topLevelUsage: json.usage && typeof json.usage === "object" ? json.usage : null,
    // RELAYED — Claude Code's own aggregate figure. Never computed from a price table.
    totalCostUsd: numOrUnknown(json.total_cost_usd),
    numTurns: numOrUnknown(json.num_turns),
    durationMs: numOrUnknown(json.duration_ms),
  };
}

/**
 * The effective `--max-turns` for one role: the role's own cap clamped to the
 * global GAFFER_MAX_TURNS ceiling (Math.min). The global can LOWER a role cap but
 * never raise or replace it — `GAFFER_MAX_TURNS || roleCap` used to let the
 * factory's 200-turn delivery cap silently override the planner's 20. A missing /
 * non-positive role cap falls back to the global; both missing → 0 (emit no flag).
 * Parity with gaffer_role_turns in factory.config.sh.
 */
export function roleTurnCap(roleCap, env = process.env) {
  const pos = (v) => {
    const n = parseInt(String(v ?? ""), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const role = pos(roleCap);
  const ceiling = pos(env.GAFFER_MAX_TURNS);
  if (role && ceiling) return Math.min(role, ceiling);
  return role || ceiling;
}

/**
 * The old per-role turn-cap variables, deprecated for one release: each still sets its
 * role's cap when GAFFER_ROLE_MAX_TURNS does not name the role (the first one set
 * wins: the resolver spelling before the merge one). Parity with gaffer_role_cap in
 * runner/config/07-limits.sh.
 */
export const ROLE_TURNS_ALIASES = {
  review: ["GAFFER_REVIEW_MAX_TURNS"],
  security_review: ["GAFFER_SECURITY_REVIEW_MAX_TURNS"],
  clarify: ["GAFFER_CLARIFY_MAX_TURNS"],
  judge: ["GAFFER_JUDGE_MAX_TURNS"],
  tester: ["GAFFER_TESTER_MAX_TURNS"],
  merge: ["GAFFER_RESOLVER_MAX_TURNS", "GAFFER_MERGE_MAX_TURNS"],
  po: ["GAFFER_PO_MAX_TURNS"],
  scout: ["GAFFER_SCOUT_MAX_TURNS"],
  decompose: ["GAFFER_DECOMPOSE_AGENT_MAX_TURNS"],
  spec_author: ["GAFFER_SPEC_AUTHOR_AGENT_MAX_TURNS"],
  onboard: ["GAFFER_ONBOARD_MAX_TURNS"],
};

/**
 * One role's own turn cap, before the GAFFER_MAX_TURNS ceiling: its entry in
 * GAFFER_ROLE_MAX_TURNS ("review=30 tester=120", commas or spaces), else its deprecated
 * variable, else `fallback`. A missing, zero or non-numeric value is skipped.
 */
export function roleTurnsSetting(role, fallback, env = process.env) {
  const pos = (v) => {
    const s = String(v ?? "").trim();
    return /^[0-9]+$/.test(s) && Number(s) > 0 ? Number(s) : 0;
  };
  for (const pair of String(env.GAFFER_ROLE_MAX_TURNS ?? "").split(/[\s,]+/)) {
    const eq = pair.indexOf("=");
    if (eq > 0 && pair.slice(0, eq) === role) {
      const n = pos(pair.slice(eq + 1));
      if (n) return n;
    }
  }
  for (const name of ROLE_TURNS_ALIASES[role] ?? []) {
    const n = pos(env[name]);
    if (n) return n;
  }
  return fallback;
}

/**
 * The old per-role model variables, deprecated for one release: each still names its
 * role's model when GAFFER_ROLE_MODELS does not. (scout and judge had FLAG variables,
 * read at their shell call sites.) Parity with gaffer_role_model in
 * runner/config/04-models.sh.
 */
export const ROLE_MODEL_ALIASES = {
  rework: "GAFFER_REWORK_STRONG_MODEL",
  card: "GAFFER_CARD_MODEL",
  inherit: "GAFFER_INHERIT_MODEL",
  synth: "GAFFER_ONBOARD_SYNTH_MODEL",
  tester: "GAFFER_TEST_MODEL",
};

/**
 * One role's model: its entry in GAFFER_ROLE_MODELS ("card=haiku judge=opus", commas or
 * spaces), else its deprecated variable, else "" (the caller applies the role's own
 * default). A blank value is skipped.
 */
export function roleModel(role, env = process.env) {
  for (const pair of String(env.GAFFER_ROLE_MODELS ?? "").split(/[\s,]+/)) {
    const eq = pair.indexOf("=");
    if (eq > 0 && pair.slice(0, eq) === role && pair.slice(eq + 1)) return pair.slice(eq + 1);
  }
  const alias = ROLE_MODEL_ALIASES[role];
  return alias ? String(env[alias] ?? "").trim() : "";
}

/** roleTurnsSetting clamped to the GAFFER_MAX_TURNS ceiling (roleTurnCap). */
export function roleTurns(role, fallback, env = process.env) {
  return roleTurnCap(roleTurnsSetting(role, fallback, env), env);
}

// Turn-cap markers Claude Code may surface across shapes (matches the legacy
// delivery-recovery.sh scan exactly): "max_turns", "max-turns", "turn limit", …
const MAX_TURNS_RE = /max[_-]?turns|turn[_ -]?limit/i;

/**
 * True iff the parsed envelope carries a stop/finish reason signalling the turn
 * cap. Scans the same candidate fields (and same order) the bash guard used, so
 * cap detection is byte-for-byte the prior behaviour.
 */
export function stopReasonIsMaxTurns(json) {
  if (!json || typeof json !== "object") return false;
  const cands = [
    json.stop_reason,
    json.subtype,
    json.finish_reason,
    json.result && json.result.stop_reason,
    json.error && json.error.message,
    json.permission_denials,
  ];
  for (const v of cands) {
    if (typeof v === "string" && MAX_TURNS_RE.test(v)) return true;
  }
  return false;
}

// Budget-stop markers: `--max-budget-usd` ends a run with subtype
// "error_max_budget_usd" (and similar "budget exceeded/limit" wording).
const MAX_BUDGET_RE = /max[_-]?budget|budget[_ -]?(exceeded|limit)/i;

/**
 * True iff the envelope says the run stopped on its per-call DOLLAR cap
 * (--max-budget-usd). Kept separate from the turn cap: a budget stop pauses as
 * `budget_cap`, never `cap_hit`, so a Continue is not misread as "give it more turns".
 */
export function stopReasonIsBudget(json) {
  if (!json || typeof json !== "object") return false;
  for (const v of [
    json.stop_reason,
    json.subtype,
    json.finish_reason,
    json.error && json.error.message,
  ]) {
    if (typeof v === "string" && MAX_BUDGET_RE.test(v)) return true;
  }
  return false;
}

/**
 * The per-call dollar cap (`--max-budget-usd`). OPT-IN: it applies only when the
 * operator sets GAFFER_MAX_CALL_USD (default empty = off, so the argv is unchanged).
 * When on, the cap is the lowest of GAFFER_MAX_CALL_USD, the factory's live headroom
 * (GAFFER_BUDGET_REMAINING, when a budget is set) and `ticketRemaining` (the ticket's
 * own headroom, passed by the bash delivery site). A zero / negative headroom yields
 * null: the pre-spawn budget gates own that case (they park or refuse before a
 * spawn). Claude Code checks the cap between turns, so a call can overshoot it by one
 * turn. Parity with gaffer_call_budget_usd in factory.config.sh.
 */
export function callBudgetUsd(env = process.env, ticketRemaining) {
  const num = (v) => (v == null || String(v).trim() === "" ? NaN : Number(v));
  const perCall = num(env.GAFFER_MAX_CALL_USD);
  if (!(perCall > 0)) return null;
  const vals = [perCall, num(env.GAFFER_BUDGET_REMAINING), num(ticketRemaining)].filter((n) =>
    Number.isFinite(n),
  );
  const min = Math.min(...vals);
  return min > 0 ? min : null;
}

/** Append `--max-budget-usd <cap>` unless the argv already names one or no cap is set. */
export function withCallBudget(argv, env = process.env) {
  if (!Array.isArray(argv) || argv.includes("--max-budget-usd")) return argv;
  const cap = callBudgetUsd(env);
  return cap == null ? argv : [...argv, "--max-budget-usd", cap.toFixed(4)];
}

/**
 * Turn-cap detection signals: the finite `num_turns` (or null when absent/garbage —
 * we never INVENT a cap from missing data) plus the max-turns stop-reason boolean.
 */
export function extractCapSignals(json) {
  const nt = json && typeof json === "object" ? json.num_turns : undefined;
  const numTurns = typeof nt === "number" && Number.isFinite(nt) ? nt : null;
  return { numTurns, stopReasonIsMaxTurns: stopReasonIsMaxTurns(json) };
}

/** The stop/finish reason string (first present of stop_reason/subtype/finish_reason), or null. */
export function extractStopReason(json) {
  if (!json || typeof json !== "object") return null;
  for (const v of [json.stop_reason, json.subtype, json.finish_reason]) {
    if (typeof v === "string" && v) return v;
  }
  return null;
}

// =====================================================================
// USAGE-LIMIT / RATE-LIMIT DETECTION (the usage-window-aware scheduler)
// ---------------------------------------------------------------------
// A plan's usage window running out (or an API rate limit) is NOT a failed
// delivery: the agent never got to work. Read as a failure it burned an attempt
// and, repeated overnight, parked good tickets. parseResult classifies it as its
// own outcome (`usageLimit`) so the tick can release the claim WITHOUT counting an
// attempt and pause the whole factory until the window resets (lib/usage-pause.mjs).
//
// THE TABLE BELOW IS THE ONLY PLACE THESE STRINGS LIVE. Each row records where the
// exact text comes from, so nothing is matched on a guess. Rules:
//   • Text rows match ONLY on an ERROR envelope (is_error:true, an error_* subtype,
//     or type:"error"): an agent whose ordinary reply talks about rate limiting
//     (a ticket that adds a rate limiter) is never misread as a limit hit.
//     There is NO exception, the legacy whole-string form included: `.result` on a
//     success envelope is the agent's own final reply, which a misbehaving or
//     prompt-injected agent controls. Honouring it would let the agent release its
//     ticket with no attempt counted on every pass and never be parked for a human.
//   • Text rows are anchored at the start of the string (`^`) and checked against
//     the envelope's `.result` and each `errors[]` string.
//   • `reset` names how the reset time is read when present: "clock" (the CLI's
//     " · resets 3pm (Europe/London)" suffix), "epoch" (unix seconds in the match),
//     "retry-after" (a retry-after seconds hint in the text). No reset → the
//     configured default pause (usage-pause.mjs), which errs toward a longer wait.
// Verified against two Claude Code builds: 2.1.42's npm cli.js, and 2.1.316's
// native binary (the CLI on PATH on the build host this was checked on; the
// factory runs whichever build its operator installed, so BOTH wordings stay):
//   2.1.42  rj1(A,q)  = `You've hit your ${A}${q}`, A ∈ {session limit, weekly
//               limit, Opus limit, Sonnet limit, usage limit, limit}.
//   2.1.316 M(e,n,_,{progressSavedSuffix}) = `You've hit your ${e}${n}` plus an
//               optional ` · progress saved`, e from its label table {5-hour limit,
//               weekly limit, Opus limit, Sonnet limit, Fable limit, usage credit
//               limit} or the literals "usage limit" / "limit".
//   Both:     n/q = ` · resets ${time}` where time is "3pm" / "3:30pm" within 24h,
//               "Oct 9, 3pm" beyond (", 2027" added in another year), then
//               ` (${Intl timeZone})`. A trailing ` · progress saved` (2.1.316)
//               follows the zone; parseResetClock ignores trailing segments.
//   2.1.42  b79       = `You're out of extra usage${q}` (overage disabled: out_of_credits).
//   2.1.316           = `You're out of usage credits${n}` (+ ` · progress saved`), and
//               `You're out of usage credits. Switch to another model…`.
//   2.1.316           = `You've reached your Fable limit` / `…limit.` (mid-session).
//   2.1.42  kw6       = `API Error: Rate limit reached` (HTTP 429 without unified-limit
//               headers); Qq1 (Opus high load) is also tagged error:"rate_limit".
//   NOT matched on purpose: spend caps and admin switches ("You've hit your
//   monthly spend limit", "…team's shared budget", "Your seat type doesn't
//   include…", "… requires usage credits"). They do not end on their own; a
//   human has to raise the cap, so they stay ordinary failures that park the
//   ticket for a person instead of an open-ended run of paused re-tries.
// The Agent SDK's assistant message carries `error: "rate_limit"`
// (SDKAssistantMessageError); the raw Messages API 429 body is
// {type:"error", error:{type:"rate_limit_error", message}}.
// When Claude Code changes a string, add a row here (and a fixture in
// test/usage-limit-detect.test.mjs) — never loosen an existing one.
// =====================================================================
export const USAGE_LIMIT_PATTERNS = Object.freeze([
  {
    id: "cc-hit-your-limit",
    kind: "usage_limit",
    re: /^You've hit your (?:5-hour limit|session limit|weekly limit|Opus limit|Sonnet limit|Fable limit|usage credit limit|usage limit|limit)(?=$|\s|\u00b7|\.)/,
    reset: "clock",
    source:
      "Claude Code 2.1.42 cli.js rj1() and 2.1.316 M(): `You've hit your <limit> · resets <time> (<zone>)[ · progress saved]`",
  },
  {
    id: "cc-out-of-usage-credits",
    kind: "usage_limit",
    re: /^You're out of usage credits(?=$|\s|\u00b7|\.)/,
    reset: "clock",
    source:
      "Claude Code 2.1.316 (overage out_of_credits): `You're out of usage credits · resets <time> (<zone>)[ · progress saved]`",
  },
  {
    id: "cc-reached-your-limit",
    kind: "usage_limit",
    re: /^You've reached your (?:[A-Za-z0-9-]+ )?limit(?=$|\s|\u00b7|\.)/,
    reset: "clock",
    source: "Claude Code 2.1.316 (mid-session): `You've reached your Fable limit[.]`",
  },
  {
    id: "cc-out-of-extra-usage",
    kind: "usage_limit",
    re: /^You're out of extra usage(?=$|\s|\u00b7)/,
    reset: "clock",
    source: "Claude Code 2.1.42 cli.js b79(): `You're out of extra usage · resets <time> (<zone>)`",
  },
  {
    id: "cc-legacy-usage-limit",
    kind: "usage_limit",
    re: /^Claude AI usage limit reached\|(\d{9,11})\s*$/,
    reset: "epoch",
    source:
      "Claude Code 1.x print mode: `Claude AI usage limit reached|<unix seconds>` (absent from 2.1.42)",
  },
  {
    id: "cc-api-rate-limit",
    kind: "rate_limit",
    re: /^API Error: Rate limit reached(?=$|\s|[.:])/,
    reset: "retry-after",
    source: "Claude Code 2.1.42 cli.js kw6(): `API Error: Rate limit reached` (HTTP 429)",
  },
  {
    id: "cc-opus-high-load",
    kind: "rate_limit",
    re: /^Opus is experiencing high load, please use \/model to switch to Sonnet/,
    reset: null,
    source: 'Claude Code 2.1.42 cli.js Qq1, returned with error:"rate_limit"',
  },
  {
    id: "api-429-rate-limit-error",
    kind: "rate_limit",
    re: /^API Error: 429\b[\s\S]*"type"\s*:\s*"rate_limit_error"/,
    reset: "retry-after",
    source: "Messages API 429 body relayed by Claude Code as `API Error: 429 {…rate_limit_error…}`",
  },
]);

/** Structural (non-text) shapes, checked before the text table. Same contract. */
export const USAGE_LIMIT_SHAPES = Object.freeze([
  {
    id: "sdk-assistant-error-rate-limit",
    kind: "rate_limit",
    test: (j) => j.error === "rate_limit",
    source: 'Agent SDK SDKAssistantMessage.error === "rate_limit"',
  },
  {
    id: "api-error-rate-limit-error",
    kind: "rate_limit",
    test: (j) =>
      !!j.error &&
      typeof j.error === "object" &&
      j.error.type === "rate_limit_error" &&
      (j.type === "error" || j.is_error === true),
    source: 'Messages API error body {type:"error", error:{type:"rate_limit_error"}}',
  },
]);

function isErrorEnvelope(json) {
  return (
    json.is_error === true ||
    json.type === "error" ||
    (typeof json.subtype === "string" && /^error/.test(json.subtype))
  );
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** The UTC offset (ms) of `tz` at the instant `utcMs`; throws on an unknown zone. */
function tzOffsetMs(utcMs, tz) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p = {};
  for (const x of f.formatToParts(new Date(utcMs))) p[x.type] = x.value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** A wall-clock time in `tz` → epoch ms (DST-correct to the minute). */
function zonedToUtcMs(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo, d, h, mi);
  const off = tzOffsetMs(guess, tz);
  let t = guess - off;
  const off2 = tzOffsetMs(t, tz);
  if (off2 !== off) t = guess - off2;
  return t;
}

/** Today's calendar date in `tz` at `nowMs`. */
function zonedToday(nowMs, tz) {
  const t = nowMs + tzOffsetMs(nowMs, tz);
  const d = new Date(t);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate() };
}

/**
 * Parse Claude Code's reset suffix — `· resets 3pm (Europe/London)`,
 * `· resets 3:30pm (UTC)`, `· resets Oct 9, 3pm (America/New_York)`,
 * `· resets Oct 9, 2027, 3pm (…)` — into epoch ms, the NEXT such instant after
 * `nowMs`. Returns null when there is no suffix, the time does not parse, or the
 * zone is unknown (the caller then uses the configured default pause). A suffix
 * without a zone is read in the host's zone (the CLI formats in its own zone).
 * Trailing ` · …` segments after the reset (2.1.316's ` · progress saved`) are
 * ignored, so they cannot push a weekly reset back to the short default pause.
 */
export function parseResetClock(text, nowMs = Date.now()) {
  if (typeof text !== "string") return null;
  // Drop trailing ` · …` segments that carry no reset (2.1.316 appends
  // ` · progress saved` after the zone), so the zone anchor below still holds.
  let head = text.trim();
  for (;;) {
    const tail = /\s*[\u00b7\u2219]\s*([^\u00b7\u2219]*)$/.exec(head);
    if (!tail || /\bresets\b/i.test(tail[1])) break;
    head = head.slice(0, tail.index).trimEnd();
  }
  const m = /(?:\u00b7|\u2219|-)\s*resets\s+(.+?)\s*(?:\(([^)]+)\))?\s*$/i.exec(head);
  if (!m) return null;
  const when = m[1].trim();
  const tz = (m[2] || "").trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const t =
    /^(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(?:(\d{4}),\s*)?)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?$/i.exec(
      when,
    );
  if (!t) return null;
  let hour = parseInt(t[4], 10);
  const minute = t[5] ? parseInt(t[5], 10) : 0;
  if (hour < 1 || hour > 12 || minute > 59) return null;
  hour = (hour % 12) + (t[6].toLowerCase() === "p" ? 12 : 0);
  try {
    if (t[1]) {
      const mo = MONTHS.indexOf(t[1].toLowerCase());
      const day = parseInt(t[2], 10);
      if (mo < 0 || day < 1 || day > 31) return null;
      const today = zonedToday(nowMs, tz);
      let y = t[3] ? parseInt(t[3], 10) : today.y;
      let at = zonedToUtcMs(y, mo, day, hour, minute, tz);
      // "Oct 9" with no year that is already well past → next year's Oct 9.
      if (!t[3] && at < nowMs - 86_400_000) at = zonedToUtcMs(++y, mo, day, hour, minute, tz);
      return at;
    }
    const today = zonedToday(nowMs, tz);
    let at = zonedToUtcMs(today.y, today.mo, today.d, hour, minute, tz);
    if (at <= nowMs) at = zonedToUtcMs(today.y, today.mo, today.d + 1, hour, minute, tz);
    return at;
  } catch {
    return null; // unknown time zone
  }
}

/** A `retry-after: N` / `retry after N seconds` hint in the text → epoch ms, or null. */
export function parseRetryAfter(text, nowMs = Date.now()) {
  if (typeof text !== "string") return null;
  const m = /retry[-_ ]after["':\s]*(\d{1,7})/i.exec(text);
  if (!m) return null;
  const s = parseInt(m[1], 10);
  return Number.isFinite(s) && s > 0 ? nowMs + s * 1000 : null;
}

/**
 * Classify a parsed envelope as a usage-limit / rate-limit outcome, or null.
 *   → { kind: "usage_limit"|"rate_limit", id, message, resetsAtMs: number|null,
 *       resetBasis: "clock"|"epoch"|"retry-after"|null }
 * `message` is the matched text (≤300 chars) so the event and the status line can
 * quote what the CLI said. `resetsAtMs` is null when no reset could be read.
 */
export function detectUsageLimit(json, nowMs = Date.now()) {
  if (!json || typeof json !== "object") return null;
  // A command worker's envelope is written by the worker program, not a CLI the runner
  // knows: it never releases a ticket attempt-free (normalizeCommandEnvelope).
  if (isCommandEnvelope(json)) return null;
  const isErr = isErrorEnvelope(json);
  // Structural shapes are typed fields the SDK / API set, not prose, so they need no
  // error-envelope gate of their own beyond what each row checks.
  for (const s of USAGE_LIMIT_SHAPES) {
    if (s.test(json)) {
      const msg =
        (json.error && typeof json.error === "object" && typeof json.error.message === "string"
          ? json.error.message
          : typeof json.result === "string"
            ? json.result
            : "") || s.id;
      const ra = parseRetryAfter(msg, nowMs);
      return {
        kind: s.kind,
        id: s.id,
        message: msg.slice(0, 300),
        resetsAtMs: ra,
        resetBasis: ra == null ? null : "retry-after",
      };
    }
  }
  const texts = [];
  if (typeof json.result === "string") texts.push(json.result.trim());
  if (Array.isArray(json.errors)) {
    for (const e of json.errors) if (typeof e === "string") texts.push(e.trim());
  }
  for (const text of texts) {
    for (const p of USAGE_LIMIT_PATTERNS) {
      if (!isErr) continue;
      const m = p.re.exec(text);
      if (!m) continue;
      let resetsAtMs = null;
      if (p.reset === "clock") resetsAtMs = parseResetClock(text, nowMs);
      else if (p.reset === "epoch") resetsAtMs = parseInt(m[1], 10) * 1000;
      else if (p.reset === "retry-after") resetsAtMs = parseRetryAfter(text, nowMs);
      if (!Number.isFinite(resetsAtMs)) resetsAtMs = null;
      return {
        kind: p.kind,
        id: p.id,
        message: text.slice(0, 300),
        resetsAtMs,
        resetBasis: resetsAtMs == null ? null : p.reset,
      };
    }
  }
  return null;
}

// =====================================================================
// AUTH ERRORS — the CLI could not authenticate (logged out, a bad or expired key).
// The agent never ran, so the runner releases the claim WITHOUT counting an attempt
// and stops the run with a /login hint (exploratory finding fresh-user/F-06): read as
// an ordinary failure it went through the no-commit counter and parked good tickets.
// Gated on an ERROR envelope like the usage-limit rows (the agent controls a success
// envelope's text), and anchored at the start of the text. Add a row (and a fixture
// in test/auth-gate.test.sh) when the CLI changes a string; never loosen one.
// =====================================================================
export const AUTH_ERROR_PATTERNS = Object.freeze([
  { id: "cc-invalid-api-key", re: /^Invalid API key(?=$|\s|\u00b7|\.)/ },
  { id: "cc-not-logged-in", re: /^Not logged in(?=$|\s|\u00b7|\.)/ },
  { id: "cc-oauth-expired", re: /^OAuth token has expired(?=$|\s|\.)/ },
  { id: "cc-api-401", re: /^API Error: 401(?=$|\s)/ },
  {
    id: "cc-auth-failed",
    re: /^(?:API Error: )?(?:Failed to authenticate|Authentication failed)(?=$|\s|\.|:)/,
  },
]);

/**
 * Classify a parsed envelope as an authentication failure, or null.
 *   → { id, message }  (message ≤300 chars, quoted in the log and the release reason)
 */
export function detectAuthError(json) {
  if (!json || typeof json !== "object" || !isErrorEnvelope(json)) return null;
  if (isCommandEnvelope(json)) return null; // see detectUsageLimit
  // A turn-cap stop means the agent ran for its turns: whatever text the envelope
  // carries is the agent's, never the CLI's login failure (it must not dodge the cap).
  if (json.subtype === "error_max_turns") return null;
  if (json.error && typeof json.error === "object" && json.error.type === "authentication_error") {
    const m = typeof json.error.message === "string" ? json.error.message : "authentication_error";
    return { id: "api-authentication-error", message: m.slice(0, 300) };
  }
  const texts = [];
  if (typeof json.result === "string") texts.push(json.result.trim());
  if (Array.isArray(json.errors)) {
    for (const e of json.errors) if (typeof e === "string") texts.push(e.trim());
  }
  for (const text of texts) {
    for (const p of AUTH_ERROR_PATTERNS) {
      if (p.re.test(text)) return { id: p.id, message: text.slice(0, 300) };
    }
  }
  return null;
}

/**
 * THE seam: parse a captured `--output-format json` envelope into the things every
 * caller needs — the agent text, the usage signals, the cap signals, the stop
 * reason, and whether the call was refused by a usage window / rate limit
 * (`usageLimit`, see detectUsageLimit; null for every ordinary result). `json` is
 * included for callers that still shape their own record.
 */
export function parseResult(text, { nowMs = Date.now() } = {}) {
  const json = parseClaudeJson(text);
  return {
    json,
    resultText: extractResultText(json),
    usage: extractUsage(json),
    capHit: extractCapSignals(json),
    stopReason: extractStopReason(json),
    usageLimit: detectUsageLimit(json, nowMs),
  };
}

export const Worker = {
  deliver,
  parseResult,
  parseCommandEnvelope,
  normalizeCommandEnvelope,
  workerProvider,
  unsupportedProviderMessage,
  commandWorkerConfig,
  commandContainmentProblem,
  commandCostFloorUsd,
  sandboxWanted,
  sandboxRequired,
  sandboxProvider,
  sandboxWrapArgv,
  mcpBridgeOn,
  startMcpBridge,
};

// =====================================================================
// CLI — the bash worker (delivery-recovery.sh) reads cap/spend through this so the
// SAME parseResult drives both runtimes. One field per call, emitted in the EXACT
// legacy format the bash guards expected (behavioural parity):
//   node lib/worker.mjs parse-result num-turns            --json-file <f>
//        → prints the integer num_turns (nothing when absent); exit 0
//   node lib/worker.mjs parse-result spend                --json-file <f>
//        → prints "$<total_cost_usd.toFixed(4)>" or "unknown"; exit 0
//   node lib/worker.mjs parse-result stopreason-maxturns  --json-file <f>
//        → exit 0 iff a max-turns stop reason is present, else exit 1
//   node lib/worker.mjs parse-result stopreason-budget    --json-file <f>
//        → exit 0 iff the run stopped on its --max-budget-usd cap, else exit 1
//   node lib/worker.mjs parse-result result-text          --json-file <f>
//        → prints the model's reply text (empty when absent); exit 0
//   node lib/worker.mjs parse-result usage-limit          --json-file <f>
//        → prints the detectUsageLimit JSON and exits 0 on a usage/rate-limit
//          outcome; prints nothing and exits 1 otherwise
//   node lib/worker.mjs parse-result auth-error           --json-file <f>
//        → prints the detectAuthError message and exits 0 on an auth failure;
//          prints nothing and exits 1 otherwise
// =====================================================================
function readFileSafe(f) {
  try {
    return readFileSync(f, "utf8");
  } catch {
    return "";
  }
}

function parseResultCli(argv) {
  const field = argv[1];
  let jsonFile = null;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--json-file") jsonFile = argv[++i];
  }
  const parsed = parseResult(jsonFile ? readFileSafe(jsonFile) : "");
  if (field === "num-turns") {
    const nt = parsed.capHit.numTurns;
    if (typeof nt === "number" && Number.isFinite(nt)) process.stdout.write(String(nt));
    process.exit(0);
  }
  if (field === "spend") {
    const c = parsed.usage.totalCostUsd;
    if (typeof c === "number" && Number.isFinite(c)) process.stdout.write("$" + c.toFixed(4));
    else process.stdout.write("unknown");
    process.exit(0);
  }
  if (field === "stopreason-maxturns") {
    process.exit(parsed.capHit.stopReasonIsMaxTurns ? 0 : 1);
  }
  if (field === "stopreason-budget") {
    process.exit(
      stopReasonIsBudget(parseClaudeJson(jsonFile ? readFileSafe(jsonFile) : "")) ? 0 : 1,
    );
  }
  if (field === "usage-limit") {
    if (!parsed.usageLimit) process.exit(1);
    process.stdout.write(JSON.stringify(parsed.usageLimit));
    process.exit(0);
  }
  if (field === "auth-error") {
    const a = detectAuthError(parseClaudeJson(jsonFile ? readFileSafe(jsonFile) : ""));
    if (!a) process.exit(1);
    process.stdout.write(a.message);
    process.exit(0);
  }
  if (field === "result-text") {
    // The model's reply text from the envelope (empty when absent/unparseable).
    // Used by the eval judge to feed the reply into deliveryJudgeCli --mode parse.
    if (typeof parsed.resultText === "string") process.stdout.write(parsed.resultText);
    process.exit(0);
  }
  process.exit(2); // unknown field
}

// Run as a CLI when invoked directly — compared by real path too, so a symlinked
// runner dir (a test's fake runner, a packaged install) still reaches the CLI instead
// of silently exiting 0 with no output (which `parse-result usage-limit` callers would
// otherwise have to guess about).
function invokedDirectly() {
  if (!process.argv[1]) return false;
  if (import.meta.url === `file://${process.argv[1]}`) return true;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
// `node lib/worker.mjs normalize-command-envelope --in <raw stdout> --out <envelope>`:
// the bash seam's call into the command provider's parser adapter. Writes the
// canonical envelope (or an empty file when the raw stdout held no JSON object).
// --per-call-usd / --explicit-floor / --kill-floor feed commandCostFloorUsd (the bash
// seam passes the call's dollar cap and the two knobs; an unset knob is passed as "").
// Only the LAST 16 MiB of the raw stdout are read (the envelope is the last object, the
// same bound the Node launchers' maxBuffer puts on it), so a runaway worker's output
// cannot exhaust the parser.
const COMMAND_STDOUT_TAIL_BYTES = 16 * 1024 * 1024;
function readTail(f, max) {
  let fd;
  try {
    fd = openSync(f, "r");
    const size = fstatSync(fd).size;
    const len = Math.min(size, max);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
function normalizeCli(argv) {
  let inFile = null;
  let outFile = null;
  const floor = { explicit: "", perCall: "", killFloor: "" };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--in") inFile = argv[++i];
    else if (argv[i] === "--out") outFile = argv[++i];
    else if (argv[i] === "--explicit-floor") floor.explicit = argv[++i];
    else if (argv[i] === "--per-call-usd") floor.perCall = argv[++i];
    else if (argv[i] === "--kill-floor") floor.killFloor = argv[++i];
  }
  if (!inFile || !outFile) process.exit(2);
  const norm = normalizeCommandEnvelope(readTail(inFile, COMMAND_STDOUT_TAIL_BYTES), {
    costFloorUsd: commandCostFloorUsd(floor),
  });
  writeFileSync(outFile, norm ? norm + "\n" : "");
  process.exit(0);
}

// `node lib/worker.mjs command-worker-check --write-roots <roots> --cwd <dir>`: the bash
// seam's (and preflight's) call into commandWorkerConfig — prints the program on
// stdout and exits 0, or prints the refusal on stderr and exits 1.
function commandCheckCli(argv) {
  const o = { writeRoots: "", cwd: "" };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--write-roots") o.writeRoots = argv[++i] ?? "";
    else if (argv[i] === "--cwd") o.cwd = argv[++i] ?? "";
  }
  const c = commandWorkerConfig(process.env, o);
  if (!c.ok) {
    process.stderr.write(c.message + "\n");
    process.exit(1);
  }
  process.stdout.write(c.command);
  process.exit(0);
}

// `node lib/worker.mjs command-containment [--mcp-config <f>]`: prints why the command
// worker may not launch under this configuration (the refusal sentence) and exits 1,
// or exits 0 when it may. `command-refusal <why>` prints one refusal sentence.
function commandContainmentCli(argv) {
  let mcp = "";
  for (let i = 1; i < argv.length; i++) if (argv[i] === "--mcp-config") mcp = argv[++i] ?? "";
  const why = commandContainmentProblem(process.env, {
    hasMcpServers: mcp ? mcpConfigHasServers(mcp) : true,
  });
  if (!why) process.exit(0);
  process.stdout.write(commandSandboxRefusalMessage(why) + "\n");
  process.exit(1);
}

if (invokedDirectly()) {
  const argv = process.argv.slice(2);
  if (argv[0] === "parse-result") parseResultCli(argv);
  else if (argv[0] === "normalize-command-envelope") normalizeCli(argv);
  else if (argv[0] === "command-worker-check") commandCheckCli(argv);
  else if (argv[0] === "command-containment") commandContainmentCli(argv);
  else if (argv[0] === "command-refusal") {
    process.stdout.write(commandSandboxRefusalMessage(argv[1]) + "\n");
    process.exit(0);
  } else process.exit(2);
}

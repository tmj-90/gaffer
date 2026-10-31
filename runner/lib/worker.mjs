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

import { spawn, spawnSync } from "node:child_process";
import { BUDGET_REFUSED_STATUS, paidLaunchAdmission } from "./budget-admission.mjs";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import { platform } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RUNNER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const UNKNOWN = "unknown";

// ── PROVIDER DISPATCH (Spec 3 / Phase 3 — SEAM ONLY, honest fail-closed stubs) ──
// The mjs runners (decompose, product-owner) pick their worker backend the same
// way the bash seam (worker.sh) and the sandbox seam (sandbox.sh) do: on an env
// var, defaulting to the one real provider. `claude-code` is BYTE-IDENTICAL to the
// historical spawn; any other provider FAILS CLOSED (no spawn) because the
// PreToolUse containment hook is Claude-Code-native — a non-Claude worker has no
// in-process boundary. See worker.sh's header and SECURITY.md for the full reason.
export const DEFAULT_WORKER_PROVIDER = "claude-code";

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

/** True when the OS sandbox is REQUIRED (GAFFER_STRICT_REQUIRE on) — sandbox.sh's `_sandbox_strict_required`. */
export function sandboxRequired(env = process.env) {
  const v = String(env.GAFFER_STRICT_REQUIRE ?? "0")
    .trim()
    .toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
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
      'source "$0/lib/sandbox.sh" && sandbox_wrap_cmd "$1" "$2"',
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
      message:
        "worker: GAFFER_STRICT_REQUIRE demands an OS sandbox and none is available on this host — refusing to spawn the agent (fail closed)" +
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
  if (provider !== DEFAULT_WORKER_PROVIDER) {
    // codex / local / any non-Claude provider — honest stub, FAIL CLOSED. No spawn.
    return failClosedResult(unsupportedProviderMessage(provider));
  }
  // BUDGET ADMISSION (external review #6): the ONE check every paid launch passes
  // immediately before it spawns (lib/budget-admission.mjs; the bash seam asks the same
  // module). Daily or lifetime budget exhausted, or the spend unknowable with a cap set
  // ⇒ NO spawn: status 77, empty stdout, nothing booked to the ledger.
  const admission = paidLaunchAdmission({ kind, env: process.env });
  if (!admission.ok) {
    const r = failClosedResult(admission.reason);
    r.status = BUDGET_REFUSED_STATUS;
    r.budgetRefused = true;
    process.stderr.write(`worker: ${admission.reason}\n`);
    return r;
  }
  // claude-code — the current path. With the sandbox off and no dollar cap configured
  // this is byte-identical. An opted-in per-call cap (GAFFER_MAX_CALL_USD, clamped to
  // GAFFER_BUDGET_REMAINING) bounds THIS call while it runs, not only between calls.
  argv = withCallBudget(argv, process.env);
  let spawnBin = bin;
  let spawnArgv = argv;
  let spawnEnv = env;
  let bridgeStop = () => {};
  if (sandboxWanted(process.env)) {
    // Derive the wrap from the per-call boundary vars (the cwd is the write root
    // when none is named), exactly like worker_deliver's WORKER_CALL_ENV scan.
    const writeRoots = (env && env.GAFFER_WRITE_ROOTS) || cwd;
    const readRoots = (env && env.GAFFER_READ_ROOTS) || "";
    const wrapped = sandboxWrapArgv({ writeRoots, readRoots, env: process.env });
    if (!wrapped.ok) {
      // FAIL CLOSED: a required sandbox the host cannot supply means NO spawn —
      // status 75, empty stdout (no fabricated envelope), error set so callers'
      // existing error paths fire. Never a silent bare run.
      const r = failClosedResult(wrapped.message);
      r.status = SANDBOX_REFUSED_STATUS;
      return r;
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
        ...env,
      };
      // Inside the `docker` provider the HOST's claude path / HOME / PATH do not
      // exist — the image ships `claude` on its own PATH and root's HOME is /root.
      // Substitute ONLY when a docker wrap is active, and only for the command
      // INSIDE the container (an `env HOME=… PATH=… claude` prefix, the shape the
      // bash seam's `env -i … HOME= PATH= claude` takes) — the wrapper script itself
      // still runs with the host PATH so it can find `docker`.
      let inner = [spawnBin, ...argv];
      if ((process.env.SANDBOX_PROVIDER || "sandbox-exec") === "docker") {
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
            return r;
          }
          bridgeStop = b.stop;
          if (b.dataPlane === "bridge") {
            spawnEnv = { ...spawnEnv, GAFFER_MCP_BRIDGE_SOCKET: b.socket };
            agentArgv = argv.map((a, k) => (k === i + 1 ? b.bridgedConfig : a));
          } else {
            spawnEnv = { ...spawnEnv, GAFFER_SANDBOX_DATA_PLANE: "none" };
          }
        }
        inner = [
          "env",
          `HOME=${process.env.GAFFER_SANDBOX_HOME || "/root"}`,
          `PATH=${process.env.GAFFER_SANDBOX_PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}`,
          process.env.GAFFER_SANDBOX_CLAUDE_BIN || "claude",
          ...agentArgv,
        ];
      }
      spawnArgv = [...wrapped.wrap.slice(1), ...inner];
      spawnBin = wrapped.wrap[0];
    }
  }
  try {
    return spawnSync(spawnBin, spawnArgv, {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer,
      env: spawnEnv,
    });
  } finally {
    bridgeStop(); // the host-side servers, the socket and the bridged config go with the agent
  }
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
  workerProvider,
  unsupportedProviderMessage,
  sandboxWanted,
  sandboxRequired,
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
if (invokedDirectly()) {
  const argv = process.argv.slice(2);
  if (argv[0] === "parse-result") parseResultCli(argv);
  else process.exit(2);
}

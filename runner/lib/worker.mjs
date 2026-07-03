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
//   parseResult(text) -> { json, resultText, usage, capHit, stopReason }
//     resultText — the agent's `.result` text ("" when absent/unparseable)
//     usage      — { models, topLevelUsage, totalCostUsd, numTurns, durationMs }
//                  (tokens verbatim; dollars RELAYED, never computed — see honesty
//                   rules in usage-ledger.mjs, which shapes these into a ledger row)
//     capHit     — { numTurns, stopReasonIsMaxTurns } (turn-cap detection signals)
//     stopReason — the stop/finish reason string, or null
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

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

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

export function deliver({ bin, argv, cwd, timeoutMs, maxBuffer, env }) {
  const provider = workerProvider(process.env);
  if (provider !== DEFAULT_WORKER_PROVIDER) {
    // codex / local / any non-Claude provider — honest stub, FAIL CLOSED. No spawn.
    return failClosedResult(unsupportedProviderMessage(provider));
  }
  // claude-code — the current path, byte-identical.
  return spawnSync(bin, argv, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer,
    env,
  });
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

/**
 * THE seam: parse a captured `--output-format json` envelope into the four things
 * every caller needs — the agent text, the usage signals, the cap signals, and the
 * stop reason. `json` is included for callers that still shape their own record.
 */
export function parseResult(text) {
  const json = parseClaudeJson(text);
  return {
    json,
    resultText: extractResultText(json),
    usage: extractUsage(json),
    capHit: extractCapSignals(json),
    stopReason: extractStopReason(json),
  };
}

export const Worker = { deliver, parseResult, workerProvider, unsupportedProviderMessage };

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
  process.exit(2); // unknown field
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  if (argv[0] === "parse-result") parseResultCli(argv);
  else process.exit(2);
}

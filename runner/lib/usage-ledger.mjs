#!/usr/bin/env node
/**
 * Gaffer factory — honest USAGE LEDGER for headless `claude -p` agent calls.
 *
 * Mirrors the safety-block ledger discipline (safety-hook.mjs's logBlock + the
 * run-summary "safety" section): best-effort, gated on GAFFER_DATA, fully
 * swallowed, run-scoped. A ledger failure must NEVER fail or alter a tick — the
 * live delivery path is paramount.
 *
 * GROUND TRUTH: `claude -p "<prompt>" --output-format json` returns a JSON
 * result object carrying the real usage the API reported:
 *   usage.{input_tokens,output_tokens,cache_creation_input_tokens,cache_read_input_tokens}
 *   modelUsage : { <model>: { inputTokens, outputTokens, cacheReadInputTokens,
 *                             cacheCreationInputTokens, costUSD, ... } }
 *   total_cost_usd, num_turns, duration_ms, result (the agent's text)
 *
 * HONESTY RULES (the entire point — enforced here, not just documented):
 *   1. TOKENS are reported as ground truth, exactly as the API returned them.
 *   2. DOLLARS are RELAYED from Claude Code's own total_cost_usd / modelUsage[*].costUSD.
 *      We NEVER compute cost from a price table. The figure is labelled (in the
 *      report) "API-equivalent cost (Claude Code's own figure)" with a note that
 *      on a Max/Pro plan the marginal cost is the flat fee, not this number.
 *   3. If a call cannot be measured (timeout, crash, JSON missing/unparseable,
 *      no usage field), every numeric field is recorded as the STRING "unknown"
 *      — never 0, never inferred — and `measured:false` so the report can show
 *      measured-vs-unknown counts. A partial run can never read as "cheap".
 *
 * Two entrypoints:
 *   • Library  — import { parseClaudeJson, buildUsageRecord, extractResultText,
 *                appendUsageRecord } for the .mjs call sites (decompose,
 *                product-owner) and the tests.
 *   • CLI      — `node lib/usage-ledger.mjs --kind <kind> [--ticket N]
 *                [--rc <exitcode>] [--json-file <path>]`
 *                reads the captured claude stdout (a --output-format json blob)
 *                from --json-file or stdin, prints the agent's `.result` TEXT to
 *                stdout (so the bash caller can keep the human-readable log), and
 *                appends one ledger record. Used by tick.sh's bash call sites.
 */
import { appendFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const UNKNOWN = "unknown";
export const LEDGER_FILENAME = "usage-ledger.jsonl";
export const VALID_KINDS = new Set([
  "delivery",
  "clarify",
  "bootstrap",
  "review",
  "decompose",
  "product-owner",
  "onboard",
]);

/**
 * Parse the captured stdout of `claude -p … --output-format json`.
 * Returns the result OBJECT, or null when the text is missing/unparseable.
 *
 * Tolerant by design: a JSON object may be the whole stdout, or be embedded in
 * other log noise (the bash sites capture only stdout, but be defensive). We try
 * a strict whole-string parse first, then fall back to the LAST balanced
 * top-level `{...}` block in the text (the final result object). Anything we
 * cannot parse → null → the caller records "unknown" (never 0).
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
  // Scan for the last balanced top-level { … } object in the text.
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
 * value to 0 — that would let an unmeasured call read as free. null/undefined/
 * NaN/non-number all become "unknown".
 */
function numOrUnknown(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return UNKNOWN;
}

/**
 * Build the per-model usage map from a parsed result object, honouring honesty
 * rule 1 (tokens verbatim) and rule 2 (cost relayed, never computed). Each model
 * entry carries input/output/cache_read/cache_create (from modelUsage's camelCase
 * fields) and cost_usd (Claude Code's own costUSD for that model). A field the
 * payload didn't carry is "unknown", not 0.
 *
 * Returns null when there is no usable modelUsage object (caller may still have
 * top-level usage to fall back on, but the per-model split is then unknown).
 */
function buildModels(json) {
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
 * Construct a fully-"unknown" record — used when a call could not be measured
 * (timeout / crash / no JSON / no usage). Honesty rule 3: every numeric field is
 * the string "unknown", measured:false. We still stamp ts/ticket/kind/reason so
 * the report can count it as an UNMEASURED tick (never silently dropped).
 */
export function unknownRecord({ ts, ticket, kind, reason }) {
  return {
    ts: ts || new Date().toISOString(),
    ticket: ticket ?? null,
    kind: kind || null,
    measured: false,
    unknown_reason: reason || "unmeasurable (no usage data)",
    models: UNKNOWN,
    total_cost_usd: UNKNOWN,
    num_turns: UNKNOWN,
    duration_ms: UNKNOWN,
  };
}

/**
 * Build a ledger record from a parsed claude JSON result object. Applies all
 * three honesty rules. When `json` has no usable usage signal at all (no
 * modelUsage AND no top-level usage AND no total_cost_usd), we return an
 * unknownRecord rather than a record full of zeros.
 */
export function buildUsageRecord({ json, ts, ticket, kind, reason }) {
  if (!json || typeof json !== "object") {
    return unknownRecord({ ts, ticket, kind, reason: reason || "no parseable result JSON" });
  }
  const models = buildModels(json);
  const usage = json.usage && typeof json.usage === "object" ? json.usage : null;
  const totalCost = numOrUnknown(json.total_cost_usd);
  const numTurns = numOrUnknown(json.num_turns);
  const durationMs = numOrUnknown(json.duration_ms);

  // No usage signal whatsoever → treat as unmeasured (honesty rule 3): do not
  // emit an all-zero record that would read as a free call.
  const hasAnySignal =
    models !== null ||
    usage !== null ||
    totalCost !== UNKNOWN ||
    numTurns !== UNKNOWN ||
    durationMs !== UNKNOWN;
  if (!hasAnySignal) {
    return unknownRecord({
      ts,
      ticket,
      kind,
      reason: reason || "result JSON carried no usage block",
    });
  }

  // If modelUsage is absent but top-level usage exists, synthesise a single
  // "(unknown-model)" entry from the top-level token counts so the report can
  // still sum tokens. Cost stays "unknown" here (top-level usage carries no
  // per-model cost; total_cost_usd is reported separately and verbatim).
  let modelMap = models;
  if (modelMap === null && usage !== null) {
    modelMap = {
      "(unknown-model)": {
        input: numOrUnknown(usage.input_tokens),
        output: numOrUnknown(usage.output_tokens),
        cache_read: numOrUnknown(usage.cache_read_input_tokens),
        cache_create: numOrUnknown(usage.cache_creation_input_tokens),
        cost_usd: UNKNOWN,
      },
    };
  }

  return {
    ts: ts || new Date().toISOString(),
    ticket: ticket ?? null,
    kind: kind || null,
    measured: true,
    models: modelMap || UNKNOWN,
    // RELAYED — Claude Code's own aggregate figure. Never computed from a price table.
    total_cost_usd: totalCost,
    num_turns: numTurns,
    duration_ms: durationMs,
  };
}

/**
 * Append one record to $GAFFER_DATA/usage-ledger.jsonl (or GAFFER_USAGE_LEDGER when
 * set — mirrors GAFFER_BLOCK_LEDGER). Gated on GAFFER_DATA so the test harness
 * (which doesn't set it) is unaffected, and NON-FATAL so a logging failure can never
 * fail or alter a tick. Returns true on a best-effort write, false if gated off or
 * the append threw.
 *
 * R-4: a gated-off return (no path resolvable) is intentional and stays silent. But
 * once a path IS resolved, an append that THROWS (unwritable dir, full disk, perms)
 * is a real MEASUREMENT GAP — cost goes unrecorded with no signal, so a partial run
 * could read as "cheap". We emit a clear WARNING to stderr (which the tick.sh call
 * site routes to the factory log) so the gap is VISIBLE, while still swallowing the
 * error and returning false — the live delivery path is never affected.
 */
export function appendUsageRecord(record, env = process.env) {
  const explicit = env.GAFFER_USAGE_LEDGER;
  let path = explicit;
  if (!path) {
    const dir = env.GAFFER_DATA;
    if (!dir) return false; // gated: no GAFFER_DATA, no ledger (silent, intentional)
    path = join(dir, LEDGER_FILENAME);
  }
  try {
    appendFileSync(path, JSON.stringify(record) + "\n");
    return true;
  } catch (err) {
    // Non-fatal, but NOT silent: a measurement gap must be visible to the operator.
    const ticket = record && record.ticket != null ? ` (ticket #${record.ticket})` : "";
    const reason = (err && err.message) || String(err);
    process.stderr.write(
      `WARNING: usage-ledger append FAILED${ticket} — cost for this call goes ` +
        `UNMEASURED (path: ${path}): ${reason}\n`,
    );
    return false;
  }
}

// =====================================================================
// CLI — used by tick.sh's bash call sites.
//   node lib/usage-ledger.mjs --kind delivery --ticket 42 --rc 0 \
//        --json-file /tmp/claude-out.json
// Reads the captured `--output-format json` stdout (from --json-file or stdin),
// PRINTS the agent's `.result` text to stdout (so bash keeps a human-readable
// log line), and appends one ledger record. Never exits non-zero on a ledger
// problem — the tick must not be affected.
// =====================================================================
function parseCliArgs(argv) {
  const out = { kind: null, ticket: null, rc: null, jsonFile: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--kind") out.kind = argv[++i];
    else if (a === "--ticket") out.ticket = argv[++i];
    else if (a === "--rc") out.rc = argv[++i];
    else if (a === "--json-file") out.jsonFile = argv[++i];
  }
  return out;
}

function readInput(jsonFile) {
  try {
    if (jsonFile) return readFileSync(jsonFile, "utf8");
    return readFileSync(0, "utf8"); // stdin
  } catch {
    return "";
  }
}

function cliMain(argv) {
  const args = parseCliArgs(argv);
  const ticket =
    args.ticket && /^\d+$/.test(String(args.ticket)) ? Number(args.ticket) : args.ticket || null;
  const kind = VALID_KINDS.has(args.kind) ? args.kind : args.kind || null;
  const rcNum = args.rc != null ? parseInt(args.rc, 10) : NaN;
  const raw = readInput(args.jsonFile);

  const json = parseClaudeJson(raw);
  // ALWAYS print the agent's text so the bash caller can append it to $GAFFER_LOG
  // and preserve the human-readable log (the delivery path is unchanged).
  const resultText = extractResultText(json);
  if (resultText) process.stdout.write(resultText);

  // Decide measured vs unknown honestly. A non-zero rc (timeout=124, crash) or an
  // unparseable/usage-less JSON → unknown record (never 0).
  let record;
  if (Number.isFinite(rcNum) && rcNum !== 0) {
    record = unknownRecord({
      ticket,
      kind,
      reason: rcNum === 124 ? "claude call timed out (rc=124)" : `claude call exited rc=${rcNum}`,
    });
  } else if (json === null) {
    record = unknownRecord({ ticket, kind, reason: "no parseable --output-format json on stdout" });
  } else {
    record = buildUsageRecord({ json, ticket, kind });
  }
  appendUsageRecord(record);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cliMain(process.argv.slice(2));
}

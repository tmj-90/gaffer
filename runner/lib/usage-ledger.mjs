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
import { resolveLedgerPath } from "./usage-ledger-path.mjs";

// Spec 3 / Phase 2: the claude-JSON envelope schema is owned by the worker seam.
// This module keeps the LEDGER-RECORD shaping + honesty rules, but the raw parse +
// numeric extraction come from lib/worker.mjs so a ledger row and the worker's
// parseResult can never disagree. The public names below are RE-EXPORTED so existing
// importers (tests, decompose.mjs, product-owner-run.mjs) are unchanged.
import {
  UNKNOWN,
  detectUsageLimit,
  extractResultText,
  extractUsage,
  numOrUnknown,
  parseClaudeJson,
} from "./worker.mjs";

export { UNKNOWN, extractResultText, parseClaudeJson };
// The ledger path is resolved in ONE place, shared with the paid-launch admission check.
export { LEDGER_FILENAME, resolveLedgerPath } from "./usage-ledger-path.mjs";
export const VALID_KINDS = new Set([
  "delivery",
  "clarify",
  "bootstrap",
  "review",
  "security-review",
  "tester",
  "decompose",
  "product-owner",
  "onboard",
  // The post-delivery quality judge's model turn (lib/eval-judge.sh) — paid work
  // that must count toward the day-USD cap and the cost tiles like any other call.
  "eval-judge",
  // The merge-conflict resolver agent (bin/merge-ticket.mjs) — spawned when a landing
  // conflicts; paid work that counts toward the caps like any other call.
  "merge-resolver",
  // Booked by bin/spec-author.mjs and the onboarding card-review gate
  // (lib/onboard-analyze.mjs) but missing here, so `estimate-usage --kind` refused them.
  "spec-author",
  "onboard-review",
  // The ambiguous-sibling repo classifier (bin/inherit-repo.mjs via lib/greenfield.sh).
  "inherit",
]);

// parseClaudeJson / extractResultText / the numeric extractors (numOrUnknown,
// buildModels, extractUsage) now live in lib/worker.mjs (the seam that owns the
// claude-JSON schema — Spec 3 / Phase 2). They are imported + re-exported above;
// buildUsageRecord below shapes extractUsage's output into a ledger row.

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
 * Budget honesty for a KILLED / TIMED-OUT call (Part A). A `claude -p` that is
 * SIGALRM'd (rc=124), TERM'd (143), INT'd (130) or otherwise crashes emits no
 * clean result envelope — so today its cost lands as "unknown", which every spend
 * summation skips, i.e. it books $0. An unattended run that keeps timing out then
 * looks FREE while it is really burning tokens. This record fixes that gap without
 * ever pretending the call was measured:
 *   - `measured` stays FALSE and `total_cost_usd` stays "unknown" — nothing was
 *     measured, and estimate.mjs's isMeasuredRow still drops the row so token
 *     PREDICTIONS remain built only on real measured history.
 *   - `estimated:true` + `estimated_cost_usd:<number>` make it a first-class,
 *     clearly-labelled ESTIMATE that the windowed-spend summations DO count.
 *   - `estimate_basis` documents how the number was derived so the ledger is
 *     self-explaining ("history-rate", "history-p10" or "flat-floor").
 * A non-positive / non-finite estimate falls back to a plain unknownRecord — that
 * is the opt-out (GAFFER_KILL_ESTIMATE_USD=0 with no usable history) and preserves
 * today's $0/unknown behaviour exactly.
 */
export function estimatedRecord({ ts, ticket, kind, reason, estimateUsd, basis }) {
  const usd = typeof estimateUsd === "number" && Number.isFinite(estimateUsd) ? estimateUsd : NaN;
  if (!(usd > 0)) return unknownRecord({ ts, ticket, kind, reason });
  return {
    ...unknownRecord({ ts, ticket, kind, reason }),
    // NEVER measured — this is an explicit, conservative ESTIMATE, not a reading.
    estimated: true,
    estimated_cost_usd: usd,
    estimate_basis: basis || "flat-floor",
  };
}

/**
 * Conservative kill-cost estimate from the factory's OWN measured history: the
 * P10 (cheapest-decile) of measured `total_cost_usd` across prior calls of the
 * SAME kind. Rationale: a killed call did real work, and the cheapest comparable
 * MEASURED call is a defensible floor (never invents a price table). Returns null
 * when there is not enough history (< MIN_SAMPLES) so the caller falls back to the
 * flat floor. Self-contained (a tiny JSONL scan + percentile) so this module never
 * imports estimate.mjs — whose honesty contract forbids it from reading cost, and
 * which itself imports UNKNOWN from here (avoiding an import cycle).
 */
export const KILL_ESTIMATE_MIN_SAMPLES = 5;
export function killEstimateFromHistory(text, kind, minSamples = KILL_ESTIMATE_MIN_SAMPLES) {
  if (typeof text !== "string" || !text.trim()) return null;
  const costs = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue; // one corrupt line never aborts the estimate
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) continue;
    if (obj.measured !== true) continue; // only REAL measured rows ground the floor
    if (kind && obj.kind !== kind) continue;
    const c = obj.total_cost_usd;
    if (typeof c === "number" && Number.isFinite(c) && c >= 0) costs.push(c);
  }
  if (costs.length < minSamples) return null;
  costs.sort((a, b) => a - b);
  // Linear-interpolated P10 (same "type 7" convention as estimate.mjs percentile).
  const rank = 0.1 * (costs.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const p10 = lo === hi ? costs[lo] : costs[lo] + (costs[hi] - costs[lo]) * (rank - lo);
  return p10 > 0 ? p10 : null;
}

/**
 * Duration-scaled kill estimate. A call killed at the wall clock is among the
 * LONGEST calls of its kind, not the cheapest decile, so P10 badly under-books it
 * (a 30-minute killed delivery read as $0.05). From the factory's OWN measured
 * history of the same kind: the median spend RATE (total_cost_usd / duration_ms)
 * times how long the killed call ran, capped at the P90 measured cost of the kind so
 * one long hang can never book more than a costly real call did. Returns
 * { rateUsd, capUsd } or null with fewer than `minSamples` usable rows or no
 * positive elapsed time (the caller then falls back to the P10 / flat floor).
 */
export function killRateEstimateFromHistory(
  text,
  kind,
  elapsedMs,
  minSamples = KILL_ESTIMATE_MIN_SAMPLES,
) {
  if (typeof text !== "string" || !text.trim()) return null;
  if (!(typeof elapsedMs === "number" && Number.isFinite(elapsedMs) && elapsedMs > 0)) return null;
  const rates = [];
  const costs = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) continue;
    if (obj.measured !== true) continue;
    if (kind && obj.kind !== kind) continue;
    const c = obj.total_cost_usd;
    const d = obj.duration_ms;
    if (!(typeof c === "number" && Number.isFinite(c) && c >= 0)) continue;
    costs.push(c);
    if (typeof d === "number" && Number.isFinite(d) && d > 0) rates.push(c / d);
  }
  if (rates.length < minSamples) return null;
  const pct = (arr, q) => {
    const a = [...arr].sort((x, y) => x - y);
    const rank = q * (a.length - 1);
    const lo = Math.floor(rank);
    const hi = Math.ceil(rank);
    return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (rank - lo);
  };
  return { rateUsd: pct(rates, 0.5) * elapsedMs, capUsd: pct(costs, 0.9) };
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
  // Numeric extraction is the SHARED worker seam (parity with parseResult).
  const {
    models,
    topLevelUsage: usage,
    totalCostUsd: totalCost,
    numTurns,
    durationMs,
  } = extractUsage(json);

  // No usage signal whatsoever → treat as unmeasured (honesty rule 3): do not
  // emit an all-zero record that would read as a free call.
  const hasAnySignal =
    models !== null ||
    usage !== null ||
    totalCost !== UNKNOWN ||
    numTurns !== UNKNOWN ||
    durationMs !== UNKNOWN;
  if (!hasAnySignal) {
    return withUsageLimit(
      unknownRecord({
        ts,
        ticket,
        kind,
        reason: reason || "result JSON carried no usage block",
      }),
      json,
    );
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

  const rec = {
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
  return withUsageLimit(rec, json);
}

// A call the usage window / rate limit refused is labelled on its row (the SAME
// detectUsageLimit parseResult uses, so the ledger and the scheduler agree). Absent
// on every ordinary row, so existing rows and readers are unchanged.
function withUsageLimit(rec, json) {
  const limit = detectUsageLimit(json);
  if (limit) rec.usage_limit = limit.kind;
  return rec;
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
  const path = resolveLedgerPath(env);
  if (!path) return false; // gated: disabled, or no GAFFER_DATA (silent, intentional)
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
  const out = {
    kind: null,
    ticket: null,
    rc: null,
    jsonFile: null,
    killEstimate: null,
    killBasis: null,
    elapsedMs: null,
    attempt: null,
    model: null,
    claudeVersion: null,
    attemptId: null,
    startedAt: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--kind") out.kind = argv[++i];
    else if (a === "--ticket") out.ticket = argv[++i];
    else if (a === "--rc") out.rc = argv[++i];
    else if (a === "--json-file") out.jsonFile = argv[++i];
    // Part A: flat conservative USD floor booked ONLY on the killed/timeout branches
    // (measured calls ignore it). Optional --kill-basis overrides the derived basis.
    else if (a === "--kill-estimate") out.killEstimate = argv[++i];
    else if (a === "--kill-basis") out.killBasis = argv[++i];
    // How long the killed call ran — scales the estimate (deriveKillEstimate).
    else if (a === "--elapsed-ms") out.elapsedMs = argv[++i];
    // Per-attempt provenance (lib/worker.sh worker_deliver → gaffer_usage_record).
    else if (a === "--attempt") out.attempt = argv[++i];
    else if (a === "--model") out.model = argv[++i];
    else if (a === "--claude-version") out.claudeVersion = argv[++i];
    // The delivery attempt this call belongs to, and when it was spawned: lets the
    // Health report charge a correction's spend to the send-back that caused it.
    else if (a === "--attempt-id") out.attemptId = argv[++i];
    else if (a === "--started-at") out.startedAt = argv[++i];
  }
  return out;
}

/**
 * Stamp a record with its delivery attempt (`attempt_id`, e.g. `c3f9a…/2` — a hash of
 * the claim, never the claim token itself, and the attempt number within it) and the
 * call's spawn time (`started_at`). Malformed values are dropped, never guessed.
 */
export function withAttempt(record, { attemptId, startedAt } = {}) {
  const out = { ...record };
  if (typeof attemptId === "string" && /^[A-Za-z0-9._:/-]{1,96}$/.test(attemptId)) {
    out.attempt_id = attemptId;
  }
  if (typeof startedAt === "string" && !Number.isNaN(Date.parse(startedAt))) {
    out.started_at = new Date(Date.parse(startedAt)).toISOString();
  }
  return out;
}

/** A short, printable label (a model id, a CLI version): never a log dump. */
function provLabel(v) {
  if (v == null) return null;
  const s = String(v)
    .split("\n")[0]
    .replace(/[^A-Za-z0-9 ._()+:/@[\]-]/g, "")
    .trim()
    .slice(0, 80);
  return s || null;
}

/**
 * Stamp a ledger record with WHICH call it was: the delivery attempt, the model the
 * call asked for (`default` = the CLI's own default; the measured `models` map still
 * names what actually served it) and the Claude Code CLI version that ran it. Every
 * later quality metric (per model, per CLI release) keys on these. Absent inputs add
 * nothing, so older call sites write exactly the record they always did.
 */
export function withProvenance(record, { attempt, model, claudeVersion } = {}) {
  const out = { ...record };
  const n = attempt != null && /^\d+$/.test(String(attempt)) ? Number(attempt) : null;
  if (n != null && n > 0) out.attempt = n;
  const m = provLabel(model);
  if (m) out.model_requested = m;
  const v = provLabel(claudeVersion);
  if (v) out.claude_version = v;
  return out;
}

/**
 * Resolve the ledger path exactly as appendUsageRecord does (explicit
 * GAFFER_USAGE_LEDGER wins, else $GAFFER_DATA/usage-ledger.jsonl). Used to read the
 * factory's own measured history for the conservative kill-cost P10. Read is fully
 * best-effort: any resolution/IO failure returns "" so the caller degrades to the
 * flat floor — the ledger write must never block on this.
 */
function readLedgerText(env = process.env) {
  try {
    const path = resolveLedgerPath(env);
    if (!path) return "";
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * Derive the conservative kill-cost estimate for a killed/timeout record. Precedence:
 *   1. elapsed time known + enough history → max(median $/ms × elapsed, flat floor),
 *      capped at the kind's P90 measured cost (never below the floor) — "history-rate";
 *   2. the P10 of the factory's OWN measured history for this kind — "history-p10";
 *   3. the flat operator floor (--kill-estimate / GAFFER_KILL_ESTIMATE_USD) — "flat-floor".
 * A flat floor of 0 with no usable history is the opt-out. Returns
 * { estimateUsd, basis } — estimateUsd 0 means "no estimate" (the caller then writes
 * a plain unknownRecord). Fully wrapped: any failure falls through to the floor / 0.
 */
export function deriveKillEstimate({
  kind,
  killEstimate,
  killBasis,
  elapsedMs,
  env = process.env,
}) {
  const floor = killEstimate != null ? parseFloat(killEstimate) : NaN;
  const floorPos = Number.isFinite(floor) && floor > 0 ? floor : 0;
  const elapsed = elapsedMs != null && elapsedMs !== "" ? Number(elapsedMs) : NaN;
  let est = null;
  let basis = null;
  try {
    const text = readLedgerText(env);
    const rate = killRateEstimateFromHistory(text, kind, elapsed);
    if (rate) {
      const cap = Math.max(rate.capUsd, floorPos);
      const v = Math.min(Math.max(rate.rateUsd, floorPos), cap);
      if (v > 0) {
        est = v;
        basis = "history-rate";
      }
    }
    if (est == null) {
      const hist = killEstimateFromHistory(text, kind);
      if (hist != null && hist > 0) {
        est = hist;
        basis = "history-p10";
      }
    }
  } catch {
    /* history read is best-effort — fall through to the flat floor */
  }
  if (est == null && Number.isFinite(floor) && floor > 0) {
    est = floor;
    basis = "flat-floor";
  }
  if (est == null || !(est > 0)) return { estimateUsd: 0, basis: null };
  return { estimateUsd: est, basis: killBasis || basis };
}

/** The flat kill floor default when GAFFER_KILL_ESTIMATE_USD is unset (factory.config.sh parity). */
export const KILL_ESTIMATE_DEFAULT_USD = 0.05;

/**
 * Book a killed / timed-out / unparseable call from a .mjs call site — the same
 * labelled ESTIMATE the bash path books (cliMain), so a planner, spec author,
 * product owner, tester, onboarding or merge-resolver call that keeps timing out no
 * longer reads as FREE against GAFFER_DAY_USD_CAP / GAFFER_BUDGET_USD. These helpers
 * often run outside factory.config.sh, so the floor is read from
 * env.GAFFER_KILL_ESTIMATE_USD here (default 0.05; 0 opts out, leaving a plain
 * "unknown" record when there is no usable history). Never throws.
 */
export function recordKilledCall({ kind, ticket, reason, elapsedMs, env = process.env }) {
  let record;
  try {
    const raw = env.GAFFER_KILL_ESTIMATE_USD;
    const killEstimate =
      raw == null || String(raw).trim() === "" ? KILL_ESTIMATE_DEFAULT_USD : String(raw);
    const { estimateUsd, basis } = deriveKillEstimate({ kind, killEstimate, elapsedMs, env });
    record = estimatedRecord({ ticket, kind, reason, estimateUsd, basis });
  } catch {
    record = unknownRecord({ ticket, kind, reason });
  }
  return appendUsageRecord(record, env);
}

/**
 * The per-attempt AGENT-RUN evidence tick.sh attaches to the ticket after each
 * delivery attempt: which model served it (the measured `modelUsage` ids, else the
 * model the call asked for) and which Claude Code CLI ran it. Returns
 * `{ summary, payload }` — a one-line summary for the evidence list and the
 * structured payload the ticket page's attempt history reads.
 */
export function agentRunEvidence({ json, role, attempt, maxAttempts, model, claudeVersion, rc }) {
  let served = [];
  try {
    const { models } = extractUsage(json || {});
    if (models && typeof models === "object") {
      served = Object.keys(models)
        .filter((k) => k && k !== "(unknown-model)")
        .map(provLabel)
        .filter(Boolean)
        .slice(0, 4);
    }
  } catch {
    served = [];
  }
  const requested = provLabel(model) || "default";
  const version = provLabel(claudeVersion) || "unknown";
  const a = attempt != null && /^\d+$/.test(String(attempt)) ? Number(attempt) : null;
  const m = maxAttempts != null && /^\d+$/.test(String(maxAttempts)) ? Number(maxAttempts) : null;
  const code = rc != null && /^-?\d+$/.test(String(rc)) ? Number(rc) : null;
  const payload = {
    kind: "agent_run",
    role: provLabel(role) || "delivery",
    attempt: a,
    max_attempts: m,
    model_requested: requested,
    models_served: served,
    claude_version: version,
    rc: code,
  };
  const shown = served.length ? served.join(", ") : requested;
  const summary =
    `Agent run${a ? `, attempt ${a}${m ? `/${m}` : ""}` : ""}: model ${shown}` +
    `, CLI ${version}${code != null && code !== 0 ? ` (exit ${code})` : ""}`;
  return { summary, payload };
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
  // `--agent-run-evidence`: print the agent-run evidence (line 1 the summary, line 2
  // the payload JSON) for tick.sh to attach; writes NO ledger record.
  if (argv.includes("--agent-run-evidence")) {
    const a = parseCliArgs(argv.filter((x) => x !== "--agent-run-evidence"));
    const i = argv.indexOf("--max-attempts");
    const r = argv.indexOf("--role");
    const { summary, payload } = agentRunEvidence({
      json: parseClaudeJson(readInput(a.jsonFile)),
      role: r >= 0 ? argv[r + 1] : "delivery",
      attempt: a.attempt,
      maxAttempts: i >= 0 ? argv[i + 1] : null,
      model: a.model,
      claudeVersion: a.claudeVersion,
      rc: a.rc,
    });
    process.stdout.write(summary + "\n" + JSON.stringify(payload) + "\n");
    return;
  }
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
  // unparseable/usage-less JSON → the call was KILLED with no usage envelope. Part A:
  // book a CONSERVATIVE ESTIMATE (measured stays false, cost stays "unknown", but
  // estimated_cost_usd counts toward windowed spend) instead of a silent $0. A
  // measured call NEVER reaches these branches, so an estimate can never overwrite a
  // real measured record.
  let record;
  if (Number.isFinite(rcNum) && rcNum !== 0) {
    const reason =
      rcNum === 124 ? "claude call timed out (rc=124)" : `claude call exited rc=${rcNum}`;
    const { estimateUsd, basis } = deriveKillEstimate({
      kind,
      killEstimate: args.killEstimate,
      killBasis: args.killBasis,
      elapsedMs: args.elapsedMs,
    });
    // A usage-window refusal also exits non-zero but carries a full envelope. Its row
    // keeps the conservative estimate (the spend caps never under-count) and is
    // labelled usage_limit so the ledger says why the call ended.
    record = withUsageLimit(estimatedRecord({ ticket, kind, reason, estimateUsd, basis }), json);
  } else if (json === null) {
    const reason = "no parseable --output-format json on stdout";
    const { estimateUsd, basis } = deriveKillEstimate({
      kind,
      killEstimate: args.killEstimate,
      killBasis: args.killBasis,
      elapsedMs: args.elapsedMs,
    });
    record = estimatedRecord({ ticket, kind, reason, estimateUsd, basis });
  } else {
    record = buildUsageRecord({ json, ticket, kind });
  }
  appendUsageRecord(withAttempt(withProvenance(record, args), args));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cliMain(process.argv.slice(2));
}

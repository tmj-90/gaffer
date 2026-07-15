import type { ContextPacket } from "../context/packet.js";

import type { AgentEvidence, AgentRunResult, AgentRuntime } from "./agentRuntime.js";

// =====================================================================
// ClaudeAgentRuntime — P0 spike + seam (docs/tick-sh-runtime-migration.md).
// ---------------------------------------------------------------------
// The live delivery runtime is `tick.sh → claude -p` (bash). This is the first
// slice of moving that into a typed runtime behind crew's existing AgentRuntime
// seam. P0 delivers the TYPED BRIDGE the eventual live runtime needs — parse a
// `claude -p --output-format json` envelope and map it into the crew
// `AgentRunResult` — plus a `ClaudeAgentRuntime` that maps a PRE-CAPTURED
// envelope, injectable in tests exactly like MockAgentRuntime.
//
// It does NOT spawn `claude` and does NOT touch tick.sh. The live spawn is a
// later slice and needs the seam to become async (`run(): Promise<...>`), which
// touches MockAgentRuntime + the impl-loop caller — deliberately deferred (P1/P2).
// =====================================================================

/**
 * The parsed `claude -p --output-format json` result envelope, narrowed to the
 * fields the runtime bridge consumes. This mirrors the subset that
 * `runner/lib/worker.mjs parseResult` produces — that JS parser stays the
 * runner-side source of truth for the current LIVE path; this typed parser is the
 * crew-side equivalent for the runtime seam. A later slice unifies them once the
 * live spawn moves behind this seam (until then, the parity is covered by tests
 * that run the SAME captured envelopes through both).
 */
export interface ClaudeEnvelope {
  /** The agent's `.result` text (empty string when absent/unparseable). */
  readonly resultText: string;
  /** True when the envelope signals an error (is_error / subtype:error / type:error). */
  readonly isError: boolean;
  /** First present of stop_reason / subtype / finish_reason, or null. */
  readonly stopReason: string | null;
  /** True when the stop signal indicates the turn cap was hit (never invented). */
  readonly stopReasonIsMaxTurns: boolean;
  /** Turn count when the envelope reports a finite one, else null. */
  readonly numTurns: number | null;
  /** Cost relayed from the envelope (never computed here), else null. */
  readonly totalCostUsd: number | null;
}

const MAX_TURNS_RE = /max[_-]?turns|turn limit/i;

type Json = Record<string, unknown>;

/** Parse `text` as JSON; if that fails, recover the LAST balanced `{...}` block
 *  (claude sometimes prefixes trust/log noise before the JSON). Never throws. */
function tolerantJson(text: string): Json | null {
  const trimmed = (text ?? "").trim();
  if (trimmed === "") return null;
  try {
    const v = JSON.parse(trimmed);
    return v && typeof v === "object" ? (v as Json) : null;
  } catch {
    // fall through to balanced-block recovery
  }
  // A string-AWARE brace scanner: braces inside JSON string values are data, not
  // structure. A raw count would (A) drive depth negative on a stray `}` in prefix
  // noise and then miss the real block, and (B) mis-balance on an unmatched `{`/`}`
  // inside a result string (e.g. claude summarising `edited f(x) {`), returning null
  // and falsely marking a SUCCESSFUL run blocked. Track in-string + escape state and
  // never let depth go negative. `candidate` keeps the LAST top-level balanced block.
  let depth = 0;
  let start = -1;
  let candidate: string | null = null;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    const c = trimmed[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
    } else if (c === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (c === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) candidate = trimmed.slice(start, i + 1);
    }
  }
  if (candidate === null) return null;
  try {
    const v = JSON.parse(candidate);
    return v && typeof v === "object" ? (v as Json) : null;
  } catch {
    return null;
  }
}

function firstString(json: Json | null, keys: string[]): string | null {
  if (!json) return null;
  for (const k of keys) {
    const v = json[k];
    if (typeof v === "string" && v !== "") return v;
  }
  return null;
}

function finiteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Tolerant parse of a `claude -p --output-format json` envelope into the typed
 * subset the runtime bridge needs. Total — a malformed/empty envelope yields a
 * safe "errored, no result" shape rather than throwing.
 */
export function parseClaudeEnvelope(stdout: string): ClaudeEnvelope {
  const json = tolerantJson(stdout);
  if (json === null && (stdout ?? "").trim() !== "") {
    // Non-empty stdout that yields no JSON envelope is treated as errored below.
    // Surface a truncated snippet so a parse regression (or a future claude output
    // change) is diagnosable rather than a silent false-negative "blocked".
    const snippet = stdout.slice(0, 300).replace(/\s+/g, " ").trim();
    console.error(
      `[claudeAgentRuntime] unparseable claude stdout (len=${stdout.length}): ${snippet}`,
    );
  }
  const stopReason = firstString(json, ["stop_reason", "subtype", "finish_reason"]);
  // `json["error"]` is `unknown`; narrow to an object before reading `.message`
  // rather than asserting `as Json` (a primitive would make that assertion false).
  const errorObj = json?.["error"];
  const errMsg =
    typeof errorObj === "object" &&
    errorObj !== null &&
    typeof (errorObj as Json)["message"] === "string"
      ? String((errorObj as Json)["message"])
      : "";
  const maxTurns = [stopReason ?? "", String(json?.["subtype"] ?? ""), errMsg].some((s) =>
    MAX_TURNS_RE.test(s),
  );
  return {
    resultText: typeof json?.["result"] === "string" ? (json["result"] as string) : "",
    isError:
      json === null ||
      json["is_error"] === true ||
      json["subtype"] === "error" ||
      json["type"] === "error",
    stopReason,
    stopReasonIsMaxTurns: maxTurns,
    numTurns: finiteNumber(json?.["num_turns"]),
    totalCostUsd: finiteNumber(json?.["total_cost_usd"]),
  };
}

/**
 * Pure bridge: a parsed Claude envelope + the context packet → the crew
 * `AgentRunResult`. This is the one tested place the two contracts meet, and it's
 * exactly the mapping the live `ClaudeAgentRuntime` will apply once the spawn moves
 * behind the seam. Total + side-effect-free.
 *
 * NOTE (P0 honesty): per-AC evidence and `changedPaths` are computed from the git
 * diff by the delivery slice, NOT from the envelope — so at P0 a success emits one
 * note per AC (parity with MockAgentRuntime) and carries the agent's summary text.
 * Wiring real evidence + the write-set is a later slice.
 */
export function mapEnvelopeToRunResult(env: ClaudeEnvelope, packet: ContextPacket): AgentRunResult {
  if (env.stopReasonIsMaxTurns) {
    return {
      status: "blocked",
      summary: env.resultText || `Agent hit the turn cap on ticket #${packet.ticket.number}.`,
      evidence: [],
      blockedReason: `agent hit max turns (stop_reason=${env.stopReason ?? "unknown"})`,
    };
  }
  if (env.isError) {
    return {
      status: "blocked",
      summary: env.resultText || `Agent run errored on ticket #${packet.ticket.number}.`,
      evidence: [],
      blockedReason: `agent run errored (stop_reason=${env.stopReason ?? "unknown"})`,
    };
  }
  const evidence: AgentEvidence[] = packet.acceptanceCriteria.map((ac) => ({
    acId: ac.id,
    evidenceType: "note",
    summary: `Agent reported work against AC: ${ac.text}`,
  }));
  return {
    status: "submitted_for_review",
    summary: env.resultText || `Delivered ticket #${packet.ticket.number}.`,
    evidence,
  };
}

/**
 * Typed Claude runtime behind the crew `AgentRuntime` seam. **P0 spike:** it maps a
 * PRE-CAPTURED envelope (injected as a parsed `ClaudeEnvelope` or raw `{stdout}`)
 * into an `AgentRunResult` — proving the two contracts bridge cleanly, and it's
 * injectable in the impl loop exactly like `MockAgentRuntime`.
 *
 * It deliberately does NOT spawn `claude` and does NOT read `tick.sh`. The live
 * spawn needs the seam to become async and belongs to a later slice
 * (docs/tick-sh-runtime-migration.md P1/P2).
 */
export class ClaudeAgentRuntime implements AgentRuntime {
  private readonly envelope: ClaudeEnvelope;

  constructor(source: ClaudeEnvelope | { stdout: string }) {
    this.envelope = "stdout" in source ? parseClaudeEnvelope(source.stdout) : source;
  }

  async run(packet: ContextPacket): Promise<AgentRunResult> {
    return mapEnvelopeToRunResult(this.envelope, packet);
  }
}

/**
 * Run-detail enrichment: parse ROUTE lines from a captured run log and join
 * per-ticket cost from the usage ledger.
 *
 * Design:
 *  - All functions are pure / defensive: they return zero-state shapes when
 *    the log is absent, malformed, or the ledger is missing. They never throw.
 *  - The log tail is capped at LOG_TAIL_LINES (last 50 lines) for the detail
 *    endpoint; the raw file reading still uses readLogTail (byte-capped) so a
 *    chatty run log never blows up memory.
 *  - ROUTE line format (from runner/factory.config.sh):
 *      ROUTE #N phase=<phase> risk=<risk> ac=<ac> attempt=<attempt> budget=<budget> → model=<model> [...]
 *    or (with no ticket context):
 *      ROUTE phase=<phase> ...
 *    The function returns the LAST ROUTE line found so a multi-tick run reports
 *    the most-recent phase/model rather than a stale earlier one.
 *  - "Outcome" is derived from run status and well-known log markers written by
 *    tick.sh: `in_review`, `refining` (delivery FAILED → requeue), `FLAGGED`
 *    (hygiene-flagged), `FAILED` (hard fail), or null while still running.
 */

import { readLedgerRows, resolveLedgerPath } from "../cost/costAggregator.js";
import type { Run } from "../domain/types.js";

// ── ROUTE parsing ────────────────────────────────────────────────────────────

/**
 * Parsed fields from a ROUTE log line.
 *
 * The line format (from factory.config.sh) is:
 *   ROUTE [#<ticket>] phase=<phase> risk=<risk> ac=<ac_count>
 *     attempt=<attempt> budget=<budget> → tier=<tier> model=<model> [<reasons>]
 *   OR (explicit override path):
 *   ROUTE [#<ticket>] phase=<phase> ... → model=<model> (explicit GAFFER_*_MODEL override)
 */
export interface RouteInfo {
  /** Ticket number extracted from "ROUTE #N" (null when absent). */
  ticket: number | null;
  /** Routing phase (e.g. "implement", "decompose", "review"). */
  phase: string | null;
  /** Resolved model id (e.g. "claude-sonnet-4-6"). */
  model: string | null;
}

/**
 * Parse a single ROUTE log line. Returns null when the line is not a ROUTE
 * line or is too malformed to extract meaningful fields.
 *
 * Accepts both timestamp-prefixed lines written by tick.sh
 *   `2026-01-01T00:00:00 ROUTE #42 phase=implement ...`
 * and bare ROUTE lines (in tests / edge cases).
 */
export function parseRouteLine(line: string): RouteInfo | null {
  // Strip optional leading timestamp (ISO-like prefix logged by tick.sh).
  const stripped = line.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\s+/, "");

  if (!stripped.startsWith("ROUTE")) return null;

  // Ticket number — optional "#N" immediately after "ROUTE ".
  let ticket: number | null = null;
  const ticketMatch = stripped.match(/^ROUTE\s+#(\d+)\s/);
  if (ticketMatch) {
    const n = parseInt(ticketMatch[1]!, 10);
    if (Number.isFinite(n) && n > 0) ticket = n;
  }

  // phase=<value>
  let phase: string | null = null;
  const phaseMatch = stripped.match(/\bphase=(\S+)/);
  if (phaseMatch) phase = phaseMatch[1]!;

  // model=<value> — appears after "→ " (or "-> ") with "model=<id>"
  let model: string | null = null;
  const modelMatch = stripped.match(/\bmodel=(\S+)/);
  if (modelMatch) {
    const raw = modelMatch[1]!;
    // Strip trailing punctuation that might be captured from "(explicit ...)"
    model = raw.replace(/[()]/g, "").trim() || null;
  }

  // Not a ROUTE line if we couldn't extract anything useful.
  if (phase === null && model === null) return null;

  return { ticket, phase, model };
}

/**
 * Extract the LAST (most-recent) ROUTE info from a block of log text.
 * Returns null when no ROUTE lines are present.
 */
export function parseLastRouteInfo(logText: string): RouteInfo | null {
  const lines = logText.split("\n");
  let last: RouteInfo | null = null;
  for (const line of lines) {
    const parsed = parseRouteLine(line);
    if (parsed !== null) last = parsed;
  }
  return last;
}

// ── Outcome detection ─────────────────────────────────────────────────────────

/**
 * Terminal outcome markers we can detect from the log text.
 * Matches tick.sh's logged strings:
 *   "delivery FAILED"   → "FAILED"
 *   "HYGIENE:"          → "FLAGGED"
 *   "delivery tick … finished (rc=0)" with no FAILED → "in_review" (submitted)
 *   "delivery FAILED … skipping" → "refining" (re-queued)
 */
export type RunOutcome = "in_review" | "refining" | "FLAGGED" | "FAILED" | null;

/**
 * Detect the settled outcome of a run from log text. Returns null when the
 * run is still active or when no conclusive marker is found.
 */
export function detectOutcome(logText: string, runStatus: Run["status"]): RunOutcome {
  if (runStatus === "running") return null;

  // HYGIENE failure is the most specific and takes priority.
  if (/\bHYGIENE:.+delivery for #\d+ is NOT hygienic/i.test(logText)) {
    return "FLAGGED";
  }

  // Hard failure markers (tick.sh logs "delivery FAILED for #N").
  if (/delivery FAILED for #\d+/.test(logText)) {
    // If the log also has "skipping it for the rest of this run" it was
    // re-queued (→ refining). Without that marker it's a terminal FAILED.
    if (/skipping it for the rest of this run/.test(logText)) return "refining";
    return "FAILED";
  }

  // Successful delivery: "delivery tick for #N finished (rc=0)".
  if (/delivery tick for #\d+ finished \(rc=0\)/.test(logText)) {
    return "in_review";
  }

  return null;
}

// ── Per-ticket cost join ──────────────────────────────────────────────────────

/**
 * Per-ticket cost and turns from the usage ledger for ONE ticket.
 * Zero-state when the ticket has no ledger rows.
 */
export interface TicketCostInfo {
  cost_usd: number;
  num_turns: number;
}

/**
 * Sum cost and turns from the usage ledger for a single ticket number.
 * Reads the ledger file path from the process environment each call (the file
 * path is env-bound; keeping it hot is the caller's concern, not ours).
 * Returns { cost_usd: 0, num_turns: 0 } when the ticket isn't found or the
 * ledger is absent — never throws.
 */
export function ticketCostInfo(
  ticketNumber: number,
  env: NodeJS.ProcessEnv = process.env,
): TicketCostInfo {
  try {
    const ledgerPath = resolveLedgerPath(env);
    if (!ledgerPath) return { cost_usd: 0, num_turns: 0 };
    const rows = readLedgerRows(ledgerPath);
    let cost = 0;
    let turns = 0;
    for (const row of rows) {
      if (row.ticket === ticketNumber) {
        cost += row.total_cost_usd;
        turns += row.num_turns;
      }
    }
    return {
      cost_usd: Math.round(cost * 1e6) / 1e6,
      num_turns: turns,
    };
  } catch {
    return { cost_usd: 0, num_turns: 0 };
  }
}

// ── Log tail (line-capped) ────────────────────────────────────────────────────

/** Maximum lines returned in the run-detail log tail. */
export const DETAIL_LOG_TAIL_LINES = 50;

/**
 * Return the last {@link DETAIL_LOG_TAIL_LINES} non-empty lines from a block
 * of log text. Returns the input unchanged when it fits within the cap.
 */
export function logTailLines(text: string, maxLines = DETAIL_LOG_TAIL_LINES): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return lines.slice(lines.length - maxLines).join("\n");
}

// ── Full detail shape ─────────────────────────────────────────────────────────

/** The enriched detail shape returned by GET /api/runs/:id. */
export interface RunDetail {
  run: Run;
  /** Ticket number discovered from ROUTE lines, or null when not found. */
  ticket_number: number | null;
  /** Routing phase (latest), e.g. "implement". Null when log absent. */
  phase: string | null;
  /** Model id (latest), e.g. "claude-sonnet-4-6". Null when log absent. */
  model: string | null;
  /** Turns consumed (from ledger) for this ticket. 0 when unknown. */
  num_turns: number;
  /** Cost in USD (from ledger) for this ticket. 0 when unknown. */
  cost_usd: number;
  /** Capped log tail (last 50 lines of the per-run log). Null when absent. */
  log_tail: string | null;
  /** Settled outcome, or null when still running / not determinable. */
  outcome: RunOutcome;
}

/**
 * Assemble a {@link RunDetail} from a run row, its log text (pre-read), and
 * the process environment (for ledger resolution). All fields degrade
 * gracefully: a missing log or ledger gives zeros/nulls, never a throw.
 *
 * `logText` is the full byte-capped tail string from {@link readLogTail} (or
 * null when the log is absent). The function applies the line cap on top.
 */
export function buildRunDetail(
  run: Run,
  logText: string | null,
  env: NodeJS.ProcessEnv = process.env,
): RunDetail {
  const routeInfo = logText ? parseLastRouteInfo(logText) : null;
  const ticketNumber = routeInfo?.ticket ?? null;
  const phase = routeInfo?.phase ?? null;
  const model = routeInfo?.model ?? null;
  const outcome = logText ? detectOutcome(logText, run.status) : null;
  const logTail = logText !== null ? logTailLines(logText) : null;

  const costInfo =
    ticketNumber !== null ? ticketCostInfo(ticketNumber, env) : { cost_usd: 0, num_turns: 0 };

  return {
    run,
    ticket_number: ticketNumber,
    phase,
    model,
    num_turns: costInfo.num_turns,
    cost_usd: costInfo.cost_usd,
    log_tail: logTail,
    outcome,
  };
}

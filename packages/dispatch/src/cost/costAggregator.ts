/**
 * Cost aggregation over the factory usage-ledger.
 *
 * Reads $GAFFER_USAGE_LEDGER (or $GAFFER_DATA/usage-ledger.jsonl) line by line
 * and produces:
 *   - per-ticket totals (summed across attempts and phases)
 *   - per-repo totals (derived from the dispatch ticket→repo mapping, passed in
 *     as a lookup function so this module stays database-free and easily testable)
 *   - factory grand total + ticket count
 *
 * Defensive by design:
 *   - Malformed or non-JSON lines are silently skipped (never throws)
 *   - Missing / "unknown" numeric fields contribute 0 to aggregates
 *   - Missing file returns a zero-state aggregate (never throws)
 *
 * The aggregated totals are intentionally capped in the API layer (not here),
 * so this module is pure data — easy to unit test.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ---- Types ------------------------------------------------------------------

/** A single raw JSONL row as written by lib/usage-ledger.mjs. */
interface RawLedgerRow {
  ts?: unknown;
  ticket?: unknown;
  kind?: unknown;
  measured?: unknown;
  total_cost_usd?: unknown;
  num_turns?: unknown;
  duration_ms?: unknown;
}

/** A normalised, fully-coerced ledger row. */
export interface LedgerRow {
  ts: string;
  ticket: number | null;
  kind: string | null;
  measured: boolean;
  total_cost_usd: number;
  num_turns: number;
  duration_ms: number;
}

/** Per-ticket aggregated cost. */
export interface TicketCostEntry {
  ticket: number;
  total_cost_usd: number;
  num_turns: number;
}

/** Per-repo aggregated cost. */
export interface RepoCostEntry {
  repo: string;
  total_cost_usd: number;
  ticket_count: number;
}

/** The full aggregate returned by aggregateCosts(). */
export interface CostAggregate {
  total_usd: number;
  ticket_count: number;
  /** All per-ticket totals, sorted descending by cost. */
  by_ticket: TicketCostEntry[];
  /** All per-repo totals, sorted descending by cost. */
  by_repo: RepoCostEntry[];
  /** UTC ISO string of the most recent ledger row's ts, or null when empty. */
  last_record_at: string | null;
}

/** Resolve repo names for a set of ticket numbers. */
export type RepoResolver = (ticketNumber: number) => string | null;

// ---- Helpers ----------------------------------------------------------------

/** Coerce a raw value to a finite non-negative number, or 0. */
function numOrZero(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  return 0;
}

/** True when a raw "unknown" value is the sentinel string "unknown". */
function isUnknownSentinel(v: unknown): boolean {
  return v === "unknown";
}

// ---- Core -------------------------------------------------------------------

/**
 * Parse one JSONL line into a LedgerRow. Returns null for empty / non-JSON /
 * non-object lines so the caller can skip them safely.
 */
export function parseLedgerLine(line: string): LedgerRow | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as RawLedgerRow;

  const ts = typeof r.ts === "string" ? r.ts : new Date().toISOString();
  const measured = r.measured === true;

  let ticket: number | null = null;
  if (typeof r.ticket === "number" && Number.isFinite(r.ticket)) {
    ticket = Math.trunc(r.ticket);
  } else if (typeof r.ticket === "string" && /^\d+$/.test(r.ticket)) {
    ticket = parseInt(r.ticket, 10);
  }

  const kind = typeof r.kind === "string" ? r.kind : null;

  // When measured=false or total_cost_usd is the "unknown" sentinel, contribute 0.
  const total_cost_usd =
    !measured || isUnknownSentinel(r.total_cost_usd) ? 0 : numOrZero(r.total_cost_usd);
  const num_turns = !measured || isUnknownSentinel(r.num_turns) ? 0 : numOrZero(r.num_turns);
  const duration_ms = !measured || isUnknownSentinel(r.duration_ms) ? 0 : numOrZero(r.duration_ms);

  return { ts, ticket, kind, measured, total_cost_usd, num_turns, duration_ms };
}

/**
 * Resolve the ledger file path from the process environment.
 * Mirrors the runner's resolution: GAFFER_USAGE_LEDGER wins; otherwise
 * $GAFFER_DATA/usage-ledger.jsonl.
 */
export function resolveLedgerPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.GAFFER_USAGE_LEDGER;
  if (explicit) return explicit;
  const dir = env.GAFFER_DATA;
  if (!dir) return null;
  return join(dir, "usage-ledger.jsonl");
}

/**
 * Read and parse all rows from the ledger file. Returns an empty array when the
 * file is missing, unreadable, or has no valid rows — never throws.
 */
export function readLedgerRows(ledgerPath: string): LedgerRow[] {
  try {
    if (!existsSync(ledgerPath)) return [];
    const content = readFileSync(ledgerPath, "utf8");
    const rows: LedgerRow[] = [];
    for (const line of content.split("\n")) {
      const row = parseLedgerLine(line);
      if (row !== null) rows.push(row);
    }
    return rows;
  } catch {
    return [];
  }
}

/**
 * Aggregate costs from a set of ledger rows.
 *
 * @param rows     Parsed ledger rows.
 * @param resolve  Optional: maps a ticket number to a repo name for by_repo
 *                 grouping. When null/missing the ticket is counted under an
 *                 "(unlinked)" bucket.
 */
export function aggregateRows(
  rows: LedgerRow[],
  resolve: RepoResolver = () => null,
): CostAggregate {
  let totalUsd = 0;
  let lastRecordAt: string | null = null;

  // Per-ticket accumulation
  const byTicket = new Map<number, { cost: number; turns: number }>();
  // Per-repo accumulation
  const byRepo = new Map<string, { cost: number; tickets: Set<number> }>();

  for (const row of rows) {
    totalUsd += row.total_cost_usd;

    // Track most-recent ts
    if (lastRecordAt === null || row.ts > lastRecordAt) lastRecordAt = row.ts;

    if (row.ticket !== null) {
      const prev = byTicket.get(row.ticket) ?? { cost: 0, turns: 0 };
      byTicket.set(row.ticket, {
        cost: prev.cost + row.total_cost_usd,
        turns: prev.turns + row.num_turns,
      });

      const repo = resolve(row.ticket) ?? "(unlinked)";
      const prevRepo = byRepo.get(repo) ?? { cost: 0, tickets: new Set<number>() };
      prevRepo.cost += row.total_cost_usd;
      prevRepo.tickets.add(row.ticket);
      byRepo.set(repo, prevRepo);
    }
  }

  const byTicketArr: TicketCostEntry[] = Array.from(byTicket.entries())
    .map(([ticket, { cost, turns }]) => ({
      ticket,
      total_cost_usd: Math.round(cost * 1e6) / 1e6,
      num_turns: turns,
    }))
    .sort((a, b) => b.total_cost_usd - a.total_cost_usd);

  const byRepoArr: RepoCostEntry[] = Array.from(byRepo.entries())
    .map(([repo, { cost, tickets }]) => ({
      repo,
      total_cost_usd: Math.round(cost * 1e6) / 1e6,
      ticket_count: tickets.size,
    }))
    .sort((a, b) => b.total_cost_usd - a.total_cost_usd);

  return {
    total_usd: Math.round(totalUsd * 1e6) / 1e6,
    ticket_count: byTicket.size,
    by_ticket: byTicketArr,
    by_repo: byRepoArr,
    last_record_at: lastRecordAt,
  };
}

/**
 * Aggregate costs from the ledger file, deriving repo names from the provided
 * resolver. Returns a zero-state aggregate when the ledger is missing.
 *
 * @param env      Process environment (for path resolution).
 * @param resolve  Repo resolver — maps ticket number → repo name.
 */
export function aggregateCosts(
  env: NodeJS.ProcessEnv = process.env,
  resolve: RepoResolver = () => null,
): CostAggregate {
  const path = resolveLedgerPath(env);
  if (!path) {
    return { total_usd: 0, ticket_count: 0, by_ticket: [], by_repo: [], last_record_at: null };
  }
  const rows = readLedgerRows(path);
  return aggregateRows(rows, resolve);
}

/**
 * Compute today's spend (UTC calendar day) from an aggregate's ledger rows.
 * Separate from aggregateRows to keep the main path lean.
 */
export function todaySpend(rows: LedgerRow[]): number {
  const today = new Date().toISOString().slice(0, 10);
  return (
    Math.round(
      rows
        .filter((r) => r.ts.slice(0, 10) === today)
        .reduce((sum, r) => sum + r.total_cost_usd, 0) * 1e6,
    ) / 1e6
  );
}

/**
 * Compute GAFFER_BUDGET_REMAINING given a configured budget and total spend.
 *
 * Returns:
 *   - null when GAFFER_BUDGET_USD is unset or zero (unlimited)
 *   - 0 when spend >= budget (exhausted)
 *   - (budget - spend), rounded to 6dp
 */
export function computeBudgetRemaining(
  budgetUsd: number | null,
  totalSpendUsd: number,
): number | null {
  if (budgetUsd === null || budgetUsd <= 0) return null;
  const remaining = budgetUsd - totalSpendUsd;
  return Math.round(Math.max(0, remaining) * 1e6) / 1e6;
}

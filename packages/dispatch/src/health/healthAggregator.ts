/**
 * Factory-health / ROI aggregation over the usage-ledger.
 *
 * This is the honest counterpart to {@link "../cost/costAggregator"}: where the
 * cost aggregator throws away everything except dollars-per-ticket/-repo, this
 * module KEEPS the fields cost drops — per-kind spend, per-model token mix,
 * measured-vs-unknown coverage, a daily spend series, cost-of-rework and
 * duration/latency — so the Health surface can answer "what did the factory buy
 * with this money and how honest is that number".
 *
 * Reuse posture (per spec): the ledger path is resolved with
 * {@link resolveLedgerPath} from the cost aggregator. The row READER lives here
 * (rather than reusing `readLedgerRows`) for exactly one reason: `readLedgerRows`
 * discards the per-model `models` map, which is the source of the token-mix
 * signal. `parseHealthLine`/`readHealthRows` mirror that reader line-for-line and
 * additionally retain `models`.
 *
 * Defensive by design (same contract as costAggregator):
 *   - Malformed / non-JSON lines are silently skipped (never throws).
 *   - Missing / "unknown" numeric fields contribute 0.
 *   - Unmeasured rows (measured!==true) contribute 0 cost/turns/duration but ARE
 *     counted for the coverage gap — that is the whole point of this surface.
 *   - Missing file returns a zero-state aggregate (never throws).
 *
 * Aggregate list-sizing is left to the API layer, so this module is pure data.
 */

import { existsSync, readFileSync } from "node:fs";

import { resolveLedgerPath } from "../cost/costAggregator.js";

// Re-export so callers can resolve the ledger path from one place.
export { resolveLedgerPath };

// ---- Types ------------------------------------------------------------------

/** Per-model token/cost usage as written by lib/usage-ledger.mjs. */
export interface ModelUsage {
  input: number;
  output: number;
  cache_read: number;
  cache_create: number;
  cost_usd: number;
}

/** A single raw JSONL row (superset of the cost aggregator's RawLedgerRow). */
interface RawHealthRow {
  ts?: unknown;
  ticket?: unknown;
  kind?: unknown;
  measured?: unknown;
  total_cost_usd?: unknown;
  num_turns?: unknown;
  duration_ms?: unknown;
  models?: unknown;
}

/** A normalised, fully-coerced health row — keeps the per-model token map. */
export interface HealthRow {
  ts: string;
  ticket: number | null;
  kind: string | null;
  measured: boolean;
  total_cost_usd: number;
  num_turns: number;
  duration_ms: number;
  /** Per-model token/cost split; empty when the row carried no usable modelUsage. */
  models: Record<string, ModelUsage>;
}

/** Spend + call count grouped by ledger `kind` (delivery, review, testing …). */
export interface KindSpendEntry {
  kind: string;
  total_cost_usd: number;
  count: number;
}

/** Token mix + relayed cost grouped by model. */
export interface ModelMixEntry extends ModelUsage {
  model: string;
}

/** One calendar-day (UTC) spend point. */
export interface DailySpendEntry {
  date: string;
  total_cost_usd: number;
}

/** Per-ticket cost-of-rework attribution. */
export interface ReworkCostEntry {
  ticket: number;
  rework_count: number;
  ticket_cost_usd: number;
  /** Wasted spend attributed to the redo attempts (see aggregateHealthRows). */
  rework_cost_usd: number;
}

/** The honesty gap: how much of the factory's activity is actually measured. */
export interface CoverageStat {
  measured_count: number;
  total_count: number;
  /** measured/total as a 0–100 number (0 when there are no rows). */
  coverage_pct: number;
}

/** Duration / latency roll-up over measured calls. */
export interface DurationStat {
  total_ms: number;
  measured_calls: number;
  /** total_ms / measured_calls, rounded (0 when no measured calls). */
  avg_ms: number;
}

/** The full health/ROI aggregate. */
export interface HealthAggregate {
  total_usd: number;
  ticket_count: number;
  /** Number of shipped (`done`) tickets used as the cost-per-shipped divisor. */
  shipped_count: number;
  /** total_usd / shipped_count, or null when nothing has shipped (no div-by-zero). */
  cost_per_shipped_usd: number | null;
  coverage: CoverageStat;
  by_kind: KindSpendEntry[];
  by_model: ModelMixEntry[];
  daily_spend: DailySpendEntry[];
  rework: {
    total_rework_cost_usd: number;
    /** total_rework_cost / total_usd as a 0–100 number (0 when total is 0). */
    rework_cost_share_pct: number;
    by_ticket: ReworkCostEntry[];
  };
  duration: DurationStat;
  last_record_at: string | null;
}

/** Resolve the rework-attempt count for a ticket number (0 when none). */
export type ReworkResolver = (ticketNumber: number) => number;

/** Options for {@link aggregateHealthRows}. */
export interface HealthAggregateOptions {
  /** Count of shipped (`done`) tickets — the cost-per-shipped divisor. */
  shippedCount?: number;
  /** Ticket-number → rework-attempt count. Defaults to "no rework". */
  resolveRework?: ReworkResolver;
}

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

/** Round a number to 6 decimal places (dollars) — matches costAggregator. */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Parse the per-model usage map, tolerating missing / "unknown" fields. */
function parseModels(raw: unknown): Record<string, ModelUsage> {
  const out: Record<string, ModelUsage> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [model, u] of Object.entries(raw as Record<string, unknown>)) {
    if (!u || typeof u !== "object") continue;
    const uu = u as Record<string, unknown>;
    out[model] = {
      input: numOrZero(uu.input),
      output: numOrZero(uu.output),
      cache_read: numOrZero(uu.cache_read),
      cache_create: numOrZero(uu.cache_create),
      cost_usd: numOrZero(uu.cost_usd),
    };
  }
  return out;
}

// ---- Core -------------------------------------------------------------------

/**
 * Parse one JSONL line into a HealthRow. Returns null for empty / non-JSON /
 * non-object lines so the caller can skip them safely. Mirrors
 * {@link "../cost/costAggregator".parseLedgerLine} and additionally retains the
 * per-model `models` map.
 */
export function parseHealthLine(line: string): HealthRow | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as RawHealthRow;

  const ts = typeof r.ts === "string" ? r.ts : new Date().toISOString();
  const measured = r.measured === true;

  let ticket: number | null = null;
  if (typeof r.ticket === "number" && Number.isFinite(r.ticket)) {
    ticket = Math.trunc(r.ticket);
  } else if (typeof r.ticket === "string" && /^\d+$/.test(r.ticket)) {
    ticket = parseInt(r.ticket, 10);
  }

  const kind = typeof r.kind === "string" ? r.kind : null;

  // Unmeasured or "unknown" sentinels contribute 0 — an unmeasured call can
  // never read as free.
  const total_cost_usd =
    !measured || isUnknownSentinel(r.total_cost_usd) ? 0 : numOrZero(r.total_cost_usd);
  const num_turns = !measured || isUnknownSentinel(r.num_turns) ? 0 : numOrZero(r.num_turns);
  const duration_ms = !measured || isUnknownSentinel(r.duration_ms) ? 0 : numOrZero(r.duration_ms);
  const models = measured ? parseModels(r.models) : {};

  return { ts, ticket, kind, measured, total_cost_usd, num_turns, duration_ms, models };
}

/**
 * Read and parse all rows from the ledger file. Returns an empty array when the
 * file is missing, unreadable, or has no valid rows — never throws. Mirrors
 * {@link "../cost/costAggregator".readLedgerRows}, retaining the model map.
 */
export function readHealthRows(ledgerPath: string): HealthRow[] {
  try {
    if (!existsSync(ledgerPath)) return [];
    const content = readFileSync(ledgerPath, "utf8");
    const rows: HealthRow[] = [];
    for (const line of content.split("\n")) {
      const row = parseHealthLine(line);
      if (row !== null) rows.push(row);
    }
    return rows;
  } catch {
    return [];
  }
}

/**
 * Aggregate the health/ROI view from a set of ledger rows.
 *
 * cost-of-rework: for a ticket delivered after N rework attempts, N+1 delivery
 * runs were paid for and N of them were redo. We therefore attribute
 * `ticket_cost * N/(N+1)` of that ticket's spend to rework — a bounded, honest
 * share that can never exceed the ticket's own cost.
 */
export function aggregateHealthRows(
  rows: HealthRow[],
  options: HealthAggregateOptions = {},
): HealthAggregate {
  const shippedCount = Math.max(0, Math.trunc(options.shippedCount ?? 0));
  const resolveRework = options.resolveRework ?? (() => 0);

  let totalUsd = 0;
  let measuredCount = 0;
  let totalDurationMs = 0;
  let measuredCalls = 0;
  let lastRecordAt: string | null = null;

  const byTicket = new Map<number, number>(); // ticket → cost
  const byKind = new Map<string, { cost: number; count: number }>();
  const byModel = new Map<string, ModelUsage>();
  const byDay = new Map<string, number>(); // yyyy-mm-dd → cost

  for (const row of rows) {
    totalUsd += row.total_cost_usd;
    if (row.measured) {
      measuredCount += 1;
      measuredCalls += 1;
      totalDurationMs += row.duration_ms;
    }

    if (lastRecordAt === null || row.ts > lastRecordAt) lastRecordAt = row.ts;

    if (row.ticket !== null) {
      byTicket.set(row.ticket, (byTicket.get(row.ticket) ?? 0) + row.total_cost_usd);
    }

    const kind = row.kind ?? "(unattributed)";
    const prevKind = byKind.get(kind) ?? { cost: 0, count: 0 };
    byKind.set(kind, { cost: prevKind.cost + row.total_cost_usd, count: prevKind.count + 1 });

    const day = row.ts.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + row.total_cost_usd);

    for (const [model, u] of Object.entries(row.models)) {
      const prev = byModel.get(model) ?? {
        input: 0,
        output: 0,
        cache_read: 0,
        cache_create: 0,
        cost_usd: 0,
      };
      byModel.set(model, {
        input: prev.input + u.input,
        output: prev.output + u.output,
        cache_read: prev.cache_read + u.cache_read,
        cache_create: prev.cache_create + u.cache_create,
        cost_usd: prev.cost_usd + u.cost_usd,
      });
    }
  }

  const by_kind: KindSpendEntry[] = Array.from(byKind.entries())
    .map(([kind, { cost, count }]) => ({ kind, total_cost_usd: round6(cost), count }))
    .sort((a, b) => b.total_cost_usd - a.total_cost_usd);

  const by_model: ModelMixEntry[] = Array.from(byModel.entries())
    .map(([model, u]) => ({
      model,
      input: u.input,
      output: u.output,
      cache_read: u.cache_read,
      cache_create: u.cache_create,
      cost_usd: round6(u.cost_usd),
    }))
    .sort((a, b) => b.cost_usd - a.cost_usd);

  const daily_spend: DailySpendEntry[] = Array.from(byDay.entries())
    .map(([date, cost]) => ({ date, total_cost_usd: round6(cost) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // cost-of-rework — join the ledger's per-ticket cost with the rework count.
  let totalReworkCost = 0;
  const reworkByTicket: ReworkCostEntry[] = [];
  for (const [ticket, cost] of byTicket.entries()) {
    const rc = Math.max(0, Math.trunc(resolveRework(ticket)));
    if (rc <= 0) continue;
    const reworkCost = round6((cost * rc) / (rc + 1));
    totalReworkCost += reworkCost;
    reworkByTicket.push({
      ticket,
      rework_count: rc,
      ticket_cost_usd: round6(cost),
      rework_cost_usd: reworkCost,
    });
  }
  reworkByTicket.sort((a, b) => b.rework_cost_usd - a.rework_cost_usd);
  totalReworkCost = round6(totalReworkCost);

  const total_usd = round6(totalUsd);
  const coverage_pct =
    rows.length > 0 ? Math.round((measuredCount / rows.length) * 1000) / 10 : 0;

  return {
    total_usd,
    ticket_count: byTicket.size,
    shipped_count: shippedCount,
    cost_per_shipped_usd: shippedCount > 0 ? round6(total_usd / shippedCount) : null,
    coverage: {
      measured_count: measuredCount,
      total_count: rows.length,
      coverage_pct,
    },
    by_kind,
    by_model,
    daily_spend,
    rework: {
      total_rework_cost_usd: totalReworkCost,
      rework_cost_share_pct:
        total_usd > 0 ? Math.round((totalReworkCost / total_usd) * 1000) / 10 : 0,
      by_ticket: reworkByTicket,
    },
    duration: {
      total_ms: totalDurationMs,
      measured_calls: measuredCalls,
      avg_ms: measuredCalls > 0 ? Math.round(totalDurationMs / measuredCalls) : 0,
    },
    last_record_at: lastRecordAt,
  };
}

/**
 * Aggregate the health view from the ledger file. Returns a zero-state aggregate
 * when the ledger is missing / unconfigured. Never throws.
 */
export function aggregateHealth(
  env: NodeJS.ProcessEnv = process.env,
  options: HealthAggregateOptions = {},
): HealthAggregate {
  const path = resolveLedgerPath(env);
  const rows = path ? readHealthRows(path) : [];
  return aggregateHealthRows(rows, options);
}

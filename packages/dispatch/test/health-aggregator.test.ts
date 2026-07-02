/**
 * Unit tests for packages/dispatch/src/health/healthAggregator.ts
 *
 * Mirrors the rigor of the cost-aggregator suite. Covers:
 *   - zero-state (no rows)
 *   - an all-unknown ledger (the honesty gap: 0% coverage, $0 total)
 *   - a mixed measured/unmeasured ledger (partial coverage)
 *   - cost-per-shipped with ZERO shipped tickets (no divide-by-zero → null)
 *   - spend-by-kind, token mix, daily spend, duration
 *   - cost-of-rework via the rework resolver
 *   - a NEGATIVE CONTROL: an unmeasured / unlinked row that must NOT count toward
 *     spend or coverage's measured tally.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  aggregateHealth,
  aggregateHealthRows,
  parseHealthLine,
  readHealthRows,
  type HealthRow,
} from "../src/health/healthAggregator.js";

// ---------------------------------------------------------------------------
// parseHealthLine — retains the model map the cost parser drops
// ---------------------------------------------------------------------------

describe("parseHealthLine", () => {
  it("parses a measured row with a per-model usage map", () => {
    const row = parseHealthLine(
      JSON.stringify({
        ts: "2025-01-15T10:00:00Z",
        ticket: 42,
        kind: "delivery",
        measured: true,
        total_cost_usd: 0.2,
        num_turns: 5,
        duration_ms: 12000,
        models: {
          "claude-opus": {
            input: 100,
            output: 200,
            cache_read: 50,
            cache_create: 10,
            cost_usd: 0.2,
          },
        },
      }),
    );
    expect(row).not.toBeNull();
    expect(row!.models["claude-opus"]).toEqual({
      input: 100,
      output: 200,
      cache_read: 50,
      cache_create: 10,
      cost_usd: 0.2,
    });
  });

  it("drops the model map for an unmeasured row and zeroes cost", () => {
    const row = parseHealthLine(
      JSON.stringify({
        ts: "2025-01-15T10:00:00Z",
        ticket: 7,
        kind: "delivery",
        measured: false,
        total_cost_usd: "unknown",
        models: "unknown",
      }),
    );
    expect(row!.measured).toBe(false);
    expect(row!.total_cost_usd).toBe(0);
    expect(row!.models).toEqual({});
  });

  it("tolerates 'unknown' sentinels inside the model map", () => {
    const row = parseHealthLine(
      JSON.stringify({
        ts: "2025-01-15T10:00:00Z",
        ticket: 9,
        measured: true,
        total_cost_usd: 0.1,
        models: {
          "(unknown-model)": {
            input: 10,
            output: "unknown",
            cache_read: "unknown",
            cache_create: 0,
            cost_usd: "unknown",
          },
        },
      }),
    );
    expect(row!.models["(unknown-model)"]).toEqual({
      input: 10,
      output: 0,
      cache_read: 0,
      cache_create: 0,
      cost_usd: 0,
    });
  });

  it("returns null for empty / non-JSON / array lines", () => {
    expect(parseHealthLine("")).toBeNull();
    expect(parseHealthLine("not json")).toBeNull();
    expect(parseHealthLine("[1,2]")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// aggregateHealthRows — the synthesis
// ---------------------------------------------------------------------------

const makeRow = (o: Partial<HealthRow>): HealthRow => ({
  ts: "2025-01-15T10:00:00Z",
  ticket: null,
  kind: "delivery",
  measured: true,
  total_cost_usd: 0,
  num_turns: 0,
  duration_ms: 0,
  models: {},
  ...o,
});

describe("aggregateHealthRows — zero-state", () => {
  it("returns a safe zero aggregate for no rows", () => {
    const agg = aggregateHealthRows([]);
    expect(agg.total_usd).toBe(0);
    expect(agg.ticket_count).toBe(0);
    expect(agg.shipped_count).toBe(0);
    expect(agg.cost_per_shipped_usd).toBeNull();
    expect(agg.coverage).toEqual({ measured_count: 0, total_count: 0, coverage_pct: 0 });
    expect(agg.by_kind).toEqual([]);
    expect(agg.by_model).toEqual([]);
    expect(agg.daily_spend).toEqual([]);
    expect(agg.rework.total_rework_cost_usd).toBe(0);
    expect(agg.rework.rework_cost_share_pct).toBe(0);
    expect(agg.rework.by_ticket).toEqual([]);
    expect(agg.duration).toEqual({ total_ms: 0, measured_calls: 0, avg_ms: 0 });
    expect(agg.last_record_at).toBeNull();
  });
});

describe("aggregateHealthRows — coverage (the honesty gap)", () => {
  it("reports 0% coverage and $0 for an all-unknown ledger", () => {
    const rows = [
      makeRow({ ticket: 1, measured: false, total_cost_usd: 0 }),
      makeRow({ ticket: 2, measured: false, total_cost_usd: 0 }),
    ];
    const agg = aggregateHealthRows(rows);
    expect(agg.total_usd).toBe(0);
    expect(agg.coverage).toEqual({ measured_count: 0, total_count: 2, coverage_pct: 0 });
  });

  it("reports partial coverage for a mixed measured/unmeasured ledger", () => {
    const rows = [
      makeRow({ ticket: 1, measured: true, total_cost_usd: 0.3 }),
      makeRow({ ticket: 2, measured: false, total_cost_usd: 0 }),
      makeRow({ ticket: 3, measured: true, total_cost_usd: 0.1 }),
      makeRow({ ticket: 4, measured: false, total_cost_usd: 0 }),
    ];
    const agg = aggregateHealthRows(rows);
    expect(agg.total_usd).toBeCloseTo(0.4);
    // 2 of 4 rows measured → 50%.
    expect(agg.coverage.measured_count).toBe(2);
    expect(agg.coverage.total_count).toBe(4);
    expect(agg.coverage.coverage_pct).toBe(50);
  });
});

describe("aggregateHealthRows — cost-per-shipped (no divide-by-zero)", () => {
  it("returns null cost-per-shipped when nothing has shipped", () => {
    const rows = [makeRow({ ticket: 1, total_cost_usd: 1.0 })];
    const agg = aggregateHealthRows(rows, { shippedCount: 0 });
    expect(agg.total_usd).toBeCloseTo(1.0);
    expect(agg.shipped_count).toBe(0);
    expect(agg.cost_per_shipped_usd).toBeNull();
  });

  it("divides total spend by the shipped count when > 0", () => {
    const rows = [
      makeRow({ ticket: 1, total_cost_usd: 0.6 }),
      makeRow({ ticket: 2, total_cost_usd: 0.4 }),
    ];
    const agg = aggregateHealthRows(rows, { shippedCount: 2 });
    expect(agg.cost_per_shipped_usd).toBeCloseTo(0.5);
  });
});

describe("aggregateHealthRows — kept fields cost drops", () => {
  it("rolls up spend-by-kind, token-mix, daily spend and duration", () => {
    const rows = [
      makeRow({
        ts: "2025-01-14T10:00:00Z",
        ticket: 1,
        kind: "delivery",
        total_cost_usd: 0.3,
        duration_ms: 10000,
        models: {
          opus: { input: 100, output: 50, cache_read: 20, cache_create: 5, cost_usd: 0.3 },
        },
      }),
      makeRow({
        ts: "2025-01-15T10:00:00Z",
        ticket: 1,
        kind: "review",
        total_cost_usd: 0.1,
        duration_ms: 4000,
        models: {
          opus: { input: 40, output: 10, cache_read: 0, cache_create: 0, cost_usd: 0.1 },
        },
      }),
    ];
    const agg = aggregateHealthRows(rows, { shippedCount: 1 });

    // spend-by-kind
    const delivery = agg.by_kind.find((k) => k.kind === "delivery")!;
    const review = agg.by_kind.find((k) => k.kind === "review")!;
    expect(delivery.total_cost_usd).toBeCloseTo(0.3);
    expect(delivery.count).toBe(1);
    expect(review.total_cost_usd).toBeCloseTo(0.1);

    // token mix (summed per model)
    const opus = agg.by_model.find((m) => m.model === "opus")!;
    expect(opus.input).toBe(140);
    expect(opus.output).toBe(60);
    expect(opus.cache_read).toBe(20);
    expect(opus.cost_usd).toBeCloseTo(0.4);

    // daily spend (sorted asc by date)
    expect(agg.daily_spend.map((d) => d.date)).toEqual(["2025-01-14", "2025-01-15"]);
    expect(agg.daily_spend[0]!.total_cost_usd).toBeCloseTo(0.3);

    // duration
    expect(agg.duration.total_ms).toBe(14000);
    expect(agg.duration.measured_calls).toBe(2);
    expect(agg.duration.avg_ms).toBe(7000);

    expect(agg.last_record_at).toBe("2025-01-15T10:00:00Z");
  });
});

describe("aggregateHealthRows — cost-of-rework", () => {
  it("attributes ticket_cost * N/(N+1) to rework and excludes zero-rework tickets", () => {
    const rows = [
      makeRow({ ticket: 1, total_cost_usd: 0.9 }), // 2 reworks → 0.9 * 2/3 = 0.6
      makeRow({ ticket: 2, total_cost_usd: 0.5 }), // no rework → excluded
    ];
    const resolveRework = (n: number) => (n === 1 ? 2 : 0);
    const agg = aggregateHealthRows(rows, { shippedCount: 2, resolveRework });

    expect(agg.rework.by_ticket).toHaveLength(1);
    const entry = agg.rework.by_ticket[0]!;
    expect(entry.ticket).toBe(1);
    expect(entry.rework_count).toBe(2);
    expect(entry.ticket_cost_usd).toBeCloseTo(0.9);
    expect(entry.rework_cost_usd).toBeCloseTo(0.6);

    expect(agg.rework.total_rework_cost_usd).toBeCloseTo(0.6);
    // 0.6 of 1.4 total ≈ 42.9%
    expect(agg.rework.rework_cost_share_pct).toBeCloseTo(42.9, 1);
  });
});

describe("aggregateHealthRows — NEGATIVE CONTROL", () => {
  it("an unmeasured, ticket-less row must not count toward spend, tickets, or measured coverage", () => {
    const rows = [
      makeRow({ ticket: 1, measured: true, total_cost_usd: 0.5 }),
      // The decoy: unmeasured AND ticket-less. It exists (so total_count = 2),
      // but must add $0, no ticket, and must NOT inflate measured_count.
      makeRow({ ticket: null, measured: false, total_cost_usd: 0, num_turns: 0 }),
    ];
    const agg = aggregateHealthRows(rows, { shippedCount: 1 });

    expect(agg.total_usd).toBeCloseTo(0.5); // decoy adds nothing
    expect(agg.ticket_count).toBe(1); // decoy has no ticket
    expect(agg.coverage.measured_count).toBe(1); // decoy is not measured
    expect(agg.coverage.total_count).toBe(2); // but it is still a row
    expect(agg.cost_per_shipped_usd).toBeCloseTo(0.5);
  });
});

// ---------------------------------------------------------------------------
// readHealthRows + aggregateHealth (file + env path)
// ---------------------------------------------------------------------------

describe("readHealthRows / aggregateHealth", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "gaffer-health-test-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns [] when the ledger file is absent", () => {
    expect(readHealthRows(join(tmpDir, "nope.jsonl"))).toEqual([]);
  });

  it("reads valid rows and skips malformed lines", () => {
    const ledger = join(tmpDir, "usage-ledger.jsonl");
    writeFileSync(
      ledger,
      [
        JSON.stringify({ ts: "2025-01-15T10:00:00Z", ticket: 1, measured: true, total_cost_usd: 0.1 }),
        "GARBAGE",
        "",
        JSON.stringify({ ts: "2025-01-15T11:00:00Z", ticket: 2, measured: false }),
      ].join("\n"),
    );
    const rows = readHealthRows(ledger);
    expect(rows).toHaveLength(2);
  });

  it("aggregateHealth returns zero-state when neither env var is set", () => {
    const agg = aggregateHealth({});
    expect(agg.total_usd).toBe(0);
    expect(agg.coverage.total_count).toBe(0);
  });

  it("aggregateHealth reads GAFFER_USAGE_LEDGER end-to-end", () => {
    const ledger = join(tmpDir, "custom.jsonl");
    writeFileSync(
      ledger,
      JSON.stringify({
        ts: "2025-01-15T10:00:00Z",
        ticket: 3,
        kind: "delivery",
        measured: true,
        total_cost_usd: 1.5,
        duration_ms: 5000,
      }),
    );
    const agg = aggregateHealth({ GAFFER_USAGE_LEDGER: ledger }, { shippedCount: 3 });
    expect(agg.total_usd).toBeCloseTo(1.5);
    expect(agg.cost_per_shipped_usd).toBeCloseTo(0.5);
    expect(agg.coverage.coverage_pct).toBe(100);
  });
});

/**
 * Unit tests for packages/dispatch/src/cost/costAggregator.ts
 *
 * Covers:
 *   - aggregation math (costs summed per-ticket, per-repo, and grand total)
 *   - malformed-line tolerance (skip bad JSON, partial rows, unknown sentinels)
 *   - budget-remaining computation
 *   - today's spend helper
 *   - ledger-path resolution from the env
 *   - zero-state when ledger is absent
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  aggregateRows,
  computeBudgetRemaining,
  parseLedgerLine,
  readLedgerRows,
  resolveLedgerPath,
  todaySpend,
  type LedgerRow,
} from "../src/cost/costAggregator.js";

// ---------------------------------------------------------------------------
// parseLedgerLine
// ---------------------------------------------------------------------------

describe("parseLedgerLine", () => {
  it("parses a well-formed measured row", () => {
    const raw = JSON.stringify({
      ts: "2025-01-15T10:00:00.000Z",
      ticket: 42,
      kind: "delivery",
      measured: true,
      total_cost_usd: 0.1234,
      num_turns: 7,
      duration_ms: 30000,
    });
    const row = parseLedgerLine(raw);
    expect(row).not.toBeNull();
    expect(row!.ticket).toBe(42);
    expect(row!.total_cost_usd).toBeCloseTo(0.1234);
    expect(row!.num_turns).toBe(7);
    expect(row!.measured).toBe(true);
  });

  it("parses a ticket number given as a string", () => {
    const raw = JSON.stringify({
      ts: "2025-01-15T10:00:00Z",
      ticket: "7",
      measured: true,
      total_cost_usd: 0.05,
      num_turns: 2,
      duration_ms: 1000,
    });
    const row = parseLedgerLine(raw);
    expect(row!.ticket).toBe(7);
  });

  it("returns null for empty / whitespace-only lines", () => {
    expect(parseLedgerLine("")).toBeNull();
    expect(parseLedgerLine("   ")).toBeNull();
    expect(parseLedgerLine("\n")).toBeNull();
  });

  it("returns null for non-JSON text", () => {
    expect(parseLedgerLine("not json at all")).toBeNull();
    expect(parseLedgerLine("{broken")).toBeNull();
  });

  it("returns null for JSON arrays and scalars", () => {
    expect(parseLedgerLine("[1,2,3]")).toBeNull();
    expect(parseLedgerLine('"string"')).toBeNull();
    expect(parseLedgerLine("42")).toBeNull();
  });

  it("tolerates missing numeric fields — defaults to 0", () => {
    const raw = JSON.stringify({
      ts: "2025-01-15T10:00:00Z",
      ticket: 1,
      kind: "delivery",
      measured: true,
    });
    const row = parseLedgerLine(raw);
    expect(row!.total_cost_usd).toBe(0);
    expect(row!.num_turns).toBe(0);
    expect(row!.duration_ms).toBe(0);
  });

  it('treats "unknown" sentinel values as 0', () => {
    const raw = JSON.stringify({
      ts: "2025-01-15T10:00:00Z",
      ticket: 99,
      kind: "delivery",
      measured: true,
      total_cost_usd: "unknown",
      num_turns: "unknown",
      duration_ms: "unknown",
    });
    const row = parseLedgerLine(raw);
    expect(row!.total_cost_usd).toBe(0);
    expect(row!.num_turns).toBe(0);
  });

  it("contributes 0 cost when measured=false", () => {
    const raw = JSON.stringify({
      ts: "2025-01-15T10:00:00Z",
      ticket: 5,
      measured: false,
      total_cost_usd: 9.99,
      num_turns: 100,
    });
    const row = parseLedgerLine(raw);
    expect(row!.measured).toBe(false);
    expect(row!.total_cost_usd).toBe(0);
    expect(row!.num_turns).toBe(0);
  });

  it("allows null ticket (no ticket context)", () => {
    const raw = JSON.stringify({
      ts: "2025-01-15T10:00:00Z",
      ticket: null,
      measured: true,
      total_cost_usd: 0.01,
      num_turns: 1,
    });
    const row = parseLedgerLine(raw);
    expect(row!.ticket).toBeNull();
  });

  it("handles a ticket-less kind=decompose row", () => {
    const raw = JSON.stringify({
      ts: "2025-01-15T10:00:00Z",
      kind: "decompose",
      measured: true,
      total_cost_usd: 0.25,
      num_turns: 10,
    });
    const row = parseLedgerLine(raw);
    expect(row!.ticket).toBeNull();
    expect(row!.total_cost_usd).toBeCloseTo(0.25);
  });
});

// ---------------------------------------------------------------------------
// aggregateRows — math
// ---------------------------------------------------------------------------

describe("aggregateRows — math", () => {
  const makeRow = (overrides: Partial<LedgerRow>): LedgerRow => ({
    ts: "2025-01-15T10:00:00Z",
    ticket: null,
    kind: "delivery",
    measured: true,
    total_cost_usd: 0,
    num_turns: 0,
    duration_ms: 0,
    ...overrides,
  });

  it("returns zero-state for an empty row set", () => {
    const agg = aggregateRows([]);
    expect(agg.total_usd).toBe(0);
    expect(agg.ticket_count).toBe(0);
    expect(agg.by_ticket).toHaveLength(0);
    expect(agg.by_repo).toHaveLength(0);
    expect(agg.last_record_at).toBeNull();
  });

  it("sums costs across rows for the same ticket", () => {
    const rows = [
      makeRow({ ticket: 1, total_cost_usd: 0.1, num_turns: 5 }),
      makeRow({ ticket: 1, total_cost_usd: 0.05, num_turns: 3 }),
      makeRow({ ticket: 2, total_cost_usd: 0.2, num_turns: 8 }),
    ];
    const agg = aggregateRows(rows);
    expect(agg.total_usd).toBeCloseTo(0.35);
    expect(agg.ticket_count).toBe(2);

    const t1 = agg.by_ticket.find((t) => t.ticket === 1)!;
    expect(t1.total_cost_usd).toBeCloseTo(0.15);
    expect(t1.num_turns).toBe(8);

    const t2 = agg.by_ticket.find((t) => t.ticket === 2)!;
    expect(t2.total_cost_usd).toBeCloseTo(0.2);
  });

  it("groups by repo via the resolver, summing distinct tickets", () => {
    const rows = [
      makeRow({ ticket: 1, total_cost_usd: 0.1 }),
      makeRow({ ticket: 2, total_cost_usd: 0.2 }),
      makeRow({ ticket: 3, total_cost_usd: 0.3 }),
    ];
    const resolver = (n: number) => (n <= 2 ? "repo-a" : "repo-b");
    const agg = aggregateRows(rows, resolver);

    const ra = agg.by_repo.find((r) => r.repo === "repo-a")!;
    expect(ra.total_cost_usd).toBeCloseTo(0.3);
    expect(ra.ticket_count).toBe(2);

    const rb = agg.by_repo.find((r) => r.repo === "repo-b")!;
    expect(rb.total_cost_usd).toBeCloseTo(0.3);
    expect(rb.ticket_count).toBe(1);
  });

  it("assigns unresolved tickets to the (unlinked) bucket", () => {
    const rows = [makeRow({ ticket: 99, total_cost_usd: 0.5 })];
    const agg = aggregateRows(rows, () => null);
    const unlinked = agg.by_repo.find((r) => r.repo === "(unlinked)");
    expect(unlinked).toBeDefined();
    expect(unlinked!.total_cost_usd).toBeCloseTo(0.5);
  });

  it("sorts by_ticket and by_repo descending by cost", () => {
    const rows = [
      makeRow({ ticket: 1, total_cost_usd: 0.01 }),
      makeRow({ ticket: 2, total_cost_usd: 0.99 }),
      makeRow({ ticket: 3, total_cost_usd: 0.5 }),
    ];
    const agg = aggregateRows(rows);
    expect(agg.by_ticket[0]!.ticket).toBe(2);
    expect(agg.by_ticket[1]!.ticket).toBe(3);
    expect(agg.by_ticket[2]!.ticket).toBe(1);
  });

  it("tracks the most recent ts as last_record_at", () => {
    const rows = [
      makeRow({ ts: "2025-01-10T00:00:00Z" }),
      makeRow({ ts: "2025-01-15T12:00:00Z" }),
      makeRow({ ts: "2025-01-12T06:00:00Z" }),
    ];
    const agg = aggregateRows(rows);
    expect(agg.last_record_at).toBe("2025-01-15T12:00:00Z");
  });

  it("ignores null-ticket rows in by_ticket / by_repo counts", () => {
    const rows = [
      makeRow({ ticket: null, total_cost_usd: 0.99 }),
      makeRow({ ticket: 1, total_cost_usd: 0.01 }),
    ];
    const agg = aggregateRows(rows);
    // total_usd includes the null-ticket row
    expect(agg.total_usd).toBeCloseTo(1.0);
    // but ticket_count only counts distinct ticket numbers
    expect(agg.ticket_count).toBe(1);
    // null-ticket row not in by_ticket
    expect(agg.by_ticket.find((t) => t.ticket === null)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// readLedgerRows — file I/O with malformed-line tolerance
// ---------------------------------------------------------------------------

describe("readLedgerRows", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "gaffer-cost-test-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns [] when the file does not exist", () => {
    expect(readLedgerRows(join(tmpDir, "nonexistent.jsonl"))).toEqual([]);
  });

  it("reads valid rows and skips malformed lines", () => {
    const ledger = join(tmpDir, "usage-ledger.jsonl");
    const good1 = JSON.stringify({
      ts: "2025-01-15T10:00:00Z",
      ticket: 1,
      measured: true,
      total_cost_usd: 0.1,
      num_turns: 3,
    });
    const good2 = JSON.stringify({
      ts: "2025-01-15T11:00:00Z",
      ticket: 2,
      measured: true,
      total_cost_usd: 0.2,
      num_turns: 5,
    });
    writeFileSync(ledger, [good1, "THIS IS NOT JSON", "{broken", "", good2].join("\n"));

    const rows = readLedgerRows(ledger);
    // Only 2 valid rows despite 5 lines
    expect(rows).toHaveLength(2);
    expect(rows[0]!.ticket).toBe(1);
    expect(rows[1]!.ticket).toBe(2);
  });

  it("returns [] for an empty file", () => {
    const ledger = join(tmpDir, "empty.jsonl");
    writeFileSync(ledger, "");
    expect(readLedgerRows(ledger)).toEqual([]);
  });

  it("handles a file with only blank lines", () => {
    const ledger = join(tmpDir, "blanks.jsonl");
    writeFileSync(ledger, "\n\n\n");
    expect(readLedgerRows(ledger)).toEqual([]);
  });

  it("accumulates many rows correctly", () => {
    const ledger = join(tmpDir, "many.jsonl");
    const lines = Array.from({ length: 20 }, (_, i) =>
      JSON.stringify({
        ts: "2025-01-15T10:00:00Z",
        ticket: i + 1,
        measured: true,
        total_cost_usd: 0.01,
        num_turns: 1,
      }),
    );
    writeFileSync(ledger, lines.join("\n"));
    const rows = readLedgerRows(ledger);
    expect(rows).toHaveLength(20);
  });
});

// ---------------------------------------------------------------------------
// computeBudgetRemaining
// ---------------------------------------------------------------------------

describe("computeBudgetRemaining", () => {
  it("returns null when budget is null (unlimited)", () => {
    expect(computeBudgetRemaining(null, 1.23)).toBeNull();
  });

  it("returns null when budget is 0 (unlimited)", () => {
    expect(computeBudgetRemaining(0, 0.5)).toBeNull();
  });

  it("returns null when budget is negative", () => {
    expect(computeBudgetRemaining(-5, 0)).toBeNull();
  });

  it("returns remaining headroom when spend < budget", () => {
    const r = computeBudgetRemaining(10.0, 3.5);
    expect(r).toBeCloseTo(6.5);
  });

  it("returns 0 when spend equals budget", () => {
    expect(computeBudgetRemaining(5.0, 5.0)).toBe(0);
  });

  it("returns 0 when spend exceeds budget (clamped, never negative)", () => {
    expect(computeBudgetRemaining(5.0, 7.0)).toBe(0);
  });

  it("handles floating-point spend correctly", () => {
    const r = computeBudgetRemaining(1.0, 0.1 + 0.2); // classic 0.30000000000000004
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThan(1.0);
  });
});

// ---------------------------------------------------------------------------
// todaySpend
// ---------------------------------------------------------------------------

describe("todaySpend", () => {
  it("sums only today's rows", () => {
    const today = new Date().toISOString().slice(0, 10);
    const rows: LedgerRow[] = [
      {
        ts: `${today}T10:00:00Z`,
        ticket: 1,
        kind: "delivery",
        measured: true,
        total_cost_usd: 0.1,
        num_turns: 1,
        duration_ms: 0,
      },
      {
        ts: `${today}T11:00:00Z`,
        ticket: 2,
        kind: "delivery",
        measured: true,
        total_cost_usd: 0.05,
        num_turns: 1,
        duration_ms: 0,
      },
      {
        ts: "2020-01-01T00:00:00Z",
        ticket: 3,
        kind: "delivery",
        measured: true,
        total_cost_usd: 9.99,
        num_turns: 1,
        duration_ms: 0,
      },
    ];
    expect(todaySpend(rows)).toBeCloseTo(0.15);
  });

  it("returns 0 when no rows fall on today", () => {
    const rows: LedgerRow[] = [
      {
        ts: "2020-01-01T00:00:00Z",
        ticket: 1,
        kind: "delivery",
        measured: true,
        total_cost_usd: 1.0,
        num_turns: 1,
        duration_ms: 0,
      },
    ];
    expect(todaySpend(rows)).toBe(0);
  });

  it("returns 0 for an empty row set", () => {
    expect(todaySpend([])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// resolveLedgerPath
// ---------------------------------------------------------------------------

describe("resolveLedgerPath", () => {
  it("returns GAFFER_USAGE_LEDGER when set", () => {
    expect(resolveLedgerPath({ GAFFER_USAGE_LEDGER: "/custom/path.jsonl" })).toBe(
      "/custom/path.jsonl",
    );
  });

  it("derives path from GAFFER_DATA when GAFFER_USAGE_LEDGER is absent", () => {
    const p = resolveLedgerPath({ GAFFER_DATA: "/var/gaffer" });
    expect(p).toBe("/var/gaffer/usage-ledger.jsonl");
  });

  it("returns null when neither is set", () => {
    expect(resolveLedgerPath({})).toBeNull();
  });

  it("prefers GAFFER_USAGE_LEDGER over GAFFER_DATA", () => {
    const p = resolveLedgerPath({ GAFFER_USAGE_LEDGER: "/explicit.jsonl", GAFFER_DATA: "/data" });
    expect(p).toBe("/explicit.jsonl");
  });
});

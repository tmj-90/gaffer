/**
 * B28(e) — the dashboard's cost tiles must count the labelled ESTIMATE the runner
 * books for a killed / timed-out call, marked as an estimate.
 *
 * Live audit: the runner's day-USD cap (lib/budget.sh gaffer_day_usd_spent) and the
 * budget headroom sum `total_cost_usd` PLUS `estimated_cost_usd`, but the dashboard's
 * aggregators dropped every unmeasured row's estimate — so "Today" could read LOWER
 * than the figure the daemon had just halted on. Covers:
 *   - parseLedgerLine / parseHealthLine keep the estimate of an unmeasured
 *     `estimated:true` row (and ignore one on a measured row — never double-count)
 *   - aggregateRows / todaySpend / aggregateHealthRows include it in the totals and
 *     report the estimated share separately
 *   - a plain "unknown" row (no estimate) still contributes $0 [negative control]
 *   - GET /api/cost carries estimated_usd + today_estimated_usd
 *   - the two budget knobs the audit found missing from the Settings allow-list
 *     (GAFFER_DAILY_BUDGET_USD, DISPATCH_MAX_ATTEMPTS) are present with their types
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApiServer } from "../src/api/server.js";
import { SETTING_DEFS } from "../src/api/settings.js";
import { Dispatch } from "../src/core.js";
import {
  aggregateRows,
  parseLedgerLine,
  todayEstimatedSpend,
  todaySpend,
} from "../src/cost/costAggregator.js";
import { aggregateHealthRows, parseHealthLine } from "../src/health/healthAggregator.js";
import { TestClock } from "../src/util/clock.js";

const today = new Date().toISOString().slice(0, 10);

const measured = (ticket: number, cost: number, ts = `${today}T10:00:00Z`) =>
  JSON.stringify({
    ts,
    ticket,
    kind: "delivery",
    measured: true,
    total_cost_usd: cost,
    num_turns: 3,
    duration_ms: 1000,
  });
// Exactly what lib/usage-ledger.mjs estimatedRecord writes for a killed call.
const killed = (ticket: number, est: number, ts = `${today}T11:00:00Z`) =>
  JSON.stringify({
    ts,
    ticket,
    kind: "delivery",
    measured: false,
    total_cost_usd: "unknown",
    num_turns: "unknown",
    duration_ms: "unknown",
    reason: "claude call timed out (rc=124)",
    estimated: true,
    estimated_cost_usd: est,
    estimate_basis: "flat-floor",
  });
const unknown = (ticket: number, ts = `${today}T12:00:00Z`) =>
  JSON.stringify({
    ts,
    ticket,
    kind: "delivery",
    measured: false,
    total_cost_usd: "unknown",
    num_turns: "unknown",
  });

describe("cost aggregator — killed/timeout estimates count, marked", () => {
  it("parseLedgerLine keeps the labelled estimate of an unmeasured row", () => {
    const row = parseLedgerLine(killed(7, 0.05))!;
    expect(row.measured).toBe(false);
    expect(row.total_cost_usd).toBe(0);
    expect(row.estimated_cost_usd).toBeCloseTo(0.05);
  });

  it("a measured row never carries an estimate (no double count) and a plain unknown row has none", () => {
    const m = parseLedgerLine(
      JSON.stringify({
        ts: `${today}T10:00:00Z`,
        ticket: 1,
        measured: true,
        total_cost_usd: 0.2,
        estimated: true,
        estimated_cost_usd: 9,
      }),
    )!;
    expect(m.total_cost_usd).toBeCloseTo(0.2);
    expect(m.estimated_cost_usd).toBe(0);
    expect(parseLedgerLine(unknown(2))!.estimated_cost_usd).toBe(0);
  });

  it("aggregateRows and todaySpend sum measured + estimated — the runner's day-cap figure", () => {
    const rows = [
      measured(1, 0.4),
      killed(1, 0.2),
      unknown(2),
      measured(3, 9.99, "2020-01-01T00:00:00Z"),
    ]
      .map(parseLedgerLine)
      .map((r) => r!);
    const agg = aggregateRows(rows);
    expect(agg.total_usd).toBeCloseTo(10.59); // 0.4 + 0.2 + 9.99; the unknown row adds 0
    expect(agg.estimated_usd).toBeCloseTo(0.2);
    expect(agg.by_ticket.find((t) => t.ticket === 1)!.total_cost_usd).toBeCloseTo(0.6);
    // Today: measured 0.40 + estimated 0.20 = 0.60 — matches gaffer_day_usd_spent.
    expect(todaySpend(rows)).toBeCloseTo(0.6);
    expect(todayEstimatedSpend(rows)).toBeCloseTo(0.2);
  });

  it("health aggregator counts the estimate in totals / by_kind / daily_spend but never as measured coverage", () => {
    const rows = [measured(1, 0.4), killed(1, 0.2), unknown(2)].map(parseHealthLine).map((r) => r!);
    expect(rows[1]!.estimated_cost_usd).toBeCloseTo(0.2);
    const agg = aggregateHealthRows(rows);
    expect(agg.total_usd).toBeCloseTo(0.6);
    expect(agg.estimated_usd).toBeCloseTo(0.2);
    expect(agg.by_kind.find((k) => k.kind === "delivery")!.total_cost_usd).toBeCloseTo(0.6);
    expect(agg.daily_spend.find((d) => d.date === today)!.total_cost_usd).toBeCloseTo(0.6);
    // The estimate is still an UNMEASURED call for the honesty gap.
    expect(agg.coverage.measured_count).toBe(1);
    expect(agg.coverage.total_count).toBe(3);
  });
});

describe("GET /api/cost — estimated spend is in the envelope", () => {
  let tmpDir: string;
  let baseUrl = "";
  let close: () => Promise<void> = async () => {};
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "gaffer-cost-est-"));
    for (const k of [
      "GAFFER_DATA",
      "GAFFER_USAGE_LEDGER",
      "DISPATCH_API_TOKEN",
      "DISPATCH_AUDIT_OFF",
    ]) {
      saved[k] = process.env[k];
    }
    delete process.env.DISPATCH_API_TOKEN;
    delete process.env.GAFFER_USAGE_LEDGER;
    process.env.GAFFER_DATA = tmpDir;
    process.env.DISPATCH_AUDIT_OFF = "1";
    writeFileSync(
      join(tmpDir, "usage-ledger.jsonl"),
      [measured(1, 0.4), killed(1, 0.2), unknown(2)].join("\n"),
    );
    const wg = Dispatch.open(":memory:", new TestClock());
    const server = createApiServer(wg);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          wg.db.close();
          resolve();
        });
      });
  });

  afterEach(async () => {
    await close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("today_usd includes the estimate; the estimated share rides alongside", async () => {
    const res = await fetch(`${baseUrl}/api/cost`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, number>;
    expect(body.total_usd).toBeCloseTo(0.6);
    expect(body.today_usd).toBeCloseTo(0.6);
    expect(body.estimated_usd).toBeCloseTo(0.2);
    expect(body.today_estimated_usd).toBeCloseTo(0.2);
  });
});

describe("Settings allow-list — the budget knobs the runner enforces are exposed", () => {
  it("GAFFER_DAILY_BUDGET_USD is a budget setting (decimal string)", () => {
    const def = SETTING_DEFS.find((d) => d.key === "GAFFER_DAILY_BUDGET_USD");
    expect(def).toBeDefined();
    expect(def!.group).toBe("budget");
    expect(def!.type).toBe("string");
    expect(def!.help).toMatch(/UTC/);
  });

  it("DISPATCH_MAX_ATTEMPTS is a budget setting (int) whose help names its real semantics", () => {
    const def = SETTING_DEFS.find((d) => d.key === "DISPATCH_MAX_ATTEMPTS");
    expect(def).toBeDefined();
    expect(def!.group).toBe("budget");
    expect(def!.type).toBe("int");
    expect(def!.help).toMatch(/reject/i);
    expect(def!.help).toMatch(/Max delivery attempts/);
  });
});

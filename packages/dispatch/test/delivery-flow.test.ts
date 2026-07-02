/**
 * Unit tests for packages/dispatch/src/health/deliveryFlow.ts — the single
 * authoritative cycle-time/throughput definition the Overview now reads.
 *
 * Guards that the server-side maths reproduces the old client computation so the
 * displayed numbers do not move, and covers zero-state + a negative control.
 */

import { describe, expect, it } from "vitest";

import { deliveryFlow, type FlowTicket } from "../src/health/deliveryFlow.js";

const DAY = 86_400_000;
// A fixed "now" so the 14-day window is deterministic.
const NOW = Date.parse("2025-01-15T12:00:00Z");

const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();

describe("deliveryFlow — zero-state", () => {
  it("returns zeros for no tickets", () => {
    const flow = deliveryFlow([], NOW);
    expect(flow.cycle_time.median_days).toBe(0);
    expect(flow.cycle_time.series).toHaveLength(14);
    expect(flow.cycle_time.series.every((v) => v === 0)).toBe(true);
    expect(flow.throughput.last7).toBe(0);
    expect(flow.throughput.prev7).toBe(0);
    expect(flow.throughput.series).toHaveLength(14);
  });
});

describe("deliveryFlow — cycle time", () => {
  it("takes the median created→done duration in days over done tickets", () => {
    const tickets: FlowTicket[] = [
      { status: "done", created_at: daysAgo(4), updated_at: daysAgo(2) }, // 2 days
      { status: "done", created_at: daysAgo(9), updated_at: daysAgo(5) }, // 4 days
      { status: "done", created_at: daysAgo(7), updated_at: daysAgo(1) }, // 6 days
    ];
    const flow = deliveryFlow(tickets, NOW);
    expect(flow.cycle_time.median_days).toBeCloseTo(4);
  });

  it("only counts done tickets (a NEGATIVE CONTROL: in-flight rows are ignored)", () => {
    const tickets: FlowTicket[] = [
      { status: "done", created_at: daysAgo(3), updated_at: daysAgo(1) }, // 2 days
      // Decoy: an in_progress ticket with a huge age that must NOT skew cycle time
      // or throughput. It is not shipped, so it contributes nothing.
      { status: "in_progress", created_at: daysAgo(13), updated_at: daysAgo(1) },
    ];
    const flow = deliveryFlow(tickets, NOW);
    expect(flow.cycle_time.median_days).toBeCloseTo(2);
    expect(flow.throughput.last7).toBe(1); // only the done ticket shipped
  });
});

describe("deliveryFlow — throughput", () => {
  it("buckets shipped tickets per day and splits last7 vs prev7", () => {
    const tickets: FlowTicket[] = [
      // last 7 days (indices 7..13): 2 shipped
      { status: "done", created_at: daysAgo(5), updated_at: daysAgo(1) },
      { status: "done", created_at: daysAgo(6), updated_at: daysAgo(3) },
      // prior 7 days (indices 0..6): 1 shipped
      { status: "done", created_at: daysAgo(12), updated_at: daysAgo(10) },
      // outside the 14-day window: ignored
      { status: "done", created_at: daysAgo(40), updated_at: daysAgo(30) },
    ];
    const flow = deliveryFlow(tickets, NOW);
    expect(flow.throughput.last7).toBe(2);
    expect(flow.throughput.prev7).toBe(1);
    // series length == window, sum of in-window shipments == 3
    expect(flow.throughput.series).toHaveLength(14);
    expect(flow.throughput.series.reduce((a, b) => a + b, 0)).toBe(3);
  });

  it("reproduces the old client series shape (oldest→newest, carried-forward cycle)", () => {
    const tickets: FlowTicket[] = [
      { status: "done", created_at: daysAgo(2), updated_at: daysAgo(0) }, // today, 2d
    ];
    const flow = deliveryFlow(tickets, NOW);
    // The last series slot (today) carries the 2-day cycle; earlier slots are 0.
    expect(flow.cycle_time.series[13]).toBeCloseTo(2);
    expect(flow.cycle_time.series[0]).toBe(0);
  });
});

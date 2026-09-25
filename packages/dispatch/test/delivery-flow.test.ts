/**
 * Unit tests for packages/dispatch/src/health/deliveryFlow.ts — the single
 * authoritative cycle-time/throughput definition the Overview now reads.
 *
 * Guards that the server-side maths reproduces the old client computation so the
 * displayed numbers do not move, and covers zero-state + a negative control.
 */

import { describe, expect, it } from "vitest";

import {
  deliveryFlow,
  flowSignalsFromTransitions,
  type FlowTicket,
  type FlowTransition,
} from "../src/health/deliveryFlow.js";

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

describe("deliveryFlow — event-derived completion (done_at beats updated_at)", () => {
  it("uses done_at for the cycle duration and the completion day when present", () => {
    // Shipped 2 days after creation, but touched again today (a note after shipping):
    // updated_at would report a 6-day cycle and count it as shipped today.
    const t: FlowTicket = {
      status: "done",
      created_at: daysAgo(6),
      updated_at: daysAgo(0),
      done_at: daysAgo(4),
    };
    const flow = deliveryFlow([t], NOW);
    expect(flow.cycle_time.median_days).toBeCloseTo(2);
    // Bucketed on the done day (index 13-4 = 9), not today (13).
    expect(flow.throughput.series[9]).toBe(1);
    expect(flow.throughput.series[13]).toBe(0);
  });

  it("falls back to updated_at when done_at is absent or unparseable (legacy tickets)", () => {
    const a: FlowTicket = { status: "done", created_at: daysAgo(3), updated_at: daysAgo(1) };
    const b: FlowTicket = {
      status: "done",
      created_at: daysAgo(3),
      updated_at: daysAgo(1),
      done_at: "not-a-date",
    };
    expect(deliveryFlow([a], NOW).cycle_time.median_days).toBeCloseTo(2);
    expect(deliveryFlow([b], NOW).cycle_time.median_days).toBeCloseTo(2);
  });
});

describe("deliveryFlow — flow efficiency", () => {
  it("is null (never a fake 0) when no shipped ticket carries the active-time signal", () => {
    const flow = deliveryFlow(
      [{ status: "done", created_at: daysAgo(3), updated_at: daysAgo(1) }],
      NOW,
    );
    expect(flow.flow_efficiency.median_pct).toBeNull();
    expect(flow.flow_efficiency.sample).toBe(0);
  });

  it("is the median of active/lead over shipped tickets, as a percentage", () => {
    const tickets: FlowTicket[] = [
      // 4-day lead, 1 day active → 25%
      {
        status: "done",
        created_at: daysAgo(5),
        updated_at: daysAgo(1),
        done_at: daysAgo(1),
        active_ms: DAY,
      },
      // 2-day lead, 1.5 days active → 75%
      {
        status: "done",
        created_at: daysAgo(3),
        updated_at: daysAgo(1),
        done_at: daysAgo(1),
        active_ms: 1.5 * DAY,
      },
      // 10-day lead, 5 days active → 50%
      {
        status: "done",
        created_at: daysAgo(11),
        updated_at: daysAgo(1),
        done_at: daysAgo(1),
        active_ms: 5 * DAY,
      },
      // not done → ignored
      { status: "in_review", created_at: daysAgo(2), updated_at: daysAgo(1), active_ms: DAY },
    ];
    const flow = deliveryFlow(tickets, NOW);
    expect(flow.flow_efficiency.median_pct).toBe(50);
    expect(flow.flow_efficiency.sample).toBe(3);
  });

  it("clamps a pathological active > lead ticket to 100", () => {
    const flow = deliveryFlow(
      [
        {
          status: "done",
          created_at: daysAgo(2),
          updated_at: daysAgo(1),
          done_at: daysAgo(1),
          active_ms: 5 * DAY,
        },
      ],
      NOW,
    );
    expect(flow.flow_efficiency.median_pct).toBe(100);
  });
});

describe("flowSignalsFromTransitions", () => {
  const at = (n: number) => daysAgo(n);
  const tr = (ticket_id: string, from: string | null, to: string, n: number): FlowTransition => ({
    ticket_id,
    from_status: from,
    to_status: to,
    created_at: at(n),
  });

  it("finds the LAST transition into done and sums time in active states before it", () => {
    const log: FlowTransition[] = [
      tr("t1", "draft", "ready", 10), // waiting
      tr("t1", "ready", "claimed", 8), // active from day -8
      tr("t1", "claimed", "in_progress", 7.5), // still active
      tr("t1", "in_progress", "blocked", 6), // waiting (2 active days so far)
      tr("t1", "blocked", "in_progress", 5), // active again
      tr("t1", "in_progress", "in_review", 4),
      tr("t1", "in_review", "ready_for_merge", 3),
      tr("t1", "ready_for_merge", "done", 2), // +3 active days → 5 total
    ];
    const sig = flowSignalsFromTransitions(log).get("t1");
    expect(sig?.done_at).toBe(at(2));
    expect(sig?.active_ms).toBeCloseTo(5 * DAY, -3);
  });

  it("ignores activity after the last done (a later reopen does not count) and picks the LAST done", () => {
    const log: FlowTransition[] = [
      tr("t2", "ready", "in_progress", 9),
      tr("t2", "in_progress", "done", 8), // first done: 1 active day
      tr("t2", "done", "in_review", 6), // reopened
      tr("t2", "in_review", "done", 5), // last done: +1 active day
      tr("t2", "done", "in_review", 1), // reopened again after the last done — ignored
    ];
    const sig = flowSignalsFromTransitions(log).get("t2");
    expect(sig?.done_at).toBe(at(5));
    expect(sig?.active_ms).toBeCloseTo(2 * DAY, -3);
  });

  it("yields null signals for a ticket that never reached done", () => {
    const sig = flowSignalsFromTransitions([tr("t3", "ready", "in_progress", 2)]).get("t3");
    expect(sig).toEqual({ done_at: null, active_ms: null });
  });

  it("tolerates an unordered log (sorts by timestamp within a ticket)", () => {
    const log: FlowTransition[] = [
      tr("t4", "in_progress", "done", 1),
      tr("t4", "ready", "in_progress", 3),
    ];
    const sig = flowSignalsFromTransitions(log).get("t4");
    expect(sig?.active_ms).toBeCloseTo(2 * DAY, -3);
  });
});

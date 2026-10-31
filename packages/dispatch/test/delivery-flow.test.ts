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

  it("finds the LAST transition into done; only claimed/in_progress is work, the rest is waiting", () => {
    const log: FlowTransition[] = [
      tr("t1", "draft", "ready", 10), // waiting
      tr("t1", "ready", "claimed", 8), // active from day -8
      tr("t1", "claimed", "in_progress", 7.5), // still active
      tr("t1", "in_progress", "blocked", 6), // waiting (2 active days so far)
      tr("t1", "blocked", "in_progress", 5), // active again
      tr("t1", "in_progress", "in_review", 4), // +1 work day → 3 total
      tr("t1", "in_review", "ready_for_merge", 3), // 1 day in review: WAITING
      tr("t1", "ready_for_merge", "done", 2), // 1 day in the merge queue: WAITING
    ];
    const sig = flowSignalsFromTransitions(log).get("t1");
    expect(sig?.done_at).toBe(at(2));
    expect(sig?.active_ms).toBeCloseTo(3 * DAY, -3);
    expect(sig?.wait_ms?.held).toBeCloseTo(DAY, -3);
    expect(sig?.wait_ms?.review).toBeCloseTo(DAY, -3);
    expect(sig?.wait_ms?.merge).toBeCloseTo(DAY, -3);
  });

  it("ignores activity after the last done (a later reopen does not count) and picks the LAST done", () => {
    const log: FlowTransition[] = [
      tr("t2", "ready", "in_progress", 9),
      tr("t2", "in_progress", "done", 8), // first done: 1 active day
      tr("t2", "done", "in_review", 6), // reopened
      tr("t2", "in_review", "done", 5), // last done: +1 day in review (waiting)
      tr("t2", "done", "in_review", 1), // reopened again after the last done — ignored
    ];
    const sig = flowSignalsFromTransitions(log).get("t2");
    expect(sig?.done_at).toBe(at(5));
    expect(sig?.active_ms).toBeCloseTo(DAY, -3);
    expect(sig?.wait_ms?.review).toBeCloseTo(DAY, -3);
  });

  it("yields null signals for a ticket that never reached done", () => {
    const sig = flowSignalsFromTransitions([tr("t3", "ready", "in_progress", 2)]).get("t3");
    expect(sig).toEqual({ done_at: null, active_ms: null, wait_ms: null });
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

describe("flow efficiency: the merge queue is waiting, not work (third external review)", () => {
  const MIN = 60_000;
  it("11 minutes to merge-ready, then a week in the merge queue → far below 100%, a week's merge wait", () => {
    const created = NOW - 7 * DAY - 11 * MIN;
    const iso = (ms: number) => new Date(ms).toISOString();
    const log: FlowTransition[] = [
      { ticket_id: "w", from_status: "draft", to_status: "ready", created_at: iso(created) },
      {
        ticket_id: "w",
        from_status: "ready",
        to_status: "claimed",
        created_at: iso(created + MIN),
      },
      {
        ticket_id: "w",
        from_status: "claimed",
        to_status: "in_progress",
        created_at: iso(created + MIN),
      },
      {
        ticket_id: "w",
        from_status: "in_progress",
        to_status: "in_review",
        created_at: iso(created + 8 * MIN),
      },
      {
        ticket_id: "w",
        from_status: "in_review",
        to_status: "ready_for_merge",
        created_at: iso(created + 11 * MIN),
      },
      { ticket_id: "w", from_status: "ready_for_merge", to_status: "done", created_at: iso(NOW) },
    ];
    const sig = flowSignalsFromTransitions(log).get("w")!;
    const flow = deliveryFlow(
      [
        {
          status: "done",
          created_at: iso(created),
          updated_at: iso(NOW),
          done_at: sig.done_at,
          active_ms: sig.active_ms,
          wait_ms: sig.wait_ms,
        },
      ],
      NOW,
    );
    // 7 minutes of work over a week and 11 minutes of lead time.
    expect(flow.flow_efficiency.median_pct).not.toBeNull();
    expect(flow.flow_efficiency.median_pct!).toBeLessThan(1);
    expect(flow.waiting.merge_wait_ms).toBeCloseTo(7 * DAY, -4);
    expect(flow.waiting.merge_wait_max_ms).toBeCloseTo(7 * DAY, -4);
    expect(flow.waiting.review_ms).toBeCloseTo(3 * MIN, -3);
    expect(flow.waiting.backlog_ms).toBeCloseTo(MIN, -3);
    expect(flow.waiting.queue_pct!).toBeGreaterThan(99);
    expect(flow.waiting.sample).toBe(1);
  });
});

describe("flow waiting: a send-back that waits in refining is queued after work began, not backlog", () => {
  const HOUR = 3_600_000;
  it("1h work, 1h review, rejected to refining, 72h there, 1h work, 1h review, 24h merge queue", () => {
    const created = NOW - 101 * HOUR;
    const iso = (ms: number) => new Date(ms).toISOString();
    const step = (from: string | null, to: string, h: number): FlowTransition => ({
      ticket_id: "s",
      from_status: from,
      to_status: to,
      created_at: iso(created + h * HOUR),
    });
    const log: FlowTransition[] = [
      step("draft", "ready", 0),
      step("ready", "claimed", 0),
      step("claimed", "in_progress", 0),
      step("in_progress", "in_review", 1), // 1h work
      step("in_review", "refining", 2), // 1h review, then the reviewer sends it back
      step("refining", "ready", 74), // 72h waiting for a human to refine it
      step("ready", "claimed", 74),
      step("claimed", "in_progress", 74),
      step("in_progress", "in_review", 75), // 1h work
      step("in_review", "ready_for_merge", 76), // 1h review
      step("ready_for_merge", "done", 100), // 24h merge queue
    ];
    const sig = flowSignalsFromTransitions(log).get("s")!;
    expect(sig.active_ms).toBeCloseTo(2 * HOUR, -3);
    expect(sig.wait_ms?.review).toBeCloseTo(2 * HOUR, -3);
    expect(sig.wait_ms?.merge).toBeCloseTo(24 * HOUR, -3);
    expect(sig.wait_ms?.requeued).toBeCloseTo(72 * HOUR, -3);
    expect(sig.wait_ms?.held).toBe(0);
    const flow = deliveryFlow(
      [
        {
          status: "done",
          created_at: iso(created),
          updated_at: iso(created + 100 * HOUR),
          done_at: sig.done_at,
          active_ms: sig.active_ms,
          wait_ms: sig.wait_ms,
        },
      ],
      NOW,
    );
    // Nothing happened before work started; the 72h is a send-back queue.
    expect(flow.waiting.backlog_ms).toBeCloseTo(0, -3);
    expect(flow.waiting.requeued_ms).toBeCloseTo(72 * HOUR, -3);
    expect(flow.waiting.queue_ms).toBeCloseTo(98 * HOUR, -3);
    expect(flow.waiting.queue_pct).toBe(98);
    expect(flow.flow_efficiency.median_pct).toBe(2);
  });

  it("time in draft / refining / ready (and a hold) before the first claim stays backlog", () => {
    const created = NOW - 10 * HOUR;
    const iso = (ms: number) => new Date(ms).toISOString();
    const step = (from: string | null, to: string, h: number): FlowTransition => ({
      ticket_id: "b",
      from_status: from,
      to_status: to,
      created_at: iso(created + h * HOUR),
    });
    const log: FlowTransition[] = [
      step("draft", "refining", 1),
      step("refining", "blocked", 2), // blocked on a dependency before any work
      step("blocked", "ready", 5),
      step("ready", "claimed", 6),
      step("claimed", "in_review", 8), // 2h work
      step("in_review", "done", 10), // 2h review
    ];
    const sig = flowSignalsFromTransitions(log).get("b")!;
    expect(sig.active_ms).toBeCloseTo(2 * HOUR, -3);
    expect(sig.wait_ms).toEqual({ review: 2 * HOUR, merge: 0, held: 0, requeued: 0 });
    const flow = deliveryFlow(
      [
        {
          status: "done",
          created_at: iso(created),
          updated_at: iso(created + 10 * HOUR),
          done_at: sig.done_at,
          active_ms: sig.active_ms,
          wait_ms: sig.wait_ms,
        },
      ],
      NOW,
    );
    expect(flow.waiting.backlog_ms).toBeCloseTo(6 * HOUR, -3);
    expect(flow.waiting.queue_pct).toBe(20);
    expect(flow.waiting.requeued_ms).toBe(0);
  });
});

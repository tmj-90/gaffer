import { describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import { makeHandlers } from "../src/mcp/tools.js";
import { type Actor } from "../src/domain/types.js";
import { TestClock } from "../src/util/clock.js";

const agentActor: Actor = { type: "agent", id: "mcp-agent" };
const systemActor: Actor = { type: "system" };

/**
 * FAILURE-DIAGNOSIS: the rework loop already DISTILLS the real failing test +
 * assertion each attempt, but the latest overwrites the previous in
 * `last_review_feedback`. These tests pin the durable APPEND-ONLY failure trail:
 *  - a ticket reworking 3× persists all 3 distilled failures (not just the latest);
 *  - the "why did #N fail" read model returns the full ordered trail;
 *  - the cross-ticket signal surfaces a ticket bouncing the SAME gate repeatedly.
 */
function seedTicket(wg: Dispatch, title = "T"): string {
  const h = makeHandlers(wg, agentActor);
  const created = h.create_ticket({ title, policy_pack: "solo_loose" }).structuredContent as {
    ticket_id: string;
  };
  return created.ticket_id;
}

describe("failure-diagnosis: the append-only rework failure trail", () => {
  it("persists ALL distilled failures across 3 rework attempts, not just the latest", () => {
    const wg = Dispatch.open(":memory:", new TestClock());
    const ticketId = seedTicket(wg);

    wg.recordReworkAttempt(
      {
        ticket_id: ticketId,
        attempt: 1,
        maxAttempts: 3,
        reason: "tests: expected 3 to be 4",
        gate: "tests",
        distilledFailure:
          "FAIL src/add.test.ts > adds\n  expected 3 to be 4\n    at add.test.ts:12:20",
      },
      systemActor,
    );
    wg.recordReworkAttempt(
      {
        ticket_id: ticketId,
        attempt: 2,
        maxAttempts: 3,
        reason: "tests: cannot read properties of undefined",
        gate: "tests",
        distilledFailure:
          "FAIL src/add.test.ts > adds\n  TypeError: cannot read properties of undefined (reading 'x')\n    at add.ts:4:9",
      },
      systemActor,
    );
    wg.recordReworkAttempt(
      {
        ticket_id: ticketId,
        attempt: 3,
        maxAttempts: 3,
        reason: "lint: no-unused-vars",
        gate: "lint",
        distilledFailure: "src/add.ts:2:7  error  'y' is assigned a value but never used",
      },
      systemActor,
    );

    const trail = wg.reworkTrail(ticketId);
    expect(trail).toHaveLength(3);

    // Ordered attempt 1 → 2 → 3.
    expect(trail.map((a) => a.attempt)).toEqual([1, 2, 3]);
    expect(trail.map((a) => a.gate)).toEqual(["tests", "tests", "lint"]);

    // The FULL distilled block is persisted for each (not the one-line summary),
    // and each attempt's distinct failure survives — nothing was overwritten.
    expect(trail[0]?.distilled_failure).toContain("expected 3 to be 4");
    expect(trail[0]?.distilled_failure).toContain("add.test.ts:12:20");
    expect(trail[1]?.distilled_failure).toContain("cannot read properties of undefined");
    expect(trail[2]?.distilled_failure).toContain("never used");

    // The board chip still reflects only the LATEST (last_review_feedback) — the
    // trail is the additive surface, the chip is the snapshot.
    const fb = wg.view(ticketId).ticket.last_review_feedback;
    expect(fb).toContain("no-unused-vars");
  });

  it("falls back to the short reason when the runner omits the full distilled block", () => {
    const wg = Dispatch.open(":memory:", new TestClock());
    const ticketId = seedTicket(wg);
    wg.recordReworkAttempt(
      { ticket_id: ticketId, attempt: 1, maxAttempts: 2, reason: "tests failed" },
      systemActor,
    );
    const trail = wg.reworkTrail(ticketId);
    expect(trail).toHaveLength(1);
    expect(trail[0]?.distilled_failure).toBe("tests failed");
    expect(trail[0]?.gate).toBeNull();
  });

  it("the ticket view carries the ordered trail (the 'why did #N fail' read model)", () => {
    const wg = Dispatch.open(":memory:", new TestClock());
    const ticketId = seedTicket(wg);
    wg.recordReworkAttempt(
      {
        ticket_id: ticketId,
        attempt: 1,
        maxAttempts: 2,
        reason: "a",
        gate: "tests",
        distilledFailure: "first",
      },
      systemActor,
    );
    wg.recordReworkAttempt(
      {
        ticket_id: ticketId,
        attempt: 2,
        maxAttempts: 2,
        reason: "b",
        gate: "tests",
        distilledFailure: "second",
      },
      systemActor,
    );
    const view = wg.view(ticketId);
    expect(view.reworkTrail.map((a) => a.distilled_failure)).toEqual(["first", "second"]);
  });

  it("surfaces a ticket that bounced the SAME gate repeatedly (cross-ticket signal)", () => {
    const wg = Dispatch.open(":memory:", new TestClock());
    const stubborn = seedTicket(wg, "Stubborn");
    const flaky = seedTicket(wg, "Flaky");
    const clean = seedTicket(wg, "Clean");

    // Stubborn: 3 attempts, ALL the SAME gate (tests) — the key signal.
    for (let i = 1; i <= 3; i++) {
      wg.recordReworkAttempt(
        {
          ticket_id: stubborn,
          attempt: i,
          maxAttempts: 3,
          reason: `t${i}`,
          gate: "tests",
          distilledFailure: `fail ${i}`,
        },
        systemActor,
      );
    }
    // Flaky: 2 attempts across DIFFERENT gates.
    wg.recordReworkAttempt(
      {
        ticket_id: flaky,
        attempt: 1,
        maxAttempts: 3,
        reason: "l",
        gate: "lint",
        distilledFailure: "lint fail",
      },
      systemActor,
    );
    wg.recordReworkAttempt(
      {
        ticket_id: flaky,
        attempt: 2,
        maxAttempts: 3,
        reason: "t",
        gate: "tests",
        distilledFailure: "test fail",
      },
      systemActor,
    );
    // Clean: a single rework — below the bounce floor (default 2).
    wg.recordReworkAttempt(
      {
        ticket_id: clean,
        attempt: 1,
        maxAttempts: 3,
        reason: "x",
        gate: "tests",
        distilledFailure: "one",
      },
      systemActor,
    );

    const bouncing = wg.bouncingTickets();
    const ids = bouncing.map((b) => b.ticket_id);

    // The clean single-rework ticket is below the floor — not surfaced.
    expect(ids).not.toContain(clean);
    // Both repeat-offenders surface.
    expect(ids).toContain(stubborn);
    expect(ids).toContain(flaky);

    // Stubborn leads: it repeatedly failed the SAME gate (tests ×3).
    expect(bouncing[0]?.ticket_id).toBe(stubborn);
    expect(bouncing[0]?.top_gate).toBe("tests");
    expect(bouncing[0]?.top_gate_count).toBe(3);
    expect(bouncing[0]?.rework_count).toBe(3);
    expect(bouncing[0]?.distinct_gates).toBe(1);

    // Flaky spread its failures across gates — its worst same-gate repeat is 1.
    const flakyRow = bouncing.find((b) => b.ticket_id === flaky);
    expect(flakyRow?.distinct_gates).toBe(2);
    expect(flakyRow?.top_gate_count).toBe(1);
  });

  it("respects the minReworks floor and the limit", () => {
    const wg = Dispatch.open(":memory:", new TestClock());
    const a = seedTicket(wg, "A");
    for (let i = 1; i <= 3; i++) {
      wg.recordReworkAttempt(
        {
          ticket_id: a,
          attempt: i,
          maxAttempts: 3,
          reason: "r",
          gate: "tests",
          distilledFailure: "f",
        },
        systemActor,
      );
    }
    // A 2-rework ticket is included by default (floor 2) but excluded at floor 4.
    expect(wg.bouncingTickets({ minReworks: 4 })).toHaveLength(0);
    expect(wg.bouncingTickets({ minReworks: 3 })).toHaveLength(1);
    expect(wg.bouncingTickets({ limit: 0 })).toHaveLength(0);
  });
});

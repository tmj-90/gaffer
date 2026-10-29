// resume-has-no-lease: a paused delivery holds no lease, and a resumed one is leased
// to the runner re-entering it. Case A (Continue pressed while the pre-pause lease
// was live) used to let that old lease lapse mid-resume and hand the live ticket to
// a second agent; case B (runner dies mid-resume) used to strand it in_progress for
// ever with no claim for the sweep to find.
import { describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { TestClock } from "../src/util/clock.js";

const human: Actor = { type: "human", id: "tom" };
const system: Actor = { type: "system" };

const CTX = {
  reason: "cap_hit" as const,
  branch_name: "gaffer/ticket-1-demo",
  worktree_path: "/data/worktrees/ticket-1/svc",
  attempt: 1,
  turns: 40,
  spend: "1.20",
};

function setup(clock: TestClock): {
  wg: Dispatch;
  ticketId: string;
  runnerId: string;
  otherId: string;
} {
  const wg = Dispatch.open(":memory:", clock);
  const t = wg.createTicket({ title: "big", description: "d", policy_pack: "solo_loose" }, human);
  wg.addAcceptanceCriterion({ ticket_id: t.id, text: "AC" }, human);
  wg.markReady(t.id, human);
  const runner = wg.registerAgent({ display_name: "runner" }, human);
  const other = wg.registerAgent({ display_name: "other" }, human);
  const claim = wg.claimNextTicket(
    { agentId: runner.id, ttlSeconds: 600 },
    { type: "agent", id: runner.id },
  );
  expect(claim?.ticketId).toBe(t.id);
  return { wg, ticketId: t.id, runnerId: runner.id, otherId: other.id };
}

function activeClaims(wg: Dispatch, ticketId: string): number {
  return (
    wg.db
      .prepare("SELECT COUNT(*) AS n FROM ticket_claims WHERE ticket_id = ? AND status = 'active'")
      .get(ticketId) as { n: number }
  ).n;
}

describe("resume-has-no-lease", () => {
  it("pausing releases the delivery's lease", () => {
    const { wg, ticketId } = setup(new TestClock());
    expect(activeClaims(wg, ticketId)).toBe(1);
    wg.pauseDelivery(ticketId, CTX, system);
    expect(wg.view(ticketId).ticket.status).toBe("paused");
    expect(activeClaims(wg, ticketId)).toBe(0);
    wg.db.close();
  });

  it("A: a resumed delivery holds its own heartbeated lease past the old TTL; no second agent gets it", () => {
    const clock = new TestClock();
    const { wg, ticketId, runnerId, otherId } = setup(clock);
    clock.advanceSeconds(100);
    wg.pauseDelivery(ticketId, CTX, system);
    wg.continuePaused(ticketId, human);
    clock.advanceSeconds(200); // Continue pressed while the pre-pause lease would be live
    const res = wg.beginResume(ticketId, system, { agentId: runnerId, ttlSeconds: 600 });
    expect(typeof res.claimToken).toBe("string");
    expect(activeClaims(wg, ticketId)).toBe(1);

    // The resumed delivery runs well past the pre-pause lease, heartbeating its own.
    for (let i = 0; i < 3; i++) {
      clock.advanceSeconds(400);
      wg.heartbeat(res.claimToken!);
    }
    expect(wg.expireStaleClaims(system).expired).toBe(0);
    expect(wg.view(ticketId).ticket.status).toBe("in_progress");
    expect(
      wg.claimNextTicket({ agentId: otherId, ttlSeconds: 600 }, { type: "agent", id: otherId }),
    ).toBeNull();

    // And it submits through the normal token-gated path.
    const sub = wg.submitForReview(
      { claimToken: res.claimToken!, ticket_id: ticketId, reason: "done" },
      { type: "agent", id: runnerId },
    );
    expect(sub.status).toBe("in_review");
    expect(activeClaims(wg, ticketId)).toBe(0);
    wg.db.close();
  });

  it("B: a crashed resume's lease lapses and the sweep returns it to paused, resumable again", () => {
    const clock = new TestClock();
    const { wg, ticketId, runnerId } = setup(clock);
    wg.pauseDelivery(ticketId, CTX, system);
    clock.advanceSeconds(12 * 3600); // paused overnight
    expect(wg.expireStaleClaims(system).expired).toBe(0); // nothing leased while paused
    wg.continuePaused(ticketId, human);
    wg.beginResume(ticketId, system, { agentId: runnerId, ttlSeconds: 600 });
    // ... and the runner dies mid-resume: no heartbeat, no submit, no release.
    clock.advanceSeconds(601);
    expect(wg.expireStaleClaims(system).expired).toBe(1);
    expect(wg.view(ticketId).ticket.status).toBe("paused");
    expect(activeClaims(wg, ticketId)).toBe(0);
    expect(wg.pausedContext(ticketId)?.resume_requested).toBe(0);

    // A human presses Continue again and the next resume picks it back up.
    wg.continuePaused(ticketId, human);
    const again = wg.beginResume(ticketId, system, { agentId: runnerId, ttlSeconds: 600 });
    expect(again.claimToken).toBeTruthy();
    expect(wg.view(ticketId).ticket.status).toBe("in_progress");
    wg.db.close();
  });

  it("a resumed delivery that is released ends its pause context, so a later fresh claim lapses to ready", () => {
    const clock = new TestClock();
    const { wg, ticketId, runnerId, otherId } = setup(clock);
    wg.pauseDelivery(ticketId, CTX, system);
    wg.continuePaused(ticketId, human);
    const res = wg.beginResume(ticketId, system, { agentId: runnerId, ttlSeconds: 600 });
    wg.runnerRelease({ ticket_id: ticketId, to: "ready", claimToken: res.claimToken! }, system);
    expect(wg.pausedContext(ticketId)).toBeNull();

    const fresh = wg.claimNextTicket(
      { agentId: otherId, ttlSeconds: 600 },
      { type: "agent", id: otherId },
    );
    expect(fresh?.ticketId).toBe(ticketId);
    clock.advanceSeconds(601);
    expect(wg.expireStaleClaims(system).expired).toBe(1);
    expect(wg.view(ticketId).ticket.status).toBe("ready");
    wg.db.close();
  });

  it("B': a lapsed resume lease found by another agent's claim goes back to paused, not to that agent", () => {
    const clock = new TestClock();
    const { wg, ticketId, runnerId, otherId } = setup(clock);
    wg.pauseDelivery(ticketId, CTX, system);
    wg.continuePaused(ticketId, human);
    wg.beginResume(ticketId, system, { agentId: runnerId, ttlSeconds: 600 });
    clock.advanceSeconds(601);
    expect(
      wg.claimNextTicket({ agentId: otherId, ttlSeconds: 600 }, { type: "agent", id: otherId }),
    ).toBeNull();
    expect(wg.view(ticketId).ticket.status).toBe("paused");
    wg.db.close();
  });
});

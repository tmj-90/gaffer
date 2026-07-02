// TRACK-2b: model the human's OWN in-flight work as a first-class lane.
//
// A human can take a ready ticket "by hand": it moves ready -> in_progress OWNED BY
// THE HUMAN, the agent selection loop STRUCTURALLY skips it, and the human can hand
// it back to the queue or carry it through the normal review path. These tests pin
// the invariants: the agent never picks up human-owned work, the ownership marker is
// tracked distinctly, and the release/review paths work.

import { beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { TestClock } from "../src/util/clock.js";
import { DispatchError } from "../src/util/errors.js";

const human: Actor = { type: "human", id: "tom" };
const agentActor: Actor = { type: "agent", id: "agent-runner" };

function freshWg(clock = new TestClock()): Dispatch {
  return Dispatch.open(":memory:", clock);
}

/** A ready, claimable solo_loose ticket. */
function readyTicket(wg: Dispatch, title = "Task"): string {
  const t = wg.createTicket({ title, policy_pack: "solo_loose" }, human);
  wg.addAcceptanceCriterion({ ticket_id: t.id, text: "AC" }, human);
  wg.markReady(t.id, human);
  return t.id;
}

describe("TRACK-2b: human takes a ticket by hand", () => {
  let wg: Dispatch;
  beforeEach(() => {
    wg = freshWg();
  });

  it("moves a ready ticket to in_progress owned by the human", () => {
    const ticketId = readyTicket(wg);
    const res = wg.humanClaimTicket(ticketId, human);
    expect(res.ticketId).toBe(ticketId);

    const view = wg.view(ticketId);
    expect(view.ticket.status).toBe("in_progress");
    expect(view.ticket.human_owner).toBe("tom");
  });

  it("records a ticket.human_claimed event with the owner", () => {
    const ticketId = readyTicket(wg);
    wg.humanClaimTicket(ticketId, human);
    const events = wg.listTicketEvents(ticketId).map((e) => e.event_type);
    expect(events).toContain("ticket.human_claimed");
  });

  it("refuses to take a ticket that is not ready", () => {
    const ticketId = readyTicket(wg);
    wg.humanClaimTicket(ticketId, human); // now in_progress (human-owned)
    // A second human-claim on the same (now in_progress) ticket is rejected.
    try {
      wg.humanClaimTicket(ticketId, human);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DispatchError);
      expect((err as DispatchError).code).toBe("TICKET_NOT_CLAIMABLE");
    }
  });

  it("refuses to take a ticket an agent already holds a claim on", () => {
    const ticketId = readyTicket(wg);
    const agent = wg.registerAgent({ display_name: "a1" }, human);
    wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 300 }, agentActor); // agent claims → claimed
    expect(() => wg.humanClaimTicket(ticketId, human)).toThrowError(DispatchError);
    // The agent's claim + status are untouched.
    expect(wg.view(ticketId).ticket.status).toBe("claimed");
    expect(wg.view(ticketId).ticket.human_owner).toBeNull();
  });
});

describe("TRACK-2b: the agent selection loop STRUCTURALLY skips human-owned work", () => {
  it("claimNextTicket never picks up a human-owned ticket", () => {
    const wg = freshWg();
    const mine = readyTicket(wg, "mine — by hand");
    wg.humanClaimTicket(mine, human); // mine -> in_progress (human)

    const agent = wg.registerAgent({ display_name: "a1" }, human);
    // The ONLY non-done ticket is human-owned → the agent gets nothing.
    expect(wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 300 }, agentActor)).toBeNull();
  });

  it("claimNextTicket picks the OTHER ready ticket and leaves the human's alone", () => {
    const wg = freshWg();
    const mine = readyTicket(wg, "mine");
    const theirs = readyTicket(wg, "agent's");
    wg.humanClaimTicket(mine, human);

    const agent = wg.registerAgent({ display_name: "a1" }, human);
    const claimed = wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 300 }, agentActor);
    expect(claimed?.ticketId).toBe(theirs);
    // The human's ticket is never touched by the factory tick.
    expect(wg.view(mine).ticket.status).toBe("in_progress");
    expect(wg.view(mine).ticket.human_owner).toBe("tom");
  });

  it("claimTicket (the runner's preselect-then-claim) refuses a human-owned ticket", () => {
    const wg = freshWg();
    const mine = readyTicket(wg, "mine");
    wg.humanClaimTicket(mine, human);
    const agent = wg.registerAgent({ display_name: "a1" }, human);
    // The runner's atomic claim-at-selection path must also refuse it structurally.
    expect(() =>
      wg.claimTicket({ ticket_id: mine, agent_id: agent.id, ttl_seconds: 300 }, agentActor),
    ).toThrowError(DispatchError);
  });
});

describe("TRACK-2b: hand-back + review paths", () => {
  let wg: Dispatch;
  beforeEach(() => {
    wg = freshWg();
  });

  it("hands a by-hand ticket back to ready and clears the marker (agent can reclaim)", () => {
    const ticketId = readyTicket(wg);
    wg.humanClaimTicket(ticketId, human);
    const rel = wg.humanReleaseTicket(ticketId, human);
    expect(rel.status).toBe("ready");
    expect(wg.view(ticketId).ticket.human_owner).toBeNull();

    const events = wg.listTicketEvents(ticketId).map((e) => e.event_type);
    expect(events).toContain("ticket.human_released");

    // Now an agent CAN pick it up (it's back in the agent-shaped queue).
    const agent = wg.registerAgent({ display_name: "a1" }, human);
    const claimed = wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 300 }, agentActor);
    expect(claimed?.ticketId).toBe(ticketId);
  });

  it("refuses to hand back a ticket that is not human-owned in-flight work", () => {
    const ticketId = readyTicket(wg);
    // Never taken by hand → nothing to hand back.
    try {
      wg.humanReleaseTicket(ticketId, human);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DispatchError);
      expect((err as DispatchError).code).toBe("TICKET_NOT_HUMAN_OWNED");
    }
  });

  it("carries a by-hand ticket through the normal review path, clearing the marker", () => {
    const ticketId = readyTicket(wg);
    wg.humanClaimTicket(ticketId, human);
    // The human submits their own work for review via the ordinary board move.
    const moved = wg.moveTicket(ticketId, "in_review", human);
    expect(moved.ticket.status).toBe("in_review");
    // Leaving in_progress clears the ownership marker — it's now review lane, not WIP.
    expect(wg.view(ticketId).ticket.human_owner).toBeNull();
  });

  it("does not clear the marker while the ticket stays in_progress", () => {
    const ticketId = readyTicket(wg);
    wg.humanClaimTicket(ticketId, human);
    // A no-op-ish read: the marker persists across reads while in-flight.
    expect(wg.view(ticketId).ticket.human_owner).toBe("tom");
  });
});

describe("TRACK-2b: the board surfaces human WIP distinctly", () => {
  it("a human-owned card carries humanOwner and no agent claim", () => {
    const wg = freshWg();
    const mine = readyTicket(wg, "mine");
    wg.humanClaimTicket(mine, human);

    const board = wg.board();
    const inProgress = board.columns.find((c) => c.column === "in_progress");
    const card = inProgress?.cards.find((c) => c.id === mine);
    expect(card).toBeTruthy();
    expect(card?.humanOwner).toBe("tom");
    expect(card?.claim).toBeNull();
  });

  it("an agent-claimed card has no humanOwner", () => {
    const wg = freshWg();
    const theirs = readyTicket(wg, "agent's");
    const agent = wg.registerAgent({ display_name: "a1" }, human);
    wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 300 }, agentActor);

    const board = wg.board();
    const inProgress = board.columns.find((c) => c.column === "in_progress");
    const card = inProgress?.cards.find((c) => c.id === theirs);
    expect(card).toBeTruthy();
    expect(card?.humanOwner).toBeNull();
    expect(card?.claim).not.toBeNull();
  });
});

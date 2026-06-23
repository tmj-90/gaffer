import { beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { TestClock } from "../src/util/clock.js";
import { DispatchError } from "../src/util/errors.js";

const human: Actor = { type: "human", id: "tom" };
const agentActor: Actor = { type: "agent", id: "agent-runner" };
const systemActor: Actor = { type: "system" };

function freshWg(clock = new TestClock()): Dispatch {
  return Dispatch.open(":memory:", clock);
}

/** Create a ready ticket at a given risk level. */
function readyTicket(
  wg: Dispatch,
  risk: "low" | "medium" | "high" | "critical",
  title = "Task",
): string {
  const t = wg.createTicket({ title, policy_pack: "solo_loose", risk_level: risk }, human);
  wg.markReady(t.id, human);
  return t.id;
}

/** Attach a required capability directly (no public API yet for this table). */
function requireCapability(wg: Dispatch, ticketId: string, capability: string): void {
  wg.db
    .prepare(`INSERT INTO ticket_required_capabilities (ticket_id, capability) VALUES (?, ?)`)
    .run(ticketId, capability);
}

// --- P0-1: risk + capability + status eligibility ------------------------

describe("P0-1: risk-level eligibility", () => {
  it("an agent below the risk ceiling cannot claim a high-risk ticket", () => {
    const wg = freshWg();
    readyTicket(wg, "high", "Risky");
    const agent = wg.registerAgent({ display_name: "low-agent", max_risk: "medium" }, human);

    const result = wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 300 }, agentActor);
    expect(result).toBeNull();
  });

  it("an agent at or above the risk ceiling can claim the ticket", () => {
    const wg = freshWg();
    const ticketId = readyTicket(wg, "high", "Risky");
    const agent = wg.registerAgent({ display_name: "high-agent", max_risk: "high" }, human);

    const result = wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 300 }, agentActor);
    expect(result?.ticketId).toBe(ticketId);
  });

  it("skips the ineligible high-risk ticket and claims the next eligible one", () => {
    const wg = freshWg();
    // Higher priority high-risk ticket the agent cannot take, plus a low-risk one it can.
    const highRisk = wg.createTicket(
      {
        title: "blocked-for-agent",
        policy_pack: "solo_loose",
        risk_level: "critical",
        priority: 10,
      },
      human,
    );
    wg.markReady(highRisk.id, human);
    const lowRisk = readyTicket(wg, "low", "ok-for-agent");

    const agent = wg.registerAgent({ display_name: "medium-agent", max_risk: "medium" }, human);
    const result = wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 300 }, agentActor);
    expect(result?.ticketId).toBe(lowRisk);
    expect(wg.view(highRisk.id).ticket.status).toBe("ready");
  });
});

describe("P0-1: capability eligibility", () => {
  it("an agent missing a required capability cannot claim", () => {
    const wg = freshWg();
    const ticketId = readyTicket(wg, "low", "needs-rust");
    requireCapability(wg, ticketId, "rust");
    const agent = wg.registerAgent(
      { display_name: "ts-agent", capabilities: ["typescript"] },
      human,
    );

    const result = wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 300 }, agentActor);
    expect(result).toBeNull();
  });

  it("an agent holding every required capability can claim", () => {
    const wg = freshWg();
    const ticketId = readyTicket(wg, "low", "needs-backend-and-tests");
    requireCapability(wg, ticketId, "backend");
    requireCapability(wg, ticketId, "tests");
    const agent = wg.registerAgent(
      { display_name: "full-agent", capabilities: ["backend", "tests", "extra"] },
      human,
    );

    const result = wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 300 }, agentActor);
    expect(result?.ticketId).toBe(ticketId);
  });

  it("an agent with partial capabilities cannot claim", () => {
    const wg = freshWg();
    const ticketId = readyTicket(wg, "low", "needs-both");
    requireCapability(wg, ticketId, "backend");
    requireCapability(wg, ticketId, "frontend");
    const agent = wg.registerAgent({ display_name: "partial", capabilities: ["backend"] }, human);

    expect(wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 300 }, agentActor)).toBeNull();
  });
});

describe("P0-1: agent status eligibility", () => {
  it("a non-active agent cannot claim and is rejected", () => {
    const wg = freshWg();
    readyTicket(wg, "low");
    const agent = wg.registerAgent({ display_name: "paused" }, human);
    // Simulate an operator pausing the agent.
    wg.db.prepare(`UPDATE agents SET status = 'paused' WHERE id = ?`).run(agent.id);

    try {
      wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 300 }, agentActor);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DispatchError);
      expect((err as DispatchError).code).toBe("AGENT_NOT_ELIGIBLE");
    }
  });

  it("an active agent claims normally", () => {
    const wg = freshWg();
    const ticketId = readyTicket(wg, "low");
    const agent = wg.registerAgent({ display_name: "active" }, human);
    const result = wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 300 }, agentActor);
    expect(result?.ticketId).toBe(ticketId);
  });
});

// --- P0-2: expired-but-active claim is immediately reclaimable -----------

describe("P0-2: expired claim is reclaimable without a separate sweep", () => {
  let clock: TestClock;
  let wg: Dispatch;
  beforeEach(() => {
    clock = new TestClock();
    wg = freshWg(clock);
  });

  it("claimNextTicket reaps an expired active claim and reclaims atomically", () => {
    const ticketId = readyTicket(wg, "low");
    const a1 = wg.registerAgent({ display_name: "a1" }, human);
    const a2 = wg.registerAgent({ display_name: "a2" }, human);

    const first = wg.claimNextTicket({ agentId: a1.id, ttlSeconds: 60 }, agentActor);
    expect(first?.ticketId).toBe(ticketId);

    // Lease lapses, but NO expireStaleClaims sweep is run.
    clock.advanceSeconds(120);

    const reclaim = wg.claimNextTicket({ agentId: a2.id, ttlSeconds: 60 }, agentActor);
    expect(reclaim?.ticketId).toBe(ticketId);
    expect(reclaim?.claimToken).not.toBe(first?.claimToken);

    // The old claim was reaped (expired) and only one active claim remains.
    const active = wg.listActiveClaims().filter((c) => c.ticket_id === ticketId);
    expect(active).toHaveLength(1);
    expect(active[0]?.agent_id).toBe(a2.id);
  });

  it("an unexpired active claim still blocks a second claimant", () => {
    const ticketId = readyTicket(wg, "low");
    const a1 = wg.registerAgent({ display_name: "a1" }, human);
    const a2 = wg.registerAgent({ display_name: "a2" }, human);

    wg.claimNextTicket({ agentId: a1.id, ttlSeconds: 300 }, agentActor);
    // Still within the lease window — not reclaimable.
    expect(wg.claimNextTicket({ agentId: a2.id, ttlSeconds: 300 }, agentActor)).toBeNull();
    expect(wg.view(ticketId).ticket.status).toBe("claimed");
  });
});

// --- P0-3: block requires a held claim for agent actors ------------------

describe("P0-3: tokenless mutation is barred for agents", () => {
  it("an agent cannot block a ticket it does not hold a claim for", () => {
    const wg = freshWg();
    const ticketId = readyTicket(wg, "low");
    const agent = wg.registerAgent({ display_name: "a" }, human);
    wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 300 }, agentActor);

    try {
      wg.markBlocked({ ticket_id: ticketId, reason: "no token" }, agentActor);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DispatchError);
      expect((err as DispatchError).code).toBe("CLAIM_REQUIRED");
    }
    // Ticket was not transitioned.
    expect(wg.view(ticketId).ticket.status).toBe("claimed");
  });

  it("an agent cannot block with a token for a different ticket", () => {
    const wg = freshWg();
    const target = readyTicket(wg, "low", "target");
    const other = readyTicket(wg, "low", "other");
    const a1 = wg.registerAgent({ display_name: "a1" }, human);
    const a2 = wg.registerAgent({ display_name: "a2" }, human);
    wg.claimNextTicket({ agentId: a1.id, ttlSeconds: 300 }, agentActor);
    const otherClaim = wg.claimNextTicket({ agentId: a2.id, ttlSeconds: 300 }, agentActor);
    // otherClaim holds whichever ticket it got; block the one it does NOT hold.
    const wrongTicket = otherClaim?.ticketId === target ? other : target;

    expect(() =>
      wg.markBlocked(
        { claimToken: otherClaim!.claimToken, ticket_id: wrongTicket, reason: "mismatch" },
        agentActor,
      ),
    ).toThrowError(DispatchError);
  });

  it("the claim-holding agent can block its own ticket", () => {
    const wg = freshWg();
    const ticketId = readyTicket(wg, "low");
    const agent = wg.registerAgent({ display_name: "a" }, human);
    const claim = wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 300 }, agentActor);

    wg.markBlocked(
      { claimToken: claim!.claimToken, ticket_id: ticketId, reason: "needs decision" },
      agentActor,
    );
    expect(wg.view(ticketId).ticket.status).toBe("blocked");
  });

  it("a human can block tokenlessly and the actor is on the event trail", () => {
    const wg = freshWg();
    const ticketId = readyTicket(wg, "low");
    const agent = wg.registerAgent({ display_name: "a" }, human);
    wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 300 }, agentActor);

    wg.markBlocked({ ticket_id: ticketId, reason: "operator override" }, human);
    expect(wg.view(ticketId).ticket.status).toBe("blocked");

    const blockedEvent = wg.view(ticketId).events.find((e) => e.event_type === "ticket.blocked");
    expect(blockedEvent?.actor_type).toBe("human");
  });

  it("a system actor can block tokenlessly", () => {
    const wg = freshWg();
    const ticketId = readyTicket(wg, "low");
    const agent = wg.registerAgent({ display_name: "a" }, human);
    wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 300 }, agentActor);

    wg.markBlocked({ ticket_id: ticketId, reason: "system halt" }, systemActor);
    expect(wg.view(ticketId).ticket.status).toBe("blocked");
  });
});

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
  wg.addAcceptanceCriterion({ ticket_id: t.id, text: "AC" }, human); // Guard A: ≥1 AC required to ready
  wg.markReady(t.id, human);
  return t.id;
}

describe("M2: registerAgent", () => {
  it("registers an agent with capabilities", () => {
    const wg = freshWg();
    const agent = wg.registerAgent(
      { display_name: "Claude", capabilities: ["backend", "tests"] },
      human,
    );
    expect(agent.status).toBe("active");
    expect(wg.agents.capabilities(agent.id)).toEqual(["backend", "tests"]);
  });
});

describe("M2: single active claim per ticket", () => {
  let wg: Dispatch;
  beforeEach(() => {
    wg = freshWg();
  });

  it("prevents two agents holding an active claim on the same ticket", () => {
    const ticketId = readyTicket(wg);
    const a1 = wg.registerAgent({ display_name: "a1" }, human);
    const a2 = wg.registerAgent({ display_name: "a2" }, human);

    const first = wg.claimNextTicket({ agentId: a1.id, ttlSeconds: 300 }, agentActor);
    expect(first).not.toBeNull();
    expect(first?.ticketId).toBe(ticketId);

    // No other ready ticket exists, and the only one is now claimed → null.
    const second = wg.claimNextTicket({ agentId: a2.id, ttlSeconds: 300 }, agentActor);
    expect(second).toBeNull();
  });

  it("skips a claimed ticket but still claims a different ready one", () => {
    const claimed = readyTicket(wg, "first");
    const open = readyTicket(wg, "second");
    const a1 = wg.registerAgent({ display_name: "a1" }, human);
    const a2 = wg.registerAgent({ display_name: "a2" }, human);

    const r1 = wg.claimNextTicket({ agentId: a1.id, ttlSeconds: 300 }, agentActor);
    const r2 = wg.claimNextTicket({ agentId: a2.id, ttlSeconds: 300 }, agentActor);
    const claimedIds = [r1?.ticketId, r2?.ticketId].sort();
    expect(claimedIds).toEqual([claimed, open].sort());
  });
});

describe("M2: stale claim recovery", () => {
  it("expires a stale claim, returns the ticket to ready, and allows reclaim", () => {
    const clock = new TestClock();
    const wg = freshWg(clock);
    const ticketId = readyTicket(wg);
    const a1 = wg.registerAgent({ display_name: "a1" }, human);
    const a2 = wg.registerAgent({ display_name: "a2" }, human);

    const first = wg.claimNextTicket({ agentId: a1.id, ttlSeconds: 60 }, agentActor);
    expect(first?.ticketId).toBe(ticketId);
    expect(wg.view(ticketId).ticket.status).toBe("claimed");

    // Before expiry, the ticket cannot be reclaimed.
    expect(wg.claimNextTicket({ agentId: a2.id, ttlSeconds: 60 }, agentActor)).toBeNull();

    clock.advanceSeconds(120);
    const { expired } = wg.expireStaleClaims({ type: "system" });
    expect(expired).toBe(1);
    expect(wg.view(ticketId).ticket.status).toBe("ready");

    const reclaim = wg.claimNextTicket({ agentId: a2.id, ttlSeconds: 60 }, agentActor);
    expect(reclaim?.ticketId).toBe(ticketId);
  });
});

describe("M2: evidence + claim tokens", () => {
  it("rejects evidence from an invalid/expired claim token", () => {
    const clock = new TestClock();
    const wg = freshWg(clock);
    const ticketId = readyTicket(wg);
    const agent = wg.registerAgent({ display_name: "a" }, human);
    const claim = wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 60 }, agentActor);
    expect(claim).not.toBeNull();

    // Unknown token.
    expect(() =>
      wg.recordEvidence(
        {
          claimToken: "not-a-real-token",
          ticket_id: ticketId,
          evidence_type: "log",
          summary: "x",
        },
        agentActor,
      ),
    ).toThrowError(DispatchError);

    // Expired token.
    clock.advanceSeconds(120);
    try {
      wg.recordEvidence(
        {
          claimToken: claim!.claimToken,
          ticket_id: ticketId,
          evidence_type: "log",
          summary: "x",
        },
        agentActor,
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DispatchError);
      expect((err as DispatchError).code).toBe("CLAIM_INVALID");
    }
  });

  it("links AC evidence and flips the AC to satisfied", () => {
    const wg = freshWg();
    const t = wg.createTicket({ title: "Feature", policy_pack: "solo_loose" }, human);
    const { ac } = wg.addAcceptanceCriterion({ ticket_id: t.id, text: "Returns 200" }, human);
    wg.markReady(t.id, human);
    const agent = wg.registerAgent({ display_name: "a" }, human);
    const claim = wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 300 }, agentActor);

    const res = wg.recordEvidence(
      {
        claimToken: claim!.claimToken,
        ticket_id: t.id,
        ac_id: ac.id,
        evidence_type: "test_output",
        summary: "test passed",
      },
      agentActor,
    );
    expect(res.evidenceId).toBeTruthy();

    const view = wg.view(t.id);
    const updatedAc = view.acceptanceCriteria.find((c) => c.id === ac.id);
    expect(updatedAc?.status).toBe("satisfied");
  });

  it("allows a human to record manual evidence without a claim token", () => {
    const wg = freshWg();
    const t = wg.createTicket({ title: "Manual", policy_pack: "solo_loose" }, human);
    const res = wg.recordEvidence(
      { ticket_id: t.id, evidence_type: "manual_note", summary: "human note" },
      human,
    );
    expect(res.evidenceId).toBeTruthy();
  });
});

describe("M2: review only through the transition service", () => {
  it("reaches in_review via claimed->in_progress->in_review with an event trail", () => {
    const wg = freshWg();
    const ticketId = readyTicket(wg);
    const agent = wg.registerAgent({ display_name: "a" }, human);
    const claim = wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 300 }, agentActor);

    const res = wg.submitForReview(
      { claimToken: claim!.claimToken, ticket_id: ticketId, reason: "done" },
      agentActor,
    );
    expect(res.status).toBe("in_review");

    const events = wg
      .view(ticketId)
      .events.filter((e) => e.event_type === "ticket.transitioned")
      .map((e) => JSON.parse(e.payload_json ?? "{}") as { from: string; to: string });
    // ready->claimed, claimed->in_progress, in_progress->in_review
    expect(events).toEqual([
      { from: "draft", to: "ready", reason: "mark ready", patch: null },
      { from: "ready", to: "claimed", reason: "claim_next", patch: null },
      { from: "claimed", to: "in_progress", reason: "submit_for_review", patch: null },
      { from: "in_progress", to: "in_review", reason: "done", patch: null },
    ]);
  });
});

describe("M2: blocked + release + draft", () => {
  it("marks a claimed ticket blocked", () => {
    const wg = freshWg();
    const ticketId = readyTicket(wg);
    const agent = wg.registerAgent({ display_name: "a" }, human);
    const claim = wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 300 }, agentActor);
    wg.markBlocked(
      { claimToken: claim!.claimToken, ticket_id: ticketId, reason: "needs decision" },
      agentActor,
    );
    expect(wg.view(ticketId).ticket.status).toBe("blocked");
  });

  it("releases a claim back to ready", () => {
    const wg = freshWg();
    const ticketId = readyTicket(wg);
    const agent = wg.registerAgent({ display_name: "a" }, human);
    const claim = wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 300 }, agentActor);
    wg.releaseClaim(claim!.claimToken, agentActor);
    expect(wg.view(ticketId).ticket.status).toBe("ready");
  });

  it("creates a draft ticket with linked repo and a manual_note evidence row", () => {
    const wg = freshWg();
    wg.registerRepository({ name: "api" }, human);
    const { ticketId, number } = wg.createDraftTicket(
      { title: "Idea", repoName: "api", evidenceSummary: "captured from idle loop" },
      human,
    );
    expect(number).toBeGreaterThan(0);
    const view = wg.view(ticketId);
    expect(view.ticket.status).toBe("draft");
    expect(view.repositories.map((r) => r.name)).toContain("api");
    expect(view.events.map((e) => e.event_type)).toContain("evidence.recorded");
  });

  it("threads an explicit policyPack through to the draft ticket", () => {
    const wg = freshWg();
    const { ticketId } = wg.createDraftTicket(
      { title: "Strict idea", policyPack: "factory_strict" },
      human,
    );
    expect(wg.view(ticketId).ticket.policy_pack).toBe("factory_strict");
  });

  it("defaults the draft ticket policy_pack to solo_loose when omitted", () => {
    const wg = freshWg();
    const { ticketId } = wg.createDraftTicket({ title: "Loose idea" }, human);
    expect(wg.view(ticketId).ticket.policy_pack).toBe("solo_loose");
  });
});

describe("M2: a re-queue move releases the claim (ghost-claim safety net)", () => {
  it("board-move out of the delivery lane (blocked→ready) leaves no stale claim; ticket stays claimable", () => {
    const wg = freshWg();
    const id = readyTicket(wg);
    const a1 = wg.registerAgent({ display_name: "a1" }, human);
    const claim = wg.claimNextTicket({ agentId: a1.id, ttlSeconds: 300 }, agentActor);
    expect(claim).toBeTruthy();
    expect(wg.view(id).ticket.status).toBe("claimed");
    // A re-queue move must clear the lease. Regression: before this fix a claimed ticket
    // moved back to a queue/parked state kept its (unexpired) claim, and the candidate
    // queries reject any ticket with an unexpired active claim — so it was silently
    // un-claimable until the TTL ran out. Here: claimed→blocked, then a raw board drag
    // blocked→ready, then it MUST be immediately re-claimable by another agent.
    wg.moveTicket(id, "blocked", human);
    wg.moveTicket(id, "ready", human);
    expect(wg.view(id).ticket.status).toBe("ready");
    const a2 = wg.registerAgent({ display_name: "a2" }, human);
    const reclaim = wg.claimNextTicket({ agentId: a2.id, ttlSeconds: 300 }, agentActor);
    expect(reclaim).toBeTruthy();
    expect(wg.view(id).ticket.status).toBe("claimed");
  });
});

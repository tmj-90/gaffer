import { describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { makeHandlers } from "../src/mcp/tools.js";
import { TestClock } from "../src/util/clock.js";

const agentActor: Actor = { type: "agent", id: "mcp-agent" };
const systemActor: Actor = { type: "system" };

/**
 * RUNNER-OWNED-BOOKKEEPING: the factory runner claims the ticket, injects the
 * claim token into the MCP server env (GAFFER_CLAIM_TOKEN), submits after its
 * gates pass, and releases/parks the claim on failure. These tests pin the
 * dispatch primitives that seam depends on.
 */
function structured(result: {
  structuredContent: Record<string, unknown>;
}): Record<string, unknown> {
  return result.structuredContent;
}

function seedReadyClaimedTicket(wg: Dispatch): { ticketId: string; acId: string; token: string } {
  const h = makeHandlers(wg, agentActor);
  const created = structured(h.create_ticket({ title: "T", policy_pack: "solo_loose" }));
  const ticketId = created.ticket_id as string;
  const acRes = structured(h.add_acceptance_criterion({ ticket_id: ticketId, text: "does X" }));
  const acId = acRes.ac_id as string;
  h.mark_ticket_ready({ ticket_id: ticketId });
  const agent = wg.registerAgent({ display_name: "claude" }, { type: "human", id: "tom" });
  const claim = structured(
    h.claim_ticket({ ticket_id: ticketId, agent_id: agent.id, ttl_seconds: 600 }),
  );
  return { ticketId, acId, token: claim.claim_token as string };
}

describe("runner-owned bookkeeping", () => {
  it("record_ac_evidence resolves the claim token from GAFFER_CLAIM_TOKEN when no arg is passed", () => {
    const wg = Dispatch.open(":memory:", new TestClock());
    const { ticketId, acId, token } = seedReadyClaimedTicket(wg);
    const h = makeHandlers(wg, agentActor);

    const prev = process.env.GAFFER_CLAIM_TOKEN;
    process.env.GAFFER_CLAIM_TOKEN = token;
    try {
      // No claim_token arg — the server injects it from the env.
      const res = structured(
        h.record_ac_evidence({
          ticket_id: ticketId,
          ac_id: acId,
          evidence_type: "test_output",
          summary: "green",
        }),
      );
      expect(res.evidence_id).toBeTruthy();
    } finally {
      if (prev === undefined) delete process.env.GAFFER_CLAIM_TOKEN;
      else process.env.GAFFER_CLAIM_TOKEN = prev;
    }
    expect(wg.view(ticketId).acceptanceCriteria[0].status).toBe("satisfied");
  });

  it("mark_ticket_blocked resolves the env token; with none it stays rejected for agents", () => {
    const wg = Dispatch.open(":memory:", new TestClock());
    const { ticketId, token } = seedReadyClaimedTicket(wg);
    const h = makeHandlers(wg, agentActor);

    // No env token, no arg → still rejected (agents can't block tokenlessly).
    const prev = process.env.GAFFER_CLAIM_TOKEN;
    delete process.env.GAFFER_CLAIM_TOKEN;
    try {
      const noTok = h.mark_ticket_blocked({ ticket_id: ticketId, reason: "stuck" });
      expect(noTok.isError).toBe(true);

      process.env.GAFFER_CLAIM_TOKEN = token;
      const withEnv = structured(h.mark_ticket_blocked({ ticket_id: ticketId, reason: "stuck" }));
      expect(withEnv.status).toBe("blocked");
    } finally {
      if (prev === undefined) delete process.env.GAFFER_CLAIM_TOKEN;
      else process.env.GAFFER_CLAIM_TOKEN = prev;
    }
  });

  it("runnerRelease --to ready releases the claim and requeues (failure/retry)", () => {
    const wg = Dispatch.open(":memory:", new TestClock());
    const { ticketId, token } = seedReadyClaimedTicket(wg);

    const res = wg.runnerRelease(
      { ticket_id: ticketId, to: "ready", claimToken: token },
      systemActor,
    );
    expect(res.status).toBe("ready");
    // The claim is released — the ticket can be claimed again.
    const agent = wg.registerAgent({ display_name: "claude2" }, { type: "human", id: "tom" });
    const reclaim = wg.claimTicket(
      { ticket_id: ticketId, agent_id: agent.id, ttl_seconds: 600 },
      {
        type: "agent",
        id: agent.id,
      },
    );
    expect(reclaim.claimToken).toBeTruthy();
  });

  it("runnerRelease --to refining parks a claimed delivery (branch preserved lane)", () => {
    const wg = Dispatch.open(":memory:", new TestClock());
    const { ticketId, token } = seedReadyClaimedTicket(wg);
    const res = wg.runnerRelease(
      { ticket_id: ticketId, to: "refining", claimToken: token, reason: "DoD failed" },
      systemActor,
    );
    expect(res.status).toBe("refining");
  });

  it("runnerRelease works tokenlessly for a resumed (in_progress) delivery", () => {
    const wg = Dispatch.open(":memory:", new TestClock());
    const { ticketId, token } = seedReadyClaimedTicket(wg);
    // Simulate a resumed delivery: claimed -> in_progress.
    wg.moveTicket(ticketId, "in_progress", systemActor);
    // Original claim lease is irrelevant on resume; park without a token.
    void token;
    const res = wg.runnerRelease(
      { ticket_id: ticketId, to: "refining", reason: "resume park" },
      systemActor,
    );
    expect(res.status).toBe("refining");
  });

  it("runnerRelease --to ready requeues a resumed (in_progress) delivery", () => {
    const wg = Dispatch.open(":memory:", new TestClock());
    const { ticketId, token } = seedReadyClaimedTicket(wg);
    // Simulate a resumed delivery: claimed -> in_progress. The original lease is
    // irrelevant on resume; a crash-trap release hands it back to ready tokenlessly.
    wg.moveTicket(ticketId, "in_progress", systemActor);
    void token;
    const res = wg.runnerRelease(
      { ticket_id: ticketId, to: "ready", reason: "runner killed mid-delivery" },
      systemActor,
    );
    expect(res.status).toBe("ready");
  });

  it("the guarded release transitions are NOT reachable via a plain board move", () => {
    const wg = Dispatch.open(":memory:", new TestClock());
    const { ticketId } = seedReadyClaimedTicket(wg);
    // claimed -> refining is illegal except through the runner-release path.
    expect(() => wg.moveTicket(ticketId, "refining", { type: "admin", id: "tom" })).toThrow(
      /ILLEGAL_TRANSITION|not allowed|released\/parked/i,
    );
  });

  // The runner-release guard is an OR over three legs (claimed->refining,
  // in_progress->ready, in_progress->refining). Assert EACH in_progress leg is
  // independently unreachable via a plain board move, so dropping any one leg of the
  // `||` chain in transitionService is caught here (not just the claimed->refining leg).
  it("board move in_progress -> ready is illegal (runner-release-only leg)", () => {
    const wg = Dispatch.open(":memory:", new TestClock());
    const { ticketId } = seedReadyClaimedTicket(wg);
    wg.moveTicket(ticketId, "in_progress", systemActor);
    expect(() => wg.moveTicket(ticketId, "ready", { type: "admin", id: "tom" })).toThrow(
      /ILLEGAL_TRANSITION|not allowed|released\/parked/i,
    );
  });

  it("board move in_progress -> refining is illegal (runner-release-only leg)", () => {
    const wg = Dispatch.open(":memory:", new TestClock());
    const { ticketId } = seedReadyClaimedTicket(wg);
    wg.moveTicket(ticketId, "in_progress", systemActor);
    expect(() => wg.moveTicket(ticketId, "refining", { type: "admin", id: "tom" })).toThrow(
      /ILLEGAL_TRANSITION|not allowed|released\/parked/i,
    );
  });

  it("a claim token scoped to ticket A cannot evidence ticket B (CLAIM_INVALID)", () => {
    const wg = Dispatch.open(":memory:", new TestClock());
    // Ticket A: claimed by the runner, token in hand.
    const { token: tokenA } = seedReadyClaimedTicket(wg);
    // Ticket B: an independent ready+claimed ticket with its own AC.
    const b = seedReadyClaimedTicket(wg);
    const h = makeHandlers(wg, agentActor);
    // Presenting A's token against B's AC must be rejected — the token is not an
    // active claim on ticket B. The MCP guard surfaces this as an error result.
    const res = h.record_ac_evidence({
      ticket_id: b.ticketId,
      ac_id: b.acId,
      evidence_type: "test_output",
      summary: "cross-ticket evidence attempt",
      claim_token: tokenA,
    });
    expect(res.isError).toBe(true);
    // B's AC stays unsatisfied — no cross-ticket evidence leaked in.
    expect(wg.view(b.ticketId).acceptanceCriteria[0].status).not.toBe("satisfied");
  });
});

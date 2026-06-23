import { describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import { type Actor, parseReviewFeedback, type ReviewFeedback } from "../src/domain/types.js";
import { makeHandlers } from "../src/mcp/tools.js";
import { TestClock } from "../src/util/clock.js";

const human: Actor = { type: "human", id: "tom" };
const reviewer: Actor = { type: "human", id: "rev" };
const agentActor: Actor = { type: "agent", id: "mcp-agent" };

type Handlers = ReturnType<typeof makeHandlers>;

function structured(result: {
  structuredContent: Record<string, unknown>;
}): Record<string, unknown> {
  return result.structuredContent;
}

/**
 * Drive a fresh solo_loose ticket to `in_review` via the MCP handlers and return
 * its id + the active claim token, so a test can reject it and re-claim.
 */
function toInReview(wg: Dispatch, h: Handlers): { ticketId: string; claimToken: string } {
  const created = structured(h.create_ticket({ title: "Ship it", policy_pack: "solo_loose" }));
  const ticketId = created.ticket_id as string;
  h.add_acceptance_criterion({ ticket_id: ticketId, text: "Returns 200" });
  h.mark_ticket_ready({ ticket_id: ticketId });

  const agent = wg.registerAgent({ display_name: "claude" }, human);
  const claim = structured(h.claim_next_ticket({ agent_id: agent.id, ttl_seconds: 600 }));
  const claimToken = claim.claim_token as string;
  h.submit_ticket_for_review({ claim_token: claimToken, ticket_id: ticketId });
  expect(wg.view(ticketId).ticket.status).toBe("in_review");
  return { ticketId, claimToken };
}

describe("WG-049: review-rejection feedback", () => {
  it("AC1: get_ticket returns last_review_feedback {reason, reviewer, at} after a reject to refining", () => {
    const clock = new TestClock();
    const wg = Dispatch.open(":memory:", clock);
    const h = makeHandlers(wg, agentActor);
    const { ticketId } = toInReview(wg, h);

    const rejectedAt = clock.now();
    wg.rejectReview(ticketId, "refining", reviewer, "tests are missing for the error path");

    const ticket = structured(h.get_ticket({ ticket_id: ticketId })).ticket as {
      status: string;
      last_review_feedback: ReviewFeedback | null;
    };
    expect(ticket.status).toBe("refining");
    // H2: get_ticket envelopes the untrusted free-text `reason` server-side.
    expect(ticket.last_review_feedback).toEqual({
      reason:
        "<untrusted-review-feedback>tests are missing for the error path</untrusted-review-feedback>",
      reviewer: "rev",
      at: rejectedAt,
    });
  });

  it("falls back to a sentinel reason when the reviewer gives none", () => {
    const wg = Dispatch.open(":memory:", new TestClock());
    const h = makeHandlers(wg, agentActor);
    const { ticketId } = toInReview(wg, h);

    wg.rejectReview(ticketId, "refining", reviewer);
    const ticket = structured(h.get_ticket({ ticket_id: ticketId })).ticket as {
      last_review_feedback: ReviewFeedback | null;
    };
    // H2: the sentinel reason is enveloped too (server-side quarantine).
    expect(ticket.last_review_feedback?.reason).toBe(
      "<untrusted-review-feedback>review_rejected</untrusted-review-feedback>",
    );
  });

  it("AC2: the re-claiming agent receives the reason in the claim_ticket result", () => {
    const wg = Dispatch.open(":memory:", new TestClock());
    const h = makeHandlers(wg, agentActor);
    const { ticketId } = toInReview(wg, h);
    wg.rejectReview(ticketId, "refining", reviewer, "rethink the approach");

    // A human triages the rework: refining -> ready, then the agent re-claims it.
    wg.markReady(ticketId, human);
    const agent = wg.registerAgent({ display_name: "claude-2" }, human);
    const claim = structured(
      h.claim_ticket({ ticket_id: ticketId, agent_id: agent.id, ttl_seconds: 600 }),
    );
    expect(claim.claimed).toBe(true);
    expect(claim.last_review_feedback).toEqual({
      reason: "rethink the approach",
      reviewer: "rev",
      at: expect.any(String),
    });
  });

  it("AC2: claim_next_ticket also carries the reason, and a clean ticket carries null", () => {
    const wg = Dispatch.open(":memory:", new TestClock());
    const h = makeHandlers(wg, agentActor);

    // A never-rejected ticket: claim result carries null.
    const fresh = structured(h.create_ticket({ title: "fresh", policy_pack: "solo_loose" }));
    h.mark_ticket_ready({ ticket_id: fresh.ticket_id as string });
    const agent = wg.registerAgent({ display_name: "a" }, human);
    const cleanClaim = structured(h.claim_next_ticket({ agent_id: agent.id, ttl_seconds: 600 }));
    expect(cleanClaim.last_review_feedback).toBeNull();

    // A rejected-and-retriaged ticket: claim_next result carries the reason.
    const { ticketId } = toInReview(wg, h);
    wg.rejectReview(ticketId, "refining", reviewer, "needs error handling");
    wg.markReady(ticketId, human);
    const claim = structured(h.claim_next_ticket({ agent_id: agent.id, ttl_seconds: 600 }));
    expect(claim.ticket_id).toBe(ticketId);
    expect((claim.last_review_feedback as ReviewFeedback).reason).toBe("needs error handling");
  });

  it("AC3: the board card surfaces the rejection reason on a refining ticket", () => {
    const wg = Dispatch.open(":memory:", new TestClock());
    const h = makeHandlers(wg, agentActor);
    const { ticketId } = toInReview(wg, h);
    wg.rejectReview(ticketId, "refining", reviewer, "redo the validation");

    const card = wg
      .board()
      .columns.flatMap((c) => c.cards)
      .find((c) => c.id === ticketId)!;
    expect(card.lastReviewFeedback?.reason).toBe("redo the validation");
  });

  it("AC4: re-entering in_review clears the stored feedback so it never shows as current", () => {
    const wg = Dispatch.open(":memory:", new TestClock());
    const h = makeHandlers(wg, agentActor);
    const { ticketId } = toInReview(wg, h);
    wg.rejectReview(ticketId, "refining", reviewer, "first pass was wrong");
    expect(wg.view(ticketId).ticket.last_review_feedback).not.toBeNull();

    // Retriage + re-claim + re-submit: the ticket re-enters in_review.
    wg.markReady(ticketId, human);
    const agent = wg.registerAgent({ display_name: "claude-3" }, human);
    const claim = structured(
      h.claim_ticket({ ticket_id: ticketId, agent_id: agent.id, ttl_seconds: 600 }),
    );
    h.submit_ticket_for_review({ claim_token: claim.claim_token as string, ticket_id: ticketId });

    expect(wg.view(ticketId).ticket.status).toBe("in_review");
    expect(wg.view(ticketId).ticket.last_review_feedback).toBeNull();
    const ticket = structured(h.get_ticket({ ticket_id: ticketId })).ticket as {
      last_review_feedback: ReviewFeedback | null;
    };
    expect(ticket.last_review_feedback).toBeNull();

    // And the board card no longer shows stale feedback.
    const card = wg
      .board()
      .columns.flatMap((c) => c.cards)
      .find((c) => c.id === ticketId)!;
    expect(card.lastReviewFeedback).toBeNull();
  });

  it("parseReviewFeedback returns null for absent or malformed JSON (corrupt rows never throw)", () => {
    expect(parseReviewFeedback(null)).toBeNull();
    expect(parseReviewFeedback("")).toBeNull();
    expect(parseReviewFeedback("{not json")).toBeNull();
    expect(parseReviewFeedback(JSON.stringify({ reviewer: "rev" }))).toBeNull(); // no reason/at
    expect(
      parseReviewFeedback(JSON.stringify({ reason: "r", at: "2026-01-01T00:00:00Z" })),
    ).toEqual({ reason: "r", reviewer: null, at: "2026-01-01T00:00:00Z" });
  });
});

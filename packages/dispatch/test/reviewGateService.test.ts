/**
 * Unit tests for ReviewGateService — security-critical authz gates:
 *
 *  1. approveReview: agent CANNOT approve by default; CAN with
 *     DISPATCH_ALLOW_AGENT_APPROVE=1 (operator opt-in).
 *  2. markMerged: only system/admin may call.
 *  3. reopenForReview: only system/admin may call.
 *  4. capRetry: shared P1 retry-cap helper increments correctly, parks at cap.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { Dispatch } from "../src/core.js";
import { capRetry } from "../src/services/reviewGateService.js";
import { DispatchError } from "../src/util/errors.js";
import type { Actor } from "../src/domain/types.js";
import { nonEmptyDiffRunner } from "./helpers/realDiff.js";

// ---------------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------------
const human: Actor = { type: "human", id: "tom" };
const agentActor: Actor = { type: "agent", id: "agt-1" };
const systemActor: Actor = { type: "system" };
const adminActor: Actor = { type: "admin" };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function openDispatch(): Dispatch {
  return Dispatch.open(":memory:", undefined, nonEmptyDiffRunner);
}

/** Assert that fn() throws a DispatchError with the given code. */
function expectDispatchCode(fn: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown, `Expected a DispatchError with code '${code}'`).toBeInstanceOf(DispatchError);
  expect((thrown as DispatchError).code).toBe(code);
}

/**
 * Drive a ticket all the way to in_review.
 * Satisfies the AC and records a delivery branch so the P0 done-gate passes on approve.
 */
function buildInReviewTicket(d: Dispatch): string {
  const repo = d.registerRepository(
    { name: "svc", default_branch: "main", local_path: process.cwd() },
    human,
  );
  const ticket = d.createTicket({ title: "T1", priority: 1, risk_level: "low" }, human);
  d.linkRepository(ticket.id, "svc", "primary", human);
  const { ac } = d.addAcceptanceCriterion({ ticket_id: ticket.id, text: "Works" }, human);
  d.markReady(ticket.id, human);

  const agent = d.registerAgent({ display_name: "Bot" }, human);
  const claim = d.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, agentActor);
  if (!claim) throw new Error("Expected a claim");

  // Satisfy AC so the done-gate passes on approve.
  d.recordEvidence(
    {
      claimToken: claim.claimToken,
      ticket_id: ticket.id,
      ac_id: ac.id,
      evidence_type: "test_output",
      summary: "all passing",
    },
    agentActor,
  );
  // Record delivery branch so the real-diff gate resolves via nonEmptyDiffRunner.
  d.recordRepoDelivery(
    { ticket_id: ticket.id, repo_id: repo.id, branch_name: "feat/t1" },
    agentActor,
  );
  d.submitForReview(
    { claimToken: claim.claimToken, ticket_id: ticket.id, reason: "done" },
    agentActor,
  );
  return ticket.id;
}

/** Build a ticket that is already merged (done). */
function buildMergedTicket(d: Dispatch): string {
  const ticketId = buildInReviewTicket(d);
  d.approveReview(ticketId, human);
  d.markMerged(ticketId, systemActor);
  return ticketId;
}

// ---------------------------------------------------------------------------
// capRetry
// ---------------------------------------------------------------------------

describe("capRetry (P1 retry-cap helper)", () => {
  it("increments attempt count by 1", () => {
    const { nextAttempt, capReached } = capRetry(0, 3);
    expect(nextAttempt).toBe(1);
    expect(capReached).toBe(false);
  });

  it("sets capReached when nextAttempt equals maxAttempts", () => {
    const { nextAttempt, capReached } = capRetry(2, 3);
    expect(nextAttempt).toBe(3);
    expect(capReached).toBe(true);
  });

  it("sets capReached when nextAttempt exceeds maxAttempts", () => {
    const { capReached } = capRetry(5, 3);
    expect(capReached).toBe(true);
  });

  it("never parks below cap (one before max)", () => {
    const { capReached } = capRetry(1, 3);
    expect(capReached).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// approveReview authz gate
// ---------------------------------------------------------------------------

describe("approveReview authz gate", () => {
  let d: Dispatch;
  beforeEach(() => {
    d = openDispatch();
    delete process.env.DISPATCH_ALLOW_AGENT_APPROVE;
  });

  it("human may approve", () => {
    const ticketId = buildInReviewTicket(d);
    const result = d.approveReview(ticketId, human);
    expect(result.ticket.status).toBe("ready_for_merge");
  });

  it("admin may approve", () => {
    const ticketId = buildInReviewTicket(d);
    const result = d.approveReview(ticketId, adminActor);
    expect(result.ticket.status).toBe("ready_for_merge");
  });

  it("agent is REJECTED by default (safety-hook ON)", () => {
    const ticketId = buildInReviewTicket(d);
    expectDispatchCode(() => d.approveReview(ticketId, agentActor), "ACTOR_NOT_PERMITTED");
  });

  it("agent is REJECTED when DISPATCH_ALLOW_AGENT_APPROVE=0", () => {
    process.env.DISPATCH_ALLOW_AGENT_APPROVE = "0";
    const ticketId = buildInReviewTicket(d);
    expectDispatchCode(() => d.approveReview(ticketId, agentActor), "ACTOR_NOT_PERMITTED");
  });

  it("agent is ALLOWED when DISPATCH_ALLOW_AGENT_APPROVE=1 (operator opt-in)", () => {
    process.env.DISPATCH_ALLOW_AGENT_APPROVE = "1";
    try {
      const ticketId = buildInReviewTicket(d);
      const result = d.approveReview(ticketId, agentActor);
      expect(result.ticket.status).toBe("ready_for_merge");
    } finally {
      delete process.env.DISPATCH_ALLOW_AGENT_APPROVE;
    }
  });

  it("system actor is REJECTED (system is not human/admin)", () => {
    const ticketId = buildInReviewTicket(d);
    expectDispatchCode(() => d.approveReview(ticketId, systemActor), "ACTOR_NOT_PERMITTED");
  });
});

// ---------------------------------------------------------------------------
// markMerged authz gate
// ---------------------------------------------------------------------------

describe("markMerged authz gate", () => {
  let d: Dispatch;
  beforeEach(() => {
    d = openDispatch();
  });

  it("system may mark merged", () => {
    const ticketId = buildInReviewTicket(d);
    d.approveReview(ticketId, human);
    const result = d.markMerged(ticketId, systemActor);
    expect(result.ticket.status).toBe("done");
  });

  it("admin may mark merged", () => {
    const ticketId = buildInReviewTicket(d);
    d.approveReview(ticketId, human);
    const result = d.markMerged(ticketId, adminActor);
    expect(result.ticket.status).toBe("done");
  });

  it("human is REJECTED", () => {
    const ticketId = buildInReviewTicket(d);
    d.approveReview(ticketId, human);
    expectDispatchCode(() => d.markMerged(ticketId, human), "ACTOR_NOT_PERMITTED");
  });

  it("agent is REJECTED", () => {
    const ticketId = buildInReviewTicket(d);
    d.approveReview(ticketId, human);
    expectDispatchCode(() => d.markMerged(ticketId, agentActor), "ACTOR_NOT_PERMITTED");
  });
});

// ---------------------------------------------------------------------------
// reopenForReview authz gate
// ---------------------------------------------------------------------------

describe("reopenForReview authz gate", () => {
  let d: Dispatch;
  beforeEach(() => {
    d = openDispatch();
  });

  it("system may reopen for review", () => {
    const ticketId = buildMergedTicket(d);
    const result = d.reopenForReview(
      ticketId,
      { reason: "conflict resolved", resolution: "Rebased and fixed conflicts" },
      systemActor,
    );
    expect(result.status).toBe("in_review");
  });

  it("admin may reopen for review", () => {
    const ticketId = buildMergedTicket(d);
    const result = d.reopenForReview(
      ticketId,
      { reason: "conflict", resolution: "Fixed conflicts" },
      adminActor,
    );
    expect(result.status).toBe("in_review");
  });

  it("human is REJECTED", () => {
    const ticketId = buildMergedTicket(d);
    expectDispatchCode(
      () => d.reopenForReview(ticketId, { reason: "conflict", resolution: "Fixed" }, human),
      "ACTOR_NOT_PERMITTED",
    );
  });

  it("agent is REJECTED", () => {
    const ticketId = buildMergedTicket(d);
    expectDispatchCode(
      () => d.reopenForReview(ticketId, { reason: "conflict", resolution: "Fixed" }, agentActor),
      "ACTOR_NOT_PERMITTED",
    );
  });

  it("requires non-empty resolution summary", () => {
    const ticketId = buildMergedTicket(d);
    expectDispatchCode(
      () => d.reopenForReview(ticketId, { reason: "conflict", resolution: "" }, systemActor),
      "VALIDATION_ERROR",
    );
  });
});

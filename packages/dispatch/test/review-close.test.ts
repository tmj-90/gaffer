import { describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { TestClock } from "../src/util/clock.js";
import { DispatchError } from "../src/util/errors.js";
import { giveTicketRealDelivery, nonEmptyDiffRunner } from "./helpers/realDiff.js";

const human: Actor = { type: "human", id: "tom" };
const reviewer: Actor = { type: "human", id: "rev" };
const agentActor: Actor = { type: "agent", id: "agent-runner" };
const systemActor: Actor = { type: "system" };

// The done-gate now recomputes a REAL git diff (P0); inject a non-empty runner so
// the legitimate approve path passes without a real clone on disk.
function freshWg(clock = new TestClock()): Dispatch {
  return Dispatch.open(":memory:", clock, nonEmptyDiffRunner);
}

/**
 * Build a team_light ticket and drive it to `in_review`. Returns the ticket id
 * and the (now-completed) claim token. By default it links a repo and adds one
 * acceptance criterion so the readiness gate passes; the AC is left pending so
 * callers can choose to satisfy it (or not) before approving.
 */
function inReviewTicket(
  wg: Dispatch,
  opts: { satisfyAc?: boolean } = {},
): { ticketId: string; acId: string } {
  wg.registerRepository({ name: "svc", default_branch: "main" }, human);
  const t = wg.createTicket(
    { title: "Ship it", description: "deliver the thing", policy_pack: "team_light" },
    human,
  );
  wg.linkRepository(t.id, "svc", "primary", human);
  const { ac } = wg.addAcceptanceCriterion({ ticket_id: t.id, text: "Returns 200" }, human);
  wg.markReady(t.id, human);

  const agent = wg.registerAgent({ display_name: "a" }, human);
  const claim = wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, agentActor);
  if (opts.satisfyAc) {
    wg.recordEvidence(
      {
        claimToken: claim!.claimToken,
        ticket_id: t.id,
        ac_id: ac.id,
        evidence_type: "test_output",
        summary: "passed",
      },
      agentActor,
    );
  }
  wg.submitForReview(
    { claimToken: claim!.claimToken, ticket_id: t.id, reason: "done" },
    agentActor,
  );
  expect(wg.view(t.id).ticket.status).toBe("in_review");
  return { ticketId: t.id, acId: ac.id };
}

describe("review approve", () => {
  it("approves an in_review ticket with satisfied ACs + a diff to ready_for_merge (NOT done)", () => {
    const wg = freshWg();
    const { ticketId } = inReviewTicket(wg, { satisfyAc: true });
    // P0: back the done-gate with a REAL non-empty branch diff (not just prose).
    giveTicketRealDelivery(wg, ticketId, human);

    // Approve lands in `ready_for_merge` — the merge runner has not confirmed yet,
    // so `done` (= actually merged) is not reached by approve alone.
    const res = wg.approveReview(ticketId, reviewer);
    expect(res.ticket.status).toBe("ready_for_merge");
    expect(wg.view(ticketId).ticket.status).toBe("ready_for_merge");

    // The merge runner's callback then marks it merged (-> done).
    const merged = wg.markMerged(ticketId, systemActor);
    expect(merged.ticket.status).toBe("done");
    expect(wg.view(ticketId).ticket.status).toBe("done");
  });

  it("is blocked by policy when ACs are unresolved", () => {
    const wg = freshWg();
    const { ticketId } = inReviewTicket(wg, { satisfyAc: false });
    // Even with a diff present, an unresolved AC must block done.
    wg.attachDeliveryEvidence(
      ticketId,
      { evidenceType: "diff_summary", summary: "diff" },
      systemActor,
    );

    try {
      wg.approveReview(ticketId, reviewer);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DispatchError);
      const wgErr = err as DispatchError;
      expect(wgErr.code).toBe("POLICY_DENIED");
      const policy = (wgErr.details as { policy: { failures: Array<{ code: string }> } }).policy;
      expect(policy.failures.map((f) => f.code)).toContain("AC_UNRESOLVED");
    }
    expect(wg.view(ticketId).ticket.status).toBe("in_review");
  });

  it("is blocked by policy when no PR/diff evidence exists", () => {
    const wg = freshWg();
    const { ticketId } = inReviewTicket(wg, { satisfyAc: true });
    // ACs satisfied but no PR/diff attached yet.
    try {
      wg.approveReview(ticketId, reviewer);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DispatchError);
      const policy = (
        (err as DispatchError).details as {
          policy: { failures: Array<{ code: string }> };
        }
      ).policy;
      expect(policy.failures.map((f) => f.code)).toContain("PR_OR_DIFF_REQUIRED");
    }
    expect(wg.view(ticketId).ticket.status).toBe("in_review");
  });
});

describe("review reject", () => {
  it("returns the ticket to ready with the reason recorded on an event", () => {
    const wg = freshWg();
    const { ticketId } = inReviewTicket(wg, { satisfyAc: true });

    const res = wg.rejectReview(ticketId, "ready", reviewer, "needs more tests");
    expect(res.ticket.status).toBe("ready");

    const transition = wg
      .view(ticketId)
      .events.filter((e) => e.event_type === "ticket.transitioned")
      .map(
        (e) => JSON.parse(e.payload_json ?? "{}") as { from: string; to: string; reason: string },
      )
      .find((p) => p.from === "in_review" && p.to === "ready");
    expect(transition?.reason).toBe("needs more tests");
  });

  it("can return the ticket to refining", () => {
    const wg = freshWg();
    const { ticketId } = inReviewTicket(wg, { satisfyAc: true });
    const res = wg.rejectReview(ticketId, "refining", reviewer, "rethink approach");
    expect(res.ticket.status).toBe("refining");
  });

  it("resets ALL acceptance criteria to not-satisfied on reject-for-rework", () => {
    const wg = freshWg();
    const { ticketId, acId } = inReviewTicket(wg, { satisfyAc: true });
    // Pre-condition: the delivery satisfied the AC.
    expect(wg.view(ticketId).acceptanceCriteria.find((a) => a.id === acId)?.status).toBe(
      "satisfied",
    );

    wg.rejectReview(ticketId, "refining", reviewer, "stale work");

    // The now-rejected delivery's satisfied stamp is cleared.
    const acs = wg.view(ticketId).acceptanceCriteria;
    expect(acs.every((a) => a.status === "pending")).toBe(true);
    expect(acs.find((a) => a.id === acId)?.verified_by).toBeNull();
    // And an auditable reset event is recorded.
    const reset = wg
      .view(ticketId)
      .events.find((e) => e.event_type === "ticket.acceptance_criteria_reset");
    expect(reset).toBeDefined();
  });

  it("the rejected ticket shows 0/N satisfied again on the board", () => {
    const wg = freshWg();
    const { ticketId } = inReviewTicket(wg, { satisfyAc: true });
    wg.rejectReview(ticketId, "refining", reviewer, "redo");
    const card = wg
      .board()
      .columns.flatMap((c) => c.cards)
      .find((c) => c.id === ticketId)!;
    expect(card.acTotal).toBe(1);
    expect(card.acSatisfied).toBe(0);
  });

  it("can abandon a rejected delivery straight to won't do (-> cancelled, ACs reset)", () => {
    const wg = freshWg();
    const { ticketId, acId } = inReviewTicket(wg, { satisfyAc: true });

    const res = wg.rejectReview(ticketId, "cancelled", reviewer, "out of scope");
    expect(res.ticket.status).toBe("cancelled");
    expect(wg.view(ticketId).acceptanceCriteria.find((a) => a.id === acId)?.status).toBe("pending");
  });
});

describe("system delivery evidence", () => {
  it("a diff_summary row alone does NOT satisfy the done-gate; a REAL branch diff does (P0)", () => {
    const wg = freshWg();
    const { ticketId } = inReviewTicket(wg, { satisfyAc: true });

    // Without a diff, approval is denied for the PR/diff requirement.
    expect(() => wg.approveReview(ticketId, reviewer)).toThrowError(DispatchError);

    // Attaching an agent/system-authored `diff_summary` evidence row is NO LONGER
    // sufficient on its own — the gate recomputes the real git diff (the red-team
    // P0 hole). The repo on this ticket has no on-disk branch, so approval STILL
    // fails on PR_OR_DIFF_REQUIRED.
    const res = wg.attachDeliveryEvidence(
      ticketId,
      { evidenceType: "diff_summary", summary: "delivery diff", uri: "https://x/diff" },
      systemActor,
    );
    expect(res.evidenceId).toBeTruthy();
    try {
      wg.approveReview(ticketId, reviewer);
      throw new Error("prose diff_summary must NOT satisfy the gate");
    } catch (err) {
      expect(err).toBeInstanceOf(DispatchError);
      const policy = (
        (err as DispatchError).details as {
          policy: { failures: Array<{ code: string }> };
        }
      ).policy;
      expect(policy.failures.map((f) => f.code)).toContain("PR_OR_DIFF_REQUIRED");
    }

    // Give the ticket a REAL non-empty branch diff → now the gate passes.
    giveTicketRealDelivery(wg, ticketId, human);
    expect(wg.approveReview(ticketId, reviewer).ticket.status).toBe("ready_for_merge");
    expect(wg.markMerged(ticketId, systemActor).ticket.status).toBe("done");
  });

  it("writes an auditable evidence.recorded event tagged system_delivery", () => {
    const wg = freshWg();
    const { ticketId } = inReviewTicket(wg, { satisfyAc: true });
    wg.attachDeliveryEvidence(
      ticketId,
      { evidenceType: "diff_summary", summary: "diff" },
      systemActor,
    );

    const event = wg
      .view(ticketId)
      .events.filter((e) => e.event_type === "evidence.recorded")
      .map((e) => JSON.parse(e.payload_json ?? "{}") as { source?: string; ac_id: string | null })
      .find((p) => p.source === "system_delivery");
    expect(event).toBeDefined();
    // Crucially it carries no ac_id — AC satisfaction stays claim-scoped.
    expect(event?.ac_id).toBeNull();
  });

  it("is rejected for a non-system actor (agents cannot bypass claims)", () => {
    const wg = freshWg();
    const { ticketId } = inReviewTicket(wg, { satisfyAc: true });

    for (const actor of [agentActor, human, { type: "admin" as const }]) {
      try {
        wg.attachDeliveryEvidence(
          ticketId,
          { evidenceType: "diff_summary", summary: "diff" },
          actor,
        );
        throw new Error(`should have thrown for actor ${actor.type}`);
      } catch (err) {
        expect(err).toBeInstanceOf(DispatchError);
        expect((err as DispatchError).code).toBe("ACTOR_NOT_PERMITTED");
      }
    }
  });

  it("does not satisfy an acceptance criterion (only the PR/diff gate)", () => {
    const wg = freshWg();
    const { ticketId, acId } = inReviewTicket(wg, { satisfyAc: false });
    wg.attachDeliveryEvidence(
      ticketId,
      { evidenceType: "diff_summary", summary: "diff" },
      systemActor,
    );

    const ac = wg.view(ticketId).acceptanceCriteria.find((c) => c.id === acId);
    expect(ac?.status).toBe("pending");
    // And approval is still blocked on the unresolved AC.
    expect(() => wg.approveReview(ticketId, reviewer)).toThrowError(DispatchError);
  });

  it("still requires agents to present a claim token on the claim-scoped path", () => {
    // Guard the un-weakened path: an agent with no token is refused on recordEvidence.
    const wg = freshWg();
    const t = wg.createTicket({ title: "x", policy_pack: "solo_loose" }, human);
    expect(() =>
      wg.recordEvidence(
        { ticket_id: t.id, evidence_type: "diff_summary", summary: "diff" },
        agentActor,
      ),
    ).toThrowError(DispatchError);
  });
});

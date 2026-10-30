// board-move-bypasses-guards: a raw board move must not skip the guarded submit and
// reject paths.
//  - in_progress -> in_review (and claimed -> in_progress) of AGENT-LEASED work is
//    refused: it left the lease dangling and broke the agent's own submit. Unleased
//    work (a by-hand delivery) is still handed in by a move.
//  - in_review -> ready|refining and ready_for_merge -> refining are rejections: the
//    move now takes the reject path (AC reset, attempt bump, feedback, retry-cap
//    park), so a rework can no longer pass the done gate on the previous evidence.
import { describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { ALLOWED, GUARDED_EDGES } from "../src/services/transitionService.js";
import { TestClock } from "../src/util/clock.js";
import { DispatchError } from "../src/util/errors.js";
import { giveTicketRealDelivery, nonEmptyDiffRunner } from "./helpers/realDiff.js";

const human: Actor = { type: "human", id: "tom" };
const reviewer: Actor = { type: "human", id: "rev" };

function open(maxAttempts = 3): Dispatch {
  return Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner, { maxAttempts });
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof DispatchError ? e.code : String(e);
  }
  return undefined;
}

/** A team_light ticket claimed by an agent; returns its id, AC id, agent and token. */
function claimed(wg: Dispatch): { id: string; acId: string; agent: Actor; token: string } {
  const t = wg.createTicket({ title: "t", description: "d", policy_pack: "team_light" }, human);
  const { ac } = wg.addAcceptanceCriterion({ ticket_id: t.id, text: "Returns 200" }, human);
  giveTicketRealDelivery(wg, t.id, human);
  wg.markReady(t.id, human);
  const reg = wg.registerAgent({ display_name: "a" }, human);
  const agent: Actor = { type: "agent", id: reg.id };
  const claim = wg.claimNextTicket({ agentId: reg.id, ttlSeconds: 600 }, agent);
  return { id: t.id, acId: ac.id, agent, token: claim!.claimToken };
}

/** Claim, satisfy the AC with evidence and submit: an in_review ticket that passes the gate. */
function inReview(wg: Dispatch): { id: string; acId: string; agent: Actor } {
  const c = claimed(wg);
  wg.recordEvidence(
    {
      claimToken: c.token,
      ticket_id: c.id,
      ac_id: c.acId,
      evidence_type: "test_output",
      summary: "passed",
    },
    c.agent,
  );
  wg.submitForReview({ claimToken: c.token, ticket_id: c.id, reason: "done" }, c.agent);
  expect(wg.view(c.id).ticket.status).toBe("in_review");
  return c;
}

describe("board moves of leased in-flight work are refused", () => {
  it("claimed -> in_progress and in_progress -> in_review drags of an agent's lease are ILLEGAL", () => {
    const wg = open();
    const c = claimed(wg);
    expect(codeOf(() => wg.moveTicket(c.id, "in_progress", human))).toBe("ILLEGAL_TRANSITION");
    // Its own claim-gated submit still works (and completes the lease).
    const sub = wg.submitForReview({ claimToken: c.token, ticket_id: c.id }, c.agent);
    expect(sub.status).toBe("in_review");
    wg.db.close();
  });

  it("an in_progress ticket with a live lease cannot be dragged into review", () => {
    const wg = open();
    const c = claimed(wg);
    wg.transitions.transition({
      ticketId: c.id,
      actor: { type: "system" },
      toStatus: "in_progress",
      expectedFromStatus: "claimed",
      agentSubmit: true,
    });
    expect(codeOf(() => wg.moveTicket(c.id, "in_review", human))).toBe("ILLEGAL_TRANSITION");
    expect(wg.view(c.id).ticket.status).toBe("in_progress");
    wg.db.close();
  });

  it("a human's by-hand (unleased) delivery is still handed in by a move", () => {
    const wg = open();
    const t = wg.createTicket({ title: "t", description: "d", policy_pack: "solo_loose" }, human);
    wg.addAcceptanceCriterion({ ticket_id: t.id, text: "AC" }, human);
    wg.markReady(t.id, human);
    wg.humanClaimTicket(t.id, human);
    expect(wg.moveTicket(t.id, "in_review", human).ticket.status).toBe("in_review");
    wg.db.close();
  });
});

describe("dragging a reviewed ticket back for rework takes the reject path", () => {
  for (const [from, to] of [
    ["in_review", "ready"],
    ["in_review", "refining"],
    ["ready_for_merge", "refining"],
  ] as const) {
    it(`${from} -> ${to}: ACs reset, attempt bumped, feedback recorded`, () => {
      const wg = open();
      const c = inReview(wg);
      if (from === "ready_for_merge") wg.approveReview(c.id, reviewer);
      expect(wg.view(c.id).ticket.status).toBe(from);

      const res = wg.moveTicket(c.id, to, human);
      expect(res.ticket.status).toBe(to);
      const v = wg.view(c.id);
      expect(v.ticket.attempt_count).toBe(1);
      expect(v.acceptanceCriteria.map((a) => a.status)).toEqual(["pending"]);
      expect(JSON.parse(v.ticket.last_review_feedback ?? "{}")).toMatchObject({
        reason: "board_move",
      });
      wg.db.close();
    });
  }

  it("the rework cannot pass the done gate on the previous delivery's evidence", () => {
    const wg = open();
    const c = inReview(wg);
    wg.moveTicket(c.id, "ready", human);
    const again = wg.claimNextTicket({ agentId: c.agent.id!, ttlSeconds: 600 }, c.agent);
    wg.submitForReview({ claimToken: again!.claimToken, ticket_id: c.id }, c.agent);
    const gate = wg.transitions.preview(c.id, "ready_for_merge");
    expect(gate?.allowed).toBe(false);
    expect(gate?.failures.map((f) => f.code)).toContain("AC_UNRESOLVED");
    wg.db.close();
  });

  it("a drag at the retry cap parks the ticket instead of re-queueing it", () => {
    const wg = open(1);
    const c = inReview(wg);
    expect(wg.moveTicket(c.id, "ready", human).ticket.status).toBe("blocked");
    wg.db.close();
  });
});

describe("guarded-edge coverage", () => {
  // Edges out of in-flight / review states that a board move may take as-is: each
  // STOPS the work (requeue releases the lease; block/fail park it) rather than
  // pretending a delivery step happened.
  const BOARD_SAFE = new Set([
    "claimed->ready",
    "claimed->blocked",
    "in_progress->blocked",
    "in_progress->failed",
  ]);
  const IN_FLIGHT = ["claimed", "in_progress", "in_review", "in_testing", "ready_for_merge"];

  it("every ALLOWED edge out of an in-flight or review state is guarded or explicitly board-safe", () => {
    const guarded = (edge: string): boolean => {
      const to = edge.split("->")[1]!;
      return GUARDED_EDGES.some((r) => r.edges.includes(edge) || r.edges.includes(`to:${to}`));
    };
    const open = [...ALLOWED].filter(
      (e) => IN_FLIGHT.includes(e.split("->")[0]!) && !guarded(e) && !BOARD_SAFE.has(e),
    );
    expect(open).toEqual([]);
  });
});

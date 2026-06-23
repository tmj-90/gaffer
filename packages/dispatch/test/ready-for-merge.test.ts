import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
const adminActor: Actor = { type: "admin", id: "boss" };

// The done-gate now recomputes a REAL git diff (P0). Inject a runner that yields a
// non-empty diff so the legitimate approve path passes in a unit test.
function freshWg(clock = new TestClock()): Dispatch {
  return Dispatch.open(":memory:", clock, nonEmptyDiffRunner);
}

/**
 * Drive a team_light ticket to `in_review` with the done-gate satisfiable: a
 * linked repo, one satisfied AC, and a delivery diff attached. Approving it then
 * passes the gate and lands in `ready_for_merge`.
 */
function approvableInReview(wg: Dispatch): { ticketId: string; acId: string } {
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
  wg.submitForReview(
    { claimToken: claim!.claimToken, ticket_id: t.id, reason: "done" },
    agentActor,
  );
  // P0: back the done-gate with a REAL non-empty branch diff (not just prose).
  giveTicketRealDelivery(wg, t.id, human);
  return { ticketId: t.id, acId: ac.id };
}

/** A ticket sitting in `ready_for_merge` (approved, merge in flight). */
function readyForMergeTicket(wg: Dispatch): { ticketId: string; acId: string } {
  const { ticketId, acId } = approvableInReview(wg);
  const res = wg.approveReview(ticketId, reviewer);
  expect(res.ticket.status).toBe("ready_for_merge");
  return { ticketId, acId };
}

describe("approve -> ready_for_merge", () => {
  it("approve lands in ready_for_merge, NOT done", () => {
    const wg = freshWg();
    const { ticketId } = approvableInReview(wg);
    const res = wg.approveReview(ticketId, reviewer);
    expect(res.ticket.status).toBe("ready_for_merge");
    expect(wg.view(ticketId).ticket.status).toBe("ready_for_merge");
  });

  it("the done-gate policy is evaluated at approve time (blocks an unmet gate)", () => {
    const wg = freshWg();
    // No diff attached -> the PR/diff requirement fails on approve.
    wg.registerRepository({ name: "svc", default_branch: "main" }, human);
    const t = wg.createTicket({ title: "x", description: "y", policy_pack: "team_light" }, human);
    wg.linkRepository(t.id, "svc", "primary", human);
    const { ac } = wg.addAcceptanceCriterion({ ticket_id: t.id, text: "ok" }, human);
    wg.markReady(t.id, human);
    const agent = wg.registerAgent({ display_name: "a" }, human);
    const claim = wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, agentActor);
    wg.recordEvidence(
      {
        claimToken: claim!.claimToken,
        ticket_id: t.id,
        ac_id: ac.id,
        evidence_type: "test_output",
        summary: "p",
      },
      agentActor,
    );
    wg.submitForReview({ claimToken: claim!.claimToken, ticket_id: t.id }, agentActor);

    expect(() => wg.approveReview(t.id, reviewer)).toThrowError(DispatchError);
    expect(wg.view(t.id).ticket.status).toBe("in_review");
  });
});

describe("mark-merged (ready_for_merge -> done)", () => {
  it("a system actor marks an approved ticket merged (-> done)", () => {
    const wg = freshWg();
    const { ticketId } = readyForMergeTicket(wg);
    const res = wg.markMerged(ticketId, systemActor);
    expect(res.ticket.status).toBe("done");
    expect(wg.view(ticketId).ticket.status).toBe("done");
  });

  it("an admin actor may mark merged too", () => {
    const wg = freshWg();
    const { ticketId } = readyForMergeTicket(wg);
    expect(wg.markMerged(ticketId, adminActor).ticket.status).toBe("done");
  });

  it("is rejected for a normal human/agent actor (system-only)", () => {
    const wg = freshWg();
    const { ticketId } = readyForMergeTicket(wg);
    for (const actor of [human, reviewer, agentActor]) {
      try {
        wg.markMerged(ticketId, actor);
        throw new Error(`should have thrown for ${actor.type}`);
      } catch (err) {
        expect(err).toBeInstanceOf(DispatchError);
        expect((err as DispatchError).code).toBe("ACTOR_NOT_PERMITTED");
      }
    }
    // Still merging — nobody faked the merge.
    expect(wg.view(ticketId).ticket.status).toBe("ready_for_merge");
  });

  it("a board-drag (moveTicket) can NEVER fake the merge (ready_for_merge -> done)", () => {
    const wg = freshWg();
    const { ticketId } = readyForMergeTicket(wg);
    // moveTicket never sets the markMerged flag, so the guarded transition rejects.
    try {
      wg.moveTicket(ticketId, "done", adminActor);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DispatchError);
      expect((err as DispatchError).code).toBe("ILLEGAL_TRANSITION");
    }
    expect(wg.view(ticketId).ticket.status).toBe("ready_for_merge");
  });

  it("is rejected when the ticket is not in ready_for_merge", () => {
    const wg = freshWg();
    const { ticketId } = approvableInReview(wg); // still in_review
    expect(() => wg.markMerged(ticketId, systemActor)).toThrowError(DispatchError);
    expect(wg.view(ticketId).ticket.status).toBe("in_review");
  });
});

describe("reopen-for-review from ready_for_merge", () => {
  it("a conflict reopen takes a merging ticket back to in_review (system-only)", () => {
    const wg = freshWg();
    const { ticketId } = readyForMergeTicket(wg);
    const res = wg.reopenForReview(
      ticketId,
      { reason: "auto-merge conflict", resolution: "kept both sides" },
      systemActor,
    );
    expect(res.status).toBe("in_review");
    expect(wg.view(ticketId).ticket.status).toBe("in_review");
  });

  it("rejects a normal-user board-drag of ready_for_merge -> in_review", () => {
    const wg = freshWg();
    const { ticketId } = readyForMergeTicket(wg);
    try {
      wg.moveTicket(ticketId, "in_review", adminActor);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DispatchError);
      expect((err as DispatchError).code).toBe("ILLEGAL_TRANSITION");
    }
    expect(wg.view(ticketId).ticket.status).toBe("ready_for_merge");
  });
});

describe("rework / won't-do from ready_for_merge", () => {
  it("rework (-> refining) resets the acceptance criteria", () => {
    const wg = freshWg();
    const { ticketId, acId } = readyForMergeTicket(wg);
    // Pre-condition: the delivery satisfied the AC.
    expect(wg.view(ticketId).acceptanceCriteria.find((a) => a.id === acId)?.status).toBe(
      "satisfied",
    );

    const res = wg.rejectReview(ticketId, "refining", reviewer, "changed my mind pre-merge");
    expect(res.ticket.status).toBe("refining");
    const acs = wg.view(ticketId).acceptanceCriteria;
    expect(acs.every((a) => a.status === "pending")).toBe(true);
  });

  it("won't-do (-> cancelled) resets the ACs and lands in the cancelled bucket", () => {
    const wg = freshWg();
    const { ticketId, acId } = readyForMergeTicket(wg);
    const res = wg.rejectReview(ticketId, "cancelled", reviewer, "out of scope after all");
    expect(res.ticket.status).toBe("cancelled");
    expect(wg.view(ticketId).acceptanceCriteria.find((a) => a.id === acId)?.status).toBe("pending");
  });
});

describe("SPA state -> action map (single source of truth)", () => {
  const appJs = readFileSync(
    fileURLToPath(new URL("../src/api/web/app.js", import.meta.url)),
    "utf8",
  );

  /** Extract the action keys array for a status from the TICKET_ACTION_KEYS literal. */
  function actionKeysFor(status: string): string[] {
    const map = appJs.slice(appJs.indexOf("const TICKET_ACTION_KEYS"));
    const re = new RegExp(`${status}:\\s*\\[([^\\]]*)\\]`);
    const m = re.exec(map);
    expect(m, `no action set for ${status}`).not.toBeNull();
    return (m![1]!.match(/"([^"]+)"/g) ?? []).map((s) => s.replace(/"/g, ""));
  }

  it("offers 'Mark ready' ONLY for draft and refining", () => {
    expect(actionKeysFor("draft")).toContain("mark_ready");
    expect(actionKeysFor("refining")).toContain("mark_ready");
  });

  it("NEVER offers 'Mark ready' for in_review, ready_for_merge, or done", () => {
    for (const status of ["in_review", "ready_for_merge", "done"]) {
      expect(actionKeysFor(status)).not.toContain("mark_ready");
    }
  });

  it("in_review offers approve / rework / wont_do", () => {
    expect(actionKeysFor("in_review")).toEqual(["approve", "rework", "wont_do"]);
  });

  it("ready_for_merge offers mark_merged / rework (no mark_ready, no approve)", () => {
    const keys = actionKeysFor("ready_for_merge");
    expect(keys).toContain("mark_merged");
    expect(keys).toContain("rework");
    expect(keys).not.toContain("mark_ready");
    expect(keys).not.toContain("approve");
  });

  it("renders the 'Approved · merging' column label and the ready_for_merge move target", () => {
    expect(appJs).toContain('ready_for_merge: "Approved · merging"');
  });
});

describe("board() exposes readyForMerge", () => {
  it("surfaces the approved-and-merging tickets in a dedicated array AND column", () => {
    const wg = freshWg();
    const { ticketId } = readyForMergeTicket(wg);

    const board = wg.board();
    expect(board.readyForMerge.map((c) => c.id)).toContain(ticketId);

    const col = board.columns.find((c) => c.column === "ready_for_merge");
    expect(col).toBeDefined();
    expect(col!.cards.map((c) => c.id)).toContain(ticketId);
    // It is NOT in the done column.
    const done = board.columns.find((c) => c.column === "done");
    expect(done!.cards.map((c) => c.id)).not.toContain(ticketId);
  });

  it("the column is empty (and array empty) when nothing is merging", () => {
    const wg = freshWg();
    wg.createTicket({ title: "draft", description: "x", policy_pack: "solo_loose" }, human);
    const board = wg.board();
    expect(board.readyForMerge).toEqual([]);
  });
});

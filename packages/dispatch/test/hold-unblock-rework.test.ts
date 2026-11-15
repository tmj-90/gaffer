// A HELD APPROVED TICKET THAT A PERSON UNBLOCKS IS A REWORK ROUND (audit finding 7).
//
// The runner holds an approved ticket for a human (holdForHuman: ready_for_merge or
// in_testing -> blocked; merge gate red, CI red, an ignored file in the way). Every
// send-back through rejectReview resets the acceptance criteria and bumps attempt_count,
// because "a rework could pass the done gate on the previous delivery's evidence". The
// hold did neither, and `wg unblock` then returned it to ready with its criteria still
// satisfied and no attempt counted: redelivered on the old evidence, unseen by the retry
// cap. humanUnblockTicket now treats an unblock of such a hold back into the queue as the
// send-back it is.

import { describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { systemClock } from "../src/util/clock.js";
import { giveTicketRealDelivery, nonEmptyDiffRunner } from "./helpers/realDiff.js";

const human: Actor = { type: "human", id: "tom" };
const system: Actor = { type: "system" };
const agentActor: Actor = { type: "agent", id: "agent-runner" };

function freshWg(): Dispatch {
  return Dispatch.open(":memory:", systemClock, nonEmptyDiffRunner);
}

/** A ticket a person approved: ready_for_merge, its one criterion satisfied by evidence. */
function approved(wg: Dispatch) {
  const t = wg.createTicket({ title: "Ship", description: "x", policy_pack: "team_light" }, human);
  const { ac } = wg.addAcceptanceCriterion({ ticket_id: t.id, text: "ok" }, human);
  giveTicketRealDelivery(wg, t.id, human, { repoName: "billing-api" });
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
  wg.submitForReview({ claimToken: claim!.claimToken, ticket_id: t.id, reason: "d" }, agentActor);
  expect(wg.approveReview(t.id, human).ticket.status).toBe("ready_for_merge");
  return { id: t.id };
}

const acStatuses = (wg: Dispatch, id: string) =>
  wg.view(id).acceptanceCriteria.map((c: { status: string }) => c.status);

describe("hold for a human, then unblock back into the queue", () => {
  it("the approved ticket's criteria were satisfied before the hold (the fixture)", () => {
    const wg = freshWg();
    const { id } = approved(wg);
    expect(acStatuses(wg, id).every((s) => s !== "pending")).toBe(true);
    wg.db.close();
  });

  for (const to of ["ready", "refining"] as const) {
    it(`unblocked to ${to}: every criterion is pending again and the attempt is counted`, () => {
      const wg = freshWg();
      const { id } = approved(wg);
      const before = wg.view(id).ticket.attempt_count;
      wg.holdForHuman(id, { reasonCode: "merge_gate_red", reason: "red on main" }, system);
      expect(wg.view(id).ticket.status).toBe("blocked");
      const res = wg.humanUnblockTicket(id, human, to);
      expect(res.status).toBe(to);
      expect(acStatuses(wg, id)).toEqual(["pending"]);
      expect(wg.view(id).ticket.attempt_count).toBe(before + 1);
      wg.db.close();
    });
  }

  it("the default target (ready) resets too", () => {
    const wg = freshWg();
    const { id } = approved(wg);
    wg.holdForHuman(id, { reasonCode: "ci_red", reason: "CI red" }, system);
    expect(wg.humanUnblockTicket(id, human).status).toBe("ready");
    expect(acStatuses(wg, id)).toEqual(["pending"]);
    wg.db.close();
  });

  // The dashboard's Unblock sheet does not call humanUnblockTicket: it posts a board move
  // (POST /tickets/:id/move, Dispatch.moveTicket), and blocked -> ready / refining is a
  // legal board edge. The reset must not depend on which door the person used.
  for (const to of ["ready", "refining"] as const) {
    it(`the dashboard's Unblock (a board move to ${to}) is a rework round too`, () => {
      const wg = freshWg();
      const { id } = approved(wg);
      const before = wg.view(id).ticket.attempt_count;
      wg.holdForHuman(id, { reasonCode: "merge_gate_red", reason: "red on main" }, system);
      expect(wg.moveTicket(id, to, human).ticket.status).toBe(to);
      expect(acStatuses(wg, id)).toEqual(["pending"]);
      expect(wg.view(id).ticket.attempt_count).toBe(before + 1);
      wg.db.close();
    });
  }

  it("a board move out of a person's own block (from ready) keeps criteria and attempt", () => {
    const wg = freshWg();
    const t = wg.createTicket({ title: "T", description: "x", policy_pack: "team_light" }, human);
    wg.addAcceptanceCriterion({ ticket_id: t.id, text: "ok" }, human);
    giveTicketRealDelivery(wg, t.id, human, { repoName: "billing-api" });
    wg.markReady(t.id, human);
    wg.humanBlockTicket(t.id, "waiting on design", human);
    wg.moveTicket(t.id, "refining", human);
    expect(wg.view(t.id).ticket.attempt_count).toBe(0);
    wg.db.close();
  });

  it("a ticket a person blocked from ready (no delivery) keeps its criteria and attempt", () => {
    const wg = freshWg();
    const t = wg.createTicket({ title: "T", description: "x", policy_pack: "team_light" }, human);
    wg.addAcceptanceCriterion({ ticket_id: t.id, text: "ok" }, human);
    giveTicketRealDelivery(wg, t.id, human, { repoName: "billing-api" });
    wg.markReady(t.id, human);
    wg.humanBlockTicket(t.id, "waiting on design", human);
    wg.humanUnblockTicket(t.id, human, "ready");
    expect(wg.view(t.id).ticket.attempt_count).toBe(0);
    const reset = wg.db
      .prepare(
        "SELECT count(*) AS n FROM work_events WHERE entity_id = ? AND event_type = 'ticket.acceptance_criteria_reset'",
      )
      .get(t.id) as { n: number };
    expect(reset.n).toBe(0);
    wg.db.close();
  });
});

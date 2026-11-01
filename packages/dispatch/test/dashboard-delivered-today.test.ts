// "Delivered today" counts landings (exploratory finding ui-explore/F-03).
//
// The README's scoreboard shows "what's been delivered today"; its tile opens the
// done work and the Floor's lorry says "N despatched today", both of which count
// tickets that LANDED (done) today. The summary used to count every ticket that
// entered in_review OR done since midnight, so a delivery waiting for review made
// the tile read 3 while its link and the Floor showed 2.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { TestClock } from "../src/util/clock.js";
import { giveTicketRealDelivery, nonEmptyDiffRunner } from "./helpers/realDiff.js";

const human: Actor = { type: "human", id: "tom" };
const agentActor: Actor = { type: "agent", id: "agent-runner" };

const ENV_KEYS = ["AUTO_MERGE", "GAFFER_TESTING", "REVIEW_MODE", "GAFFER_MERGE_LANE"] as const;
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  vi.useRealTimers();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** The service clock and the event log's timestamps (real Date) at the same instant. */
function at(iso: string): TestClock {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
  return new TestClock(iso);
}
function advance(clock: TestClock, seconds: number): void {
  clock.advanceSeconds(seconds);
  vi.setSystemTime(new Date(Date.now() + seconds * 1000));
}

/** A ticket delivered into review (claim, evidence, submit). */
function inReview(wg: Dispatch, title: string): string {
  const t = wg.createTicket({ title, description: "x", policy_pack: "team_light" }, human);
  const { ac } = wg.addAcceptanceCriterion({ ticket_id: t.id, text: "ok" }, human);
  giveTicketRealDelivery(wg, t.id, human, { repoName: `repo-${t.number}` });
  wg.markReady(t.id, human);
  const agent = wg.registerAgent({ display_name: `a-${t.number}` }, human);
  const claim = wg.claimTicket(
    { ticket_id: t.id, agent_id: agent.id, ttl_seconds: 600, capabilities: [] },
    agentActor,
  );
  wg.recordEvidence(
    {
      claimToken: claim.claimToken,
      ticket_id: t.id,
      ac_id: ac.id,
      evidence_type: "test_output",
      summary: "passed",
    },
    agentActor,
  );
  wg.submitForReview({ claimToken: claim.claimToken, ticket_id: t.id, reason: "done" }, agentActor);
  expect(wg.view(t.id).ticket.status).toBe("in_review");
  return t.id;
}
/** Approve, then mark it merged: the ticket lands (done). */
function land(wg: Dispatch, id: string): void {
  wg.approveReview(id, human);
  if (wg.view(id).ticket.status !== "done") wg.markMerged(id, { type: "system" });
  expect(wg.view(id).ticket.status).toBe("done");
}

describe("dashboard summary: Delivered today counts landings", () => {
  it("a delivery waiting for review is not delivered yet; a landing today is", () => {
    const clock = at("2026-03-10T09:00:00.000Z");
    const wg = Dispatch.open(":memory:", clock, nonEmptyDiffRunner);
    const waiting = inReview(wg, "Waits for review");
    const landed = inReview(wg, "Lands");
    land(wg, landed);
    const s = wg.dashboard();
    expect(s.ticketsByStatus.in_review).toBe(1);
    expect(s.ticketsByStatus.done).toBe(1);
    expect(s.deliveredToday).toBe(1);
    expect(waiting).toBeTruthy();
    wg.db.close();
  });

  it("a landing yesterday is not today's", () => {
    const clock = at("2026-03-10T22:00:00.000Z");
    const wg = Dispatch.open(":memory:", clock, nonEmptyDiffRunner);
    land(wg, inReview(wg, "Landed yesterday"));
    advance(clock, 4 * 3600); // past midnight UTC
    expect(wg.dashboard().deliveredToday).toBe(0);
    land(wg, inReview(wg, "Landed today"));
    expect(wg.dashboard().deliveredToday).toBe(1);
    wg.db.close();
  });
});

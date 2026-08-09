// Track 2a — the HUMAN's "What I own" queue read model (Dispatch.humanQueue()).
//
// Proves the aggregation surfaces everything the OPERATOR owns — pending
// decisions (with their reasons), tickets awaiting review sign-off, regulated
// tickets awaiting ready-approval, and factory_strict/regulated tickets awaiting
// reviewer-assignment (mirroring the policy gate's REVIEWER_REQUIRED profile
// set) — each with the reason and how long it has waited. It ALSO surfaces
// runner/human PARKED tickets (blocked, and refining that carries a runner park
// reason_code) as the `parked` kind, while EXCLUDING ordinary agent-owned
// refining churn. Read-only: it changes no decision/approval semantics.

import { describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { TestClock } from "../src/util/clock.js";
import { nonEmptyDiffRunner } from "./helpers/realDiff.js";

const human: Actor = { type: "human", id: "tom" };
const agentActor: Actor = { type: "agent", id: "agent-1" };
const systemActor: Actor = { type: "system" };

function fresh(clock = new TestClock()): Dispatch {
  return Dispatch.open(":memory:", clock, nonEmptyDiffRunner);
}

/** Drive a team_light ticket to `in_review`, returning its id. */
function driveToInReview(wg: Dispatch, title = "Ship it"): string {
  wg.registerRepository({ name: "svc", default_branch: "main" }, human);
  const t = wg.createTicket(
    { title, description: "deliver the thing", policy_pack: "team_light" },
    human,
  );
  wg.linkRepository(t.id, "svc", "primary", human);
  wg.addAcceptanceCriterion({ ticket_id: t.id, text: "Returns 200" }, human);
  wg.markReady(t.id, human);
  const agent = wg.registerAgent({ display_name: "a" }, human);
  const claim = wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, agentActor);
  wg.submitForReview(
    { claimToken: claim!.claimToken, ticket_id: t.id, reason: "please review" },
    agentActor,
  );
  expect(wg.view(t.id).ticket.status).toBe("in_review");
  return t.id;
}

describe("humanQueue: pending decisions (with reasons)", () => {
  it("surfaces a pending decision with its reason and linked ticket", () => {
    const wg = fresh();
    const t = wg.createTicket({ title: "Needs a call", policy_pack: "solo_loose" }, human);
    wg.createDecision(
      {
        title: "Which datastore?",
        question: "Postgres or SQLite for the ledger?",
        severity: "human_required",
        ticketId: t.id,
      },
      agentActor,
    );

    const queue = wg.humanQueue();
    const decisions = queue.items.filter((i) => i.kind === "decision");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.reason).toBe("Postgres or SQLite for the ledger?");
    expect(decisions[0]!.severity).toBe("human_required");
    expect(decisions[0]!.ticket?.id).toBe(t.id);
    expect(queue.counts.decisions).toBe(1);
    wg.db.close();
  });

  it("surfaces a decision raised with no ticket link (ticket is null)", () => {
    const wg = fresh();
    wg.createDecision(
      { title: "Global call", question: "Adopt the new lint config?", severity: "human_preferred" },
      agentActor,
    );
    const queue = wg.humanQueue();
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]!.kind).toBe("decision");
    expect(queue.items[0]!.ticket).toBeNull();
    wg.db.close();
  });

  it("drops a decision once it has been resolved (no longer owed)", () => {
    const wg = fresh();
    const d = wg.createDecision(
      { title: "q", question: "why?", severity: "human_required" },
      agentActor,
    );
    expect(wg.humanQueue().counts.decisions).toBe(1);
    wg.resolveDecision({ decisionId: d.id, status: "accepted", answer: "because" }, human);
    expect(wg.humanQueue().counts.decisions).toBe(0);
    wg.db.close();
  });
});

describe("humanQueue: review sign-offs", () => {
  it("surfaces an in_review ticket with the submit reason and its ticket", () => {
    const wg = fresh();
    const id = driveToInReview(wg);
    const queue = wg.humanQueue();
    const reviews = queue.items.filter((i) => i.kind === "review");
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.ticket?.id).toBe(id);
    expect(reviews[0]!.reason).toBe("please review");
    expect(queue.counts.reviews).toBe(1);
    wg.db.close();
  });
});

describe("humanQueue: regulated tickets awaiting a human gate", () => {
  it("surfaces ready-approval + reviewer-assignment for a fresh regulated draft", () => {
    const wg = fresh();
    const t = wg.createTicket(
      { title: "Regulated change", description: "audit-sensitive", policy_pack: "regulated" },
      human,
    );
    const queue = wg.humanQueue();
    const kinds = queue.items
      .filter((i) => i.ticket?.id === t.id)
      .map((i) => i.kind)
      .sort();
    expect(kinds).toEqual(["ready_approval", "reviewer_assignment"]);
    expect(queue.counts.readyApprovals).toBe(1);
    expect(queue.counts.reviewerAssignments).toBe(1);
    wg.db.close();
  });

  it("drops the ready-approval item once approval is granted", () => {
    const wg = fresh();
    const t = wg.createTicket({ title: "Reg", description: "d", policy_pack: "regulated" }, human);
    wg.grantReadyApproval(t.id, human);
    const queue = wg.humanQueue();
    expect(queue.items.some((i) => i.kind === "ready_approval")).toBe(false);
    expect(queue.items.some((i) => i.kind === "reviewer_assignment")).toBe(true);
    wg.db.close();
  });

  it("drops the reviewer item once a reviewer is assigned", () => {
    const wg = fresh();
    const t = wg.createTicket({ title: "Reg", description: "d", policy_pack: "regulated" }, human);
    wg.assignReviewer(t.id, "alice", human);
    const queue = wg.humanQueue();
    expect(queue.items.some((i) => i.kind === "reviewer_assignment")).toBe(false);
    wg.db.close();
  });

  it("does NOT surface a non-regulated draft (no human gate owed)", () => {
    const wg = fresh();
    wg.createTicket({ title: "Loose", description: "d", policy_pack: "solo_loose" }, human);
    expect(wg.humanQueue().items).toHaveLength(0);
    wg.db.close();
  });
});

describe("humanQueue: factory_strict tickets awaiting reviewer assignment", () => {
  it("surfaces reviewer-assignment (but NOT ready-approval) for a factory_strict draft", () => {
    const wg = fresh();
    const t = wg.createTicket(
      { title: "Strict change", description: "d", policy_pack: "factory_strict" },
      human,
    );
    const queue = wg.humanQueue();
    const kinds = queue.items.filter((i) => i.ticket?.id === t.id).map((i) => i.kind);
    // The policy ready-gate's REVIEWER_REQUIRED fires for factory_strict AND
    // regulated — without this queue item the draft would block invisibly.
    expect(kinds).toEqual(["reviewer_assignment"]);
    expect(queue.counts.reviewerAssignments).toBe(1);
    // The human ready-approval gate (HUMAN_APPROVAL_REQUIRED) is regulated-only.
    expect(queue.counts.readyApprovals).toBe(0);
    wg.db.close();
  });

  it("drops the item once a reviewer is assigned to the factory_strict draft", () => {
    const wg = fresh();
    const t = wg.createTicket(
      { title: "Strict", description: "d", policy_pack: "factory_strict" },
      human,
    );
    wg.assignReviewer(t.id, "alice", human);
    expect(wg.humanQueue().items.some((i) => i.kind === "reviewer_assignment")).toBe(false);
    wg.db.close();
  });
});

/** Drive a team_light ticket to `claimed`, returning its id + the claim token. */
function driveToClaimed(wg: Dispatch, title = "Work"): { id: string; token: string } {
  wg.registerRepository({ name: "svc", default_branch: "main" }, human);
  const t = wg.createTicket(
    { title, description: "deliver the thing", policy_pack: "team_light" },
    human,
  );
  wg.linkRepository(t.id, "svc", "primary", human);
  wg.addAcceptanceCriterion({ ticket_id: t.id, text: "does x" }, human);
  wg.markReady(t.id, human);
  const agent = wg.registerAgent({ display_name: "a" }, human);
  const claim = wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, agentActor);
  return { id: t.id, token: claim!.claimToken };
}

describe("humanQueue: runner/human parked tickets (parked kind)", () => {
  it("surfaces a runner-parked blocked ticket with its reason_code, free-text reason and unpark hint", () => {
    const wg = fresh();
    const { id, token } = driveToClaimed(wg);
    // The runner parks an exhausted rework to the VISIBLE blocked column with a
    // structured reason_code (writes a ticket.blocked event carrying reason_code).
    wg.runnerRelease(
      {
        ticket_id: id,
        to: "blocked",
        claimToken: token,
        reason: "DoD failed after 3 attempts (branch preserved)",
        reasonCode: "rework_exhausted",
        attempt: 3,
        maxAttempts: 3,
      },
      systemActor,
    );
    expect(wg.view(id).ticket.status).toBe("blocked");

    const queue = wg.humanQueue();
    const parked = queue.items.filter((i) => i.kind === "parked");
    expect(parked).toHaveLength(1);
    expect(parked[0]!.ticket?.id).toBe(id);
    expect(parked[0]!.reasonCode).toBe("rework_exhausted");
    // Free text passed through as-is (agent/runner-influenceable, rendered as data).
    expect(parked[0]!.reason).toBe("DoD failed after 3 attempts (branch preserved)");
    expect(parked[0]!.suggestedAction).toBe("unpark");
    expect(parked[0]!.label).toBe("Parked");
    expect(queue.counts.parked).toBe(1);
    wg.db.close();
  });

  it("surfaces a blocked ticket with NO recorded reason_code as 'blocked (no reason recorded)' + cancel hint", () => {
    const wg = fresh();
    const { id, token } = driveToClaimed(wg);
    // markBlocked is the human/agent-initiated block: its ticket.blocked event has
    // NO reason_code key, so the queue labels it explicitly (nothing hidden).
    wg.markBlocked({ claimToken: token, ticket_id: id, reason: "stuck on a dep" }, agentActor);
    expect(wg.view(id).ticket.status).toBe("blocked");

    const queue = wg.humanQueue();
    const parked = queue.items.filter((i) => i.kind === "parked");
    expect(parked).toHaveLength(1);
    expect(parked[0]!.ticket?.id).toBe(id);
    expect(parked[0]!.reasonCode).toBeNull();
    expect(parked[0]!.reason).toBe("blocked (no reason recorded)");
    expect(parked[0]!.suggestedAction).toBe("cancel");
    expect(queue.counts.parked).toBe(1);
    wg.db.close();
  });

  it("does NOT include an agent-owned refining ticket with no park reason_code", () => {
    const wg = fresh();
    const { id, token } = driveToClaimed(wg);
    // A runner park to refining writes NO ticket.blocked event (no reason_code) —
    // ordinary agent-owned rework churn, which stays out of the human's queue.
    wg.runnerRelease(
      { ticket_id: id, to: "refining", claimToken: token, reason: "DoD failed" },
      systemActor,
    );
    expect(wg.view(id).ticket.status).toBe("refining");

    const queue = wg.humanQueue();
    expect(queue.items.some((i) => i.ticket?.id === id)).toBe(false);
    expect(queue.counts.parked).toBe(0);
    wg.db.close();
  });

  it("keeps existing kinds and counts byte-identical for a parked-free fixture", () => {
    const wg = fresh();
    const t = wg.createTicket({ title: "Needs a call", policy_pack: "solo_loose" }, human);
    wg.createDecision(
      { title: "q", question: "Postgres or SQLite?", severity: "human_required", ticketId: t.id },
      agentActor,
    );
    const queue = wg.humanQueue();
    // The parked partition exists and is zero; existing kinds unchanged.
    expect(queue.counts).toEqual({
      total: 1,
      decisions: 1,
      reviews: 0,
      readyApprovals: 0,
      reviewerAssignments: 0,
      parked: 0,
    });
    expect(queue.items.every((i) => i.kind !== "parked")).toBe(true);
    wg.db.close();
  });
});

describe("humanQueue: waited-time + ordering + counts", () => {
  it("computes waitedMs from the wait start and orders oldest-first", () => {
    const clock = new TestClock();
    const wg = fresh(clock);

    // Oldest: a decision raised at T0.
    wg.createDecision({ title: "old", question: "first?", severity: "human_required" }, agentActor);
    clock.advanceSeconds(3600); // +1h

    // Newer: a second decision an hour later.
    wg.createDecision(
      { title: "new", question: "second?", severity: "human_preferred" },
      agentActor,
    );
    clock.advanceSeconds(60); // +1m so both have waited

    const queue = wg.humanQueue();
    expect(queue.items).toHaveLength(2);
    // Oldest-waited leads.
    expect(queue.items[0]!.reason).toBe("first?");
    expect(queue.items[1]!.reason).toBe("second?");
    expect(queue.items[0]!.waitedMs).toBeGreaterThan(queue.items[1]!.waitedMs);
    expect(queue.items[0]!.waitedMs).toBe((3600 + 60) * 1000);
    expect(queue.counts.total).toBe(2);
    wg.db.close();
  });
});

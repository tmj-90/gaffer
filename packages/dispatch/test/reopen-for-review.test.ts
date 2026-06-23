import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { createApiServer } from "../src/api/server.js";
import type { MergeRunner } from "../src/api/mergeRunner.js";
import type { ProductOwnerRunner } from "../src/api/productOwner.js";
import type { PlanBuildRunner } from "../src/api/planBuild.js";
import { TestClock } from "../src/util/clock.js";
import { DispatchError } from "../src/util/errors.js";
import { giveTicketRealDelivery, nonEmptyDiffRunner } from "./helpers/realDiff.js";

const human: Actor = { type: "human", id: "tom" };
const admin: Actor = { type: "admin", id: "boss" };
const reviewer: Actor = { type: "human", id: "rev" };
const systemActor: Actor = { type: "system" };
const agentActor: Actor = { type: "agent", id: "runner" };

// The done-gate now recomputes a REAL git diff (P0); inject a non-empty runner so
// the legitimate approve path passes without a real clone on disk.
function freshWg(): Dispatch {
  return Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner);
}

/** Drive a fresh team_light ticket all the way to `done` (approved review). */
function doneTicket(wg: Dispatch): { ticketId: string; number: number } {
  wg.registerRepository({ name: "svc", default_branch: "main" }, human);
  const t = wg.createTicket(
    { title: "Ship it", description: "deliver", policy_pack: "team_light" },
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
  // Approve -> ready_for_merge, then the merge-complete callback -> done.
  const res = wg.approveReview(t.id, reviewer);
  expect(res.ticket.status).toBe("ready_for_merge");
  const merged = wg.markMerged(t.id, systemActor);
  expect(merged.ticket.status).toBe("done");
  return { ticketId: t.id, number: t.number ?? 0 };
}

describe("reopenForReview (done -> in_review)", () => {
  it("reopens a done ticket for review as a system actor and records the resolution", () => {
    const wg = freshWg();
    const { ticketId } = doneTicket(wg);

    const res = wg.reopenForReview(
      ticketId,
      { reason: "auto-merge conflict resolved", resolution: "kept both sides; tests green" },
      systemActor,
    );
    expect(res.status).toBe("in_review");
    expect(wg.view(ticketId).ticket.status).toBe("in_review");

    // The resolution is recorded as visible delivery-note evidence.
    const evi = wg
      .view(ticketId)
      .evidence.find((e) => e.summary === "kept both sides; tests green");
    expect(evi).toBeDefined();
    expect(evi?.evidence_type).toBe("manual_note");

    // A reopened_for_review event carries the merge_conflict_resolved flag.
    const event = wg
      .view(ticketId)
      .events.find((e) => e.event_type === "ticket.reopened_for_review");
    expect(event).toBeDefined();
    const payload = JSON.parse(event!.payload_json ?? "{}") as {
      merge_conflict_resolved?: boolean;
      resolution?: string;
    };
    expect(payload.merge_conflict_resolved).toBe(true);
    expect(payload.resolution).toBe("kept both sides; tests green");

    wg.db.close();
  });

  it("allows an admin actor too", () => {
    const wg = freshWg();
    const { ticketId } = doneTicket(wg);
    const res = wg.reopenForReview(ticketId, { reason: "r", resolution: "fixed" }, admin);
    expect(res.status).toBe("in_review");
    wg.db.close();
  });

  it("rejects a normal human/agent actor (not a system reopen path)", () => {
    const wg = freshWg();
    const { ticketId } = doneTicket(wg);
    for (const actor of [human, agentActor]) {
      try {
        wg.reopenForReview(ticketId, { reason: "r", resolution: "x" }, actor);
        throw new Error(`should have thrown for ${actor.type}`);
      } catch (err) {
        expect(err).toBeInstanceOf(DispatchError);
        expect((err as DispatchError).code).toBe("ACTOR_NOT_PERMITTED");
      }
    }
    // Still done — no transition happened.
    expect(wg.view(ticketId).ticket.status).toBe("done");
    wg.db.close();
  });

  it("requires a non-empty resolution", () => {
    const wg = freshWg();
    const { ticketId } = doneTicket(wg);
    expect(() =>
      wg.reopenForReview(ticketId, { reason: "r", resolution: "   " }, systemActor),
    ).toThrowError(DispatchError);
    wg.db.close();
  });

  it("is re-reviewable: the reopened ticket can be approved again", () => {
    const wg = freshWg();
    const { ticketId } = doneTicket(wg);
    wg.reopenForReview(ticketId, { reason: "r", resolution: "merged" }, systemActor);
    // The done-gate evidence is still present, so a re-approve lands it back at
    // ready_for_merge, and the merge callback closes it again.
    const res = wg.approveReview(ticketId, reviewer);
    expect(res.ticket.status).toBe("ready_for_merge");
    expect(wg.markMerged(ticketId, systemActor).ticket.status).toBe("done");
    wg.db.close();
  });

  it("rejects an arbitrary user board-drag of done -> in_review (ILLEGAL_TRANSITION)", () => {
    const wg = freshWg();
    const { ticketId } = doneTicket(wg);
    // A normal move (no reopenForReview flag) must NOT re-open a closed ticket.
    try {
      wg.moveTicket(ticketId, "in_review", admin);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DispatchError);
      expect((err as DispatchError).code).toBe("ILLEGAL_TRANSITION");
    }
    expect(wg.view(ticketId).ticket.status).toBe("done");
    wg.db.close();
  });
});

// --- REST surface ----------------------------------------------------------

interface Harness {
  wg: Dispatch;
  baseUrl: string;
  merges: Array<{ ticketNumber: number }>;
  close: () => Promise<void>;
}

const noopPo: ProductOwnerRunner = { run: () => ({ started: false, pid: null }) };
const noopPlan: PlanBuildRunner = { run: async () => ({ phase: "error", error: "n/a" }) };

async function startHarness(): Promise<Harness> {
  const wg = freshWg();
  const merges: Array<{ ticketNumber: number }> = [];
  const mergeRunner: MergeRunner = {
    trigger(input) {
      merges.push(input);
      return { triggered: true, pid: 1234 };
    },
  };
  const server = createApiServer(wg, noopPo, noopPlan, mergeRunner);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    wg,
    merges,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          wg.db.close();
          resolve();
        });
      }),
  };
}

async function call(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

describe("REST: approve -> merge trigger + reopen-for-review + diff", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("POST /tickets/:id/review/approve fires the configured merge command with the ticket number", async () => {
    const { ticketId, number } = inReviewViaWg(h.wg);
    const res = await call(h.baseUrl, "POST", `/tickets/${ticketId}/review/approve`);
    expect(res.status).toBe(200);
    expect(h.merges).toEqual([{ ticketNumber: number }]);
    expect((res.body.merge as { triggered: boolean }).triggered).toBe(true);
  });

  it("POST /tickets/:id/reopen-for-review re-opens a merging ticket and is re-reviewable", async () => {
    const { ticketId } = inReviewViaWg(h.wg);
    await call(h.baseUrl, "POST", `/tickets/${ticketId}/review/approve`);
    // Approve now lands in ready_for_merge (the merge runner is doing the merge).
    expect(h.wg.view(ticketId).ticket.status).toBe("ready_for_merge");

    // The auto-merge hit a conflict; the resolver calls reopen-for-review which
    // takes the still-merging ticket back to review for the resolved diff.
    const res = await call(h.baseUrl, "POST", `/tickets/${ticketId}/reopen-for-review`, {
      reason: "auto-merge conflict resolved",
      resolution: "kept both sides",
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("in_review");
    expect(h.wg.view(ticketId).ticket.status).toBe("in_review");
  });

  it("POST /tickets/:id/mark-merged closes an approved ticket (ready_for_merge -> done)", async () => {
    const { ticketId } = inReviewViaWg(h.wg);
    await call(h.baseUrl, "POST", `/tickets/${ticketId}/review/approve`);
    expect(h.wg.view(ticketId).ticket.status).toBe("ready_for_merge");

    const res = await call(h.baseUrl, "POST", `/tickets/${ticketId}/mark-merged`);
    expect(res.status).toBe(200);
    expect((res.body.ticket as { status: string }).status).toBe("done");
    expect(h.wg.view(ticketId).ticket.status).toBe("done");
  });

  it("POST /tickets/:id/reopen-for-review 422s without a resolution", async () => {
    const { ticketId } = inReviewViaWg(h.wg);
    await call(h.baseUrl, "POST", `/tickets/${ticketId}/review/approve`);
    const res = await call(h.baseUrl, "POST", `/tickets/${ticketId}/reopen-for-review`, {
      reason: "r",
    });
    expect(res.status).toBe(422);
  });

  it("GET /tickets/:id/diff returns a per-repo diff payload", async () => {
    const { ticketId } = inReviewViaWg(h.wg);
    const res = await call(h.baseUrl, "GET", `/tickets/${ticketId}/diff`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.repos)).toBe(true);
  });
});

/** Drive a ticket to in_review (ready to approve) directly via the facade. */
function inReviewViaWg(wg: Dispatch): { ticketId: string; number: number } {
  wg.registerRepository({ name: "svc", default_branch: "main" }, human);
  const t = wg.createTicket({ title: "Ship", description: "x", policy_pack: "team_light" }, human);
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
  return { ticketId: t.id, number: t.number ?? 0 };
}

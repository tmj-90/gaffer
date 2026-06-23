import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import { createApiServer } from "../src/api/server.js";
import type { Actor } from "../src/domain/types.js";
import { TestClock } from "../src/util/clock.js";
import { DispatchError } from "../src/util/errors.js";

const human: Actor = { type: "human", id: "tom" };
const reviewer: Actor = { type: "human", id: "rev" };
const agentActor: Actor = { type: "agent", id: "agent-runner" };

function freshWg(clock = new TestClock()): Dispatch {
  return Dispatch.open(":memory:", clock);
}

/** A solo_loose draft ticket with one (pending) acceptance criterion. */
function draftTicket(wg: Dispatch): { ticketId: string; acId: string } {
  const t = wg.createTicket(
    { title: "Maybe drop this", description: "tbd", policy_pack: "solo_loose" },
    human,
  );
  const { ac } = wg.addAcceptanceCriterion({ ticket_id: t.id, text: "Does the thing" }, human);
  return { ticketId: t.id, acId: ac.id };
}

describe("won't do — core capability", () => {
  it("abandons a draft ticket to the cancelled bucket", () => {
    const wg = freshWg();
    const { ticketId } = draftTicket(wg);
    const res = wg.wontDo(ticketId, human, "duplicate of #12");
    expect(res.ticket.status).toBe("cancelled");
    expect(wg.view(ticketId).ticket.status).toBe("cancelled");

    // The reason is recorded on the transition event.
    const transition = wg
      .view(ticketId)
      .events.filter((e) => e.event_type === "ticket.transitioned")
      .map((e) => JSON.parse(e.payload_json ?? "{}") as { to: string; reason: string })
      .find((p) => p.to === "cancelled");
    expect(transition?.reason).toBe("duplicate of #12");
  });

  it("resets the ticket's acceptance criteria to not-satisfied", () => {
    const wg = freshWg();
    const { ticketId, acId } = draftTicket(wg);
    // Satisfy the AC first via the claim path so there is a satisfied stamp to clear.
    wg.registerRepository({ name: "svc", default_branch: "main" }, human);
    wg.linkRepository(ticketId, "svc", "primary", human);
    wg.markReady(ticketId, human);
    const agent = wg.registerAgent({ display_name: "a" }, human);
    const claim = wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, agentActor);
    wg.recordEvidence(
      {
        claimToken: claim!.claimToken,
        ticket_id: ticketId,
        ac_id: acId,
        evidence_type: "test_output",
        summary: "ok",
      },
      agentActor,
    );
    expect(wg.view(ticketId).acceptanceCriteria.find((a) => a.id === acId)?.status).toBe(
      "satisfied",
    );

    // Release the claim (-> ready) so won't-do is legal from a non-in-flight state.
    wg.moveTicket(ticketId, "ready", human);
    wg.wontDo(ticketId, human, "scrapped");

    expect(wg.view(ticketId).acceptanceCriteria.find((a) => a.id === acId)?.status).toBe("pending");
  });

  it("is REVERSIBLE — a won't-do ticket reopens to refining (default)", () => {
    const wg = freshWg();
    const { ticketId } = draftTicket(wg);
    wg.wontDo(ticketId, human, "nope");
    const res = wg.reopenFromWontDo(ticketId, "refining", human);
    expect(res.ticket.status).toBe("refining");
  });

  it("can reopen all the way to draft for a clean restart", () => {
    const wg = freshWg();
    const { ticketId } = draftTicket(wg);
    wg.wontDo(ticketId, human, "nope");
    expect(wg.reopenFromWontDo(ticketId, "draft", human).ticket.status).toBe("draft");
  });

  it("REJECTS abandoning a claimed (in-flight) ticket", () => {
    const wg = freshWg();
    wg.registerRepository({ name: "svc", default_branch: "main" }, human);
    const t = wg.createTicket(
      { title: "Build", description: "do it", policy_pack: "solo_loose" },
      human,
    );
    wg.markReady(t.id, human);
    const agent = wg.registerAgent({ display_name: "a" }, human);
    wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, agentActor);
    expect(wg.view(t.id).ticket.status).toBe("claimed");

    let err: unknown;
    try {
      wg.wontDo(t.id, human, "abandon");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DispatchError);
    expect((err as DispatchError).code).toBe("ILLEGAL_TRANSITION");
    // The claim + status are untouched — in-flight work is not silently swallowed.
    expect(wg.view(t.id).ticket.status).toBe("claimed");
  });

  it("a raw board move into cancelled is rejected (won't-do must be deliberate)", () => {
    const wg = freshWg();
    const { ticketId } = draftTicket(wg);
    wg.markReady(ticketId, human);
    let err: unknown;
    try {
      wg.moveTicket(ticketId, "cancelled", human);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DispatchError);
    expect((err as DispatchError).code).toBe("ILLEGAL_TRANSITION");
    expect(wg.view(ticketId).ticket.status).toBe("ready");
  });
});

describe("won't do — board bucket", () => {
  it("surfaces cancelled tickets in a dedicated wontDo bucket, not the columns or closed area", () => {
    const wg = freshWg();
    const { ticketId } = draftTicket(wg);
    wg.wontDo(ticketId, human, "drop");

    const board = wg.board();
    expect(board.wontDo.map((c) => c.id)).toContain(ticketId);
    expect(board.closed.map((c) => c.id)).not.toContain(ticketId);
    expect(board.columns.flatMap((c) => c.cards).map((c) => c.id)).not.toContain(ticketId);
  });
});

// --- REST surface -----------------------------------------------------------

interface Harness {
  wg: Dispatch;
  baseUrl: string;
  close: () => Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const wg = Dispatch.open(":memory:", new TestClock());
  const server = createApiServer(wg);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    wg,
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

describe("REST won't-do + reopen", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  function makeDraft(): string {
    const t = h.wg.createTicket({ title: "x", policy_pack: "solo_loose" }, human);
    h.wg.addAcceptanceCriterion({ ticket_id: t.id, text: "ac" }, human);
    return t.id;
  }

  it("POST /tickets/:id/wont-do moves to cancelled (200)", async () => {
    const id = makeDraft();
    const res = await call(h.baseUrl, "POST", `/tickets/${id}/wont-do`, { reason: "no" });
    expect(res.status).toBe(200);
    expect((res.body.ticket as { status: string }).status).toBe("cancelled");
  });

  it("POST /tickets/:id/wont-do requires a reason (422)", async () => {
    const id = makeDraft();
    const res = await call(h.baseUrl, "POST", `/tickets/${id}/wont-do`, {});
    expect(res.status).toBe(422);
  });

  it("POST /tickets/:id/reopen pulls it back to refining by default (200)", async () => {
    const id = makeDraft();
    await call(h.baseUrl, "POST", `/tickets/${id}/wont-do`, { reason: "no" });
    const res = await call(h.baseUrl, "POST", `/tickets/${id}/reopen`, {});
    expect(res.status).toBe(200);
    expect((res.body.ticket as { status: string }).status).toBe("refining");
  });

  it("POST /tickets/:id/review/reject with to=cancelled abandons in one step", async () => {
    // Drive a ticket to in_review, then reject it straight to the won't-do bucket.
    h.wg.registerRepository({ name: "svc", default_branch: "main" }, human);
    const t = h.wg.createTicket(
      { title: "deliver", description: "do the work", policy_pack: "team_light" },
      human,
    );
    h.wg.linkRepository(t.id, "svc", "primary", human);
    const { ac } = h.wg.addAcceptanceCriterion({ ticket_id: t.id, text: "ac" }, human);
    h.wg.markReady(t.id, human);
    const agent = h.wg.registerAgent({ display_name: "a" }, human);
    const claim = h.wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, agentActor);
    h.wg.recordEvidence(
      {
        claimToken: claim!.claimToken,
        ticket_id: t.id,
        ac_id: ac.id,
        evidence_type: "test_output",
        summary: "ok",
      },
      agentActor,
    );
    h.wg.submitForReview(
      { claimToken: claim!.claimToken, ticket_id: t.id, reason: "done" },
      agentActor,
    );

    const res = await call(h.baseUrl, "POST", `/tickets/${t.id}/review/reject`, {
      to: "cancelled",
      reason: "out of scope",
    });
    expect(res.status).toBe(200);
    expect((res.body.ticket as { status: string }).status).toBe("cancelled");
    // ACs reset.
    expect(h.wg.view(t.id).acceptanceCriteria.find((a) => a.id === ac.id)?.status).toBe("pending");
  });

  it("GET /api/board exposes the wontDo bucket", async () => {
    const id = makeDraft();
    await call(h.baseUrl, "POST", `/tickets/${id}/wont-do`, { reason: "no" });
    const res = await call(h.baseUrl, "GET", "/api/board");
    expect(res.status).toBe(200);
    const wontDo = res.body.wontDo as Array<{ id: string }>;
    expect(wontDo.map((c) => c.id)).toContain(id);
  });
});

describe("won't-do reviewer signature (reject -> refining default)", () => {
  it("rejectReview defaults are exercised: refining is a valid rework target", () => {
    const wg = freshWg();
    // Build an in_review ticket inline.
    wg.registerRepository({ name: "svc", default_branch: "main" }, human);
    const t = wg.createTicket(
      { title: "deliver", description: "do the work", policy_pack: "team_light" },
      human,
    );
    wg.linkRepository(t.id, "svc", "primary", human);
    wg.addAcceptanceCriterion({ ticket_id: t.id, text: "ac" }, human);
    wg.markReady(t.id, human);
    const agent = wg.registerAgent({ display_name: "a" }, human);
    const claim = wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, agentActor);
    wg.submitForReview(
      { claimToken: claim!.claimToken, ticket_id: t.id, reason: "done" },
      agentActor,
    );

    expect(wg.rejectReview(t.id, "refining", reviewer, "rework").ticket.status).toBe("refining");
  });
});

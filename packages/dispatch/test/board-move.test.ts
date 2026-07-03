import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import { createApiServer } from "../src/api/server.js";
import type { Actor } from "../src/domain/types.js";
import { TestClock } from "../src/util/clock.js";
import { DispatchError } from "../src/util/errors.js";

const human: Actor = { type: "human", id: "tom" };
const admin: Actor = { type: "admin", id: "boss" };
const agentActor: Actor = { type: "agent", id: "agent-runner" };

function freshWg(clock = new TestClock()): Dispatch {
  return Dispatch.open(":memory:", clock);
}

/** A solo_loose ticket marked `ready` — the un-ready headline case starts here. */
function readyTicket(wg: Dispatch): string {
  const t = wg.createTicket(
    { title: "Tidy the backlog", description: "shape it up", policy_pack: "solo_loose" },
    human,
  );
  wg.addAcceptanceCriterion({ ticket_id: t.id, text: "AC" }, human); // Guard A: ≥1 AC required to ready
  wg.markReady(t.id, human);
  expect(wg.view(t.id).ticket.status).toBe("ready");
  return t.id;
}

describe("board move — core capability", () => {
  it("un-readies a ticket: ready -> draft (the headline reversible move)", () => {
    const wg = freshWg();
    const id = readyTicket(wg);

    const res = wg.moveTicket(id, "draft", human);

    expect(res.ticket.status).toBe("draft");
    expect(res.eventId).toBeTruthy();
    // The move is auditable as a normal transition event.
    const events = wg.listTicketEvents(id);
    const transitioned = events.find((e) => e.event_type === "ticket.transitioned");
    expect(transitioned).toBeTruthy();
  });

  it("accepts a board column key as the target (in_progress column self-resolves)", () => {
    const wg = freshWg();
    const id = readyTicket(wg);
    // "draft" is both a status and a column key; either resolves the same way.
    const res = wg.moveTicket(id, "draft", admin);
    expect(res.ticket.status).toBe("draft");
  });

  it("REJECTS a board move into cancelled (won't-do is a guarded path, not a drag)", () => {
    const wg = freshWg();
    const id = readyTicket(wg);
    // A stray drag onto a "Won't do" column must NOT silently abandon the ticket;
    // cancelled is only reachable through the deliberate won't-do path.
    let err: unknown;
    try {
      wg.moveTicket(id, "cancelled", human);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DispatchError);
    expect((err as DispatchError).code).toBe("ILLEGAL_TRANSITION");
    expect(wg.view(id).ticket.status).toBe("ready");
  });

  it("REJECTS an illegal move cancelled -> done (state machine, not forced)", () => {
    const wg = freshWg();
    const id = readyTicket(wg);
    // Abandon via the deliberate won't-do path, then assert a raw board drag to a
    // non-reopen target (done) is rejected. cancelled only reopens to draft/refining.
    wg.wontDo(id, human, "not building this");
    expect(wg.view(id).ticket.status).toBe("cancelled");

    let err: unknown;
    try {
      wg.moveTicket(id, "done", human);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DispatchError);
    expect((err as DispatchError).code).toBe("ILLEGAL_TRANSITION");
    // The state was NOT forced — the ticket is still cancelled.
    expect(wg.view(id).ticket.status).toBe("cancelled");
  });

  it("REJECTS dragging a card into in_progress (cannot conjure a claim)", () => {
    const wg = freshWg();
    const id = readyTicket(wg);
    // in_progress is only legally reached from `claimed`; a human board drop from
    // `ready` must be rejected, never silently forced.
    let err: unknown;
    try {
      wg.moveTicket(id, "in_progress", human);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DispatchError);
    expect((err as DispatchError).code).toBe("ILLEGAL_TRANSITION");
    expect(wg.view(id).ticket.status).toBe("ready");
  });

  it("REJECTS a board move into claimed (ghost claim — no lease row)", () => {
    const wg = freshWg();
    const id = readyTicket(wg);
    // A claim is real only when a ticket_claims lease backs it (created by the claim
    // path). A raw board drop to `claimed` must be rejected, never conjure a claimed
    // ticket with no lease — an unrecoverable ghost the expiry sweeper can't see.
    expect(() => wg.moveTicket(id, "claimed", human)).toThrowError(DispatchError);
    try {
      wg.moveTicket(id, "claimed", human);
    } catch (e) {
      expect((e as DispatchError).code).toBe("ILLEGAL_TRANSITION");
    }
    expect(wg.view(id).ticket.status).toBe("ready");
  });

  it("rejects a no-op drop onto the same status", () => {
    const wg = freshWg();
    const id = readyTicket(wg);
    expect(() => wg.moveTicket(id, "ready", human)).toThrowError(DispatchError);
    try {
      wg.moveTicket(id, "ready", human);
    } catch (e) {
      expect((e as DispatchError).code).toBe("NO_OP");
    }
  });

  it("rejects an unknown target with VALIDATION_ERROR", () => {
    const wg = freshWg();
    const id = readyTicket(wg);
    try {
      wg.moveTicket(id, "nonsense", human);
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(DispatchError);
      expect((e as DispatchError).code).toBe("VALIDATION_ERROR");
    }
  });

  it("does NOT touch an active claim — a claimed ticket has no legal board move to draft", () => {
    const wg = freshWg();
    wg.registerRepository({ name: "svc", default_branch: "main" }, human);
    const t = wg.createTicket(
      { title: "Build", description: "do it", policy_pack: "solo_loose" },
      human,
    );
    wg.addAcceptanceCriterion({ ticket_id: t.id, text: "AC" }, human); // Guard A: ≥1 AC required to ready
    wg.markReady(t.id, human);
    const agent = wg.registerAgent({ display_name: "a" }, human);
    wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, agentActor);
    expect(wg.view(t.id).ticket.status).toBe("claimed");

    let err: unknown;
    try {
      wg.moveTicket(t.id, "draft", human);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DispatchError);
    expect((err as DispatchError).code).toBe("ILLEGAL_TRANSITION");
    // The claim + status are untouched.
    expect(wg.view(t.id).ticket.status).toBe("claimed");
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

describe("POST /tickets/:id/move", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("un-readies via the endpoint: ready -> draft returns 200 + the draft ticket", async () => {
    const id = readyTicket(h.wg);
    const res = await call(h.baseUrl, "POST", `/tickets/${id}/move`, { to: "draft" });
    expect(res.status).toBe(200);
    expect((res.body.ticket as { status: string }).status).toBe("draft");
    expect(res.body.event_id).toBeTruthy();
  });

  it("rejects an illegal move with 409 ILLEGAL_TRANSITION", async () => {
    const id = readyTicket(h.wg);
    const res = await call(h.baseUrl, "POST", `/tickets/${id}/move`, { to: "in_progress" });
    expect(res.status).toBe(409);
    expect((res.body.error as { code: string }).code).toBe("ILLEGAL_TRANSITION");
    // The server did not force the move.
    expect(h.wg.view(id).ticket.status).toBe("ready");
  });

  it("rejects an unknown status body with 422", async () => {
    const id = readyTicket(h.wg);
    const res = await call(h.baseUrl, "POST", `/tickets/${id}/move`, { to: "banana" });
    expect(res.status).toBe(422);
  });
});

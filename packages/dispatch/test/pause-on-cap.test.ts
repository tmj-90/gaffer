import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import { createApiServer } from "../src/api/server.js";
import type { Actor } from "../src/domain/types.js";
import { TestClock } from "../src/util/clock.js";
import { DispatchError } from "../src/util/errors.js";

const human: Actor = { type: "human", id: "tom" };
const system: Actor = { type: "system" };
const agentActor: Actor = { type: "agent", id: "agent-runner" };

function freshWg(clock = new TestClock()): Dispatch {
  return Dispatch.open(":memory:", clock);
}

/** Drive a ticket to `claimed` (in-flight) and return its id + claim token. */
function claimedTicket(wg: Dispatch): { ticketId: string; claimToken: string } {
  wg.registerRepository({ name: "svc", default_branch: "main" }, human);
  const t = wg.createTicket(
    { title: "big ticket", description: "lots of work", policy_pack: "solo_loose" },
    human,
  );
  wg.linkRepository(t.id, "svc", "primary", human);
  wg.addAcceptanceCriterion({ ticket_id: t.id, text: "AC" }, human);
  wg.markReady(t.id, human);
  const agent = wg.registerAgent({ display_name: "a" }, human);
  const claim = wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, agentActor);
  return { ticketId: t.id, claimToken: claim!.claimToken };
}

const CTX = {
  reason: "cap_hit" as const,
  branch_name: "gaffer/ticket-7-demo",
  worktree_path: "/data/worktrees/ticket-7/svc",
  worktrees_json: JSON.stringify([{ repo: "svc", wt: "/data/worktrees/ticket-7/svc" }]),
  repo: "svc",
  attempt: 1,
  turns: 200,
  spend: "$2.5600",
};

describe("pause-on-cap — pause + resume context", () => {
  it("pauses an in-flight (claimed) delivery and persists the resume context", () => {
    const wg = freshWg();
    const { ticketId } = claimedTicket(wg);
    const res = wg.pauseDelivery(ticketId, CTX, system);
    expect(res.ticket.status).toBe("paused");
    expect(wg.view(ticketId).ticket.status).toBe("paused");

    const ctx = wg.pausedContext(ticketId);
    expect(ctx).not.toBeNull();
    expect(ctx?.reason).toBe("cap_hit");
    expect(ctx?.branch_name).toBe(CTX.branch_name);
    expect(ctx?.worktree_path).toBe(CTX.worktree_path);
    expect(ctx?.attempt).toBe(1);
    expect(ctx?.turns).toBe(200);
    expect(ctx?.spend).toBe("$2.5600");
    expect(ctx?.resume_requested).toBe(0);

    // The pause is recorded as a distinct event.
    const events = wg.view(ticketId).events.map((e) => e.event_type);
    expect(events).toContain("ticket.paused");
  });

  it("pauses from in_review too (cap can land on a post-submit step)", () => {
    const wg = freshWg();
    const { ticketId, claimToken } = claimedTicket(wg);
    wg.submitForReview({ claimToken, ticket_id: ticketId, reason: "wip" }, agentActor);
    expect(wg.view(ticketId).ticket.status).toBe("in_review");
    const res = wg.pauseDelivery(ticketId, { ...CTX, reason: "budget_cap" }, system);
    expect(res.ticket.status).toBe("paused");
    expect(wg.pausedContext(ticketId)?.reason).toBe("budget_cap");
  });

  it("the resume context SURVIVES a runner restart (persisted to disk)", () => {
    const dir = mkdtempSync(join(tmpdir(), "pause-restart-"));
    const dbPath = join(dir, "dispatch.db");
    try {
      let ticketId: string;
      {
        const wg = Dispatch.open(dbPath, new TestClock());
        ({ ticketId } = claimedTicket(wg));
        wg.pauseDelivery(ticketId, CTX, system);
        wg.db.close();
      }
      // Re-open the SAME file: a brand-new process would see the same row.
      const wg2 = Dispatch.open(dbPath, new TestClock());
      const ctx = wg2.pausedContext(ticketId);
      expect(ctx).not.toBeNull();
      expect(ctx?.branch_name).toBe(CTX.branch_name);
      expect(ctx?.worktree_path).toBe(CTX.worktree_path);
      expect(wg2.view(ticketId).ticket.status).toBe("paused");
      wg2.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("REJECTS pausing a non-in-flight (draft) ticket", () => {
    const wg = freshWg();
    const t = wg.createTicket({ title: "x", policy_pack: "solo_loose" }, human);
    expect(() => wg.pauseDelivery(t.id, CTX, system)).toThrowError(DispatchError);
  });

  it("a raw board move into paused is rejected (pause must be deliberate)", () => {
    const wg = freshWg();
    const { ticketId } = claimedTicket(wg);
    let err: unknown;
    try {
      wg.moveTicket(ticketId, "paused", human);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DispatchError);
    expect((err as DispatchError).code).toBe("ILLEGAL_TRANSITION");
    expect(wg.view(ticketId).ticket.status).toBe("claimed");
  });
});

describe("pause-on-cap — continue / resume / stop transitions", () => {
  it("Continue marks the paused ticket resume-requested and the loop picks it up", () => {
    const wg = freshWg();
    const { ticketId } = claimedTicket(wg);
    wg.pauseDelivery(ticketId, CTX, system);
    expect(wg.listResumeRequested()).toHaveLength(0);

    wg.continuePaused(ticketId, human);
    expect(wg.pausedContext(ticketId)?.resume_requested).toBe(1);
    const queue = wg.listResumeRequested();
    expect(queue).toHaveLength(1);
    expect(queue[0]?.ticket_id).toBe(ticketId);
    // Still paused until the runner actually re-enters delivery.
    expect(wg.view(ticketId).ticket.status).toBe("paused");
  });

  it("beginResume re-enters delivery (paused -> in_progress) and clears resume-requested", () => {
    const wg = freshWg();
    const { ticketId } = claimedTicket(wg);
    wg.pauseDelivery(ticketId, CTX, system);
    wg.continuePaused(ticketId, human);

    const res = wg.beginResume(ticketId, system);
    expect(res.context.worktree_path).toBe(CTX.worktree_path);
    expect(res.context.branch_name).toBe(CTX.branch_name);
    expect(wg.view(ticketId).ticket.status).toBe("in_progress");
    // No longer in the resume queue.
    expect(wg.listResumeRequested()).toHaveLength(0);
  });

  it("REJECTS beginResume on a ticket that isn't paused", () => {
    const wg = freshWg();
    const { ticketId } = claimedTicket(wg);
    expect(() => wg.beginResume(ticketId, system)).toThrowError(DispatchError);
  });

  it("a raw board move from paused to in_progress is rejected (resume must go through the path)", () => {
    const wg = freshWg();
    const { ticketId } = claimedTicket(wg);
    wg.pauseDelivery(ticketId, CTX, system);
    expect(() => wg.moveTicket(ticketId, "in_progress", human)).toThrowError(DispatchError);
    expect(wg.view(ticketId).ticket.status).toBe("paused");
  });

  it("Stop abandons a paused delivery (-> cancelled) and drops the resume context", () => {
    const wg = freshWg();
    const { ticketId } = claimedTicket(wg);
    wg.pauseDelivery(ticketId, CTX, system);
    const res = wg.stopPaused(ticketId, human, "not worth finishing");
    expect(res.ticket.status).toBe("cancelled");
    expect(wg.pausedContext(ticketId)).toBeNull();
  });

  it("paused->refining (human board triage) drops the stale pause context", () => {
    // FIX 2: before the fix, moveTicket(paused->refining) left a stale
    // paused_deliveries row; after the fix it is cleared atomically.
    const wg = freshWg();
    const { ticketId } = claimedTicket(wg);
    wg.pauseDelivery(ticketId, CTX, system);
    expect(wg.pausedContext(ticketId)).not.toBeNull(); // context exists while paused

    // Human board-drag: paused -> refining (triage before re-queueing).
    const res = wg.moveTicket(ticketId, "refining", human);
    expect(res.ticket.status).toBe("refining");
    // Context must be gone — no ghost data for a non-paused ticket.
    expect(wg.pausedContext(ticketId)).toBeNull();
  });

  it("paused->in_progress (resume) PRESERVES the pause context for the runner", () => {
    // The resume path keeps the context alive so the runner can re-enter the
    // existing worktree; only non-resume exits drop it.
    const wg = freshWg();
    const { ticketId } = claimedTicket(wg);
    wg.pauseDelivery(ticketId, CTX, system);
    wg.continuePaused(ticketId, human);
    wg.beginResume(ticketId, system); // paused -> in_progress
    expect(wg.view(ticketId).ticket.status).toBe("in_progress");
    // Context is preserved so the runner knows the worktree path.
    expect(wg.pausedContext(ticketId)).not.toBeNull();
    expect(wg.pausedContext(ticketId)?.branch_name).toBe(CTX.branch_name);
  });

  it("a re-pause after a resume upserts the context (attempt accumulates)", () => {
    const wg = freshWg();
    const { ticketId } = claimedTicket(wg);
    wg.pauseDelivery(ticketId, CTX, system);
    wg.continuePaused(ticketId, human);
    wg.beginResume(ticketId, system); // -> in_progress
    // Capped again mid-resume: pause with a higher attempt.
    wg.pauseDelivery(ticketId, { ...CTX, attempt: 2, spend: "$4.1000" }, system);
    const ctx = wg.pausedContext(ticketId);
    expect(ctx?.attempt).toBe(2);
    expect(ctx?.spend).toBe("$4.1000");
    expect(ctx?.resume_requested).toBe(0);
  });

  it("system claim-expiry recovers a RESUMED (in_progress) ticket, not wedging the sweep", () => {
    // Regression: the `in_progress->ready` guard used to accept only runnerRelease /
    // humanRelease, so a claim-expiry (which sets systemOverride) threw ILLEGAL_TRANSITION
    // for a resumed, in-flight ticket. Inside expireStaleClaims' single transaction that
    // rolled back the WHOLE sweep, wedging it permanently on that ticket.
    const clock = new TestClock();
    const wg = freshWg(clock);
    const { ticketId } = claimedTicket(wg); // claimed, ttl 600, original claim active
    wg.pauseDelivery(ticketId, CTX, system);
    wg.continuePaused(ticketId, human);
    wg.beginResume(ticketId, system); // paused -> in_progress; the ORIGINAL claim is still active
    expect(wg.view(ticketId).ticket.status).toBe("in_progress");

    clock.advanceSeconds(1200); // the in-flight claim goes stale
    const { expired } = wg.expireStaleClaims(system);
    expect(expired).toBe(1);
    // Recovered cleanly to ready (previously threw and rolled the sweep back).
    expect(wg.view(ticketId).ticket.status).toBe("ready");
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

describe("pause-on-cap — REST continue/stop", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  function pausedTicket(): string {
    const { ticketId } = claimedTicket(h.wg);
    h.wg.pauseDelivery(ticketId, CTX, system);
    return ticketId;
  }

  it("POST /tickets/:id/continue marks it resume-requested (200)", async () => {
    const id = pausedTicket();
    const res = await call(h.baseUrl, "POST", `/tickets/${id}/continue`, {});
    expect(res.status).toBe(200);
    expect(res.body.resume_requested).toBe(true);
    expect(h.wg.pausedContext(id)?.resume_requested).toBe(1);
  });

  it("POST /tickets/:id/continue on a non-paused ticket is a 409", async () => {
    const { ticketId } = claimedTicket(h.wg); // claimed, not paused
    const res = await call(h.baseUrl, "POST", `/tickets/${ticketId}/continue`, {});
    expect(res.status).toBe(409);
  });

  it("POST /tickets/:id/stop abandons it to cancelled (200) and drops context", async () => {
    const id = pausedTicket();
    const res = await call(h.baseUrl, "POST", `/tickets/${id}/stop`, { reason: "drop it" });
    expect(res.status).toBe(200);
    expect((res.body.ticket as { status: string }).status).toBe("cancelled");
    expect(h.wg.pausedContext(id)).toBeNull();
  });

  it("POST /tickets/:id/stop works with no body (reason optional)", async () => {
    const id = pausedTicket();
    const res = await call(h.baseUrl, "POST", `/tickets/${id}/stop`, {});
    expect(res.status).toBe(200);
    expect((res.body.ticket as { status: string }).status).toBe("cancelled");
  });
});

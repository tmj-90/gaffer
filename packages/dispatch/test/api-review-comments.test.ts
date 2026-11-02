/**
 * REVIEW COMMENTS over REST: a read token lists the comments but can write none of them
 * (the method gate answers 403 before any route runs), the shared full token writes as the
 * operator, GET /tickets/:id carries the comments, and the Fix these route answers its
 * settled reject_outcome; GET /diff for an in_review ticket predicts it.
 */
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { deriveReadToken } from "../src/api/auth.js";
import { createApiServer } from "../src/api/server.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { TestClock } from "../src/util/clock.js";
import { giveTicketRealDelivery, nonEmptyDiffRunner } from "./helpers/realDiff.js";

const human: Actor = { type: "human", id: "tom" };
const agentActor: Actor = { type: "agent", id: "agent-runner" };
const FULL = "shared-full-token-for-review-comment-tests-0123";
const READ = deriveReadToken(FULL);

let base = "";
let wg: Dispatch;
let close: () => Promise<void>;
const saved = process.env.DISPATCH_API_TOKEN;

beforeEach(async () => {
  process.env.DISPATCH_AUDIT_OFF = "1";
  process.env.DISPATCH_API_TOKEN = FULL;
  wg = Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner, { testingEnabled: false });
  const server = createApiServer(wg);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () =>
    new Promise<void>((resolve) =>
      server.close(() => {
        wg.db.close();
        resolve();
      }),
    );
});
afterEach(async () => {
  await close();
  if (saved === undefined) delete process.env.DISPATCH_API_TOKEN;
  else process.env.DISPATCH_API_TOKEN = saved;
});

async function call(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function inReview(): string {
  const t = wg.createTicket({ title: "c", policy_pack: "solo_loose" }, human);
  wg.addAcceptanceCriterion({ ticket_id: t.id, text: "AC" }, human);
  wg.markReady(t.id, human);
  const agent = wg.registerAgent({ display_name: "Bot" }, human);
  const claim = wg.claimTicket(
    { ticket_id: t.id, agent_id: agent.id, ttl_seconds: 300 },
    agentActor,
  );
  giveTicketRealDelivery(wg, t.id, human);
  wg.recordDeliveryArtifact(
    { claim_token: claim.claimToken, ticket_id: t.id, branch_name: "feat/x" },
    agentActor,
  );
  wg.submitForReview({ claimToken: claim.claimToken, ticket_id: t.id }, agentActor);
  return t.id;
}

describe("REST review comments", () => {
  it("a read token reads the comments and writes none", async () => {
    const id = inReview();
    const made = await call(FULL, "POST", `/tickets/${id}/review/comments`, {
      body: "add a test",
      severity: "must_fix",
    });
    expect(made.status).toBe(201);
    const cid = (made.body.comment as { id: string; author_id: string }).id;
    expect((made.body.comment as { author_id: string }).author_id).toBe("dispatch-api");
    const list = await call(READ, "GET", `/tickets/${id}/review/comments`);
    expect(list.status).toBe(200);
    expect(list.body.counts).toEqual({ open: 1, open_must_fix: 1, resolved: 0, withdrawn: 0 });
    expect(list.body.reject_outcome).toMatchObject({ kind: "to_refining", requirements: 1 });
    for (const [path, body] of [
      [`/tickets/${id}/review/comments`, { body: "x" }],
      [`/tickets/${id}/review/comments/${cid}/resolve`, {}],
      [`/tickets/${id}/review/fix`, {}],
    ] as const) {
      const r = await call(READ, "POST", path, body);
      expect(r.status, path).toBe(403);
    }
    const detail = await call(READ, "GET", `/tickets/${id}`);
    expect((detail.body.review_comments as Array<{ id: string }>).map((c) => c.id)).toEqual([cid]);
    expect(wg.resolveTicket(id).status).toBe("in_review");
  });

  it("GET /diff predicts Fix these; review/fix sends back and answers what it did", async () => {
    const id = inReview();
    await call(FULL, "POST", `/tickets/${id}/review/comments`, {
      body: "rename it",
      severity: "must_fix",
    });
    const diff = await call(FULL, "GET", `/tickets/${id}/diff`);
    expect(diff.body.reject_outcome).toMatchObject({ kind: "to_refining", label: "Fix these (1)" });
    const fix = await call(FULL, "POST", `/tickets/${id}/review/fix`, {});
    expect(fix.status).toBe(200);
    expect((fix.body.ticket as { status: string }).status).toBe("refining");
    expect(fix.body.reject_outcome).toMatchObject({ kind: "to_refining", ac_reset: true });
    expect((fix.body.requirements as unknown[]).length).toBe(1);
    const again = await call(FULL, "POST", `/tickets/${id}/review/fix`, {});
    expect(again.status).toBe(409);
    expect((await call(FULL, "GET", `/tickets/${id}/diff?since=nonsense`)).status).toBe(422);
  });
});

/**
 * REST actor attribution + domain-refusal statuses.
 *
 *   tester  — POST /tickets/:id/tester ran as a hard-coded system actor, so an
 *             acceptance ticket's PASS from the dashboard always hit BINDING_REQUIRED
 *             (and came back as a 500). It now runs as the calling principal: a human
 *             PASS is recorded as a waiver (provenance "human"); a bound PASS is
 *             accepted; a stale contract_hash is a 409 CONTRACT_MISMATCH.
 *   merge:  mark-merged / reopen-for-review name the calling principal instead of
 *             system/dispatch-api. They are admin acts: a named principal needs actor
 *             type admin (a CI bot recording a merge is an admin principal), the same
 *             rule as the CLI's `--as admin`; a human principal is refused, 403.
 *   status  — deliberate refusals (TEST_CONTRACT_LEAK, …) are 4xx, never 500.
 */

import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { setPrincipalResolver } from "../src/api/auth.js";
import { createApiServer } from "../src/api/server.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { listEvents } from "../src/events/eventWriter.js";
import { TestClock } from "../src/util/clock.js";
import { contractHash } from "../src/util/contractHash.js";

import { giveTicketRealDelivery, nonEmptyDiffRunner } from "./helpers/realDiff.js";

const human: Actor = { type: "human", id: "tom" };
const reviewer: Actor = { type: "human", id: "rev" };
const agentActor: Actor = { type: "agent", id: "agent-runner" };
const FULL = "shared-full-token-for-rest-actor-tests-0123456789";
const SHA = "0123456789abcdef0123456789abcdef01234567";

const saved = process.env.DISPATCH_API_TOKEN;
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  setPrincipalResolver(null);
  if (saved === undefined) delete process.env.DISPATCH_API_TOKEN;
  else process.env.DISPATCH_API_TOKEN = saved;
});

async function start(): Promise<{ base: string; wg: Dispatch; token: string; adminToken: string }> {
  process.env.DISPATCH_AUDIT_OFF = "1";
  process.env.DISPATCH_API_TOKEN = FULL;
  const wg = Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner, {
    testingEnabled: false,
  });
  const { token } = wg.createPrincipal({ name: "ci-bot" }, human);
  const { token: adminToken } = wg.createPrincipal(
    { name: "ci-merger", actorType: "admin" },
    human,
  );
  const server = createApiServer(wg);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  close = () =>
    new Promise<void>((resolve) =>
      server.close(() => {
        wg.db.close();
        resolve();
      }),
    );
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    wg,
    token,
    adminToken,
  };
}

async function post(base: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function deliver(wg: Dispatch, ticketId: string, agentId: string): void {
  const claim = wg.claimTicket(
    { ticket_id: ticketId, agent_id: agentId, ttl_seconds: 300 },
    agentActor,
  );
  giveTicketRealDelivery(wg, ticketId, human, { repoName: `delivery-${ticketId}` });
  wg.recordDeliveryArtifact(
    { claim_token: claim.claimToken, ticket_id: ticketId, branch_name: "feat/x" },
    agentActor,
  );
  wg.submitForReview({ claimToken: claim.claimToken, ticket_id: ticketId }, agentActor);
}

/** An epic's acceptance ticket, delivered and sent to the tester before review → in_testing. */
function acceptanceInTesting(wg: Dispatch): string {
  wg.registerRepository({ name: "app", default_branch: "main" }, human);
  const res = wg.createEpic(
    {
      epic: { name: "E", description: "d" },
      tickets: [{ title: "Store", acceptanceCriteria: ["a"], repo: "app" }],
    },
    human,
  );
  const id = (n: number) => wg.resolveTicket(String(n)).id;
  const agent = wg.registerAgent({ display_name: "a" }, human);
  const [impl, acc] = res.ticketNumbers as [number, number];
  wg.markReady(id(impl), human);
  deliver(wg, id(impl), agent.id);
  wg.approveReview(id(impl), reviewer);
  wg.markMerged(id(impl), { type: "system" });
  wg.markReady(id(acc), human);
  deliver(wg, id(acc), agent.id);
  wg.routeToTester(id(acc), { type: "system" });
  expect(wg.resolveTicket(id(acc)).status).toBe("in_testing");
  return id(acc);
}

/** A plain ticket approved into ready_for_merge. */
function readyForMerge(wg: Dispatch): string {
  const t = wg.createTicket(
    { title: "plain", policy_pack: "solo_loose", risk_level: "low" },
    human,
  );
  wg.addAcceptanceCriterion({ ticket_id: t.id, text: "AC" }, human);
  wg.markReady(t.id, human);
  const agent = wg.registerAgent({ display_name: "b" }, human);
  deliver(wg, t.id, agent.id);
  wg.approveReview(t.id, reviewer);
  expect(wg.resolveTicket(t.id).status).toBe("ready_for_merge");
  return t.id;
}

function lastEvent(wg: Dispatch, id: string) {
  const ev = listEvents(wg.db, "ticket", id).filter((e) => e.event_type === "ticket.transitioned");
  return ev[ev.length - 1];
}

describe("REST tester verdict runs as the calling principal", () => {
  it("a human PASS on an acceptance ticket is a 200 waiver (provenance human), not a 500", async () => {
    const { base, wg, token } = await start();
    const acc = acceptanceInTesting(wg);
    const r = await post(base, `/tickets/${acc}/tester`, token, {
      verdict: "pass",
      summary: "I verified it by hand",
    });
    expect(r.status).toBe(200);
    // Tester first: the PASS returns it to review for a person.
    expect(wg.resolveTicket(acc).status).toBe("in_review");
    const ev = wg.db
      .prepare("SELECT payload_json, created_by FROM evidence WHERE ticket_id = ? AND summary = ?")
      .get(acc, "I verified it by hand") as { payload_json: string; created_by: string };
    expect(JSON.parse(ev.payload_json)).toMatchObject({ verdict: "pass", provenance: "human" });
    expect(ev.created_by).toBe("ci-bot");
  });

  it("a bound PASS is accepted; a stale contract_hash is 409 CONTRACT_MISMATCH", async () => {
    const { base, wg, token } = await start();
    const acc = acceptanceInTesting(wg);
    const stale = await post(base, `/tickets/${acc}/tester`, token, {
      verdict: "pass",
      summary: "bound",
      contract_hash: "a".repeat(64),
    });
    expect(stale.status).toBe(409);
    expect((stale.body.error as { code: string }).code).toBe("CONTRACT_MISMATCH");
    // A principal's PASS is a person's waiver (package H1): it carries no runner
    // measurement (a replay is 422) and binds no commit the caller names (409).
    const measured = await post(base, `/tickets/${acc}/tester`, token, {
      verdict: "pass",
      summary: "bound",
      contract_hash: contractHash(wg.db, acc),
      replay: "passed",
    });
    expect(measured.status).toBe(422);
    const named = await post(base, `/tickets/${acc}/tester`, token, {
      verdict: "pass",
      summary: "bound",
      tested_commit: SHA,
      contract_hash: contractHash(wg.db, acc),
    });
    expect(named.status).toBe(409);
    const bound = await post(base, `/tickets/${acc}/tester`, token, {
      verdict: "pass",
      summary: "bound",
      contract_hash: contractHash(wg.db, acc),
    });
    expect(bound.status).toBe(200);
    const ev = wg.db
      .prepare("SELECT payload_json FROM evidence WHERE ticket_id = ? AND summary = 'bound'")
      .get(acc) as { payload_json: string };
    expect(JSON.parse(ev.payload_json)).toMatchObject({
      provenance: "human",
      contract_hash: contractHash(wg.db, acc),
      waiver: { principal: { name: "ci-bot" } },
    });
  });

  it("a malformed binding is a 422, not a silent drop", async () => {
    const { base, wg, token } = await start();
    const acc = acceptanceInTesting(wg);
    const r = await post(base, `/tickets/${acc}/tester`, token, {
      verdict: "pass",
      summary: "x",
      tested_commit: "not-a-sha",
    });
    expect(r.status).toBe(422);
  });
});

describe("REST merge callbacks name the principal", () => {
  it("mark-merged writes the event as admin/<admin principal actor_id>", async () => {
    const { base, wg, adminToken } = await start();
    const id = readyForMerge(wg);
    const r = await post(base, `/tickets/${id}/mark-merged`, adminToken);
    expect(r.status).toBe(200);
    expect(lastEvent(wg, id)).toMatchObject({ actor_type: "admin", actor_id: "ci-merger" });
  });

  it("reopen-for-review writes the event as admin/<admin principal actor_id>", async () => {
    const { base, wg, adminToken } = await start();
    const id = readyForMerge(wg);
    wg.markMerged(id, { type: "system" });
    const r = await post(base, `/tickets/${id}/reopen-for-review`, adminToken, {
      reason: "conflict resolved",
      resolution: "kept both",
    });
    expect(r.status).toBe(200);
    expect(lastEvent(wg, id)).toMatchObject({ actor_type: "admin", actor_id: "ci-merger" });
  });

  it("a human principal may not mark a ticket merged (403, nothing written), like the CLI's --as admin", async () => {
    const { base, wg, token } = await start();
    const id = readyForMerge(wg);
    const before = lastEvent(wg, id);
    const r = await post(base, `/tickets/${id}/mark-merged`, token);
    expect(r.status).toBe(403);
    expect((r.body.error as { code: string; message: string }).code).toBe("ACTOR_NOT_PERMITTED");
    expect((r.body.error as { message: string }).message).toMatch(/admin/);
    expect(wg.resolveTicket(id).status).toBe("ready_for_merge");
    expect(lastEvent(wg, id)).toEqual(before);
  });

  it("a human principal may not reopen a done ticket for review (403, nothing written)", async () => {
    const { base, wg, token } = await start();
    const id = readyForMerge(wg);
    wg.markMerged(id, { type: "system" });
    const before = lastEvent(wg, id);
    const r = await post(base, `/tickets/${id}/reopen-for-review`, token, {
      reason: "conflict resolved",
      resolution: "kept both",
    });
    expect(r.status).toBe(403);
    expect((r.body.error as { code: string }).code).toBe("ACTOR_NOT_PERMITTED");
    expect(wg.resolveTicket(id).status).toBe("done");
    expect(lastEvent(wg, id)).toEqual(before);
  });

  it("the shared token still works, attributed to its operator id", async () => {
    const { base, wg } = await start();
    const id = readyForMerge(wg);
    expect((await post(base, `/tickets/${id}/mark-merged`, FULL)).status).toBe(200);
    expect(lastEvent(wg, id)).toMatchObject({ actor_type: "admin", actor_id: "dispatch-api" });
  });
});

describe("domain refusals are 4xx over REST", () => {
  it("TEST_CONTRACT_LEAK is a 422", async () => {
    const { base, wg, token } = await start();
    const t = wg.createTicket({ title: "x", policy_pack: "solo_loose" }, human);
    const r = await post(base, `/tickets/${t.id}/test-contract`, token, {
      changed_surfaces: ["src/api/server.ts"],
    });
    expect(r.status).toBe(422);
    expect((r.body.error as { code: string }).code).toBe("TEST_CONTRACT_LEAK");
  });
});

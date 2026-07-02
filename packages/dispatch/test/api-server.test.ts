import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { createApiServer } from "../src/api/server.js";
import { TestClock } from "../src/util/clock.js";
import { giveTicketRealDelivery, nonEmptyDiffRunner } from "./helpers/realDiff.js";

const human: Actor = { type: "human", id: "tom" };

interface Harness {
  wg: Dispatch;
  clock: TestClock;
  baseUrl: string;
  close: () => Promise<void>;
}

/** Start an in-memory Dispatch behind the API on an ephemeral port. */
async function startHarness(): Promise<Harness> {
  const clock = new TestClock();
  // Inject a git runner that yields a non-empty diff so the (now universal,
  // solo_loose included) recomputed-diff done-gate can be satisfied by tests
  // that set up a real delivery via giveTicketRealDelivery.
  const wg = Dispatch.open(":memory:", clock, nonEmptyDiffRunner);
  const server = createApiServer(wg);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    wg,
    clock,
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

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

async function call(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<JsonResponse> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

describe("API: human REST surface", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("GET /healthz returns ok", async () => {
    const res = await call(h.baseUrl, "GET", "/healthz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("runs create -> AC -> ready -> review approve over HTTP", async () => {
    const created = await call(h.baseUrl, "POST", "/tickets", {
      title: "Password reset",
      policy_pack: "solo_loose",
    });
    expect(created.status).toBe(201);
    const ticket = created.body.ticket as { id: string; number: number; status: string };
    expect(ticket.status).toBe("draft");

    // Add an AC.
    const ac = await call(h.baseUrl, "POST", `/tickets/${ticket.id}/acceptance-criteria`, {
      text: "Returns 200",
    });
    expect(ac.status).toBe(201);

    // Mark ready (accepts a number ref too).
    const ready = await call(h.baseUrl, "POST", `/tickets/${ticket.number}/ready`);
    expect(ready.status).toBe(200);
    expect((ready.body.ticket as { status: string }).status).toBe("ready");

    // List filters: status=ready returns it.
    const list = await call(h.baseUrl, "GET", "/tickets?status=ready");
    expect(list.status).toBe(200);
    expect((list.body.tickets as unknown[]).length).toBe(1);
    const filteredOut = await call(h.baseUrl, "GET", "/tickets?status=done");
    expect((filteredOut.body.tickets as unknown[]).length).toBe(0);

    // Give the ticket a real, on-disk write repo + delivery branch so the
    // recomputed-diff done-gate (now enforced for solo_loose too) is satisfied
    // by genuine git output rather than agent prose.
    giveTicketRealDelivery(h.wg, ticket.id, human);

    // Drive to in_review via the facade (claim flow isn't exposed over HTTP).
    const agent = h.wg.registerAgent({ display_name: "claude" }, human);
    const claim = h.wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, human);
    expect(claim).not.toBeNull();
    const claimToken = claim!.claimToken;
    h.wg.submitForReview({ claimToken, ticket_id: ticket.id }, human);

    // Full view shows in_review + the AC + an event trail.
    const view = await call(h.baseUrl, "GET", `/tickets/${ticket.id}`);
    expect(view.status).toBe(200);
    expect((view.body.ticket as { status: string }).status).toBe("in_review");
    expect((view.body.acceptance_criteria as unknown[]).length).toBe(1);
    expect((view.body.events as unknown[]).length).toBeGreaterThan(0);

    // Events endpoint mirrors the trail.
    const events = await call(h.baseUrl, "GET", `/tickets/${ticket.id}/events`);
    expect((events.body.events as unknown[]).length).toBeGreaterThan(0);

    // Approve review -> ready_for_merge (the merge runner then marks it merged).
    const approved = await call(h.baseUrl, "POST", `/tickets/${ticket.id}/review/approve`);
    expect(approved.status).toBe(200);
    expect((approved.body.ticket as { status: string }).status).toBe("ready_for_merge");

    // mark-merged closes it (ready_for_merge -> done).
    const merged = await call(h.baseUrl, "POST", `/tickets/${ticket.id}/mark-merged`);
    expect(merged.status).toBe(200);
    expect((merged.body.ticket as { status: string }).status).toBe("done");
  });

  it("rejects a review back to refining", async () => {
    const created = await call(h.baseUrl, "POST", "/tickets", { title: "Refactor" });
    const ticket = created.body.ticket as { id: string };
    // Guard A: ≥1 AC required to ready
    await call(h.baseUrl, "POST", `/tickets/${ticket.id}/acceptance-criteria`, { text: "AC" });
    await call(h.baseUrl, "POST", `/tickets/${ticket.id}/ready`);

    const agent = h.wg.registerAgent({ display_name: "a" }, human);
    const claim = h.wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, human);
    h.wg.submitForReview({ claimToken: claim!.claimToken, ticket_id: ticket.id }, human);

    const rejected = await call(h.baseUrl, "POST", `/tickets/${ticket.id}/review/reject`, {
      to: "refining",
      reason: "needs more tests",
    });
    expect(rejected.status).toBe(200);
    expect((rejected.body.ticket as { status: string }).status).toBe("refining");

    // The reason is carried onto the transition event (not dropped).
    const events = await call(h.baseUrl, "GET", `/tickets/${ticket.id}/events`);
    const list = events.body.events as Array<{ event_type: string; payload_json: string | null }>;
    const transitioned = list.filter((e) => e.event_type === "ticket.transitioned");
    const rejectEvent = transitioned.find(
      (e) => e.payload_json !== null && e.payload_json.includes("needs more tests"),
    );
    expect(rejectEvent).toBeDefined();
  });

  it("rejects a review with a missing reason (422 — reason is required)", async () => {
    const created = await call(h.baseUrl, "POST", "/tickets", { title: "Needs reason" });
    const ticket = created.body.ticket as { id: string };
    // Guard A: ≥1 AC required to ready
    await call(h.baseUrl, "POST", `/tickets/${ticket.id}/acceptance-criteria`, { text: "AC" });
    await call(h.baseUrl, "POST", `/tickets/${ticket.id}/ready`);
    const agent = h.wg.registerAgent({ display_name: "a" }, human);
    const claim = h.wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, human);
    h.wg.submitForReview({ claimToken: claim!.claimToken, ticket_id: ticket.id }, human);

    const bad = await call(h.baseUrl, "POST", `/tickets/${ticket.id}/review/reject`, {
      to: "ready",
    });
    expect(bad.status).toBe(422);
    expect((bad.body.error as { code: string }).code).toBe("VALIDATION_ERROR");
  });

  it("exposes recorded evidence on the ticket view (review queue reads it inline)", async () => {
    const created = await call(h.baseUrl, "POST", "/tickets", { title: "Evidence view" });
    const ticket = created.body.ticket as { id: string };
    const acRes = await call(h.baseUrl, "POST", `/tickets/${ticket.id}/acceptance-criteria`, {
      text: "Tests pass",
    });
    const acId = (acRes.body.acceptance_criterion as { id: string }).id;

    // A human actor may attach evidence with no claim token.
    h.wg.recordEvidence(
      {
        ticket_id: ticket.id,
        ac_id: acId,
        evidence_type: "test_output",
        summary: "42/42 unit tests pass",
        uri: "https://ci.example.com/run/42",
      },
      human,
    );

    const view = await call(h.baseUrl, "GET", `/tickets/${ticket.id}`);
    expect(view.status).toBe(200);
    const evidence = view.body.evidence as Array<Record<string, unknown>>;
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      ac_id: acId,
      evidence_type: "test_output",
      summary: "42/42 unit tests pass",
      uri: "https://ci.example.com/run/42",
    });
  });

  it("creates, lists and resolves a decision", async () => {
    const created = await call(h.baseUrl, "POST", "/decisions", {
      title: "Use OAuth?",
      question: "Should we adopt OAuth?",
      severity: "human_required",
    });
    expect(created.status).toBe(201);
    const decision = created.body.decision as { id: string; status: string };
    expect(decision.status).toBe("human_required");

    const pending = await call(h.baseUrl, "GET", "/decisions");
    expect((pending.body.decisions as unknown[]).length).toBe(1);

    const resolved = await call(h.baseUrl, "POST", `/decisions/${decision.id}/resolve`, {
      status: "accepted",
      answer: "Yes",
      rationale: "Industry standard",
    });
    expect(resolved.status).toBe(200);
    expect((resolved.body.decision as { status: string }).status).toBe("accepted");
    expect((resolved.body.decision as { resolved_answer: string }).resolved_answer).toBe("Yes");

    // Re-resolving conflicts.
    const again = await call(h.baseUrl, "POST", `/decisions/${decision.id}/resolve`, {
      status: "rejected",
    });
    expect(again.status).toBe(409);
    expect((again.body.error as { code: string }).code).toBe("STATE_CONFLICT");

    // Pending list is now empty.
    const empty = await call(h.baseUrl, "GET", "/decisions");
    expect((empty.body.decisions as unknown[]).length).toBe(0);
  });

  it("lists active claims and revokes one, returning the ticket to ready", async () => {
    const created = await call(h.baseUrl, "POST", "/tickets", { title: "Claimable" });
    const ticket = created.body.ticket as { id: string };
    // Guard A: ≥1 AC required to ready
    await call(h.baseUrl, "POST", `/tickets/${ticket.id}/acceptance-criteria`, { text: "AC" });
    await call(h.baseUrl, "POST", `/tickets/${ticket.id}/ready`);
    const agent = h.wg.registerAgent({ display_name: "claude-01" }, human);
    h.wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, human);

    const claims = await call(h.baseUrl, "GET", "/claims");
    expect(claims.status).toBe(200);
    const active = claims.body.claims as Array<{ claim_id: string; ticket_id: string }>;
    expect(active.length).toBe(1);
    expect(active[0]!.ticket_id).toBe(ticket.id);

    const revoked = await call(h.baseUrl, "POST", `/claims/${active[0]!.claim_id}/revoke`);
    expect(revoked.status).toBe(200);

    const view = await call(h.baseUrl, "GET", `/tickets/${ticket.id}`);
    expect((view.body.ticket as { status: string }).status).toBe("ready");

    // No active claims remain.
    const after = await call(h.baseUrl, "GET", "/claims");
    expect((after.body.claims as unknown[]).length).toBe(0);

    // Revoking again conflicts.
    const again = await call(h.baseUrl, "POST", `/claims/${active[0]!.claim_id}/revoke`);
    expect(again.status).toBe(409);
  });

  it("records a delivery artifact over HTTP and persists it onto the ticket", async () => {
    const created = await call(h.baseUrl, "POST", "/tickets", { title: "Deliverable" });
    const ticket = created.body.ticket as { id: string };
    await call(h.baseUrl, "POST", `/tickets/${ticket.id}/ready`);

    const res = await call(h.baseUrl, "POST", `/tickets/${ticket.id}/delivery-artifact`, {
      branch_name: "feat/api",
      pr_url: "https://example.com/pr/7",
      diff_summary: "+5 -1",
    });
    expect(res.status).toBe(200);
    expect(res.body.branch_name).toBe("feat/api");

    const view = await call(h.baseUrl, "GET", `/tickets/${ticket.id}`);
    expect((view.body.ticket as { branch_name: string }).branch_name).toBe("feat/api");
    expect((view.body.ticket as { pr_url: string }).pr_url).toBe("https://example.com/pr/7");

    // A delivery artifact with neither branch nor PR is rejected (422).
    const bad = await call(h.baseUrl, "POST", `/tickets/${ticket.id}/delivery-artifact`, {
      commit: "abc",
    });
    expect(bad.status).toBe(422);
  });

  it("sets and reads required capabilities over HTTP", async () => {
    const created = await call(h.baseUrl, "POST", "/tickets", { title: "Caps" });
    const ticket = created.body.ticket as { id: string };

    const put = await call(h.baseUrl, "PUT", `/tickets/${ticket.id}/required-capabilities`, {
      capabilities: ["rust", "tests"],
    });
    expect(put.status).toBe(200);
    expect((put.body.capabilities as string[]).sort()).toEqual(["rust", "tests"]);

    const get = await call(h.baseUrl, "GET", `/tickets/${ticket.id}/required-capabilities`);
    expect((get.body.capabilities as string[]).sort()).toEqual(["rust", "tests"]);
  });

  it("grants a regulated ready-approval over HTTP", async () => {
    h.wg.registerRepository({ name: "web", default_branch: "main" }, human);
    const created = await call(h.baseUrl, "POST", "/tickets", {
      title: "Regulated",
      description: "desc",
      policy_pack: "regulated",
      risk_level: "low",
      repo: "web",
    });
    const ticket = created.body.ticket as { id: string };
    await call(h.baseUrl, "POST", `/tickets/${ticket.id}/acceptance-criteria`, {
      text: "Does X",
      verification_method: "test",
    });
    const rev = await call(h.baseUrl, "PUT", `/tickets/${ticket.id}/reviewer`, {
      reviewer: "rev",
    });
    expect(rev.status).toBe(200);

    // Without approval, ready is denied.
    const denied = await call(h.baseUrl, "POST", `/tickets/${ticket.id}/ready`);
    expect(denied.status).toBe(400);

    // Grant approval, then ready succeeds.
    const grant = await call(h.baseUrl, "POST", `/tickets/${ticket.id}/ready-approval`);
    expect(grant.status).toBe(200);
    const ready = await call(h.baseUrl, "POST", `/tickets/${ticket.id}/ready`);
    expect(ready.status).toBe(200);
    expect((ready.body.ticket as { status: string }).status).toBe("ready");
  });

  it("assigns a reviewer over HTTP, unblocking a factory_strict ticket", async () => {
    h.wg.registerRepository({ name: "web", default_branch: "main" }, human);
    const created = await call(h.baseUrl, "POST", "/tickets", {
      title: "Strict",
      description: "desc",
      policy_pack: "factory_strict",
      risk_level: "low",
      repo: "web",
    });
    const ticket = created.body.ticket as { id: string };
    await call(h.baseUrl, "POST", `/tickets/${ticket.id}/acceptance-criteria`, {
      text: "Does X",
      verification_method: "test",
    });

    // Without a reviewer, ready is denied.
    const denied = await call(h.baseUrl, "POST", `/tickets/${ticket.id}/ready`);
    expect(denied.status).toBe(400);

    // Assign a reviewer, then ready succeeds.
    const put = await call(h.baseUrl, "PUT", `/tickets/${ticket.id}/reviewer`, {
      reviewer: "alice",
    });
    expect(put.status).toBe(200);
    expect(put.body.reviewer).toBe("alice");

    const ready = await call(h.baseUrl, "POST", `/tickets/${ticket.id}/ready`);
    expect(ready.status).toBe(200);
    expect((ready.body.ticket as { status: string }).status).toBe("ready");

    // An empty reviewer is rejected (422).
    const bad = await call(h.baseUrl, "PUT", `/tickets/${ticket.id}/reviewer`, {
      reviewer: "",
    });
    expect(bad.status).toBe(422);
  });

  it("lists agents and repositories", async () => {
    h.wg.registerAgent({ display_name: "claude" }, human);
    h.wg.registerRepository({ name: "web", default_branch: "main" }, human);

    const agents = await call(h.baseUrl, "GET", "/agents");
    expect((agents.body.agents as unknown[]).length).toBe(1);

    const repos = await call(h.baseUrl, "GET", "/repositories");
    expect((repos.body.repositories as unknown[]).length).toBe(1);
  });

  it("returns structured errors with the right status codes", async () => {
    // Unknown ticket -> 404 NOT_FOUND.
    const missing = await call(h.baseUrl, "GET", "/tickets/does-not-exist");
    expect(missing.status).toBe(404);
    expect((missing.body.error as { code: string }).code).toBe("NOT_FOUND");

    // Invalid body -> 422 VALIDATION_ERROR.
    const bad = await call(h.baseUrl, "POST", "/tickets", { title: "" });
    expect(bad.status).toBe(422);
    expect((bad.body.error as { code: string }).code).toBe("VALIDATION_ERROR");

    // Illegal transition (approve a draft) -> 409.
    const created = await call(h.baseUrl, "POST", "/tickets", { title: "Draft only" });
    const ticket = created.body.ticket as { id: string };
    const approve = await call(h.baseUrl, "POST", `/tickets/${ticket.id}/review/approve`);
    expect(approve.status).toBe(409);

    // Unknown route -> 404.
    const nope = await call(h.baseUrl, "GET", "/nope");
    expect(nope.status).toBe(404);
  });

  it("filters the backlog by repo and risk", async () => {
    h.wg.registerRepository({ name: "api", default_branch: "main" }, human);
    const withRepo = await call(h.baseUrl, "POST", "/tickets", {
      title: "Linked",
      repo: "api",
      risk_level: "high",
    });
    expect(withRepo.status).toBe(201);
    await call(h.baseUrl, "POST", "/tickets", { title: "Unlinked", risk_level: "low" });

    const byRepo = await call(h.baseUrl, "GET", "/tickets?repo=api");
    expect((byRepo.body.tickets as unknown[]).length).toBe(1);

    const byRisk = await call(h.baseUrl, "GET", "/tickets?risk=low");
    expect((byRisk.body.tickets as unknown[]).length).toBe(1);
  });
});

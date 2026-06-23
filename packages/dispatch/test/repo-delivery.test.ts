import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApiServer } from "../src/api/server.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { makeHandlers } from "../src/mcp/tools.js";
import { TestClock } from "../src/util/clock.js";
import { DispatchError } from "../src/util/errors.js";
import { nonEmptyDiffRunner } from "./helpers/realDiff.js";

const human: Actor = { type: "human", id: "tom" };
const reviewer: Actor = { type: "human", id: "rev" };
const agentActor: Actor = { type: "agent", id: "agent-runner" };
const systemActor: Actor = { type: "system" };

// H1: the done-gate's PR/diff requirement is satisfied ONLY by a REAL git diff —
// an agent-supplied `pr_url` no longer short-circuits it. These tests exercise the
// per-repo / team_light gates (not pr_url), so we inject a runner that yields a
// non-empty diff and register write repos with an on-disk local_path so branch
// resolution succeeds (the legitimate operator path).
function fresh(clock = new TestClock()): Dispatch {
  return Dispatch.open(":memory:", clock, nonEmptyDiffRunner);
}

/** A draft ticket plus a registered+linked write repo. Returns both ids. */
function ticketWithWriteRepo(wg: Dispatch, repoName = "api"): { ticketId: string; repoId: string } {
  const t = wg.createTicket({ title: "Feature", description: "d" }, human);
  const r = wg.registerRepository({ name: repoName }, human);
  wg.linkRepository(t.id, repoName, "primary", human);
  // linkRepository keeps the legacy columns; promote to a confirmed write boundary.
  wg.setTicketRepoAccess(
    { ticket_id: t.id, repo_id: r.id, access: "write", relation: "confirmed" },
    human,
  );
  return { ticketId: t.id, repoId: r.id };
}

describe("WG-005: per-repo delivery — facade", () => {
  it("single-repo fallback records exactly ONE delivery row", () => {
    const wg = fresh();
    const { ticketId, repoId } = ticketWithWriteRepo(wg);

    const res = wg.recordRepoDelivery(
      { ticket_id: ticketId, repo_id: repoId, branch_name: "feat/x", status: "branch_created" },
      human,
    );
    expect(res.delivery.status).toBe("branch_created");
    expect(res.delivery.branch_name).toBe("feat/x");

    const rows = wg.listRepoDeliveries(ticketId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.repo_id).toBe(repoId);
    expect(rows[0]?.repo_name).toBe("api");
    // The ticket-level summary pointer is untouched by the per-repo write.
    expect(wg.view(ticketId).ticket.branch_name).toBeNull();
    wg.db.close();
  });

  it("upsert is idempotent and enriches the same (ticket,repo) row", () => {
    const wg = fresh();
    const { ticketId, repoId } = ticketWithWriteRepo(wg);

    wg.recordRepoDelivery(
      { ticket_id: ticketId, repo_id: repoId, branch_name: "feat/x", status: "branch_created" },
      human,
    );
    // A later call supplies only commit + status; branch must be preserved.
    wg.recordRepoDelivery(
      { ticket_id: ticketId, repo_id: repoId, commit_sha: "abc123", status: "tests_passed" },
      human,
    );

    const rows = wg.listRepoDeliveries(ticketId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.branch_name).toBe("feat/x");
    expect(rows[0]?.commit_sha).toBe("abc123");
    expect(rows[0]?.status).toBe("tests_passed");
    wg.db.close();
  });

  it("multi-repo records ONE row per write repo", () => {
    const wg = fresh();
    const t = wg.createTicket({ title: "Cross-cut", description: "d" }, human);
    for (const name of ["api", "web", "worker"]) {
      const r = wg.registerRepository({ name }, human);
      wg.setTicketRepoAccess(
        { ticket_id: t.id, repo_id: r.id, access: "write", relation: "confirmed" },
        human,
      );
      wg.recordRepoDelivery(
        { ticket_id: t.id, repo_id: name, branch_name: `feat/${name}`, status: "pr_opened" },
        human,
      );
    }
    const rows = wg.listRepoDeliveries(t.id);
    expect(rows).toHaveLength(3);
    expect(rows.map((d) => d.repo_name).sort()).toEqual(["api", "web", "worker"]);
    wg.db.close();
  });

  it("rejects a delivery for a repo NOT linked to the ticket", () => {
    const wg = fresh();
    const t = wg.createTicket({ title: "T", description: "d" }, human);
    // Registered but never linked to the ticket via ticket_repos.
    wg.registerRepository({ name: "orphan" }, human);

    expect(() =>
      wg.recordRepoDelivery({ ticket_id: t.id, repo_id: "orphan", branch_name: "b" }, human),
    ).toThrowError(DispatchError);
    try {
      wg.recordRepoDelivery({ ticket_id: t.id, repo_id: "orphan", branch_name: "b" }, human);
    } catch (err) {
      expect((err as DispatchError).code).toBe("REPO_NOT_LINKED");
    }
    expect(wg.listRepoDeliveries(t.id)).toHaveLength(0);
    wg.db.close();
  });
});

describe("WG-005: per-repo delivery — MCP surface", () => {
  it("record_repo_delivery tool writes a row; get_ticket carries a compact summary", () => {
    const wg = fresh();
    const { ticketId, repoId } = ticketWithWriteRepo(wg);
    const tools = makeHandlers(wg, agentActor);

    const rec = tools.record_repo_delivery({
      ticket_id: ticketId,
      repo_id: repoId,
      branch_name: "feat/x",
      pr_url: "https://example/pr/1",
      status: "pr_opened",
    });
    expect(rec.isError).toBeUndefined();
    expect(rec.structuredContent.status).toBe("pr_opened");

    const got = tools.get_ticket({ ticket_id: ticketId });
    const deliveries = got.structuredContent.repo_deliveries as Array<Record<string, unknown>>;
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      repo_id: repoId,
      name: "api",
      status: "pr_opened",
      has_branch: true,
      has_pr: true,
    });
    wg.db.close();
  });

  it("record_repo_delivery rejects an unlinked repo with a structured error", () => {
    const wg = fresh();
    const t = wg.createTicket({ title: "T", description: "d" }, human);
    wg.registerRepository({ name: "orphan" }, human);
    const tools = makeHandlers(wg, agentActor);

    const res = tools.record_repo_delivery({
      ticket_id: t.id,
      repo_id: "orphan",
      branch_name: "b",
    });
    expect(res.isError).toBe(true);
    expect((res.structuredContent.error as { code: string }).code).toBe("REPO_NOT_LINKED");
    wg.db.close();
  });
});

describe("WG-005: per-repo delivery — REST surface", () => {
  let wg: Dispatch;
  let baseUrl: string;
  let close: () => Promise<void>;

  beforeEach(async () => {
    wg = fresh();
    const server = createApiServer(wg);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
    close = () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          wg.db.close();
          resolve();
        });
      });
  });
  afterEach(async () => {
    await close();
  });

  async function call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: any }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  }

  it("POST records a delivery and GET lists it", async () => {
    const { ticketId, repoId } = ticketWithWriteRepo(wg);

    const post = await call("POST", `/tickets/${ticketId}/repo-deliveries`, {
      repo_id: repoId,
      branch_name: "feat/x",
      status: "pr_opened",
    });
    expect(post.status).toBe(201);
    expect(post.json.delivery.status).toBe("pr_opened");

    const get = await call("GET", `/tickets/${ticketId}/repo-deliveries`);
    expect(get.status).toBe(200);
    expect(get.json.deliveries).toHaveLength(1);
    expect(get.json.deliveries[0].repo_name).toBe("api");
  });

  it("POST for an unlinked repo returns 409 REPO_NOT_LINKED", async () => {
    const t = wg.createTicket({ title: "T", description: "d" }, human);
    wg.registerRepository({ name: "orphan" }, human);

    const post = await call("POST", `/tickets/${t.id}/repo-deliveries`, {
      repo_id: "orphan",
      branch_name: "b",
    });
    expect(post.status).toBe(409);
    expect(post.json.error.code).toBe("REPO_NOT_LINKED");
  });
});

/**
 * Drive a factory_strict ticket with TWO write repos to `in_review` with every
 * done-gate prerequisite EXCEPT per-repo delivery satisfied, so the test isolates
 * the WG-005 gate. Returns the ticket id and both repo ids.
 */
function strictTwoRepoInReview(wg: Dispatch): {
  ticketId: string;
  repoA: string;
  repoB: string;
} {
  const rA = wg.registerRepository(
    { name: "api", default_branch: "main", local_path: process.cwd() },
    human,
  );
  const rB = wg.registerRepository(
    { name: "web", default_branch: "main", local_path: process.cwd() },
    human,
  );
  const node = wg.createScopeNode({ name: "Platform", type: "product" }, human);

  const t = wg.createTicket(
    {
      title: "Cross-repo change",
      description: "deliver across two repos",
      policy_pack: "factory_strict",
    },
    human,
  );
  // Two confirmed write repos.
  wg.setTicketRepoAccess(
    { ticket_id: t.id, repo_id: rA.id, access: "write", relation: "confirmed" },
    human,
  );
  wg.setTicketRepoAccess(
    { ticket_id: t.id, repo_id: rB.id, access: "write", relation: "confirmed" },
    human,
  );
  wg.setPrimaryScope(t.id, node.id, human);
  wg.assignReviewer(t.id, "rev", human);
  const { ac } = wg.addAcceptanceCriterion(
    { ticket_id: t.id, text: "Returns 200", verification_method: "test", evidence_required: true },
    human,
  );
  wg.markReady(t.id, human);

  const agent = wg.registerAgent({ display_name: "a" }, human);
  const claim = wg.claimTicket(
    { ticket_id: t.id, agent_id: agent.id, ttl_seconds: 600 },
    agentActor,
  );
  // Satisfy the AC with claim-scoped evidence.
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
  // Ticket-level branch so the done-gate's real-diff + BRANCH_REQUIRED pass (H1:
  // the pr_url is an evidence link only; the recorded branch is what the injected
  // nonEmptyDiffRunner resolves a real diff against).
  wg.recordDeliveryArtifact(
    {
      claim_token: claim.claimToken,
      ticket_id: t.id,
      branch_name: "feat/cross",
      pr_url: "https://example/pr/9",
    },
    agentActor,
  );
  wg.submitForReview({ claimToken: claim.claimToken, ticket_id: t.id, reason: "done" }, agentActor);
  expect(wg.view(t.id).ticket.status).toBe("in_review");
  return { ticketId: t.id, repoA: rA.id, repoB: rB.id };
}

describe("WG-005: factory_strict done-gate requires per-repo delivery", () => {
  it("BLOCKS done until EVERY write repo has delivery evidence, then PASSES", () => {
    const wg = fresh();
    const { ticketId, repoA, repoB } = strictTwoRepoInReview(wg);

    // No per-repo deliveries yet → the gate fires.
    try {
      wg.approveReview(ticketId, reviewer);
      throw new Error("expected POLICY_DENIED");
    } catch (err) {
      expect(err).toBeInstanceOf(DispatchError);
      const e = err as DispatchError;
      expect(e.code).toBe("POLICY_DENIED");
      const policy = e.details.policy as { failures: Array<{ code: string }> };
      expect(policy.failures.some((f) => f.code === "REPO_DELIVERY_REQUIRED")).toBe(true);
    }

    // Record delivery for only ONE repo → still blocked (the other is missing).
    wg.recordRepoDelivery(
      { ticket_id: ticketId, repo_id: repoA, status: "review_ready" },
      systemActor,
    );
    expect(() => wg.approveReview(ticketId, reviewer)).toThrowError(DispatchError);

    // Record delivery for the SECOND repo (a branch counts as evidence) → passes.
    wg.recordRepoDelivery(
      { ticket_id: ticketId, repo_id: repoB, branch_name: "feat/web" },
      systemActor,
    );
    // The done-gate (now evaluated at approve time) passes: approve -> ready_for_merge.
    const res = wg.approveReview(ticketId, reviewer);
    expect(res.ticket.status).toBe("ready_for_merge");
    expect(wg.markMerged(ticketId, systemActor).ticket.status).toBe("done");
    wg.db.close();
  });

  it("solo_loose / team_light are unaffected by the per-repo gate", () => {
    const wg = fresh();
    // team_light: two write repos, no per-repo deliveries, yet done is reachable.
    const rA = wg.registerRepository(
      { name: "api", default_branch: "main", local_path: process.cwd() },
      human,
    );
    const rB = wg.registerRepository(
      { name: "web", default_branch: "main", local_path: process.cwd() },
      human,
    );
    const t = wg.createTicket(
      { title: "Ship", description: "deliver", policy_pack: "team_light" },
      human,
    );
    wg.setTicketRepoAccess(
      { ticket_id: t.id, repo_id: rA.id, access: "write", relation: "confirmed" },
      human,
    );
    wg.setTicketRepoAccess(
      { ticket_id: t.id, repo_id: rB.id, access: "write", relation: "confirmed" },
      human,
    );
    wg.addAcceptanceCriterion({ ticket_id: t.id, text: "works" }, human);
    wg.markReady(t.id, human);
    const agent = wg.registerAgent({ display_name: "a" }, human);
    const claim = wg.claimTicket(
      { ticket_id: t.id, agent_id: agent.id, ttl_seconds: 600 },
      agentActor,
    );
    // H1: the done-gate's PR/diff requirement is backed by the REAL git diff now —
    // an agent-supplied `pr_url` no longer satisfies it on its own. Record the
    // delivery BRANCH so the injected nonEmptyDiffRunner resolves a real, non-empty
    // diff (the pr_url stays as an evidence link, not as diff-proof).
    wg.recordDeliveryArtifact(
      {
        claim_token: claim.claimToken,
        ticket_id: t.id,
        branch_name: "feat/two-repo",
        pr_url: "https://example/pr/22",
      },
      agentActor,
    );
    wg.submitForReview(
      { claimToken: claim.claimToken, ticket_id: t.id, reason: "done" },
      agentActor,
    );
    // Resolve the single AC (team_light requires no unresolved AC). Tokenless
    // recordEvidence is permitted for a human actor.
    wg.recordEvidence(
      {
        claimToken: undefined,
        ticket_id: t.id,
        ac_id: wg.view(t.id).acceptanceCriteria[0]!.id,
        evidence_type: "manual_note",
        summary: "ok",
      },
      human,
    );

    const res = wg.approveReview(t.id, reviewer);
    expect(res.ticket.status).toBe("ready_for_merge");
    expect(wg.markMerged(t.id, systemActor).ticket.status).toBe("done");
    wg.db.close();
  });
});

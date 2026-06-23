import { describe, expect, it } from "vitest";

import { DEFAULT_MAX_ATTEMPTS, resolveMaxAttempts, Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { TestClock } from "../src/util/clock.js";
import { DispatchError } from "../src/util/errors.js";
import { emptyDiffRunner, nonEmptyDiffRunner } from "./helpers/realDiff.js";

const human: Actor = { type: "human", id: "tom" };
const reviewer: Actor = { type: "human", id: "rev" };
const admin: Actor = { type: "admin", id: "boss" };
const agentActor: Actor = { type: "agent", id: "agent-runner" };
const systemActor: Actor = { type: "system" };

/**
 * Drive a team_light ticket to `in_review`, with a single write repo that is
 * ON DISK (local_path = cwd) and carries a recorded delivery branch — so the real
 * git diff for it is whatever the injected runner returns. The AC is satisfied so
 * only the PR/diff requirement is in play. Returns the ticket id.
 */
function inReviewWithWriteRepo(wg: Dispatch, branch = "feat/delivery"): string {
  const repo = wg.registerRepository(
    { name: "svc", default_branch: "main", local_path: process.cwd() },
    human,
  );
  const t = wg.createTicket(
    { title: "Ship it", description: "deliver the thing", policy_pack: "team_light" },
    human,
  );
  wg.setTicketRepoAccess(
    { ticket_id: t.id, repo_id: repo.id, access: "write", relation: "confirmed" },
    human,
  );
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
  // Record the delivery branch the gate must correspond to.
  wg.recordRepoDelivery({ ticket_id: t.id, repo_id: repo.id, branch_name: branch }, human);
  wg.submitForReview(
    { claimToken: claim!.claimToken, ticket_id: t.id, reason: "done" },
    agentActor,
  );
  expect(wg.view(t.id).ticket.status).toBe("in_review");
  return t.id;
}

// ---------------------------------------------------------------------------
// Fix 1 (P0): the done-gate must verify the REAL diff, not agent prose.
// ---------------------------------------------------------------------------
describe("P0 fix 1: done-gate is backed by real git, not a diff_summary row", () => {
  it("an agent-authored diff_summary row does NOT satisfy the gate when the real diff is empty", () => {
    // Runner reports an EMPTY diff for the recorded branch — prose must not rescue it.
    const wg = Dispatch.open(":memory:", new TestClock(), emptyDiffRunner);
    const ticketId = inReviewWithWriteRepo(wg);
    // Attach exactly the agent-style prose the red-team relied on.
    wg.attachDeliveryEvidence(
      ticketId,
      { evidenceType: "diff_summary", summary: "+999 -0 across 12 files (TOTALLY real, trust me)" },
      systemActor,
    );

    try {
      wg.approveReview(ticketId, reviewer);
      throw new Error("an empty real diff + prose must NOT satisfy the gate");
    } catch (err) {
      expect(err).toBeInstanceOf(DispatchError);
      const policy = (
        (err as DispatchError).details as {
          policy: { failures: Array<{ code: string }> };
        }
      ).policy;
      expect(policy.failures.map((f) => f.code)).toContain("PR_OR_DIFF_REQUIRED");
    }
    expect(wg.view(ticketId).ticket.status).toBe("in_review");
    wg.db.close();
  });

  it("a real NON-EMPTY branch diff satisfies the gate (legitimate operator path)", () => {
    const wg = Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner);
    const ticketId = inReviewWithWriteRepo(wg);
    // No diff_summary prose at all — the REAL git diff alone carries the gate.
    const res = wg.approveReview(ticketId, reviewer);
    expect(res.ticket.status).toBe("ready_for_merge");
    wg.db.close();
  });

  it("H1: an agent-supplied pr_url does NOT short-circuit the gate when the real diff is empty", () => {
    // `pr_url` is UNVALIDATED agent input (record_delivery_artifact). A prompt-injected
    // agent could stuff a bogus URL to fake a delivery. With an EMPTY real git diff the
    // gate must still REFUSE — the PR link is an evidence pointer, never diff-proof.
    const wg = Dispatch.open(":memory:", new TestClock(), emptyDiffRunner);
    const repo = wg.registerRepository(
      { name: "svc", default_branch: "main", local_path: process.cwd() },
      human,
    );
    const t = wg.createTicket(
      { title: "Ship", description: "x", policy_pack: "team_light" },
      human,
    );
    wg.setTicketRepoAccess(
      { ticket_id: t.id, repo_id: repo.id, access: "write", relation: "confirmed" },
      human,
    );
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
        summary: "p",
      },
      agentActor,
    );
    // The agent records a delivery branch AND a bogus PR url — but produces no real diff.
    wg.recordDeliveryArtifact(
      {
        claim_token: claim!.claimToken,
        ticket_id: t.id,
        branch_name: "feat/x",
        pr_url: "https://example/pr/1",
      },
      agentActor,
    );
    wg.submitForReview(
      { claimToken: claim!.claimToken, ticket_id: t.id, reason: "done" },
      agentActor,
    );

    try {
      wg.approveReview(t.id, reviewer);
      throw new Error("a bogus pr_url + empty real diff must NOT satisfy the gate");
    } catch (err) {
      expect(err).toBeInstanceOf(DispatchError);
      const policy = (
        (err as DispatchError).details as {
          policy: { failures: Array<{ code: string }> };
        }
      ).policy;
      expect(policy.failures.map((f) => f.code)).toContain("PR_OR_DIFF_REQUIRED");
    }
    // The ticket did not move — no human gate was crossed on faked evidence.
    expect(wg.view(t.id).ticket.status).toBe("in_review");
    wg.db.close();
  });

  it("H1: a pr_url ALONGSIDE a real non-empty diff still passes (link is fine, diff is the proof)", () => {
    // The PR link remains a legitimate evidence pointer — it just isn't sufficient
    // on its own. With a real non-empty diff the gate passes as normal.
    const wg = Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner);
    const repo = wg.registerRepository(
      { name: "svc", default_branch: "main", local_path: process.cwd() },
      human,
    );
    const t = wg.createTicket(
      { title: "Ship", description: "x", policy_pack: "team_light" },
      human,
    );
    wg.setTicketRepoAccess(
      { ticket_id: t.id, repo_id: repo.id, access: "write", relation: "confirmed" },
      human,
    );
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
        summary: "p",
      },
      agentActor,
    );
    wg.recordDeliveryArtifact(
      {
        claim_token: claim!.claimToken,
        ticket_id: t.id,
        branch_name: "feat/x",
        pr_url: "https://example/pr/1",
      },
      agentActor,
    );
    wg.submitForReview(
      { claimToken: claim!.claimToken, ticket_id: t.id, reason: "done" },
      agentActor,
    );

    expect(wg.approveReview(t.id, reviewer).ticket.status).toBe("ready_for_merge");
    wg.db.close();
  });
});

// ---------------------------------------------------------------------------
// Fix 2 (P0 authz): actor-type guard on the gate transitions.
// ---------------------------------------------------------------------------
describe("P0 fix 2: approveReview / setTicketRepoAccess refuse an agent actor", () => {
  it("approveReview REFUSES an agent actor but a human/admin still passes", () => {
    const wg = Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner);
    const ticketId = inReviewWithWriteRepo(wg);

    // An agent minting an approval is refused at the in-core gate.
    try {
      wg.approveReview(ticketId, agentActor);
      throw new Error("an agent must not approve a review");
    } catch (err) {
      expect(err).toBeInstanceOf(DispatchError);
      expect((err as DispatchError).code).toBe("ACTOR_NOT_PERMITTED");
    }
    // The ticket did not move.
    expect(wg.view(ticketId).ticket.status).toBe("in_review");

    // The human reviewer (the live dashboard / operator path) still approves.
    expect(wg.approveReview(ticketId, reviewer).ticket.status).toBe("ready_for_merge");
    wg.db.close();
  });

  it("approveReview also passes for an admin actor", () => {
    const wg = Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner);
    const ticketId = inReviewWithWriteRepo(wg);
    expect(wg.approveReview(ticketId, admin).ticket.status).toBe("ready_for_merge");
    wg.db.close();
  });

  it("setTicketRepoAccess REFUSES an agent actor (no self-granting write)", () => {
    const wg = Dispatch.open(":memory:", new TestClock());
    const repo = wg.registerRepository({ name: "svc" }, human);
    const t = wg.createTicket({ title: "x", policy_pack: "solo_loose" }, human);

    try {
      wg.setTicketRepoAccess(
        { ticket_id: t.id, repo_id: repo.id, access: "write", relation: "confirmed" },
        agentActor,
      );
      throw new Error("an agent must not grant itself repo write access");
    } catch (err) {
      expect(err).toBeInstanceOf(DispatchError);
      expect((err as DispatchError).code).toBe("ACTOR_NOT_PERMITTED");
    }
    // No boundary was written.
    expect(wg.workPacketRepos(t.id).writeRepos).toHaveLength(0);
    wg.db.close();
  });

  it("setTicketRepoAccess still passes for a human and an admin actor", () => {
    const wg = Dispatch.open(":memory:", new TestClock());
    const repo = wg.registerRepository({ name: "svc" }, human);
    const t = wg.createTicket({ title: "x", policy_pack: "solo_loose" }, human);

    wg.setTicketRepoAccess(
      { ticket_id: t.id, repo_id: repo.id, access: "write", relation: "confirmed" },
      human,
    );
    expect(wg.workPacketRepos(t.id).writeRepos.some((r) => r.name === "svc")).toBe(true);

    // Admin may flip it too.
    wg.setTicketRepoAccess(
      { ticket_id: t.id, repo_id: repo.id, access: "read", relation: "confirmed" },
      admin,
    );
    expect(wg.workPacketRepos(t.id).writeRepos).toHaveLength(0);
    wg.db.close();
  });

  it("the agent-driven create_epic path still seeds a repo link (internal call is unguarded)", () => {
    // create_epic runs as an agent on the MCP surface; it must still link the repo
    // it names (via the trusted internal applyTicketRepoAccess), even though the
    // PUBLIC setTicketRepoAccess now refuses agents.
    const wg = Dispatch.open(":memory:", new TestClock());
    wg.registerRepository({ name: "app-repo" }, human);
    const res = wg.createEpic(
      {
        epic: { name: "E" },
        tickets: [{ title: "t", repo: "app-repo", access: "write", dependsOn: [] }],
      },
      agentActor,
    );
    const t = wg.resolveTicket(`#${res.ticketNumbers[0]}`);
    expect(wg.workPacketRepos(t.id).writeRepos.some((r) => r.name === "app-repo")).toBe(true);
    wg.db.close();
  });
});

// ---------------------------------------------------------------------------
// Fix 3 (P1): increment attempt_count + cap retries with a park.
// ---------------------------------------------------------------------------
describe("P1 fix 3: attempt_count increments and the retry cap parks the ticket", () => {
  it("a reject-for-rework increments attempt_count", () => {
    const wg = Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner, { maxAttempts: 5 });
    const ticketId = inReviewWithWriteRepo(wg);
    expect(wg.view(ticketId).ticket.attempt_count).toBe(0);

    wg.rejectReview(ticketId, "refining", reviewer, "needs work");
    expect(wg.view(ticketId).ticket.attempt_count).toBe(1);
    expect(wg.view(ticketId).ticket.status).toBe("refining");
  });

  it("a reject-to-ready also increments the counter", () => {
    const wg = Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner, { maxAttempts: 5 });
    const ticketId = inReviewWithWriteRepo(wg);
    wg.rejectReview(ticketId, "ready", reviewer, "again");
    expect(wg.view(ticketId).ticket.attempt_count).toBe(1);
    expect(wg.view(ticketId).ticket.status).toBe("ready");
  });

  it("abandoning to cancelled (won't-do) does NOT increment — it's terminal, not a retry", () => {
    const wg = Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner, { maxAttempts: 5 });
    const ticketId = inReviewWithWriteRepo(wg);
    wg.rejectReview(ticketId, "cancelled", reviewer, "out of scope");
    expect(wg.view(ticketId).ticket.attempt_count).toBe(0);
    expect(wg.view(ticketId).ticket.status).toBe("cancelled");
  });

  it("past the cap the ticket PARKS to blocked instead of re-queuing", () => {
    // cap = 2: the 1st reject re-queues (attempt 1), the 2nd reaches the cap → park.
    const wg = Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner, { maxAttempts: 2 });
    const ticketId = inReviewWithWriteRepo(wg);

    // Attempt 1: re-queues to refining.
    wg.rejectReview(ticketId, "refining", reviewer, "first miss");
    expect(wg.view(ticketId).ticket.status).toBe("refining");
    expect(wg.view(ticketId).ticket.attempt_count).toBe(1);

    // Re-deliver: refining → ready → claim → in_review again.
    const agent = wg.registerAgent({ display_name: "b" }, human);
    wg.markReady(ticketId, human);
    const claim = wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, agentActor);
    wg.recordEvidence(
      {
        claimToken: claim!.claimToken,
        ticket_id: ticketId,
        ac_id: wg.view(ticketId).acceptanceCriteria[0]!.id,
        evidence_type: "test_output",
        summary: "p",
      },
      agentActor,
    );
    wg.submitForReview({ claimToken: claim!.claimToken, ticket_id: ticketId }, agentActor);

    // Attempt 2 reaches the cap → PARKED to blocked (needs-human), NOT re-queued.
    wg.rejectReview(ticketId, "refining", reviewer, "second miss");
    expect(wg.view(ticketId).ticket.status).toBe("blocked");
    expect(wg.view(ticketId).ticket.attempt_count).toBe(2);

    // An auditable park event was recorded.
    const parked = wg.view(ticketId).events.find((e) => e.event_type === "ticket.parked_retry_cap");
    expect(parked).toBeDefined();
    const payload = JSON.parse(parked!.payload_json ?? "{}") as {
      max_attempts: number;
      requested_target: string;
    };
    expect(payload.max_attempts).toBe(2);
    expect(payload.requested_target).toBe("refining");
    wg.db.close();
  });

  it("a parked (blocked) ticket can be unblocked by a human (blocked -> refining/ready)", () => {
    const wg = Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner, { maxAttempts: 1 });
    const ticketId = inReviewWithWriteRepo(wg);
    // cap = 1: the very first reject parks it.
    wg.rejectReview(ticketId, "refining", reviewer, "nope");
    expect(wg.view(ticketId).ticket.status).toBe("blocked");
    // A human triages and sends it back into the pipeline.
    wg.moveTicket(ticketId, "refining", human);
    expect(wg.view(ticketId).ticket.status).toBe("refining");
    wg.db.close();
  });
});

describe("P1 fix 3: max-attempts config", () => {
  it("defaults to DEFAULT_MAX_ATTEMPTS when the env var is unset", () => {
    expect(resolveMaxAttempts({})).toBe(DEFAULT_MAX_ATTEMPTS);
  });

  it("honours a positive integer override", () => {
    expect(resolveMaxAttempts({ DISPATCH_MAX_ATTEMPTS: "7" })).toBe(7);
  });

  it("falls back to the default on a non-positive / unparseable value (fail-safe)", () => {
    expect(resolveMaxAttempts({ DISPATCH_MAX_ATTEMPTS: "0" })).toBe(DEFAULT_MAX_ATTEMPTS);
    expect(resolveMaxAttempts({ DISPATCH_MAX_ATTEMPTS: "-3" })).toBe(DEFAULT_MAX_ATTEMPTS);
    expect(resolveMaxAttempts({ DISPATCH_MAX_ATTEMPTS: "abc" })).toBe(DEFAULT_MAX_ATTEMPTS);
  });
});

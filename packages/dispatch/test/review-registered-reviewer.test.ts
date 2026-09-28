/**
 * REVIEWER ≠ AUTHOR, strengthened: with `requireRegisteredAgentApprover` on (every
 * production entry point — CLI, REST, MCP — opens Dispatch this way) an `agent` actor may
 * approve a review only as a REGISTERED agent. Before this the runner approved as the
 * bare string "<agent>/reviewer": it trivially differed from the delivering agent's id,
 * so the not-author rule was string inequality and any DB-side caller could pick a
 * fresh string. Negative controls mandatory (SECURITY-CRITICAL):
 *   - a bare, unregistered reviewer string is refused (ACTOR_NOT_PERMITTED);
 *   - the delivering agent itself is still refused (registered, but the author);
 *   - a SECOND registered agent approves under an auto policy → ready_for_merge;
 *   - the library default (flag off) is byte-identical to before for fixtures.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import { DispatchError } from "../src/util/errors.js";
import type { Actor } from "../src/domain/types.js";
import { nonEmptyDiffRunner } from "./helpers/realDiff.js";

const human: Actor = { type: "human", id: "tom" };

/** Drive a fresh low-risk ticket on `repoName` to in_review; returns ids incl. the author. */
function buildInReview(
  d: Dispatch,
  repoName: string,
  seq: number,
): { ticketId: string; repoId: string; authorId: string } {
  const repo =
    d.repos.findByName(repoName) ??
    d.registerRepository(
      { name: repoName, default_branch: "main", local_path: process.cwd() },
      human,
    );
  const ticket = d.createTicket({ title: `T-${repoName}-${seq}`, risk_level: "low" }, human);
  d.linkRepository(ticket.id, repoName, "primary", human);
  const { ac } = d.addAcceptanceCriterion({ ticket_id: ticket.id, text: "Works" }, human);
  d.markReady(ticket.id, human);
  const author = d.registerAgent({ display_name: "Builder", max_risk: "critical" }, human);
  const authorActor: Actor = { type: "agent", id: author.id };
  const claim = d.claimNextTicket({ agentId: author.id, ttlSeconds: 600 }, authorActor);
  if (!claim) throw new Error("expected a claim");
  d.recordEvidence(
    {
      claimToken: claim.claimToken,
      ticket_id: ticket.id,
      ac_id: ac.id,
      evidence_type: "test_output",
      summary: "passing",
    },
    authorActor,
  );
  d.recordRepoDelivery(
    { ticket_id: ticket.id, repo_id: repo.id, branch_name: `feat/${repoName}-${seq}` },
    authorActor,
  );
  d.submitForReview(
    { claimToken: claim.claimToken, ticket_id: ticket.id, reason: "done" },
    authorActor,
  );
  return { ticketId: ticket.id, repoId: repo.id, authorId: author.id };
}

function expectActorNotPermitted(fn: () => unknown): DispatchError {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(DispatchError);
  expect((thrown as DispatchError).code).toBe("ACTOR_NOT_PERMITTED");
  return thrown as DispatchError;
}

describe("review approve: an agent approver must be a REGISTERED agent (production entry points)", () => {
  let d: Dispatch;
  beforeEach(() => {
    delete process.env.DISPATCH_ALLOW_AGENT_APPROVE;
    d = Dispatch.open(":memory:", undefined, nonEmptyDiffRunner, {
      requireRegisteredAgentApprover: true,
    });
  });
  afterEach(() => {
    delete process.env.DISPATCH_ALLOW_AGENT_APPROVE;
    d.db.close();
  });

  function grantAutoApprove(repoId: string): void {
    d.setAutonomyPolicy(
      { repoId, riskLevel: "low", gate: "approve", mode: "auto", confirm: true },
      human,
    );
  }

  it("refuses a bare, unregistered reviewer string even under an auto policy", () => {
    const { repoId } = buildInReview(d, "svc", 1);
    grantAutoApprove(repoId);
    const { ticketId, authorId } = buildInReview(d, "svc", 2);
    const err = expectActorNotPermitted(() =>
      d.approveReview(ticketId, { type: "agent", id: `${authorId}/reviewer` }),
    );
    expect(err.message).toMatch(/REGISTERED agent principal/);
    expect(d.tickets.findById(ticketId)?.status).toBe("in_review");
  });

  it("still refuses the delivering agent itself (registered, but the author)", () => {
    const { repoId } = buildInReview(d, "svc", 1);
    grantAutoApprove(repoId);
    const { ticketId, authorId } = buildInReview(d, "svc", 2);
    const err = expectActorNotPermitted(() =>
      d.approveReview(ticketId, { type: "agent", id: authorId }),
    );
    expect(err.message).toMatch(/own delivery/);
    expect(d.tickets.findById(ticketId)?.status).toBe("in_review");
  });

  it("a SECOND registered agent (the reviewer principal) approves under the policy", () => {
    const { repoId } = buildInReview(d, "svc", 1);
    grantAutoApprove(repoId);
    const { ticketId } = buildInReview(d, "svc", 2);
    const reviewer = d.registerAgent({ display_name: "Reviewer", max_risk: "high" }, human);
    const result = d.approveReview(ticketId, { type: "agent", id: reviewer.id });
    expect(result.ticket.status).toBe("ready_for_merge");
  });

  it("an agent actor with no id at all is refused", () => {
    const { repoId } = buildInReview(d, "svc", 1);
    grantAutoApprove(repoId);
    const { ticketId } = buildInReview(d, "svc", 2);
    expectActorNotPermitted(() => d.approveReview(ticketId, { type: "agent" }));
  });

  it("a human approver is unaffected by the rule", () => {
    const { ticketId } = buildInReview(d, "svc", 1);
    const result = d.approveReview(ticketId, human);
    expect(result.ticket.status).toBe("ready_for_merge");
  });
});

describe("review approve: the library default keeps fixtures working (flag off)", () => {
  it("an unregistered agent id approves under an auto policy when the flag is off", () => {
    delete process.env.DISPATCH_ALLOW_AGENT_APPROVE;
    const d = Dispatch.open(":memory:", undefined, nonEmptyDiffRunner);
    try {
      const { repoId } = buildInReview(d, "svc", 1);
      d.setAutonomyPolicy(
        { repoId, riskLevel: "low", gate: "approve", mode: "auto", confirm: true },
        human,
      );
      const { ticketId } = buildInReview(d, "svc", 2);
      const result = d.approveReview(ticketId, { type: "agent", id: "fixture-reviewer" });
      expect(result.ticket.status).toBe("ready_for_merge");
    } finally {
      d.db.close();
    }
  });
});

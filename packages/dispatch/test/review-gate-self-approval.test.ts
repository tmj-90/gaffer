/**
 * REVIEWER ≠ AUTHOR — enforced in the control plane, not by the runner's bash hook.
 *
 * Before this rule, "an agent structurally cannot approve its own work" rested on the
 * runner's safety hook denying `dispatch review approve` to the delivery agent; any
 * process that could open the DB — or the runner passing its OWN agent id as the
 * reviewer — could approve a ticket that same agent had delivered. The gate now
 * refuses an `agent` actor whose id equals the agent on the ticket's most recent
 * claim, even when an autonomy flag permits agent approval in general.
 *
 *   - env flag on + approving agent id == delivering claim agent id → BLOCKED
 *   - env flag on + a DISTINCT reviewer principal                    → allowed
 *   - env flag on + the runner's `<agent>/reviewer` principal shape  → allowed
 *   - human approval is untouched
 *   - a never-claimed ticket makes the rule inert (no claim ⇒ no author)
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { DispatchError } from "../src/util/errors.js";
import { nonEmptyDiffRunner } from "./helpers/realDiff.js";

const human: Actor = { type: "human", id: "tom" };

function buildInReview(d: Dispatch, seq: number): { ticketId: string; agentId: string } {
  const repoName = "svc";
  const repo =
    d.repos.findByName(repoName) ??
    d.registerRepository(
      { name: repoName, default_branch: "main", local_path: process.cwd() },
      human,
    );
  const ticket = d.createTicket({ title: `T-${seq}`, risk_level: "low" }, human);
  d.linkRepository(ticket.id, repoName, "primary", human);
  const { ac } = d.addAcceptanceCriterion({ ticket_id: ticket.id, text: "Works" }, human);
  d.markReady(ticket.id, human);
  const agent = d.registerAgent({ display_name: "Bot", max_risk: "critical" }, human);
  const agentActor: Actor = { type: "agent", id: agent.id };
  const claim = d.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, agentActor);
  if (!claim) throw new Error("expected a claim");
  d.recordEvidence(
    {
      claimToken: claim.claimToken,
      ticket_id: ticket.id,
      ac_id: ac.id,
      evidence_type: "test_output",
      summary: "passing",
    },
    agentActor,
  );
  d.recordRepoDelivery(
    { ticket_id: ticket.id, repo_id: repo.id, branch_name: `feat/${seq}` },
    agentActor,
  );
  d.submitForReview(
    { claimToken: claim.claimToken, ticket_id: ticket.id, reason: "done" },
    agentActor,
  );
  return { ticketId: ticket.id, agentId: agent.id };
}

function blockedWith(fn: () => unknown, needle: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(DispatchError);
  expect((thrown as DispatchError).code).toBe("ACTOR_NOT_PERMITTED");
  expect((thrown as DispatchError).message).toContain(needle);
}

describe("review gate — reviewer ≠ author (server-side)", () => {
  let d: Dispatch;
  beforeEach(() => {
    d = Dispatch.open(":memory:", undefined, nonEmptyDiffRunner);
    process.env.DISPATCH_ALLOW_AGENT_APPROVE = "1";
  });
  afterEach(() => {
    delete process.env.DISPATCH_ALLOW_AGENT_APPROVE;
    d.db.close();
  });

  it("BLOCKS an agent whose id matches the delivering claim's agent, even with the env flag on", () => {
    const { ticketId, agentId } = buildInReview(d, 1);
    blockedWith(
      () => d.approveReview(ticketId, { type: "agent", id: agentId }),
      "may not approve its own delivery",
    );
    expect(d.resolveTicket(ticketId).status).toBe("in_review");
  });

  it("allows a DISTINCT agent principal to approve under the env flag", () => {
    const { ticketId } = buildInReview(d, 2);
    const res = d.approveReview(ticketId, { type: "agent", id: "independent-reviewer" });
    expect(res.ticket.status).toBe("ready_for_merge");
  });

  it("allows the runner's `<agent>/reviewer` principal (the AFK review pass shape)", () => {
    const { ticketId, agentId } = buildInReview(d, 3);
    const res = d.approveReview(ticketId, { type: "agent", id: `${agentId}/reviewer` });
    expect(res.ticket.status).toBe("ready_for_merge");
  });

  it("human approval is unaffected", () => {
    const { ticketId } = buildInReview(d, 4);
    const res = d.approveReview(ticketId, human);
    expect(res.ticket.status).toBe("ready_for_merge");
  });

  it("with the env flag OFF the generic agent deny still fires first", () => {
    delete process.env.DISPATCH_ALLOW_AGENT_APPROVE;
    const { ticketId, agentId } = buildInReview(d, 5);
    blockedWith(
      () => d.approveReview(ticketId, { type: "agent", id: agentId }),
      "Only a human or admin may approve",
    );
  });
});

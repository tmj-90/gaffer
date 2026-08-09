/**
 * Integration tests for OBSERVED-vs-DECLARED risk escalation at the AUTO-SHIP gate
 * (ReviewGateService.approveReview + core wiring).
 *
 * The gate runs ONLY on the auto-ship path — an agent whose approve+merge is permitted
 * WITHOUT a human because DISPATCH_ALLOW_AGENT_APPROVE=1 (or a mode='auto' policy). When
 * the OBSERVED risk from the real diff exceeds the DECLARED risk_level it HOLDS the ticket
 * for a human (stays in_review) with a recorded reason. It can only ever make the auto
 * path more conservative — human/admin approval and autonomy-off behaviour are untouched.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import { DispatchError } from "../src/util/errors.js";
import type { Actor, RiskLevel } from "../src/domain/types.js";
import type { GitRunner } from "../src/services/diffService.js";
import { emptyDiffRunner, highRiskDiffRunner, nonEmptyDiffRunner } from "./helpers/realDiff.js";

const human: Actor = { type: "human", id: "tom" };
const agentActor: Actor = { type: "agent", id: "agt-1" };

function expectDispatchCode(fn: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown, `Expected a DispatchError with code '${code}'`).toBeInstanceOf(DispatchError);
  expect((thrown as DispatchError).code).toBe(code);
}

/** Drive a ticket to in_review with the given declared risk_level. */
function buildInReviewTicket(d: Dispatch, riskLevel: RiskLevel): string {
  const repo = d.registerRepository(
    { name: "svc", default_branch: "main", local_path: process.cwd() },
    human,
  );
  const ticket = d.createTicket({ title: "T1", priority: 1, risk_level: riskLevel }, human);
  d.linkRepository(ticket.id, "svc", "primary", human);
  const { ac } = d.addAcceptanceCriterion({ ticket_id: ticket.id, text: "Works" }, human);
  d.markReady(ticket.id, human);

  // max_risk critical so the agent can CLAIM the ticket regardless of declared level
  // (the claim risk-gate is upstream and unrelated to the observed-risk approve gate).
  const agent = d.registerAgent({ display_name: "Bot", max_risk: "critical" }, human);
  const claim = d.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, agentActor);
  if (!claim) throw new Error("Expected a claim");
  d.recordEvidence(
    {
      claimToken: claim.claimToken,
      ticket_id: ticket.id,
      ac_id: ac.id,
      evidence_type: "test_output",
      summary: "all passing",
    },
    agentActor,
  );
  d.recordRepoDelivery(
    { ticket_id: ticket.id, repo_id: repo.id, branch_name: "feat/t1" },
    agentActor,
  );
  d.submitForReview(
    { claimToken: claim.claimToken, ticket_id: ticket.id, reason: "done" },
    agentActor,
  );
  return ticket.id;
}

function open(runner: GitRunner): Dispatch {
  return Dispatch.open(":memory:", undefined, runner);
}

describe("observed-risk escalation at the auto-ship gate", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_ALLOW_AGENT_APPROVE;
    delete process.env.DISPATCH_OBSERVED_RISK_CEILING;
  });
  afterEach(() => {
    delete process.env.DISPATCH_ALLOW_AGENT_APPROVE;
    delete process.env.DISPATCH_OBSERVED_RISK_CEILING;
  });

  it("ESCALATES: observed high exceeds declared low under auto-ship (held for human)", () => {
    process.env.DISPATCH_ALLOW_AGENT_APPROVE = "1";
    const d = open(highRiskDiffRunner);
    const ticketId = buildInReviewTicket(d, "low");

    expectDispatchCode(() => d.approveReview(ticketId, agentActor), "OBSERVED_RISK_ESCALATED");

    // Held — the ticket stays in_review (no transition ran).
    expect(d.resolveTicket(ticketId).status).toBe("in_review");
    // A recorded reason capturing observed vs declared exists on the event log.
    const events = d.listTicketEvents(ticketId);
    const esc = events.find((e) => e.event_type === "ticket.autoship_escalated");
    expect(esc).toBeDefined();
    const payload = JSON.parse(esc!.payload_json ?? "{}");
    expect(payload.declared).toBe("low");
    expect(payload.observed).toBe("high");
    expect(Array.isArray(payload.reasons)).toBe(true);
    expect(payload.reasons.length).toBeGreaterThan(0);
  });

  it("NO false-escalation: observed within declared still auto-ships as before", () => {
    process.env.DISPATCH_ALLOW_AGENT_APPROVE = "1";
    const d = open(nonEmptyDiffRunner); // small benign diff ⇒ observed low
    const ticketId = buildInReviewTicket(d, "low");

    const result = d.approveReview(ticketId, agentActor);
    expect(result.ticket.status).toBe("ready_for_merge");
    // No escalation event recorded.
    expect(
      d.listTicketEvents(ticketId).some((e) => e.event_type === "ticket.autoship_escalated"),
    ).toBe(false);
  });

  it("honestly-declared HIGH still auto-ships (escalation only catches under-declaration)", () => {
    process.env.DISPATCH_ALLOW_AGENT_APPROVE = "1";
    const d = open(highRiskDiffRunner); // observed high
    const ticketId = buildInReviewTicket(d, "high"); // declared high ⇒ observed !> declared

    const result = d.approveReview(ticketId, agentActor);
    expect(result.ticket.status).toBe("ready_for_merge");
    expect(
      d.listTicketEvents(ticketId).some((e) => e.event_type === "ticket.autoship_escalated"),
    ).toBe(false);
  });

  it("INERT when autonomy OFF: agent still ACTOR_NOT_PERMITTED on a high-risk diff", () => {
    // Flag unset — the observed-risk path is never reached; P0 gate denies the agent.
    const d = open(highRiskDiffRunner);
    const ticketId = buildInReviewTicket(d, "low");

    expectDispatchCode(() => d.approveReview(ticketId, agentActor), "ACTOR_NOT_PERMITTED");
    expect(d.resolveTicket(ticketId).status).toBe("in_review");
    // No observed-risk event — the code path did not run.
    expect(
      d.listTicketEvents(ticketId).some((e) => e.event_type === "ticket.autoship_escalated"),
    ).toBe(false);
  });

  it("manual HUMAN gate unchanged: human approves a high-risk-diff ticket to ready_for_merge", () => {
    // Even with the flag on, a human/admin actor never reaches the observed-risk check.
    process.env.DISPATCH_ALLOW_AGENT_APPROVE = "1";
    const d = open(highRiskDiffRunner);
    const ticketId = buildInReviewTicket(d, "low");

    const result = d.approveReview(ticketId, human);
    expect(result.ticket.status).toBe("ready_for_merge");
    expect(
      d.listTicketEvents(ticketId).some((e) => e.event_type === "ticket.autoship_escalated"),
    ).toBe(false);
  });

  it("indeterminate diff HOLDS: an unobservable diff fails toward a human", () => {
    process.env.DISPATCH_ALLOW_AGENT_APPROVE = "1";
    const d = open(emptyDiffRunner); // diff comes back empty ⇒ indeterminate observation
    const ticketId = buildInReviewTicket(d, "high"); // even a high declaration is held

    expectDispatchCode(() => d.approveReview(ticketId, agentActor), "OBSERVED_RISK_ESCALATED");
    expect(d.resolveTicket(ticketId).status).toBe("in_review");
    const esc = d
      .listTicketEvents(ticketId)
      .find((e) => e.event_type === "ticket.autoship_escalated");
    expect(esc).toBeDefined();
    expect(JSON.parse(esc!.payload_json ?? "{}").determinate).toBe(false);
  });

  it("hard ceiling escalates observed medium even when declared high", () => {
    process.env.DISPATCH_ALLOW_AGENT_APPROVE = "1";
    process.env.DISPATCH_OBSERVED_RISK_CEILING = "medium";
    // Many-files diff ⇒ observed medium; declared high would normally ship, but the
    // configured ceiling holds anything at/above medium.
    const manyFiles: GitRunner = (_cwd, args) => {
      const joined = args.join(" ");
      if (joined.startsWith("diff --numstat")) {
        // 12 changed files, small line counts ⇒ size maps to medium, no sensitive path.
        const lines = Array.from({ length: 12 }, (_v, i) => `2\t1\tsrc/f${i}.ts`).join("\n");
        return { status: 0, stdout: `${lines}\n`, stderr: "" };
      }
      if (joined.startsWith("diff")) {
        return { status: 0, stdout: "diff --git a/src/f0.ts b/src/f0.ts\n+x\n", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    };
    const d = open(manyFiles);
    const ticketId = buildInReviewTicket(d, "high");

    expectDispatchCode(() => d.approveReview(ticketId, agentActor), "OBSERVED_RISK_ESCALATED");
    expect(d.resolveTicket(ticketId).status).toBe("in_review");
  });
});

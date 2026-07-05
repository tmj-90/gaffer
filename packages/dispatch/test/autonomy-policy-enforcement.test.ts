/**
 * Behavioral E2E for Graduated Autonomy enforcement (Spec 2, Phase 3), driven through
 * the REAL Dispatch service surface. SECURITY-CRITICAL; negative controls mandatory.
 *
 * Proves the enforcement end-to-end:
 *   - with NO policy row + env unset, an agent-approve BLOCKS (byte-identical to today);
 *   - a mode='auto' approve policy for risk=low lets the agent-approve through;
 *   - the SAME repo at risk=high still BLOCKS (the grant is scoped exactly) [neg control];
 *   - flipping the row to 'off' RE-GATES the low-risk path (reversible);
 *   - enabling snapshots the evidence into the row (audit trail).
 */
import { beforeEach, afterEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import { DispatchError } from "../src/util/errors.js";
import type { Actor, RiskLevel } from "../src/domain/types.js";
import { nonEmptyDiffRunner } from "./helpers/realDiff.js";

const human: Actor = { type: "human", id: "tom" };
const agentActor: Actor = { type: "agent", id: "agt-1" };

/** Drive a fresh ticket on `repoName` at `risk` all the way to in_review. Returns ids. */
function buildInReview(
  d: Dispatch,
  repoName: string,
  risk: RiskLevel,
  seq: number,
): { ticketId: string; repoId: string } {
  const repo =
    d.repos.findByName(repoName) ??
    d.registerRepository(
      { name: repoName, default_branch: "main", local_path: process.cwd() },
      human,
    );
  const ticket = d.createTicket({ title: `T-${repoName}-${seq}`, risk_level: risk }, human);
  d.linkRepository(ticket.id, repoName, "primary", human);
  const { ac } = d.addAcceptanceCriterion({ ticket_id: ticket.id, text: "Works" }, human);
  d.markReady(ticket.id, human);
  const agent = d.registerAgent({ display_name: "Bot", max_risk: "critical" }, human);
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
    { ticket_id: ticket.id, repo_id: repo.id, branch_name: `feat/${repoName}-${seq}` },
    agentActor,
  );
  d.submitForReview(
    { claimToken: claim.claimToken, ticket_id: ticket.id, reason: "done" },
    agentActor,
  );
  return { ticketId: ticket.id, repoId: repo.id };
}

function expectBlocked(fn: () => unknown): void {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(DispatchError);
  expect((thrown as DispatchError).code).toBe("ACTOR_NOT_PERMITTED");
}

describe("Graduated Autonomy — approve-gate enforcement (behavioral)", () => {
  let d: Dispatch;
  beforeEach(() => {
    d = Dispatch.open(":memory:", undefined, nonEmptyDiffRunner);
    delete process.env.DISPATCH_ALLOW_AGENT_APPROVE;
  });
  afterEach(() => {
    delete process.env.DISPATCH_ALLOW_AGENT_APPROVE;
    d.db.close();
  });

  it("with NO policy row + env unset, an agent-approve BLOCKS [no-regression]", () => {
    const { ticketId } = buildInReview(d, "svc", "low", 1);
    expectBlocked(() => d.approveReview(ticketId, agentActor));
  });

  it("a mode='auto' approve policy for risk=low lets the agent-approve through", () => {
    const { repoId } = buildInReview(d, "svc", "low", 1);
    d.setAutonomyPolicy(
      { repoId, riskLevel: "low", gate: "approve", mode: "auto", confirm: true },
      human,
    );
    // A SECOND low-risk ticket in the same repo — the policy now grants it.
    const { ticketId } = buildInReview(d, "svc", "low", 2);
    const result = d.approveReview(ticketId, agentActor);
    expect(result.ticket.status).toBe("ready_for_merge");
  });

  it("the SAME repo at risk=high still BLOCKS an agent-approve [negative control]", () => {
    const { repoId } = buildInReview(d, "svc", "low", 1);
    d.setAutonomyPolicy(
      { repoId, riskLevel: "low", gate: "approve", mode: "auto", confirm: true },
      human,
    );
    const { ticketId: highId } = buildInReview(d, "svc", "high", 2);
    expectBlocked(() => d.approveReview(highId, agentActor));
  });

  it("flipping the policy to 'off' RE-GATES the low-risk path (reversible)", () => {
    const { repoId } = buildInReview(d, "svc", "low", 1);
    d.setAutonomyPolicy(
      { repoId, riskLevel: "low", gate: "approve", mode: "auto", confirm: true },
      human,
    );
    // Grants now.
    const allowed = buildInReview(d, "svc", "low", 2);
    expect(d.approveReview(allowed.ticketId, agentActor).ticket.status).toBe("ready_for_merge");
    // Turn it off → re-gate.
    d.setAutonomyPolicy({ repoId, riskLevel: "low", gate: "approve", mode: "off" }, human);
    const reGated = buildInReview(d, "svc", "low", 3);
    expectBlocked(() => d.approveReview(reGated.ticketId, agentActor));
  });

  it("enabling snapshots evidence + stamps who/when; off clears it", () => {
    const { repoId } = buildInReview(d, "svc", "low", 1);
    const row = d.setAutonomyPolicy(
      { repoId, riskLevel: "low", gate: "approve", mode: "auto", confirm: true },
      human,
    );
    expect(row.mode).toBe("auto");
    expect(row.enabled_by).toBe("tom");
    expect(row.enabled_at).not.toBeNull();
    expect(row.evidence_json).not.toBeNull();
    const evidence = JSON.parse(row.evidence_json as string);
    expect(evidence.confirmed_by).toBe("tom");
    expect(evidence).toHaveProperty("recommendation"); // null here (below the sample floor) — still audited.

    // The active list surfaces it (joined to repo name).
    const active = d.listAutonomyPolicies();
    expect(active.find((p) => p.repo_id === repoId && p.mode === "auto")).toBeTruthy();

    // Disabling clears the enablement + evidence.
    const off = d.setAutonomyPolicy(
      { repoId, riskLevel: "low", gate: "approve", mode: "off" },
      human,
    );
    expect(off.mode).toBe("off");
    expect(off.enabled_by).toBeNull();
    expect(off.enabled_at).toBeNull();
    expect(off.evidence_json).toBeNull();
  });

  it("enabling requires an explicit confirm (trust boundary)", () => {
    const { repoId } = buildInReview(d, "svc", "low", 1);
    let thrown: unknown;
    try {
      d.setAutonomyPolicy(
        { repoId, riskLevel: "low", gate: "approve", mode: "auto", confirm: false },
        human,
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DispatchError);
    expect((thrown as DispatchError).code).toBe("VALIDATION_ERROR");
  });

  it("env=1 STILL allows even with no policy row (the env opt-in is untouched)", () => {
    process.env.DISPATCH_ALLOW_AGENT_APPROVE = "1";
    const { ticketId } = buildInReview(d, "svc", "low", 1);
    expect(d.approveReview(ticketId, agentActor).ticket.status).toBe("ready_for_merge");
  });
});

/**
 * The READ-ONLY ship-decision surface the AFK runner consults (`autonomyGateDecision`,
 * exposed on the CLI as `wg ticket auto-decision`). It reuses the SAME isAutonomyAllowed
 * as the chokepoints, so this proves the runner sees a decision that can never diverge
 * from what the approve/merge sites enforce — for both gates, env floor + policy.
 */
describe("Graduated Autonomy — autonomyGateDecision (the runner's read-only surface)", () => {
  let d: Dispatch;
  beforeEach(() => {
    d = Dispatch.open(":memory:", undefined, nonEmptyDiffRunner);
    delete process.env.DISPATCH_ALLOW_AGENT_APPROVE;
    delete process.env.AUTO_MERGE;
    delete process.env.MERGE_ON_AGENT_REVIEW;
  });
  afterEach(() => {
    delete process.env.DISPATCH_ALLOW_AGENT_APPROVE;
    delete process.env.AUTO_MERGE;
    delete process.env.MERGE_ON_AGENT_REVIEW;
    d.db.close();
  });

  it("env floor off + no policy ⇒ BOTH gates deny, and report the (repo, risk) context", () => {
    const { ticketId, repoId } = buildInReview(d, "svc", "low", 1);
    const ticket = d.resolveTicket(ticketId);
    const approve = d.autonomyGateDecision(ticket, "approve");
    expect(approve).toMatchObject({ gate: "approve", decision: "deny", risk_level: "low" });
    expect(approve.write_repo_ids).toContain(repoId);
    expect(d.autonomyGateDecision(ticket, "merge").decision).toBe("deny");
  });

  it("graduated: a mode='auto' MERGE row flips ONLY the merge gate to allow at that risk", () => {
    const { repoId } = buildInReview(d, "svc", "low", 1);
    d.setAutonomyPolicy(
      { repoId, riskLevel: "low", gate: "merge", mode: "auto", confirm: true },
      human,
    );
    const low = d.resolveTicket(buildInReview(d, "svc", "low", 2).ticketId);
    expect(d.autonomyGateDecision(low, "merge").decision).toBe("allow");
    // The approve gate is NOT granted by a merge row [gate scoping is exact].
    expect(d.autonomyGateDecision(low, "approve").decision).toBe("deny");
    // A higher-risk ticket in the same repo is still held [risk scoping is exact].
    const high = d.resolveTicket(buildInReview(d, "svc", "high", 3).ticketId);
    expect(d.autonomyGateDecision(high, "merge").decision).toBe("deny");
  });

  it("autonomous floor (both flags) ⇒ merge gate allow with no policy [byte-identical]", () => {
    process.env.AUTO_MERGE = "1";
    process.env.MERGE_ON_AGENT_REVIEW = "1";
    const ticket = d.resolveTicket(buildInReview(d, "svc", "low", 1).ticketId);
    expect(d.autonomyGateDecision(ticket, "merge").decision).toBe("allow");
  });
});

/**
 * DEFENSE-IN-DEPTH — the runner now approves its unattended ships as an AGENT actor
 * (`wg review approve --as agent`), so the SERVER re-runs isAutonomyAllowed('approve')
 * over the SAME inputs the runner's bash gate used. This pins that the second gate is
 * real across the three postures, so a runner-side bug can never silently ship an
 * unearned approval — the core refuses it too. (The runner's approve actor is
 * `{type:'agent'}`; the human dashboard/REST approve is unchanged and untested here.)
 */
describe("Graduated Autonomy — the runner's agent-approve is re-enforced server-side", () => {
  let d: Dispatch;
  beforeEach(() => {
    d = Dispatch.open(":memory:", undefined, nonEmptyDiffRunner);
    delete process.env.DISPATCH_ALLOW_AGENT_APPROVE;
  });
  afterEach(() => {
    delete process.env.DISPATCH_ALLOW_AGENT_APPROVE;
    d.db.close();
  });

  it("SUPERVISED-floor (env off, no policy) → the server REFUSES the agent approve", () => {
    const { ticketId } = buildInReview(d, "svc", "low", 1);
    expectBlocked(() => d.approveReview(ticketId, agentActor));
  });

  it("GRADUATED (env off) → an EARNED approve row lets the agent approve through", () => {
    const { repoId } = buildInReview(d, "svc", "low", 1);
    d.setAutonomyPolicy(
      { repoId, riskLevel: "low", gate: "approve", mode: "auto", confirm: true },
      human,
    );
    const { ticketId } = buildInReview(d, "svc", "low", 2);
    expect(d.approveReview(ticketId, agentActor).ticket.status).toBe("ready_for_merge");
    // ...but an UNEARNED risk in the same repo is still refused [negative control].
    const { ticketId: highId } = buildInReview(d, "svc", "high", 3);
    expectBlocked(() => d.approveReview(highId, agentActor));
  });

  it("AUTONOMOUS floor (DISPATCH_ALLOW_AGENT_APPROVE=1) → the agent approve passes", () => {
    process.env.DISPATCH_ALLOW_AGENT_APPROVE = "1";
    const { ticketId } = buildInReview(d, "svc", "low", 1);
    expect(d.approveReview(ticketId, agentActor).ticket.status).toBe("ready_for_merge");
  });
});

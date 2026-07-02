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

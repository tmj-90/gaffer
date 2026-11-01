/**
 * REVIEW PIN for HUMAN approvals.
 *
 * The runner's agent review pins the commit the reviewer judged (lib/review.sh records a
 * SYSTEM `commit` evidence row, uri `gaffer-reviewed-commit:<sha>`), and every landing
 * path (lib/tester-binding.mjs) holds a branch that moved past it. A HUMAN approval
 * (`gaffer approve`, the dashboard, `wg review approve`) recorded no pin, so commits
 * added between the approve and the merge landed unreviewed. approveReview now records
 * the delivery-branch head a human approves as the same system pin.
 */
import { describe, expect, it } from "vitest";
import { Dispatch } from "../src/core.js";
import type { GitRunner } from "../src/services/diffService.js";
import type { Actor, Evidence } from "../src/domain/types.js";

const human: Actor = { type: "human", id: "tom" };
const agentActor: Actor = { type: "agent", id: "agt-1" };
const HEAD = "3333333333333333333333333333333333333333";

/** Non-empty diff for the done gate; a scripted head for `rev-parse --verify`. */
function runner(headSha: string | null): GitRunner {
  return (_cwd, args) => {
    const joined = args.join(" ");
    if (args[0] === "rev-parse") {
      if (headSha === null) return { status: 128, stdout: "", stderr: "unknown revision" };
      return { status: 0, stdout: `${headSha}\n`, stderr: "" };
    }
    if (args[0] === "merge-base") return { status: 0, stdout: `${"b".repeat(40)}\n`, stderr: "" };
    if (joined.startsWith("diff --numstat"))
      return { status: 0, stdout: "5\t1\tsrc/x.ts\n", stderr: "" };
    if (joined.startsWith("diff")) {
      return { status: 0, stdout: "diff --git a/src/x.ts b/src/x.ts\n+new\n-old\n", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
}

function inReview(d: Dispatch, branch = "gaffer/ticket-1-x"): string {
  const repo = d.registerRepository(
    { name: "svc", default_branch: "main", local_path: process.cwd() },
    human,
  );
  const ticket = d.createTicket({ title: "T1", priority: 1, risk_level: "low" }, human);
  d.linkRepository(ticket.id, "svc", "primary", human);
  const { ac } = d.addAcceptanceCriterion({ ticket_id: ticket.id, text: "Works" }, human);
  d.markReady(ticket.id, human);
  const agent = d.registerAgent({ display_name: "Bot" }, human);
  const claim = d.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, agentActor);
  if (!claim) throw new Error("Expected a claim");
  d.recordEvidence(
    {
      claimToken: claim.claimToken,
      ticket_id: ticket.id,
      ac_id: ac.id,
      evidence_type: "test_output",
      summary: "ok",
    },
    agentActor,
  );
  d.recordRepoDelivery({ ticket_id: ticket.id, repo_id: repo.id, branch_name: branch }, agentActor);
  d.submitForReview(
    { claimToken: claim.claimToken, ticket_id: ticket.id, reason: "done" },
    agentActor,
  );
  return ticket.id;
}

const pins = (d: Dispatch, ticketId: string): Evidence[] =>
  d
    .view(ticketId)
    .evidence.filter(
      (e) =>
        e.evidence_type === "commit" && String(e.uri ?? "").startsWith("gaffer-reviewed-commit:"),
    );

describe("approveReview pins the commit a HUMAN approved", () => {
  it("records a SYSTEM commit evidence row with the delivery-branch head", () => {
    const d = Dispatch.open(":memory:", undefined, runner(HEAD));
    const ticketId = inReview(d);
    const res = d.approveReview(ticketId, human);
    expect(res.ticket.status).toBe("ready_for_merge");
    const p = pins(d, ticketId);
    expect(p).toHaveLength(1);
    expect(p[0]!.uri).toBe(`gaffer-reviewed-commit:${HEAD}`);
    expect(p[0]!.recorded_by_actor_type).toBe("system");
    expect(p[0]!.summary).toContain("gaffer/ticket-1-x");
    expect(p[0]!.summary).toContain("tom");
    // The pin post-dates the ticket's entry into in_review (tester-binding ignores older pins).
    const entered = d
      .listTicketEvents(ticketId)
      .filter(
        (e) =>
          e.event_type === "ticket.transitioned" &&
          (e.payload_json ?? "").includes('"to":"in_review"'),
      )
      .pop();
    expect(entered).toBeDefined();
    expect(String(p[0]!.created_at) >= String(entered!.created_at)).toBe(true);
  });

  it("refuses the approval when the branch head cannot be resolved: nothing approved, no pin (external review #7)", () => {
    const d = Dispatch.open(":memory:", undefined, runner(null));
    const ticketId = inReview(d);
    let reason = "";
    try {
      d.approveReview(ticketId, human);
    } catch (e) {
      reason = String((e as { details?: { reason?: string } }).details?.reason ?? "");
    }
    expect(reason).toBe("repo_unavailable");
    expect(d.view(ticketId).ticket.status).toBe("in_review");
    expect(pins(d, ticketId)).toHaveLength(0);
  });

  it("an agent approval is not pinned here (the runner pins the commit its reviewer judged)", () => {
    const prev = process.env.DISPATCH_ALLOW_AGENT_APPROVE;
    process.env.DISPATCH_ALLOW_AGENT_APPROVE = "1";
    try {
      const d = Dispatch.open(":memory:", undefined, runner(HEAD));
      const ticketId = inReview(d);
      const reviewer = d.registerAgent({ display_name: "Reviewer" }, human);
      d.approveReview(ticketId, { type: "agent", id: reviewer.id });
      expect(pins(d, ticketId)).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env.DISPATCH_ALLOW_AGENT_APPROVE;
      else process.env.DISPATCH_ALLOW_AGENT_APPROVE = prev;
    }
  });
});

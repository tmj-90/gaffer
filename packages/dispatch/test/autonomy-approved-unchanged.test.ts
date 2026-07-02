/**
 * GRADUATED-AUTONOMY (Spec 2, Phase 1): the `approved_unchanged` signal.
 *
 * approveReview must stamp the `ticket.transitioned` payload with whether the
 * delivery was approved UNCHANGED (delivery SHA === current branch head) vs EDITED
 * (SHAs differ), and leave it `null` when either SHA is unknown (never overstate).
 *
 * Includes the required NEGATIVE CONTROL: an edited delivery (branch head moved past
 * the recorded delivery SHA) must NOT be recorded as unchanged.
 */
import { describe, expect, it } from "vitest";
import { Dispatch } from "../src/core.js";
import { approvalUnchanged } from "../src/services/reviewGateService.js";
import type { GitRunner } from "../src/services/diffService.js";
import type { Actor } from "../src/domain/types.js";

const human: Actor = { type: "human", id: "tom" };
const agentActor: Actor = { type: "agent", id: "agt-1" };

/**
 * A git runner that satisfies the real-diff done-gate (non-empty `git diff`) AND
 * returns a scripted SHA for `git rev-parse <branch>` — so the test controls the
 * "merge SHA" the approve path compares against the recorded delivery SHA.
 */
function scriptedRunner(revParseSha: string): GitRunner {
  return (_cwd, args) => {
    const joined = args.join(" ");
    if (args[0] === "rev-parse") return { status: 0, stdout: `${revParseSha}\n`, stderr: "" };
    if (joined.startsWith("diff --numstat")) {
      return { status: 0, stdout: "5\t1\tsrc/x.ts\n", stderr: "" };
    }
    if (joined.startsWith("diff")) {
      return { status: 0, stdout: "diff --git a/src/x.ts b/src/x.ts\n+new\n-old\n", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
}

/** Drive a ticket to in_review, optionally recording a delivery `commit_sha`. */
function buildInReview(d: Dispatch, opts: { commitSha?: string } = {}): string {
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
      summary: "all passing",
    },
    agentActor,
  );
  d.recordRepoDelivery(
    {
      ticket_id: ticket.id,
      repo_id: repo.id,
      branch_name: "feat/t1",
      ...(opts.commitSha ? { commit_sha: opts.commitSha } : {}),
    },
    agentActor,
  );
  d.submitForReview(
    { claimToken: claim.claimToken, ticket_id: ticket.id, reason: "done" },
    agentActor,
  );
  return ticket.id;
}

/** The `approved_unchanged` field on the ticket's most recent approve transition. */
function approvedUnchangedOf(d: Dispatch, ticketId: string): boolean | null | undefined {
  const events = d.listTicketEvents(ticketId);
  const approve = [...events]
    .reverse()
    .find(
      (e) =>
        e.event_type === "ticket.transitioned" &&
        typeof e.payload_json === "string" &&
        e.payload_json.includes('"review_approved"'),
    );
  if (!approve || approve.payload_json === null) return undefined;
  const payload = JSON.parse(approve.payload_json) as { approved_unchanged?: boolean | null };
  return payload.approved_unchanged;
}

describe("approvalUnchanged (pure SHA comparison)", () => {
  it("equal SHAs → unchanged (true)", () => {
    expect(approvalUnchanged("abc123", "abc123")).toBe(true);
  });

  it("different SHAs → edited (false) [negative control]", () => {
    expect(approvalUnchanged("abc123", "def456")).toBe(false);
  });

  it("missing delivery SHA → unknown (null)", () => {
    expect(approvalUnchanged(null, "abc123")).toBeNull();
  });

  it("missing merge SHA → unknown (null)", () => {
    expect(approvalUnchanged("abc123", null)).toBeNull();
  });
});

describe("approveReview records approved_unchanged", () => {
  it("records UNCHANGED when the branch head matches the delivery SHA", () => {
    const sha = "1111111111111111111111111111111111111111";
    const d = Dispatch.open(":memory:", undefined, scriptedRunner(sha));
    const ticketId = buildInReview(d, { commitSha: sha });
    const result = d.approveReview(ticketId, human);
    expect(result.ticket.status).toBe("ready_for_merge");
    expect(approvedUnchangedOf(d, ticketId)).toBe(true);
  });

  it("records EDITED when the branch head moved past the delivery SHA [negative control]", () => {
    const deliverySha = "1111111111111111111111111111111111111111";
    const mergeSha = "2222222222222222222222222222222222222222";
    const d = Dispatch.open(":memory:", undefined, scriptedRunner(mergeSha));
    const ticketId = buildInReview(d, { commitSha: deliverySha });
    d.approveReview(ticketId, human);
    // The edited delivery must NOT be recorded as unchanged.
    expect(approvedUnchangedOf(d, ticketId)).toBe(false);
  });

  it("records UNKNOWN (null) when no delivery SHA was recorded", () => {
    const d = Dispatch.open(":memory:", undefined, scriptedRunner("deadbeef"));
    const ticketId = buildInReview(d); // no commit_sha recorded.
    d.approveReview(ticketId, human);
    expect(approvedUnchangedOf(d, ticketId)).toBeNull();
  });
});

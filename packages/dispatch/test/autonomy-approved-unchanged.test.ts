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

// ---------------------------------------------------------------------------
// #3 — reviewDecisions scopes each decision to the PRIMARY write repo only,
// so one human approval accrues exactly ONE sample (a secondary write repo
// must NOT borrow the primary's approvals).
// ---------------------------------------------------------------------------

describe("reviewDecisions — one ticket = one sample (primary-repo scoping)", () => {
  it("attributes an approval to the primary write repo; a secondary write repo accrues no borrowed sample [negative control]", () => {
    const d = Dispatch.open(":memory:", undefined, scriptedRunner("deadbeef"));
    const ticketId = buildInReview(d); // links "svc" as the primary write repo.
    // A SECOND write repo on the same ticket, role='secondary' (linkRepository
    // defaults access='write'). Pre-fix this borrowed the primary's approval.
    d.registerRepository(
      { name: "libs", default_branch: "main", local_path: process.cwd() },
      human,
    );
    d.linkRepository(ticketId, "libs", "secondary", human);

    d.approveReview(ticketId, human);

    const decisions = d.events.reviewDecisions();
    const approvals = decisions.filter((r) => r.reason === "review_approved");
    // Exactly ONE approval sample — attributed to the primary repo.
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.repoName).toBe("svc");
    // The secondary write repo did NOT accrue a borrowed sample.
    expect(decisions.some((r) => r.repoName === "libs")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #7 — approved_unchanged is CORRECTED at merge time. With the testing lane a
// tester can amend the branch after approval, so the approve-time value can
// overstate what actually merged. reviewDecisions must surface the merge-time
// signal to the recommendation.
// ---------------------------------------------------------------------------

const systemActor: Actor = { type: "system", id: "runner" };

/** A runner whose reported branch head can be mutated between approve and merge. */
function mutableHeadRunner(getHead: () => string): GitRunner {
  return (_cwd, args) => {
    const joined = args.join(" ");
    if (args[0] === "rev-parse") return { status: 0, stdout: `${getHead()}\n`, stderr: "" };
    if (joined.startsWith("diff --numstat")) {
      return { status: 0, stdout: "5\t1\tsrc/x.ts\n", stderr: "" };
    }
    if (joined.startsWith("diff")) {
      return { status: 0, stdout: "diff --git a/src/x.ts b/src/x.ts\n+new\n-old\n", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
}

/** The (merge-corrected) approvedUnchanged the recommendation would read for a ticket. */
function decisionUnchangedOf(d: Dispatch, ticketId: string): boolean | null | undefined {
  const approval = d.events.reviewDecisions().find((r) => r.reason === "review_approved");
  return approval?.approvedUnchanged;
}

describe("markMerged corrects approved_unchanged at merge time", () => {
  it("amend-after-approve → the recommendation reads EDITED (false), not the stale approve-time true", () => {
    const deliverySha = "1".repeat(40);
    const amendedSha = "2".repeat(40);
    let head = deliverySha;
    const d = Dispatch.open(":memory:", undefined, mutableHeadRunner(() => head));
    const ticketId = buildInReview(d, { commitSha: deliverySha });

    d.approveReview(ticketId, human); // approve-time: head === delivery → unchanged=true.
    expect(approvedUnchangedOf(d, ticketId)).toBe(true);

    head = amendedSha; // a tester amends the branch AFTER approval.
    d.markMerged(ticketId, systemActor); // merge-time re-resolves → EDITED.

    // The corrected signal now reaching the recommendation is false.
    expect(decisionUnchangedOf(d, ticketId)).toBe(false);
  });

  it("no post-approval amend → the merge-time signal stays UNCHANGED (true) [negative control]", () => {
    const sha = "1".repeat(40);
    const d = Dispatch.open(":memory:", undefined, scriptedRunner(sha));
    const ticketId = buildInReview(d, { commitSha: sha });

    d.approveReview(ticketId, human);
    d.markMerged(ticketId, systemActor);

    // Nothing changed between approve and merge — still unchanged.
    expect(decisionUnchangedOf(d, ticketId)).toBe(true);
  });
});

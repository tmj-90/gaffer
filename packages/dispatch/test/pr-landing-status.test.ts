// EVERY RECORDED PR LANDS UPSTREAM (external review #8, finding 3). A two-PR ticket was
// done with one change missing upstream: the secondary repo was merged into its local
// checkout and recorded as landed. A repo whose delivery record carries a PR is landed
// only through that PR (or the operator's explicit local fallback); a local merge into
// its checkout, or git showing the commit there, is not a landing.

import { describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import type { GitRunner } from "../src/services/diffService.js";
import { systemClock } from "../src/util/clock.js";
import { FAKE_HEAD, giveTicketRealDelivery, nonEmptyDiffRunner } from "./helpers/realDiff.js";

const human: Actor = { type: "human", id: "tom" };
const system: Actor = { type: "system" };
const agentActor: Actor = { type: "agent", id: "agent-runner" };

/** `merge-base --is-ancestor` answers from `onDefault` (is the commit on main yet?). */
let onDefault = false;
const runner: GitRunner = (cwd, args, opts) => {
  if (args[0] === "merge-base" && args[1] === "--is-ancestor")
    return { status: onDefault ? 0 : 1, stdout: "", stderr: "" };
  return nonEmptyDiffRunner(cwd, args, opts);
};

function freshWg(): Dispatch {
  onDefault = false;
  return Dispatch.open(":memory:", systemClock, runner);
}

/** A ticket a human approved: ready_for_merge with one write repo (pinned at FAKE_HEAD). */
function approved(wg: Dispatch, opts: { prUrl?: string } = {}) {
  const t = wg.createTicket({ title: "Ship", description: "x", policy_pack: "team_light" }, human);
  const { ac } = wg.addAcceptanceCriterion({ ticket_id: t.id, text: "ok" }, human);
  const { repoId, branch } = giveTicketRealDelivery(wg, t.id, human, { repoName: "repoA" });
  if (opts.prUrl)
    wg.recordRepoDelivery(
      { ticket_id: t.id, repo_id: repoId, branch_name: branch, pr_url: opts.prUrl },
      human,
    );
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
  wg.submitForReview({ claimToken: claim!.claimToken, ticket_id: t.id, reason: "d" }, agentActor);
  expect(wg.approveReview(t.id, human).ticket.status).toBe("ready_for_merge");
  return { id: t.id, repoId };
}

function refusal(fn: () => unknown): { code?: string; reason?: string; message?: string } {
  try {
    fn();
  } catch (err) {
    const e = err as { code?: string; details?: { reason?: string }; message?: string };
    return { code: e.code, reason: e.details?.reason, message: e.message };
  }
  throw new Error("expected a refusal, but the call succeeded");
}

describe("a repo with a recorded PR lands only through it", () => {
  const PR = "https://github.com/example/repoA/pull/1";

  it("a local landing of a PR repo is not a landing: the ticket is not done", () => {
    const wg = freshWg();
    const { id } = approved(wg, { prUrl: PR });
    onDefault = true;
    wg.recordLanding(id, { repo: "repoA", commit: FAKE_HEAD, via: "local" }, system);
    const st = wg.landingStatus(id);
    expect(st.repos[0]).toMatchObject({ prUrl: PR, landed: false });
    // Not even git showing the commit in the local checkout makes it done.
    expect(refusal(() => wg.markMerged(id, system))).toMatchObject({
      code: "STATE_CONFLICT",
    });
    expect(refusal(() => wg.markMerged(id, system)).message).toContain(
      `its PR ${PR} has not merged upstream`,
    );
    wg.recordLanding(id, { repo: "repoA", commit: FAKE_HEAD, via: "pr" }, system);
    expect(wg.landingStatus(id).repos[0]!.landed).toBe(true);
    expect(wg.markMerged(id, system).ticket.status).toBe("done");
  });

  it("the operator's explicit local fallback counts (recorded as local-fallback)", () => {
    const wg = freshWg();
    const { id } = approved(wg, { prUrl: PR });
    onDefault = true;
    wg.recordLanding(id, { repo: "repoA", commit: FAKE_HEAD, via: "local-fallback" }, system);
    expect(wg.markMerged(id, system).ticket.status).toBe("done");
  });

  it("a repo without a PR still lands locally", () => {
    const wg = freshWg();
    const { id } = approved(wg);
    onDefault = true;
    wg.recordLanding(id, { repo: "repoA", commit: FAKE_HEAD, via: "local" }, system);
    expect(wg.landingStatus(id).repos[0]).toMatchObject({ prUrl: null, landed: true });
    expect(wg.markMerged(id, system).ticket.status).toBe("done");
  });
});

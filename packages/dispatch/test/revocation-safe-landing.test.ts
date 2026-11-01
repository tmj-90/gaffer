// REVOCATION-SAFE LANDING (external review #8, finding 1).
//
// Finding 1: a cancellation or a red required check recorded while the merge gate ran was
// acknowledged by Dispatch and then overridden: both default branches advanced and the
// ticket still read cancelled. The landing paths now call beginLanding immediately before
// a default branch moves; it re-checks status, approval, the approved revision and
// required CI in one transaction and records the landing as started, and a revocation
// recorded after that reports the landing instead of pretending it stopped it.

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

describe("beginLanding: the last word before a default branch moves", () => {
  it("lands on the current approval: records the landing as started", () => {
    const wg = freshWg();
    const { id } = approved(wg);
    const approval = wg.landingApproval(id);
    expect(approval).toBeTruthy();
    const b = wg.beginLanding(
      id,
      { repo: "repoA", commit: FAKE_HEAD, approval: approval!, via: "local" },
      system,
    );
    expect(b.commit).toBe(FAKE_HEAD);
    expect(wg.view(id).events.some((e) => e.event_type === "ticket.landing_started")).toBe(true);
  });

  it("refuses once the ticket was cancelled or held for a red required check while the gate ran", () => {
    const wg = freshWg();
    const { id } = approved(wg);
    const approval = wg.landingApproval(id)!;
    wg.rejectReview(id, "cancelled", human, "Operator cancelled release");
    expect(
      refusal(() => wg.beginLanding(id, { repo: "repoA", commit: FAKE_HEAD, approval }, system)),
    ).toMatchObject({ code: "STATE_CONFLICT", reason: "revoked" });

    const wg2 = freshWg();
    const t2 = approved(wg2);
    const a2 = wg2.landingApproval(t2.id)!;
    wg2.recordCiResult(t2.id, { commit: FAKE_HEAD, state: "fail", detail: "red" }, system);
    expect(wg2.view(t2.id).ticket.status).toBe("blocked");
    expect(
      refusal(() =>
        wg2.beginLanding(t2.id, { repo: "repoA", commit: FAKE_HEAD, approval: a2 }, system),
      ),
    ).toMatchObject({ code: "STATE_CONFLICT", reason: "revoked" });
  });

  it("refuses a stale approval, a commit that is not the approved revision, and CI that is no longer green", () => {
    const wg = freshWg();
    const { id } = approved(wg);
    expect(
      refusal(() =>
        wg.beginLanding(id, { repo: "repoA", commit: FAKE_HEAD, approval: "not-it" }, system),
      ),
    ).toMatchObject({ reason: "approval_changed" });
    expect(
      refusal(() => wg.beginLanding(id, { repo: "repoA", commit: "b".repeat(40) }, system)),
    ).toMatchObject({ reason: "approval_changed" });
    // A pending result recorded for the approved commit after approval: not green.
    wg.recordCiResult(id, { commit: FAKE_HEAD, state: "pending" }, system);
    expect(
      refusal(() => wg.beginLanding(id, { repo: "repoA", commit: FAKE_HEAD }, system)),
    ).toMatchObject({ reason: "ci_not_green" });
    wg.recordCiResult(id, { commit: FAKE_HEAD, state: "pass" }, system);
    expect(wg.beginLanding(id, { repo: "repoA", commit: FAKE_HEAD }, system).commit).toBe(
      FAKE_HEAD,
    );
  });

  it("is the system's (or an admin's) to call, never an agent's or a human's", () => {
    const wg = freshWg();
    const { id } = approved(wg);
    for (const actor of [agentActor, human]) {
      expect(
        refusal(() => wg.beginLanding(id, { repo: "repoA", commit: FAKE_HEAD }, actor)),
      ).toMatchObject({ code: "ACTOR_NOT_PERMITTED" });
    }
  });
});

describe("a revocation after a landing started reports it", () => {
  it("reject --to cancelled names the landing in progress, then the committed one", () => {
    const wg = freshWg();
    const { id } = approved(wg);
    wg.beginLanding(id, { repo: "repoA", commit: FAKE_HEAD, via: "local" }, system);
    // git has not moved yet: in progress.
    const r = wg.rejectReview(id, "cancelled", human, "too late");
    expect(r.ticket.status).toBe("cancelled");
    expect(r.landedAlready).toEqual([
      expect.objectContaining({ repo: "repoA", commit: FAKE_HEAD, landed: false }),
    ]);
    // The default branch has moved by the time anyone looks: landed.
    onDefault = true;
    expect(wg.landingsStarted(id)).toEqual([
      expect.objectContaining({ repo: "repoA", commit: FAKE_HEAD, landed: true }),
    ]);
    expect(wg.view(id).events.some((e) => e.event_type === "ticket.revoked_after_landing")).toBe(
      true,
    );
  });

  it("a failed required check after a recorded landing reports it as landed", () => {
    const wg = freshWg();
    const { id } = approved(wg);
    wg.beginLanding(id, { repo: "repoA", commit: FAKE_HEAD, via: "local" }, system);
    onDefault = true;
    wg.recordLanding(id, { repo: "repoA", commit: FAKE_HEAD, via: "local" }, system);
    const ci = wg.recordCiResult(id, { commit: FAKE_HEAD, state: "fail" }, system);
    expect(ci.landedAlready).toEqual([
      expect.objectContaining({ repo: "repoA", commit: FAKE_HEAD, landed: true }),
    ]);
  });

  it("a rejection with no landing started reports nothing", () => {
    const wg = freshWg();
    const { id } = approved(wg);
    expect(wg.rejectReview(id, "cancelled", human, "changed my mind").landedAlready).toEqual([]);
  });
});

// The gap between landing-begin and the landing's record (adversarial review of #8): a
// cancellation there was accepted, the record was then refused (the ticket was no longer
// ready_for_merge) and the change sat on main with no landing on record.
describe("a landing that started before a revocation stays on record", () => {
  it("a cancellation once git shows the started landing is refused (partly landed)", () => {
    const wg = freshWg();
    const { id } = approved(wg);
    wg.beginLanding(id, { repo: "repoA", commit: FAKE_HEAD, via: "local" }, system);
    onDefault = true; // git moved; the record is not written yet
    const r = refusal(() => wg.rejectReview(id, "cancelled", human, "too late"));
    expect(r.code).toBe("PARTLY_LANDED");
    expect(r.message).toContain("already landed in repoA");
    expect(refusal(() => wg.wontDo(id, human, "too late")).code).toBe("PARTLY_LANDED");
    expect(wg.view(id).ticket.status).toBe("ready_for_merge");
  });

  it("a landing in progress when the ticket was cancelled is recorded once git shows it", () => {
    const wg = freshWg();
    const { id } = approved(wg);
    wg.beginLanding(id, { repo: "repoA", commit: FAKE_HEAD, via: "local" }, system);
    const w = wg.wontDo(id, human, "stop");
    expect(w.ticket.status).toBe("cancelled");
    expect(w.landedAlready).toEqual([
      expect.objectContaining({ repo: "repoA", commit: FAKE_HEAD, landed: false }),
    ]);
    // git has not moved: still refused (a local landing needs git to show it).
    expect(
      refusal(() =>
        wg.recordLanding(id, { repo: "repoA", commit: FAKE_HEAD, via: "local" }, system),
      ).reason,
    ).toBe("not_on_default_branch");
    onDefault = true;
    const rec = wg.recordLanding(id, { repo: "repoA", commit: FAKE_HEAD, via: "local" }, system);
    expect(rec.recorded).toBe(true);
    // Idempotent, and the cancelled ticket now counts as partly landed.
    expect(
      wg.recordLanding(id, { repo: "repoA", commit: FAKE_HEAD, via: "local" }, system).recorded,
    ).toBe(false);
    expect(wg.view(id).events.some((e) => e.event_type === "ticket.repo_landed")).toBe(true);
  });

  it("a landing that never started is not recorded on a revoked ticket", () => {
    const wg = freshWg();
    const { id } = approved(wg);
    wg.rejectReview(id, "cancelled", human, "stop");
    onDefault = true;
    expect(
      refusal(() =>
        wg.recordLanding(id, { repo: "repoA", commit: FAKE_HEAD, via: "local" }, system),
      ).code,
    ).toBe("ILLEGAL_TRANSITION");
  });

  it("a board move back to rework reports a started landing on the trail", () => {
    const wg = freshWg();
    const { id } = approved(wg);
    wg.beginLanding(id, { repo: "repoA", commit: FAKE_HEAD, via: "local" }, system);
    wg.moveTicket(id, "refining", human);
    expect(wg.view(id).events.some((e) => e.event_type === "ticket.revoked_after_landing")).toBe(
      true,
    );
  });
});

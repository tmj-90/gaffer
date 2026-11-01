/**
 * REQUIRED CI fails closed (external review #9, finding 4).
 *
 * With CI required, PR creation on, the strict policy and `gh` unavailable, the runner's
 * CI gate returned success without recording anything, and because dispatch read "CI
 * required" only from recorded results, a human approval moved the ticket to
 * ready_for_merge with no CI pass. Now the runner records the requirement before the
 * ticket is exposed for review (`ticket.ci_required`), and approval needs a recorded
 * PASS for the exact commit under review:
 *   - required, nothing reported → refused (POLICY_DENIED, reason ci_required), and the
 *     Review button says "CI required, not reported" (held_ci);
 *   - a PASS for the reviewed commit → approved;
 *   - a PASS for another commit of the ticket → still refused.
 */
import { afterEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { DispatchError } from "../src/util/errors.js";
import { FAKE_HEAD, nonEmptyDiffRunner } from "./helpers/realDiff.js";

const human: Actor = { type: "human", id: "tom" };
const runner: Actor = { type: "system", id: "runner" };
const OTHER = "b".repeat(40);

describe("required CI is recorded before review and fails closed", () => {
  let d: Dispatch;
  afterEach(() => d.db.close());

  function deliverToReview({ markRequired }: { markRequired: boolean }): string {
    d = Dispatch.open(":memory:", undefined, nonEmptyDiffRunner);
    const repo = d.registerRepository(
      { name: "svc", default_branch: "main", local_path: process.cwd() },
      human,
    );
    const t = d.createTicket({ title: "CI", risk_level: "low" }, human);
    d.linkRepository(t.id, "svc", "primary", human);
    d.addAcceptanceCriterion({ ticket_id: t.id, text: "works" }, human);
    d.markReady(t.id, human);
    const agent = d.registerAgent({ display_name: "Bot", max_risk: "critical" }, human);
    const agentActor: Actor = { type: "agent", id: agent.id };
    const claim = d.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, agentActor)!;
    // An earlier delivery commit of this ticket (the branch has since moved to FAKE_HEAD).
    d.recordRepoDelivery(
      { ticket_id: t.id, repo_id: repo.id, branch_name: "feat/x", commit_sha: OTHER },
      agentActor,
    );
    // The runner marks the requirement BEFORE it submits (tick.sh gaffer_ci_require_mark).
    if (markRequired) d.recordCiRequired(t.id, { detail: "GAFFER_REQUIRE_CI is on" }, runner);
    d.submitForReview(
      { claimToken: claim.claimToken, ticket_id: t.id, reason: "done" },
      agentActor,
    );
    return t.id;
  }

  function denied(fn: () => unknown): DispatchError {
    try {
      fn();
    } catch (e) {
      return e as DispatchError;
    }
    throw new Error("expected a refusal");
  }

  it("CI required and nothing reported (gh missing) → approval refused, held_ci 'not reported'", () => {
    const id = deliverToReview({ markRequired: true });
    expect(d.ciStatus(id, FAKE_HEAD)).toMatchObject({ required: true, state: null });
    const outcome = d.approveOutcome(id, { mergeCommand: false, env: {} });
    expect(outcome.kind).toBe("held_ci");
    expect(outcome.approvable).toBe(false);
    expect(outcome.label).toBe("Approve held: CI required, not reported");
    expect(outcome.sentence).toMatch(/CI required: not reported/);
    const e = denied(() => d.approveReview(id, human));
    expect(e.code).toBe("POLICY_DENIED");
    expect(e.message).toMatch(/CI required: not reported/);
    expect(e.details).toMatchObject({ reason: "ci_required", ci_state: null });
    expect(d.resolveTicket(id).status).toBe("in_review");
  });

  it("a PASS for the exact reviewed commit → approval allowed", () => {
    const id = deliverToReview({ markRequired: true });
    d.recordCiResult(id, { commit: FAKE_HEAD, state: "pass" }, runner);
    expect(d.approveOutcome(id, { mergeCommand: false, env: {} }).kind).not.toBe("held_ci");
    expect(d.approveReview(id, human).ticket.status).toBe("ready_for_merge");
  });

  it("a PASS for another commit of the ticket → refused", () => {
    const id = deliverToReview({ markRequired: true });
    d.recordCiResult(id, { commit: OTHER, state: "pass" }, runner);
    expect(d.approveOutcome(id, { mergeCommand: false, env: {} }).kind).toBe("held_ci");
    const e = denied(() => d.approveReview(id, human));
    expect(e.code).toBe("POLICY_DENIED");
    expect(d.resolveTicket(id).status).toBe("in_review");
  });

  it("no requirement and no result → CI is not required (unchanged)", () => {
    const id = deliverToReview({ markRequired: false });
    expect(d.approveReview(id, human).ticket.status).toBe("ready_for_merge");
  });

  it("only the runner or an admin records the requirement; recording it twice is one event", () => {
    const id = deliverToReview({ markRequired: true });
    expect(denied(() => d.recordCiRequired(id, {}, human)).code).toBe("ACTOR_NOT_PERMITTED");
    expect(d.recordCiRequired(id, {}, runner).eventId).toBeNull();
  });
});

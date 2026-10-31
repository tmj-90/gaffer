/**
 * REQUIRED CI controls approval (server-side).
 *
 * With CI required and a poll still open, a CLI approve went through; the later failing
 * result was logged "CI RED" but the ticket stayed ready_for_merge, because the rejection
 * path acts only on in_review. Now:
 *   - once the runner records a CI result for a ticket, approval (and a tester PASS) needs
 *     a PASS for the candidate commit — pending or red is POLICY_DENIED, the ticket stays
 *     in_review;
 *   - a red result for an approved ticket HOLDS it (ready_for_merge -> blocked, reason
 *     code ci_red) and it shows in the human queue with the reason;
 *   - only the runner (system) or an admin records CI results / holds tickets.
 */
import { afterEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { DispatchError } from "../src/util/errors.js";
import { nonEmptyDiffRunner } from "./helpers/realDiff.js";

const human: Actor = { type: "human", id: "tom" };
const runner: Actor = { type: "system", id: "runner" };
const SHA = "a".repeat(40);

describe("required CI gates approval", () => {
  let d: Dispatch;
  afterEach(() => d.db.close());

  function deliverToReview(): string {
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
    d.recordRepoDelivery({ ticket_id: t.id, repo_id: repo.id, branch_name: "feat/x" }, agentActor);
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

  it("no CI result recorded → approval unchanged (CI is not required for this ticket)", () => {
    const id = deliverToReview();
    expect(d.approveReview(id, human).ticket.status).toBe("ready_for_merge");
  });

  it("CI pending → a human approve is refused and the ticket stays in_review", () => {
    const id = deliverToReview();
    d.recordCiResult(id, { commit: SHA, state: "pending" }, runner);
    const e = denied(() => d.approveReview(id, human));
    expect(e.code).toBe("POLICY_DENIED");
    expect(e.message).toMatch(/Required CI has not passed/);
    expect(d.resolveTicket(id).status).toBe("in_review");
  });

  it("CI pass → approve; a later red result HOLDS the approved ticket for a human", () => {
    const id = deliverToReview();
    d.recordCiResult(id, { commit: SHA, state: "pass" }, runner);
    expect(d.approveReview(id, human).ticket.status).toBe("ready_for_merge");
    const r = d.recordCiResult(
      id,
      { commit: SHA, state: "fail", detail: "check 'unit' failed; see https://ci/1" },
      runner,
    );
    expect(r.held).toBe(true);
    expect(d.resolveTicket(id).status).toBe("blocked");
    const item = d.humanQueue().items.find((i) => i.ticket?.id === id);
    expect(item?.kind).toBe("parked");
    expect(item?.reasonCode).toBe("ci_red");
    expect(item?.reason).toContain("Required CI failed");
    expect(item?.reason).toContain("check 'unit' failed");
  });

  it("CI fail → approve refused (it can never advance to merge)", () => {
    const id = deliverToReview();
    d.recordCiResult(id, { commit: SHA, state: "fail" }, runner);
    expect(denied(() => d.approveReview(id, human)).message).toMatch(/Required CI failed/);
  });

  it("only the runner or an admin records CI results and holds tickets", () => {
    const id = deliverToReview();
    expect(denied(() => d.recordCiResult(id, { commit: SHA, state: "pass" }, human)).code).toBe(
      "ACTOR_NOT_PERMITTED",
    );
    expect(
      denied(() => d.holdForHuman(id, { reasonCode: "merge_gate_red", reason: "x" }, human)).code,
    ).toBe("ACTOR_NOT_PERMITTED");
    // in_review is not an approved state: nothing to hold.
    expect(
      denied(() => d.holdForHuman(id, { reasonCode: "merge_gate_red", reason: "x" }, runner)).code,
    ).toBe("ILLEGAL_TRANSITION");
  });

  it("holdForHuman parks an approved ticket with its reason code (the merge gate's hold)", () => {
    const id = deliverToReview();
    d.approveReview(id, human);
    d.holdForHuman(
      id,
      { reasonCode: "merge_gate_red", reason: "the merge onto main fails its tests" },
      runner,
    );
    expect(d.resolveTicket(id).status).toBe("blocked");
    const item = d.humanQueue().items.find((i) => i.ticket?.id === id);
    expect(item?.reasonCode).toBe("merge_gate_red");
  });
});

import { describe, expect, it } from "vitest";

import { Dispatch, isTestingEnabled } from "../src/core.js";
import {
  parseTestContract,
  validateTestContract,
  type Actor,
  type TestContract,
} from "../src/domain/types.js";
import { TestClock } from "../src/util/clock.js";
import { DispatchError } from "../src/util/errors.js";
import { giveTicketRealDelivery, nonEmptyDiffRunner } from "./helpers/realDiff.js";

const human: Actor = { type: "human", id: "tom" };
const reviewer: Actor = { type: "human", id: "rev" };
const agentActor: Actor = { type: "agent", id: "agent-runner" };
const testerAgent: Actor = { type: "agent", id: "tester-1" };
const systemActor: Actor = { type: "system" };

/**
 * BBT-001 — the independent black-box testing lane. `testingEnabled` pins the
 * GAFFER_TESTING toggle per-instance so the lane is exercised without touching
 * the process env. A non-empty diff runner backs the done-gate (P0).
 */
function freshWg(opts: { testingEnabled?: boolean } = {}): Dispatch {
  return Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner, {
    ...(opts.testingEnabled !== undefined ? { testingEnabled: opts.testingEnabled } : {}),
  });
}

/**
 * Build a team_light ticket, drive it to `in_review` with a satisfied AC + a real
 * delivery diff so the done-gate passes. Returns the ticket id + the (now-resolved)
 * acceptance criterion id.
 */
function inReviewReadyTicket(wg: Dispatch): { ticketId: string; acId: string } {
  wg.registerRepository({ name: "svc", default_branch: "main" }, human);
  const t = wg.createTicket(
    { title: "Ship it", description: "deliver the thing", policy_pack: "team_light" },
    human,
  );
  wg.linkRepository(t.id, "svc", "primary", human);
  const { ac } = wg.addAcceptanceCriterion({ ticket_id: t.id, text: "Returns 200" }, human);
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
  wg.submitForReview(
    { claimToken: claim!.claimToken, ticket_id: t.id, reason: "done" },
    agentActor,
  );
  giveTicketRealDelivery(wg, t.id, human);
  expect(wg.view(t.id).ticket.status).toBe("in_review");
  return { ticketId: t.id, acId: ac.id };
}

describe("BBT-001 global toggle", () => {
  it("reads GAFFER_TESTING truthy values, off by default", () => {
    expect(isTestingEnabled({})).toBe(false);
    expect(isTestingEnabled({ GAFFER_TESTING: "" })).toBe(false);
    expect(isTestingEnabled({ GAFFER_TESTING: "0" })).toBe(false);
    expect(isTestingEnabled({ GAFFER_TESTING: "no" })).toBe(false);
    expect(isTestingEnabled({ GAFFER_TESTING: "1" })).toBe(true);
    expect(isTestingEnabled({ GAFFER_TESTING: "true" })).toBe(true);
    expect(isTestingEnabled({ GAFFER_TESTING: "YES" })).toBe(true);
    expect(isTestingEnabled({ GAFFER_TESTING: "on" })).toBe(true);
  });
});

describe("BBT-001 the Test Contract artifact", () => {
  it("round-trips set/read through the facade", () => {
    const wg = freshWg();
    const t = wg.createTicket({ title: "x", policy_pack: "solo_loose" }, human);
    const contract = wg.setTestContract(
      t.id,
      {
        changed_surfaces: ["POST /api/widgets", "wg ticket move"],
        runtime_deps: ["Postgres 16 (was MySQL)"],
        env_vars: ["DATABASE_URL"],
        run_command: "docker compose up && curl localhost:3000",
        harness_ready: false,
      },
      human,
    );
    expect(contract.changed_surfaces).toEqual(["POST /api/widgets", "wg ticket move"]);
    expect(contract.harness_ready).toBe(false);

    const read = wg.getTestContract(t.id);
    expect(read).toEqual(contract);
    // And the raw column parses to the same thing.
    expect(parseTestContract(wg.view(t.id).ticket.test_contract)).toEqual(contract);
  });

  it("set-testable defaults to not-testable and flips on/off", () => {
    const wg = freshWg();
    const t = wg.createTicket({ title: "x", policy_pack: "solo_loose" }, human);
    expect(wg.view(t.id).ticket.can_be_tested).toBe(0);

    wg.setTestable(t.id, true, human);
    expect(wg.view(t.id).ticket.can_be_tested).toBe(1);
    wg.setTestable(t.id, false, human);
    expect(wg.view(t.id).ticket.can_be_tested).toBe(0);
  });

  it("setTestable is fail-safe for an agent actor (it only adds scrutiny)", () => {
    const wg = freshWg();
    const t = wg.createTicket({ title: "x", policy_pack: "solo_loose" }, human);
    // No ACTOR_NOT_PERMITTED — marking testable can never bypass a gate.
    const res = wg.setTestable(t.id, true, agentActor);
    expect(res.canBeTested).toBe(true);
    expect(wg.view(t.id).ticket.can_be_tested).toBe(1);
  });

  it("parseTestContract tolerates a malformed / partial column", () => {
    expect(parseTestContract(null)).toBeNull();
    expect(parseTestContract("not json")).toBeNull();
    // A partial object fills the missing fields with empty/false defaults.
    const partial = parseTestContract('{"run_command":"go test ./..."}');
    expect(partial).toEqual({
      changed_surfaces: [],
      runtime_deps: [],
      env_vars: [],
      run_command: "go test ./...",
      harness_ready: false,
    });
  });
});

describe("BBT-001 contract leak validator", () => {
  const clean: TestContract = {
    changed_surfaces: ["POST /tickets", "gaffer skills install"],
    runtime_deps: ["Postgres 16"],
    env_vars: ["DATABASE_URL", "DEADBEEFCAFE0000"], // legit hex value — must NOT trip
    run_command: "docker compose up && curl localhost:3000/tickets",
    harness_ready: true,
  };

  function withSurface(surface: string): TestContract {
    return { ...clean, changed_surfaces: [...clean.changed_surfaces, surface] };
  }

  it("passes a clean contract unchanged", () => {
    expect(validateTestContract(clean)).toEqual(clean);
  });

  it("passes legit CLI / file-interface / endpoint surfaces", () => {
    expect(() => validateTestContract(withSurface("gaffer skills install"))).not.toThrow();
    expect(() => validateTestContract(withSurface("POST /tickets"))).not.toThrow();
    expect(() => validateTestContract(withSurface("GET /tickets/:id/testable"))).not.toThrow();
    // A file-interface surface (the surface IS a file path) is allowed.
    expect(() => validateTestContract(withSurface("reads runner/factory.config.sh"))).not.toThrow();
  });

  it("rejects a gaffer/… branch name", () => {
    expect(() => validateTestContract(withSurface("delivered on gaffer/ticket-12-foo"))).toThrow(
      /branch name/i,
    );
  });

  it("rejects a …/ticket-<n> branch pattern", () => {
    expect(() => validateTestContract(withSurface("see branch wip/ticket-42"))).toThrow(
      /branch name/i,
    );
  });

  it("rejects a PR / diff / commit URL", () => {
    expect(() => validateTestContract(withSurface("https://github.com/acme/repo/pull/5"))).toThrow(
      /URL/i,
    );
    expect(() =>
      validateTestContract(withSurface("https://github.com/acme/repo/commit/abcd")),
    ).toThrow(/URL/i);
  });

  it("rejects a bare commit hash in a surface", () => {
    expect(() => validateTestContract(withSurface("at rev 1a2b3c4d5e"))).toThrow(/commit hash/i);
  });

  it("does NOT run the commit-hash check over env_vars (legit hex passes)", () => {
    // clean.env_vars carries a hex value; it must not be treated as a commit hash.
    expect(() => validateTestContract(clean)).not.toThrow();
  });

  it("rejects leakage tokens (diff / pr_url / branch_name / commit)", () => {
    expect(() => validateTestContract(withSurface("see the diff for details"))).toThrow(
      /leakage token/i,
    );
    expect(() => validateTestContract(withSurface("set via branch_name"))).toThrow(
      /leakage token/i,
    );
    expect(() =>
      validateTestContract({ ...clean, run_command: "git show commit then run" }),
    ).toThrow(/leakage token/i);
  });

  it('rejects "I changed …" / "changed X to Y" narration', () => {
    expect(() => validateTestContract(withSurface("I changed the handler"))).toThrow(/changed/i);
    expect(() => validateTestContract(withSurface("changed MySQL to Postgres"))).toThrow(
      /changed/i,
    );
  });

  it("names the offending field + marker in the error", () => {
    try {
      validateTestContract(withSurface("on gaffer/ticket-9-x"));
      throw new Error("expected a leak rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(DispatchError);
      const e = err as DispatchError;
      expect(e.code).toBe("TEST_CONTRACT_LEAK");
      expect(e.message).toContain("changed_surfaces");
      expect(e.message).toMatch(/branch name/i);
    }
  });

  it("rejects a leak in run_command", () => {
    expect(() =>
      validateTestContract({ ...clean, run_command: "git checkout gaffer/ticket-3 && run" }),
    ).toThrow(/run_command/);
  });

  it("is enforced at the setTestContract write path (the CLI/MCP/REST choke point)", () => {
    const wg = freshWg();
    const t = wg.createTicket({ title: "x", policy_pack: "solo_loose" }, human);
    expect(() =>
      wg.setTestContract(
        t.id,
        { changed_surfaces: ["delivered on gaffer/ticket-7-x"], run_command: "go test" },
        human,
      ),
    ).toThrow(/branch name/i);
    // A clean contract still writes fine through the same path.
    const ok = wg.setTestContract(
      t.id,
      { changed_surfaces: ["POST /tickets"], run_command: "go test ./..." },
      human,
    );
    expect(ok.changed_surfaces).toEqual(["POST /tickets"]);
  });
});

describe("BBT-001 approval routing", () => {
  it("toggle ON + can_be_tested -> in_review goes to in_testing (not ready_for_merge)", () => {
    const wg = freshWg({ testingEnabled: true });
    const { ticketId } = inReviewReadyTicket(wg);
    wg.setTestable(ticketId, true, human);

    const res = wg.approveReview(ticketId, reviewer);
    expect(res.ticket.status).toBe("in_testing");
    expect(wg.view(ticketId).ticket.status).toBe("in_testing");
    // A routed-to-testing event is recorded.
    const ev = wg.view(ticketId).events.find((e) => e.event_type === "ticket.routed_to_testing");
    expect(ev).toBeDefined();
  });

  it("toggle OFF -> in_review goes straight to ready_for_merge (unchanged)", () => {
    const wg = freshWg({ testingEnabled: false });
    const { ticketId } = inReviewReadyTicket(wg);
    wg.setTestable(ticketId, true, human); // testable, but toggle is off.

    const res = wg.approveReview(ticketId, reviewer);
    expect(res.ticket.status).toBe("ready_for_merge");
  });

  it("can_be_tested=false with toggle ON -> still straight to ready_for_merge", () => {
    const wg = freshWg({ testingEnabled: true });
    const { ticketId } = inReviewReadyTicket(wg);
    // not testable.
    const res = wg.approveReview(ticketId, reviewer);
    expect(res.ticket.status).toBe("ready_for_merge");
  });
});

describe("BBT-001 tester verdict", () => {
  it("tester PASS moves in_testing -> ready_for_merge with evidence", () => {
    const wg = freshWg({ testingEnabled: true });
    const { ticketId } = inReviewReadyTicket(wg);
    wg.setTestable(ticketId, true, human);
    wg.approveReview(ticketId, reviewer);

    const res = wg.testerPass(
      ticketId,
      { summary: "12 black-box tests pass against the contract" },
      testerAgent,
    );
    expect(res.ticket.status).toBe("ready_for_merge");
    // The passing result is visible as the latest test_output evidence (the AC
    // evidence is also test_output, so take the most recent — list is oldest-first).
    const ev = wg
      .view(ticketId)
      .evidence.filter((e) => e.evidence_type === "test_output")
      .at(-1);
    expect(ev?.summary).toContain("black-box tests pass");
    // The merge then completes normally.
    expect(wg.markMerged(ticketId, systemActor).ticket.status).toBe("done");
  });

  it("tester FAIL moves in_testing -> refining, records the failing test + resets ACs", () => {
    const wg = freshWg({ testingEnabled: true });
    const { ticketId, acId } = inReviewReadyTicket(wg);
    wg.setTestable(ticketId, true, human);
    wg.approveReview(ticketId, reviewer);
    // Pre-condition: the AC was satisfied by the delivery.
    expect(wg.view(ticketId).acceptanceCriteria.find((a) => a.id === acId)?.status).toBe(
      "satisfied",
    );

    const res = wg.testerFail(
      ticketId,
      { summary: "AC 'Returns 200' fails: endpoint returns 500 on empty body" },
      testerAgent,
    );
    expect(res.ticket.status).toBe("refining");

    // The failing test rides as evidence + as the rejection feedback.
    const ev = wg
      .view(ticketId)
      .evidence.filter((e) => e.evidence_type === "test_output")
      .at(-1);
    expect(ev?.summary).toContain("returns 500");
    const feedback = wg.view(ticketId).ticket.last_review_feedback;
    expect(feedback).toContain("tester_failed");
    // ACs are reset to not-satisfied (reuses the reject path).
    expect(wg.view(ticketId).acceptanceCriteria.every((a) => a.status === "pending")).toBe(true);
  });

  it("tester FAIL bumps attempt_count and parks to blocked at the retry cap", () => {
    const wg = Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner, {
      testingEnabled: true,
      maxAttempts: 1, // first failure already hits the cap.
    });
    // Build directly to in_testing.
    wg.registerRepository({ name: "svc", default_branch: "main" }, human);
    const t = wg.createTicket({ title: "x", description: "d", policy_pack: "team_light" }, human);
    wg.linkRepository(t.id, "svc", "primary", human);
    const { ac } = wg.addAcceptanceCriterion({ ticket_id: t.id, text: "AC" }, human);
    wg.markReady(t.id, human);
    const agent = wg.registerAgent({ display_name: "a" }, human);
    const claim = wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, agentActor);
    wg.recordEvidence(
      {
        claimToken: claim!.claimToken,
        ticket_id: t.id,
        ac_id: ac.id,
        evidence_type: "test_output",
        summary: "ok",
      },
      agentActor,
    );
    wg.submitForReview({ claimToken: claim!.claimToken, ticket_id: t.id }, agentActor);
    giveTicketRealDelivery(wg, t.id, human);
    wg.setTestable(t.id, true, human);
    wg.approveReview(t.id, reviewer);
    expect(wg.view(t.id).ticket.status).toBe("in_testing");

    const res = wg.testerFail(t.id, { summary: "fails" }, testerAgent);
    expect(res.ticket.status).toBe("blocked");
    expect(wg.view(t.id).ticket.attempt_count).toBe(1);
    const park = wg.view(t.id).events.find((e) => e.event_type === "ticket.parked_retry_cap");
    expect(park).toBeDefined();
  });

  it("rejects a tester verdict on a ticket that is not in_testing", () => {
    const wg = freshWg({ testingEnabled: true });
    const { ticketId } = inReviewReadyTicket(wg);
    expect(() => wg.testerPass(ticketId, { summary: "x" }, testerAgent)).toThrowError(
      DispatchError,
    );
    expect(() => wg.testerFail(ticketId, { summary: "x" }, testerAgent)).toThrowError(
      DispatchError,
    );
  });
});

describe("BBT-001 a tester cannot approve or merge", () => {
  it("a tester (agent) is refused at approveReview and markMerged", () => {
    const wg = freshWg({ testingEnabled: true });
    const { ticketId } = inReviewReadyTicket(wg);
    // An agent cannot approve a review (mirrors the reviewer gate).
    expect(() => wg.approveReview(ticketId, testerAgent)).toThrowError(DispatchError);

    // Drive to in_testing, then a tester pass; the merge stays system/admin-only.
    wg.setTestable(ticketId, true, human);
    wg.approveReview(ticketId, reviewer);
    wg.testerPass(ticketId, { summary: "pass" }, testerAgent);
    expect(() => wg.markMerged(ticketId, testerAgent)).toThrowError(DispatchError);
    expect(wg.markMerged(ticketId, systemActor).ticket.status).toBe("done");
  });

  it("a board move can never push a ticket into or out of testing", () => {
    const wg = freshWg({ testingEnabled: true });
    const { ticketId } = inReviewReadyTicket(wg);
    // Drag in_review -> in_testing is rejected (the testerVerdict guard).
    expect(() => wg.moveTicket(ticketId, "in_testing", human)).toThrowError(DispatchError);

    wg.setTestable(ticketId, true, human);
    wg.approveReview(ticketId, reviewer);
    // Drag in_testing -> ready_for_merge / refining is rejected too.
    expect(() => wg.moveTicket(ticketId, "ready_for_merge", human)).toThrowError(DispatchError);
    expect(() => wg.moveTicket(ticketId, "refining", human)).toThrowError(DispatchError);
  });
});

describe("BBT-001 stats + board surface in_testing", () => {
  it("the dashboard counts in_testing tickets and the board labels the column", () => {
    const wg = freshWg({ testingEnabled: true });
    const { ticketId } = inReviewReadyTicket(wg);
    wg.setTestable(ticketId, true, human);
    wg.approveReview(ticketId, reviewer);

    const summary = wg.dashboard();
    expect(summary.ticketsByStatus.in_testing).toBe(1);

    const board = wg.board();
    const col = board.columns.find((c) => c.column === "in_testing");
    expect(col).toBeDefined();
    expect(col!.cards.map((c) => c.id)).toContain(ticketId);
  });
});

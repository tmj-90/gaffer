import { describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import { type Actor } from "../src/domain/types.js";
import type { GitRunner } from "../src/services/diffService.js";
import { currentTestingRound } from "../src/services/reviewGate/testerVerdict.js";
import { contractHash } from "../src/util/contractHash.js";
import { TestClock } from "../src/util/clock.js";
import { DispatchError } from "../src/util/errors.js";
import { giveTicketRealDelivery, nonEmptyDiffRunner } from "./helpers/realDiff.js";

/**
 * TESTING ROUNDS (external review 16): a tester verdict names the testing round its run
 * started in (the id of the ticket's latest entry into in_testing). Dispatch accepts it
 * only while that round is current and the ticket is in testing; a verdict from before a
 * rework (a new round) is refused with STALE_VERDICT naming both rounds, kept as stale
 * evidence (a manual_note, never a verdict row) and a `ticket.tester_verdict_stale` event.
 * The end-to-end proof with the real runner is runner/test/tester-overlap.test.sh.
 */
const human: Actor = { type: "human", id: "tom" };
const agentActor: Actor = { type: "agent", id: "agent-runner" };
const system: Actor = { type: "system" };
const SHA = "0123456789abcdef0123456789abcdef01234567";

function freshWg(runner: GitRunner = nonEmptyDiffRunner): Dispatch {
  return Dispatch.open(":memory:", new TestClock(), runner, { testingEnabled: true });
}

/** Deliver the ticket (claim, evidence, submit) and send it to the tester: a new round. */
function deliverToTesting(
  wg: Dispatch,
  id: string,
  acId: string,
  agentId: string,
  first = false,
): void {
  const claim = wg.claimNextTicket({ agentId, ttlSeconds: 600 }, agentActor);
  expect(claim?.ticketId).toBe(id);
  wg.recordEvidence(
    {
      claimToken: claim!.claimToken,
      ticket_id: id,
      ac_id: acId,
      evidence_type: "test_output",
      summary: "passed",
    },
    agentActor,
  );
  wg.submitForReview({ claimToken: claim!.claimToken, ticket_id: id, reason: "done" }, agentActor);
  // The delivery repo is registered once; a rework delivers to the same branch.
  if (first) giveTicketRealDelivery(wg, id, human);
  expect(wg.routeToTester(id, system)[0]!.routed).toBe(true);
  expect(wg.view(id).ticket.status).toBe("in_testing");
}

function world(runner?: GitRunner): { wg: Dispatch; id: string; acId: string; agentId: string } {
  const wg = freshWg(runner);
  wg.registerRepository({ name: "svc", default_branch: "main" }, human);
  const t = wg.createTicket(
    { title: "Ship it", description: "deliver the thing", policy_pack: "team_light" },
    human,
  );
  wg.linkRepository(t.id, "svc", "primary", human);
  const { ac } = wg.addAcceptanceCriterion({ ticket_id: t.id, text: "Returns 200" }, human);
  wg.setTestable(t.id, true, human);
  wg.markReady(t.id, human);
  const agent = wg.registerAgent({ display_name: "a" }, human);
  deliverToTesting(wg, t.id, ac.id, agent.id, true);
  return { wg, id: t.id, acId: ac.id, agentId: agent.id };
}

/** Round 1 is FAILed by a person, the rework is delivered: the ticket is in round 2. */
function reworkIntoNewRound(w: ReturnType<typeof world>): void {
  w.wg.testerFail(w.id, { summary: "a person saw AC1 fail", to: "ready" }, human);
  expect(w.wg.view(w.id).ticket.status).toBe("ready");
  deliverToTesting(w.wg, w.id, w.acId, w.agentId);
}

function refusal(fn: () => unknown): DispatchError | null {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof DispatchError) return e;
    throw e;
  }
}

function events(wg: Dispatch, id: string, type: string): Array<Record<string, unknown>> {
  return (
    wg.db
      .prepare(
        "SELECT payload_json FROM work_events WHERE entity_id = ? AND event_type = ? ORDER BY rowid",
      )
      .all(id, type) as Array<{ payload_json: string }>
  ).map((r) => JSON.parse(r.payload_json) as Record<string, unknown>);
}

const passInput = (wg: Dispatch, id: string, round: string) => ({
  summary: "PASS: every AC demonstrated",
  tested_commit: SHA,
  contract_hash: contractHash(wg.db, id)!,
  replay: "passed",
  tests_commit: "none",
  round,
});

describe("a tester verdict names its testing round", () => {
  it("the round is the latest entry into in_testing, and a rework starts a new one", () => {
    const w = world();
    const r1 = currentTestingRound(w.wg.db, w.id);
    expect(r1?.id).toMatch(/^[0-9a-f-]{36}$/);
    reworkIntoNewRound(w);
    const r2 = currentTestingRound(w.wg.db, w.id);
    expect(r2?.id).toBeTruthy();
    expect(r2!.id).not.toBe(r1!.id);
    w.wg.db.close();
  });

  it("a verdict for the current round is recorded, with its round on the evidence", () => {
    const w = world();
    const round = currentTestingRound(w.wg.db, w.id)!.id;
    const res = w.wg.testerFail(
      w.id,
      { summary: "FAIL: AC1 returns 500", tested_commit: SHA, round },
      agentActor,
    );
    expect(res.ticket.status).toBe("refining");
    const ev = events(w.wg, w.id, "ticket.tester_failed")[0]!;
    const row = w.wg.db
      .prepare("SELECT payload_json FROM evidence WHERE id = ?")
      .get(ev.evidence_id as string) as { payload_json: string };
    expect(JSON.parse(row.payload_json).round).toBe(round);
    w.wg.db.close();
  });

  for (const verdict of ["fail", "pass"] as const) {
    it(`a stale ${verdict.toUpperCase()} from before a rework is refused and kept as stale evidence`, () => {
      const w = world();
      const r1 = currentTestingRound(w.wg.db, w.id)!.id;
      reworkIntoNewRound(w);
      const r2 = currentTestingRound(w.wg.db, w.id)!.id;
      const passedBefore = events(w.wg, w.id, "ticket.tester_passed").length;
      const failedBefore = events(w.wg, w.id, "ticket.tester_failed").length;
      const err = refusal(() =>
        verdict === "pass"
          ? w.wg.testerPass(w.id, passInput(w.wg, w.id, r1), system)
          : w.wg.testerFail(
              w.id,
              { summary: "FAIL: AC1 returns 500", tested_commit: SHA, round: r1 },
              agentActor,
            ),
      );
      expect(err?.code).toBe("STALE_VERDICT");
      expect(err?.message).toContain(r1);
      expect(err?.message).toContain(r2);
      // The new round is untouched: still in testing, no verdict for it.
      expect(w.wg.view(w.id).ticket.status).toBe("in_testing");
      expect(events(w.wg, w.id, "ticket.tester_passed").length).toBe(passedBefore);
      expect(events(w.wg, w.id, "ticket.tester_failed").length).toBe(failedBefore);
      // Kept: a stale-evidence note (never a test_output verdict row) and an event.
      const stale = events(w.wg, w.id, "ticket.tester_verdict_stale");
      expect(stale).toHaveLength(1);
      expect(stale[0]).toMatchObject({ verdict, round: r1, current_round: r2 });
      const row = w.wg.db
        .prepare("SELECT evidence_type, payload_json FROM evidence WHERE id = ?")
        .get(stale[0]!.evidence_id as string) as { evidence_type: string; payload_json: string };
      expect(row.evidence_type).toBe("manual_note");
      expect(JSON.parse(row.payload_json)).toMatchObject({
        stale: true,
        stale_verdict: verdict,
        round: r1,
        current_round: r2,
        tested_commit: SHA,
      });
      expect(row.payload_json).not.toContain('"verdict":');
      // The current round's own verdict is still recorded.
      const ok = w.wg.testerPass(w.id, passInput(w.wg, w.id, r2), system);
      expect(ok.ticket.status).toBe("in_review");
      w.wg.db.close();
    });
  }

  it("a round that changes after the first check (during the PASS's git reads) is still kept as stale evidence", () => {
    // The verdict's own write transaction re-checks the round; a rework that lands
    // between the first check and that transaction (the PASS resolves the head with git
    // in between) is refused there, and the stale verdict is still recorded.
    let hook: (() => void) | null = null;
    const runner: GitRunner = (cwd, args) => {
      const h = hook;
      hook = null;
      if (h) h();
      return nonEmptyDiffRunner(cwd, args);
    };
    const w = world(runner);
    const r1 = currentTestingRound(w.wg.db, w.id)!.id;
    const input = passInput(w.wg, w.id, r1);
    let fired = false;
    hook = () => {
      fired = true;
      reworkIntoNewRound(w);
    };
    const err = refusal(() => w.wg.testerPass(w.id, input, system));
    expect(fired).toBe(true);
    const r2 = currentTestingRound(w.wg.db, w.id)!.id;
    expect(r2).not.toBe(r1);
    expect(err?.code).toBe("STALE_VERDICT");
    expect(w.wg.view(w.id).ticket.status).toBe("in_testing");
    expect(events(w.wg, w.id, "ticket.tester_passed")).toHaveLength(0);
    const stale = events(w.wg, w.id, "ticket.tester_verdict_stale");
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ verdict: "pass", round: r1, current_round: r2 });
    w.wg.db.close();
  });

  it("a round that ends after the first check (a person's FAIL during the PASS's git reads) is stale too", () => {
    let hook: (() => void) | null = null;
    const runner: GitRunner = (cwd, args) => {
      const h = hook;
      hook = null;
      if (h) h();
      return nonEmptyDiffRunner(cwd, args);
    };
    const w = world(runner);
    const r1 = currentTestingRound(w.wg.db, w.id)!.id;
    const input = passInput(w.wg, w.id, r1);
    hook = () => w.wg.testerFail(w.id, { summary: "a person saw AC1 fail" }, human);
    const err = refusal(() => w.wg.testerPass(w.id, input, system));
    expect(err?.code).toBe("STALE_VERDICT");
    expect(err?.message).toMatch(/no longer in testing \(refining\)/);
    expect(w.wg.view(w.id).ticket.status).toBe("refining");
    expect(events(w.wg, w.id, "ticket.tester_verdict_stale")).toHaveLength(1);
    w.wg.db.close();
  });

  it("a verdict for a round that already ended (the ticket left testing) is stale too", () => {
    const w = world();
    const r1 = currentTestingRound(w.wg.db, w.id)!.id;
    w.wg.testerPass(w.id, passInput(w.wg, w.id, r1), system);
    expect(w.wg.view(w.id).ticket.status).toBe("in_review");
    const err = refusal(() =>
      w.wg.testerFail(w.id, { summary: "FAIL: late", round: r1 }, agentActor),
    );
    expect(err?.code).toBe("STALE_VERDICT");
    expect(err?.message).toMatch(/no longer in testing \(in_review\)/);
    expect(w.wg.view(w.id).ticket.status).toBe("in_review");
    expect(events(w.wg, w.id, "ticket.tester_verdict_stale")).toHaveLength(1);
    w.wg.db.close();
  });

  it("a malformed round is a validation error and records nothing", () => {
    const w = world();
    const err = refusal(() =>
      w.wg.testerFail(w.id, { summary: "FAIL", round: "not a round!" }, agentActor),
    );
    expect(err?.code).toBe("VALIDATION_ERROR");
    expect(events(w.wg, w.id, "ticket.tester_verdict_stale")).toHaveLength(0);
    expect(w.wg.view(w.id).ticket.status).toBe("in_testing");
    w.wg.db.close();
  });

  it("a verdict without a round (a person's, an older runner's) is checked as before", () => {
    const w = world();
    reworkIntoNewRound(w);
    const res = w.wg.testerFail(w.id, { summary: "FAIL: by hand" }, human);
    expect(res.ticket.status).toBe("refining");
    w.wg.db.close();
  });
});

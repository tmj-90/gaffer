import { describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { contractHash } from "../src/util/contractHash.js";
import { TestClock } from "../src/util/clock.js";
import { DispatchError } from "../src/util/errors.js";
import { giveTicketRealDelivery, nonEmptyDiffRunner } from "./helpers/realDiff.js";

/**
 * TESTER FALSE GREENS (STRATEGY section 2: refuse uncertain work rather than confidently
 * accept it).
 *   1. A non-human PASS whose binding says the runner's clean replay did not pass
 *      (skipped: no registered test command, or the replay switched off; failed) is
 *      refused on EVERY ticket, not only an epic's acceptance ticket. A human PASS is a
 *      waiver and is never refused; a PASS with no binding at all keeps today's path.
 *   2. Implementation tickets get a test_contract when they become testable, so the
 *      tester's changed_surfaces is never empty: seeded from the ticket's own title,
 *      never overwriting a contract, never written once the contract is frozen.
 */
const human: Actor = { type: "human", id: "tom" };
const reviewer: Actor = { type: "human", id: "rev" };
const agentActor: Actor = { type: "agent", id: "agent-runner" };
const testerAgent: Actor = { type: "agent", id: "tester-1" };
const SHA = "0123456789abcdef0123456789abcdef01234567";

function freshWg(testingEnabled = true): Dispatch {
  return Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner, { testingEnabled });
}

/** An ordinary (non-acceptance) testable ticket sitting in_testing. */
function ordinaryInTesting(wg: Dispatch): string {
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
  wg.setTestable(t.id, true, human);
  expect(wg.approveReview(t.id, reviewer).ticket.status).toBe("in_testing");
  return t.id;
}

function code(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof DispatchError ? e.code : String(e);
  }
}

describe("a PASS whose clean replay did not pass is never recorded (any ticket)", () => {
  for (const replay of ["skipped", "failed"]) {
    it(`an agent PASS with replay=${replay} on an ORDINARY ticket is refused (BINDING_REQUIRED)`, () => {
      const wg = freshWg();
      const id = ordinaryInTesting(wg);
      const c = code(() =>
        wg.testerPass(
          id,
          {
            summary: "PASS: every AC demonstrated",
            tested_commit: SHA,
            contract_hash: contractHash(wg.db, id)!,
            replay,
          },
          testerAgent,
        ),
      );
      expect(c).toBe("BINDING_REQUIRED");
      expect(wg.view(id).ticket.status).toBe("in_testing");
      wg.db.close();
    });
  }

  it("the refusal names the missing replay and the human waiver", () => {
    const wg = freshWg();
    const id = ordinaryInTesting(wg);
    let msg = "";
    try {
      wg.testerPass(id, { summary: "PASS", replay: "skipped" }, testerAgent);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/replay/);
    expect(msg).toMatch(/--as human/);
    wg.db.close();
  });

  it("a human PASS (waiver) with replay=skipped still moves the ticket on", () => {
    const wg = freshWg();
    const id = ordinaryInTesting(wg);
    const res = wg.testerPass(
      id,
      { summary: "Checked every acceptance criterion by hand", replay: "skipped" },
      human,
    );
    expect(res.ticket.status).toBe("ready_for_merge");
    wg.db.close();
  });

  it("an agent PASS whose replay passed records as before", () => {
    const wg = freshWg();
    const id = ordinaryInTesting(wg);
    const res = wg.testerPass(
      id,
      {
        summary: "PASS",
        tested_commit: SHA,
        contract_hash: contractHash(wg.db, id)!,
        replay: "passed",
      },
      testerAgent,
    );
    expect(res.ticket.status).toBe("ready_for_merge");
    wg.db.close();
  });

  it("an agent PASS with no binding at all keeps today's path (legacy / stub seam)", () => {
    const wg = freshWg();
    const id = ordinaryInTesting(wg);
    expect(wg.testerPass(id, { summary: "PASS" }, testerAgent).ticket.status).toBe(
      "ready_for_merge",
    );
    wg.db.close();
  });

  it("a FAIL with replay=skipped is still recorded (a FAIL is never a false green)", () => {
    const wg = freshWg();
    const id = ordinaryInTesting(wg);
    const res = wg.testerFail(id, { summary: "AC1 fails", replay: "skipped" }, testerAgent);
    expect(res.ticket.status).toBe("refining");
    wg.db.close();
  });
});

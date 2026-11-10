import { describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import { parseTestContract, type Actor } from "../src/domain/types.js";
import { contractHash } from "../src/util/contractHash.js";
import { TestClock } from "../src/util/clock.js";
import { DispatchError } from "../src/util/errors.js";
import { giveTicketRealDelivery, nonEmptyDiffRunner } from "./helpers/realDiff.js";
import { asPerson } from "./helpers/principal.js";

/**
 * TESTER FALSE GREENS (STRATEGY section 2: refuse uncertain work rather than confidently
 * accept it).
 *   1. A non-human PASS whose binding says the runner's clean replay did not pass
 *      (skipped: no registered test command, or the replay switched off; failed) is
 *      refused on EVERY ticket, not only an epic's acceptance ticket, and so is a
 *      non-human PASS with no replay at all. A human PASS is a waiver and is never refused.
 *   2. Implementation tickets get a test_contract when they become testable, so the
 *      tester's changed_surfaces is never empty: seeded from the ticket's own title,
 *      never overwriting a contract, never written once the contract is frozen.
 */
const human: Actor = { type: "human", id: "tom" };
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
  // TESTER FIRST: the runner sends it to the tester before a person reviews it.
  expect(wg.routeToTester(t.id, { type: "system" })[0]!.routed).toBe(true);
  expect(wg.view(t.id).ticket.status).toBe("in_testing");
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
    expect(msg).toMatch(/principal's token/);
    wg.db.close();
  });

  it("a human PASS (waiver) with replay=skipped still moves the ticket on", () => {
    const wg = freshWg();
    const id = ordinaryInTesting(wg);
    // A waiver carries no runner measurement (package H1): a replay sent with it is refused.
    expect(() =>
      wg.testerPass(
        id,
        { summary: "Checked every acceptance criterion by hand", replay: "skipped" },
        human,
        asPerson(wg, human),
      ),
    ).toThrow(/runner's measurement/);
    const res = wg.testerPass(
      id,
      { summary: "Checked every acceptance criterion by hand" },
      human,
      asPerson(wg, human),
    );
    // Moved on: back to review for a person (tester first).
    expect(res.ticket.status).toBe("in_review");
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
    // Moved on: back to review for a person (tester first).
    expect(res.ticket.status).toBe("in_review");
    wg.db.close();
  });

  // An agent (or system) PASS with no replay at all is no more verified than one whose
  // replay was skipped: `wg ticket tester-pass` defaults to `--as agent`, so a PASS typed
  // by hand without a binding used to record as an automated tester PASS.
  for (const actor of [testerAgent, { type: "system" } as Actor]) {
    it(`${actor.type === "agent" ? "an agent" : "a system"} PASS with no binding at all is refused (BINDING_REQUIRED), the ticket stays in testing`, () => {
      const wg = freshWg();
      const id = ordinaryInTesting(wg);
      let err: unknown = null;
      try {
        wg.testerPass(id, { summary: "PASS" }, actor);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(DispatchError);
      expect((err as DispatchError).code).toBe("BINDING_REQUIRED");
      expect((err as Error).message).toMatch(/replay=passed/);
      expect((err as Error).message).toMatch(/principal's token/);
      expect(wg.view(id).ticket.status).toBe("in_testing");
      wg.db.close();
    });
  }

  it("a human PASS with no binding at all is a waiver and moves the ticket on", () => {
    const wg = freshWg();
    const id = ordinaryInTesting(wg);
    expect(
      wg.testerPass(id, { summary: "checked by hand" }, human, asPerson(wg, human)).ticket.status,
    ).toBe("in_review");
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

describe("implementation tickets get a test_contract", () => {
  function plan(wg: Dispatch, extra: Record<string, unknown> = {}) {
    wg.registerRepository({ name: "app", default_branch: "main" }, human);
    return wg.createEpic(
      {
        epic: { name: "Bookmark Vault", description: "a bookmark manager", ...extra },
        tickets: [
          {
            title: "Scaffold",
            acceptanceCriteria: ["package.json exists"],
            repo: "app",
            bootstrap: true,
          },
          {
            title: "Store bookmarks",
            acceptanceCriteria: ["atomic writes"],
            repo: "app",
            dependsOn: [0],
          },
          { title: "HTTP API", acceptanceCriteria: ["routes"], repo: "app", dependsOn: [1] },
        ],
      },
      human,
    );
  }
  const tickets = (wg: Dispatch) =>
    wg.db
      .prepare(
        "SELECT id, number, title, can_be_tested, test_contract, acceptance FROM tickets ORDER BY number",
      )
      .all() as Array<{
      id: string;
      number: number;
      title: string;
      can_be_tested: number;
      test_contract: string | null;
      acceptance: number;
    }>;

  it("plan/decompose (createEpic) with the lane on: every testable implementation ticket carries a contract with changed_surfaces", () => {
    const wg = freshWg(true);
    plan(wg);
    const rows = tickets(wg);
    const impl = rows.filter((r) => r.acceptance === 0 && r.can_be_tested === 1);
    expect(impl.map((r) => r.title)).toEqual(["Store bookmarks", "HTTP API"]);
    for (const r of impl) {
      const c = parseTestContract(r.test_contract);
      expect(c).not.toBeNull();
      expect(c!.changed_surfaces.length).toBe(1);
      expect(c!.changed_surfaces[0]).toContain(`"${r.title}"`);
      expect(c!.harness_ready).toBe(false);
      expect(c!.run_command).toBe("");
    }
    // The bootstrap is not testable and gets no contract (absent behaves as today).
    const boot = rows.find((r) => r.title === "Scaffold")!;
    expect(boot.can_be_tested).toBe(0);
    expect(boot.test_contract).toBeNull();
    wg.db.close();
  });

  it("the acceptance ticket keeps its own contract, written once", () => {
    const wg = freshWg(true);
    plan(wg);
    const acc = tickets(wg).find((r) => r.acceptance === 1)!;
    expect(parseTestContract(acc.test_contract)!.changed_surfaces[0]).toMatch(
      /the whole build of epic "Bookmark Vault"/,
    );
    const sets = wg.view(acc.id).events.filter((e) => e.event_type === "ticket.test_contract_set");
    expect(sets).toHaveLength(1);
    wg.db.close();
  });

  it("with the lane off nothing becomes testable, so nothing is seeded (today's shape)", () => {
    const wg = freshWg(false);
    plan(wg);
    for (const r of tickets(wg).filter((x) => x.acceptance === 0)) {
      expect(r.can_be_tested).toBe(0);
      expect(r.test_contract).toBeNull();
    }
    wg.db.close();
  });

  it("set-testable (CLI, dashboard switch, MCP) seeds a contract with provenance on the event", () => {
    const wg = freshWg(true);
    const t = wg.createTicket({ title: "Export CSV", policy_pack: "solo_loose" }, human);
    expect(wg.resolveTicket(t.id).test_contract).toBeNull(); // wg ticket create: none
    wg.setTestable(t.id, true, human);
    const c = parseTestContract(wg.resolveTicket(t.id).test_contract);
    expect(c!.changed_surfaces[0]).toContain('"Export CSV"');
    const ev = wg.view(t.id).events.find((e) => e.event_type === "ticket.test_contract_set");
    expect(JSON.parse(ev!.payload_json ?? "{}")).toMatchObject({ seeded_from: "title" });
    wg.db.close();
  });

  it("an existing contract is never overwritten by the seed", () => {
    const wg = freshWg(true);
    const t = wg.createTicket({ title: "Export CSV", policy_pack: "solo_loose" }, human);
    wg.setTestContract(t.id, { changed_surfaces: ["GET /export.csv"] }, human);
    const before = contractHash(wg.db, t.id);
    wg.setTestable(t.id, true, human);
    expect(parseTestContract(wg.resolveTicket(t.id).test_contract)!.changed_surfaces).toEqual([
      "GET /export.csv",
    ]);
    expect(contractHash(wg.db, t.id)).toBe(before);
    wg.db.close();
  });

  it("a frozen contract (in_testing on) is never seeded: the tester's hash stays valid", () => {
    const wg = freshWg(true);
    const t = wg.createTicket({ title: "Export CSV", policy_pack: "solo_loose" }, human);
    wg.db.prepare("UPDATE tickets SET status = 'in_testing' WHERE id = ?").run(t.id);
    const before = contractHash(wg.db, t.id);
    wg.setTestable(t.id, true, human);
    expect(wg.resolveTicket(t.id).test_contract).toBeNull();
    expect(contractHash(wg.db, t.id)).toBe(before);
    wg.db.close();
  });

  it("a title that would trip the leak rules seeds a title-free surface, never an error", () => {
    const wg = freshWg(true);
    const t = wg.createTicket(
      { title: "Fix the diff view in src/app.ts", policy_pack: "solo_loose" },
      human,
    );
    expect(() => wg.setTestable(t.id, true, human)).not.toThrow();
    const c = parseTestContract(wg.resolveTicket(t.id).test_contract);
    expect(c!.changed_surfaces).toHaveLength(1);
    expect(c!.changed_surfaces[0]).not.toContain("src/app.ts");
    const ev = wg.view(t.id).events.find((e) => e.event_type === "ticket.test_contract_set");
    expect(JSON.parse(ev!.payload_json ?? "{}")).toMatchObject({ seeded_from: "generic" });
    wg.db.close();
  });
});

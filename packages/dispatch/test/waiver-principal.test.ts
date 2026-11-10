import { describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import type { GitRunner } from "../src/services/diffService.js";
import { readLatestWaiver } from "../src/services/reviewGate/waiver.js";
import { TestClock } from "../src/util/clock.js";
import { DispatchError } from "../src/util/errors.js";
import { contractHash } from "../src/util/contractHash.js";
import { asPerson, principalFor } from "./helpers/principal.js";
import { FAKE_MERGE_BASE, giveTicketRealDelivery } from "./helpers/realDiff.js";

/**
 * PACKAGE H1: a person's tester verdict needs a human principal, is bound to what it
 * waives, and is shown. Every test here fails without the guard it names (each was run
 * against the code before the guard; see HISTORY-H1).
 */

const human: Actor = { type: "human", id: "tom" };
const admin: Actor = { type: "admin", id: "root" };
const reviewer: Actor = { type: "human", id: "rev" };
const agentActor: Actor = { type: "agent", id: "agent-runner" };
const testerAgent: Actor = { type: "agent", id: "tester-1" };
const runner: Actor = { type: "system" };

const SHA1 = "1".repeat(40);
const SHA2 = "2".repeat(40);

/** A git runner whose delivery head is whatever `head.sha` holds (a push moves it). */
function movableHead(head: { sha: string }): GitRunner {
  return (_cwd, args) => {
    const joined = args.join(" ");
    if (args[0] === "rev-parse" && /^refs\/heads\/.+\^\{commit\}$/.test(String(args.at(-1)))) {
      return { status: 0, stdout: `${head.sha}\n`, stderr: "" };
    }
    if (args[0] === "merge-base") return { status: 0, stdout: `${FAKE_MERGE_BASE}\n`, stderr: "" };
    if (joined.startsWith("diff --name-status"))
      return { status: 0, stdout: "M\0src/x.ts\0", stderr: "" };
    if (joined.startsWith("diff --numstat"))
      return { status: 0, stdout: "5\t1\tsrc/x.ts\n", stderr: "" };
    if (joined.startsWith("diff")) {
      return { status: 0, stdout: "diff --git a/src/x.ts b/src/x.ts\n+a change\n", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
}

function world(isolation = "docker") {
  const head = { sha: SHA1 };
  const wg = Dispatch.open(":memory:", new TestClock(), movableHead(head), {
    testingEnabled: true,
    isolation: () => isolation,
  });
  wg.registerRepository({ name: "svc", default_branch: "main" }, human);
  return { wg, head };
}

const shown = (wg: Dispatch, id: string) =>
  wg.ticketHeads(id).heads.map((h) => ({ repo: h.repo, sha: h.sha }));

/** A testable ticket with two criteria, delivered and sent to the tester (in_testing). */
function inTesting(wg: Dispatch): string {
  const t = wg.createTicket(
    { title: "Ship it", description: "deliver it", policy_pack: "solo_loose" },
    human,
  );
  wg.linkRepository(t.id, "svc", "primary", human);
  const { ac } = wg.addAcceptanceCriterion({ ticket_id: t.id, text: "Returns 200" }, human);
  wg.addAcceptanceCriterion({ ticket_id: t.id, text: "Shows the banner" }, human);
  wg.setTestable(t.id, true, human);
  wg.markReady(t.id, human);
  const agent = wg.registerAgent({ display_name: "a" }, human);
  const claim = wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, agentActor)!;
  wg.recordEvidence(
    {
      claimToken: claim.claimToken,
      ticket_id: t.id,
      ac_id: ac.id,
      evidence_type: "test_output",
      summary: "ok",
    },
    agentActor,
  );
  wg.submitForReview({ claimToken: claim.claimToken, ticket_id: t.id, reason: "done" }, agentActor);
  giveTicketRealDelivery(wg, t.id, human);
  const [route] = wg.routeToTester(t.id, runner);
  expect(route!.routed).toBe(true);
  expect(wg.view(t.id).ticket.status).toBe("in_testing");
  return t.id;
}

/** The runner's tester FAIL of `commit` (refining: held for a person). */
function testerFails(wg: Dispatch, id: string, commit: string | null = SHA1) {
  return wg.testerFail(
    id,
    { summary: "AC2 cannot be observed here", ...(commit ? { tested_commit: commit } : {}) },
    testerAgent,
  );
}

function refusal(fn: () => unknown): DispatchError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(DispatchError);
    return err as DispatchError;
  }
  throw new Error("expected a refusal");
}

describe("H1: a person's tester verdict needs an active human or admin principal", () => {
  for (const actor of [human, admin]) {
    it(`a ${actor.type} PASS or FAIL without a principal is refused, nothing recorded`, () => {
      const { wg } = world();
      const id = inTesting(wg);
      for (const fn of [
        () => wg.testerPass(id, { summary: "checked by hand" }, actor),
        () => wg.testerFail(id, { summary: "saw it fail" }, actor),
        () => wg.testerPass(id, { summary: "checked by hand" }, actor, { principal: null }),
      ]) {
        const err = refusal(fn);
        expect(err.code).toBe("ACTOR_NOT_PERMITTED");
        expect(err.message).toMatch(/principal create/);
        expect(err.message).toMatch(/GAFFER_PRINCIPAL_TOKEN=<token>/);
      }
      expect(wg.view(id).ticket.status).toBe("in_testing");
      const verdicts = wg.db
        .prepare(
          "SELECT COUNT(*) AS n FROM evidence WHERE ticket_id = ? AND payload_json LIKE '%\"verdict\"%'",
        )
        .get(id) as { n: number };
      expect(verdicts.n).toBe(0);
      wg.db.close();
    });
  }

  it("a revoked principal is refused (re-read from the database, not the caller's view)", () => {
    const { wg } = world();
    const id = inTesting(wg);
    const p = principalFor(wg, human);
    wg.revokePrincipal(p.principal.id, { type: "human", id: "operator" });
    const err = refusal(() => wg.testerPass(id, { summary: "checked" }, human, p.authority));
    expect(err.code).toBe("ACTOR_NOT_PERMITTED");
    expect(err.message).toMatch(/revoked/);
    expect(wg.view(id).ticket.status).toBe("in_testing");
    wg.db.close();
  });

  it("a read-only principal, an unknown one and one that is not the actor are refused", () => {
    const { wg } = world();
    const id = inTesting(wg);
    const ro = wg.createPrincipal(
      { name: "viewer", capability: "read", actorId: "tom" },
      { type: "human", id: "operator" },
    );
    expect(
      refusal(() => wg.testerPass(id, { summary: "x" }, human, { principal: ro.principal }))
        .message,
    ).toMatch(/read-only/);
    expect(
      refusal(() => wg.testerPass(id, { summary: "x" }, human, { principal: { id: "nope" } }))
        .message,
    ).toMatch(/unknown/);
    // Tom's principal does not speak for rev.
    expect(
      refusal(() => wg.testerPass(id, { summary: "x" }, reviewer, asPerson(wg, human))).message,
    ).toMatch(/is not principal/);
    wg.db.close();
  });

  it("an agent-type principal cannot exist and a forged one is refused", () => {
    const { wg } = world();
    const id = inTesting(wg);
    expect(() =>
      wg.createPrincipal(
        { name: "bot", actorType: "agent" as never },
        { type: "human", id: "operator" },
      ),
    ).toThrow();
    // A principal object claiming to be an agent's: the service reads the row, not the object.
    const p = principalFor(wg, human).principal;
    const forged = { ...p, actor_type: "agent" as never };
    const res = wg.testerPass(id, { summary: "checked" }, human, { principal: forged });
    // The stored row is a human principal speaking for tom: the forgery changed nothing.
    expect(res.ticket.status).toBe("in_review");
    const agentActorPrincipal = refusal(() =>
      wg.testerFail(id, { summary: "x" }, { type: "agent", id: "tom" }, { principal: forged }),
    );
    // An agent verdict is never a person's: the principal is ignored and the agent's FAIL
    // needs a ticket in testing (it is in review now).
    expect(agentActorPrincipal.code).toBe("ILLEGAL_TRANSITION");
    wg.db.close();
  });

  it("the runner's verdicts are unchanged: an agent or system PASS needs the replay proof", () => {
    const { wg } = world();
    const id = inTesting(wg);
    for (const actor of [testerAgent, runner]) {
      expect(refusal(() => wg.testerPass(id, { summary: "PASS" }, actor)).code).toBe(
        "BINDING_REQUIRED",
      );
    }
    const ok = wg.testerPass(
      id,
      { summary: "PASS", tested_commit: SHA1, replay: "passed" },
      testerAgent,
    );
    expect(ok.ticket.status).toBe("in_review");
    wg.db.close();
  });

  it("the principal's waiver is accepted and recorded as the principal", () => {
    const { wg } = world();
    const id = inTesting(wg);
    const res = wg.testerPass(id, { summary: "checked AC2 by hand" }, human, asPerson(wg, human));
    expect(res.ticket.status).toBe("in_review");
    const row = wg.db
      .prepare(
        "SELECT created_by, recorded_by_actor_type, payload_json FROM evidence WHERE ticket_id = ? AND summary = ?",
      )
      .get(id, "checked AC2 by hand") as {
      created_by: string;
      recorded_by_actor_type: string;
      payload_json: string;
    };
    expect(row.created_by).toBe("tom");
    expect(row.recorded_by_actor_type).toBe("human");
    expect(JSON.parse(row.payload_json).waiver.principal.name).toBe("human-tom");
    wg.db.close();
  });

  it("a principal's FAIL is accepted and names the principal", () => {
    const { wg } = world();
    const id = inTesting(wg);
    const res = wg.testerFail(id, { summary: "AC1 is 500" }, admin, asPerson(wg, admin));
    expect(res.ticket.status).toBe("refining");
    const row = wg.db
      .prepare("SELECT payload_json FROM evidence WHERE ticket_id = ? AND summary = ?")
      .get(id, "AC1 is 500") as { payload_json: string };
    expect(JSON.parse(row.payload_json).principal.name).toBe("admin-root");
    wg.db.close();
  });
});

describe("H1: a waiver is bound to what it waives", () => {
  it("records every write repo's head, the contract, the criteria, the summary and the isolation", () => {
    const { wg } = world("none");
    const id = inTesting(wg);
    wg.testerPass(id, { summary: "clicked through it" }, human, asPerson(wg, human));
    const w = readLatestWaiver(wg.db, id)!;
    expect(w).not.toBeNull();
    expect(w.heads.length).toBe(wg.ticketHeads(id).heads.length);
    expect(w.heads.length).toBeGreaterThan(0);
    for (const h of w.heads) expect(h.sha).toBe(SHA1);
    expect(w.contract_hash).toBe(contractHash(wg.db, id));
    expect(w.criteria.map((c) => c.n)).toEqual([1, 2]);
    expect(w.summary).toBe("clicked through it");
    expect(w.isolation).toBe("none");
    expect(w.label).toBe(
      `tester verdict waived by human-tom for criteria 1, 2 on ${w.heads.map((h) => `${h.repo}@${SHA1.slice(0, 12)}`).join(", ")}: clicked through it (recorded without OS isolation)`,
    );
    wg.db.close();
  });

  it("names criteria with --criterion (position or id) and refuses an unknown one", () => {
    const { wg } = world();
    const id = inTesting(wg);
    expect(
      refusal(() =>
        wg.testerPass(id, { summary: "x", criteria: ["3"] }, human, asPerson(wg, human)),
      ).code,
    ).toBe("VALIDATION_ERROR");
    const acs = wg.view(id).acceptanceCriteria;
    wg.testerPass(
      id,
      { summary: "AC2 by hand", criteria: [acs[1]!.id] },
      human,
      asPerson(wg, human),
    );
    const w = readLatestWaiver(wg.db, id)!;
    expect(w.criteria.map((c) => c.n)).toEqual([2]);
    expect(w.isolation).toBe("docker");
    expect(w.label).not.toMatch(/without OS isolation/);
    wg.db.close();
  });

  it("takes no runner measurement and no commit on the caller's word", () => {
    const { wg } = world();
    const id = inTesting(wg);
    expect(
      refusal(() =>
        wg.testerPass(id, { summary: "x", replay: "passed" }, human, asPerson(wg, human)),
      ).message,
    ).toMatch(/runner's measurement/);
    expect(
      refusal(() =>
        wg.testerPass(id, { summary: "x", tested_commit: SHA2 }, human, asPerson(wg, human)),
      ).message,
    ).toMatch(/not the branch head/);
    wg.db.close();
  });

  it("a write repo whose head cannot be read refuses the waiver", () => {
    const { wg } = world();
    const id = inTesting(wg);
    wg.db
      .prepare(
        "UPDATE repositories SET local_path = '/no/such/checkout' WHERE id IN (SELECT repo_id FROM ticket_repos WHERE ticket_id = ?)",
      )
      .run(id);
    const err = refusal(() => wg.testerPass(id, { summary: "x" }, human, asPerson(wg, human)));
    expect((err.details as { reason?: string }).reason).toBe("head_unreadable");
    wg.db.close();
  });

  it("a new commit voids it: approval and landing refuse as not tested", () => {
    const { wg, head } = world();
    const id = inTesting(wg);
    wg.testerPass(id, { summary: "by hand" }, human, asPerson(wg, human));
    expect(wg.reviewGateSvc.testerCoverage(wg.resolveTicket(id)).covered).toBe(true);
    head.sha = SHA2; // a push after the waiver
    const cov = wg.reviewGateSvc.testerCoverage(wg.resolveTicket(id));
    expect(cov).toMatchObject({ covered: false, why: "other_commit" });
    const err = refusal(() => wg.approveReview(id, reviewer, { commits: shown(wg, id) }));
    expect((err.details as { reason?: string }).reason).toBe("not_tested");
    wg.db.close();
  });

  it("a contract edit voids it, and a landing begun after the edit is refused", () => {
    const { wg } = world();
    const id = inTesting(wg);
    wg.testerPass(id, { summary: "by hand" }, human, asPerson(wg, human));
    wg.approveReview(id, reviewer, { commits: shown(wg, id) });
    expect(wg.view(id).ticket.status).toBe("ready_for_merge");
    // The landing is begun on the approved commit while the waiver still covers it.
    const repo = wg.ticketHeads(id).heads[0]!;
    // A contract edit after the approval: the waiver no longer covers what lands.
    wg.db.prepare("UPDATE tickets SET description = 'a different contract' WHERE id = ?").run(id);
    expect(wg.reviewGateSvc.testerCoverage(wg.resolveTicket(id)).why).toBe("contract_changed");
    const err = refusal(() =>
      wg.beginLanding(id, { repo: repo.repo_id, commit: repo.sha }, runner),
    );
    expect((err.details as { reason?: string }).reason).toBe("not_tested");
    wg.db.close();
  });

  it("an approved waiver still covering its commit lands (beginLanding records it)", () => {
    const { wg } = world();
    const id = inTesting(wg);
    wg.testerPass(id, { summary: "by hand" }, human, asPerson(wg, human));
    wg.approveReview(id, reviewer, { commits: shown(wg, id) });
    const repo = wg.ticketHeads(id).heads[0]!;
    const started = wg.beginLanding(id, { repo: repo.repo_id, commit: repo.sha }, runner);
    expect(started.commit).toBe(SHA1);
    wg.db.close();
  });
});

describe("H1: a principal may waive a recorded tester FAIL on the unchanged head", () => {
  it("refining by the tester's FAIL, head still the tested commit: back to in_review, then approvable", () => {
    const { wg } = world();
    const id = inTesting(wg);
    testerFails(wg, id);
    expect(wg.view(id).ticket.status).toBe("refining");
    const res = wg.testerPass(
      id,
      { summary: "AC2 holds on a real browser" },
      human,
      asPerson(wg, human),
    );
    expect(res.ticket.status).toBe("in_review");
    const w = readLatestWaiver(wg.db, id)!;
    expect(w.waives_fail).toBeTruthy();
    // The person approves the commit the waiver covers.
    const ok = wg.approveReview(id, reviewer, { commits: shown(wg, id) });
    expect(ok.ticket.status).toBe("ready_for_merge");
    wg.db.close();
  });

  it("on a moved head it is refused", () => {
    const { wg, head } = world();
    const id = inTesting(wg);
    testerFails(wg, id);
    head.sha = SHA2;
    const err = refusal(() => wg.testerPass(id, { summary: "x" }, human, asPerson(wg, human)));
    expect((err.details as { reason?: string }).reason).toBe("fail_not_waivable");
    expect(err.message).toMatch(/moved/);
    expect(wg.view(id).ticket.status).toBe("refining");
    wg.db.close();
  });

  it("a FAIL that names no tested commit, or a ticket moved since the FAIL, is refused", () => {
    const { wg } = world();
    const id = inTesting(wg);
    testerFails(wg, id, null);
    expect(
      (
        refusal(() => wg.testerPass(id, { summary: "x" }, human, asPerson(wg, human))).details as {
          reason?: string;
        }
      ).reason,
    ).toBe("fail_not_waivable");
    const { wg: wg2 } = world();
    const id2 = inTesting(wg2);
    testerFails(wg2, id2);
    wg2.moveTicket(id2, "draft", human);
    wg2.moveTicket(id2, "refining", human);
    expect(
      refusal(() => wg2.testerPass(id2, { summary: "x" }, human, asPerson(wg2, human))).message,
    ).toMatch(/not held in refining by the tester's FAIL/);
    wg.db.close();
    wg2.db.close();
  });

  it("the tokenless waiver of a FAIL is refused like any person's verdict", () => {
    const { wg } = world();
    const id = inTesting(wg);
    testerFails(wg, id);
    expect(refusal(() => wg.testerPass(id, { summary: "x" }, human)).code).toBe(
      "ACTOR_NOT_PERMITTED",
    );
    wg.db.close();
  });
});

describe("H1: no other hand route skips the tester's verdict", () => {
  it("the board move refining (tester FAIL) -> in_review is refused (the live bypass)", () => {
    const { wg } = world();
    const id = inTesting(wg);
    testerFails(wg, id);
    for (const actor of [human, admin]) {
      const err = refusal(() => wg.moveTicket(id, "in_review", actor));
      expect(err.code).toBe("ILLEGAL_TRANSITION");
    }
    // And every other forward target from refining by a move.
    for (const to of ["in_testing", "ready_for_merge", "done"]) {
      expect(refusal(() => wg.moveTicket(id, to, human)).code).toBe("ILLEGAL_TRANSITION");
    }
    expect(wg.view(id).ticket.status).toBe("refining");
    wg.db.close();
  });

  it("a move out of in_testing toward review, merge or done is refused", () => {
    const { wg } = world();
    const id = inTesting(wg);
    for (const to of ["in_review", "ready_for_merge", "done"]) {
      expect(refusal(() => wg.moveTicket(id, to, admin)).code).toBe("ILLEGAL_TRANSITION");
    }
    wg.db.close();
  });

  it("`ready` after a tester FAIL stays allowed (rework, tested again on its next submit)", () => {
    const { wg } = world();
    const id = inTesting(wg);
    testerFails(wg, id);
    // Rework (`ready` after a FAIL stays allowed): the next submit is a new round.
    wg.markReady(id, human);
    expect(wg.view(id).ticket.status).toBe("ready");
    wg.db.close();
  });

  it("reopen-for-review starts a new round: the person's approval is refused until the tester passes", () => {
    const { wg } = world();
    const id = inTesting(wg);
    wg.testerPass(id, { summary: "PASS", tested_commit: SHA1, replay: "passed" }, testerAgent);
    wg.approveReview(id, reviewer, { commits: shown(wg, id) });
    expect(wg.view(id).ticket.status).toBe("ready_for_merge");
    wg.reopenForReview(id, { reason: "moved", resolution: "re-review" }, admin);
    expect(wg.view(id).ticket.status).toBe("in_review");
    const err = refusal(() => wg.approveReview(id, reviewer, { commits: shown(wg, id) }));
    expect((err.details as { reason?: string }).reason).toBe("not_tested");
    // An agent may approve only with autonomy on; with it, the untested head goes to the
    // tester instead of to merge.
    const saved = process.env.DISPATCH_ALLOW_AGENT_APPROVE;
    process.env.DISPATCH_ALLOW_AGENT_APPROVE = "1";
    try {
      const routed = wg.approveReview(
        id,
        { type: "agent", id: "reviewer-agent" },
        {
          commits: shown(wg, id),
        },
      );
      expect(routed.ticket.status).toBe("in_testing");
    } finally {
      if (saved === undefined) delete process.env.DISPATCH_ALLOW_AGENT_APPROVE;
      else process.env.DISPATCH_ALLOW_AGENT_APPROVE = saved;
    }
    wg.db.close();
  });

  it("unblock of a ticket the tester's FAIL parked leads to rework, never to review", () => {
    const { wg } = world();
    const id = inTesting(wg);
    // A hold from testing (the runner's park), then a person unblocks it.
    wg.holdForHuman(id, { reasonCode: "ci_red", reason: "red" }, runner);
    expect(wg.view(id).ticket.status).toBe("blocked");
    for (const to of ["in_review", "ready_for_merge", "done", "in_testing"]) {
      expect(refusal(() => wg.moveTicket(id, to, admin)).code).toBe("ILLEGAL_TRANSITION");
    }
    wg.db.close();
  });

  it("mark-merged is refused for a ticket the tester failed (not approved)", () => {
    const { wg } = world();
    const id = inTesting(wg);
    testerFails(wg, id);
    // Nothing was approved, so nothing landed: mark-merged refuses (not done), and the
    // ticket stays where the FAIL left it.
    expect(["ILLEGAL_TRANSITION", "STATE_CONFLICT"]).toContain(
      refusal(() => wg.markMerged(id, runner)).code,
    );
    expect(wg.view(id).ticket.status).toBe("refining");
    wg.db.close();
  });
});

import { describe, expect, it } from "vitest";

import { Dispatch, testingLaneMode } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import type { Notifier, NotifyEvent } from "../src/notify/index.js";
import type { GitRunner } from "../src/services/diffService.js";
import { testerLaneFor, testerOffNotice } from "../src/util/testingLane.js";
import { TestClock } from "../src/util/clock.js";
import { DispatchError } from "../src/util/errors.js";
import { FAKE_MERGE_BASE, giveTicketRealDelivery } from "./helpers/realDiff.js";
import { asPerson } from "./helpers/principal.js";

/**
 * TESTER FIRST (Release A wave 2): with the tester lane on, the independent tester tests a
 * delivery BEFORE a person reviews it. The runner sends an in_review ticket to the tester
 * (routeToTester), a PASS returns it to review, a FAIL sends it back to rework, and a
 * person can approve only the commit the tester passed (a push after the PASS is refused
 * until the tester passes the new head).
 */

const human: Actor = { type: "human", id: "tom" };
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

function world(
  opts: { testingEnabled?: boolean; testCommand?: string | null; notifier?: Notifier } = {},
) {
  const head = { sha: SHA1 };
  const wg = Dispatch.open(":memory:", new TestClock(), movableHead(head), {
    ...(opts.testingEnabled !== undefined ? { testingEnabled: opts.testingEnabled } : {}),
    ...(opts.notifier ? { notifier: opts.notifier } : {}),
  });
  const repo = wg.registerRepository({ name: "svc", default_branch: "main" }, human);
  if (opts.testCommand) {
    wg.setRepoCommands(repo.id, { test_command: opts.testCommand }, human);
  }
  return { wg, head };
}

/** What the Review view shows and an approval names: every write repo's head. */
const shown = (wg: Dispatch, id: string) =>
  wg.ticketHeads(id).heads.map((h) => ({ repo: h.repo, sha: h.sha }));

/** A testable ticket delivered to in_review (satisfied AC, a real delivery diff). */
function delivered(wg: Dispatch, title = "Ship it", testCommand: string | null = null): string {
  const t = wg.createTicket({ title, description: "deliver it", policy_pack: "team_light" }, human);
  wg.linkRepository(t.id, "svc", "primary", human);
  const { ac } = wg.addAcceptanceCriterion({ ticket_id: t.id, text: "Returns 200" }, human);
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
  if (testCommand) {
    for (const r of wg.view(t.id).repositories) {
      wg.setRepoCommands(r.id, { test_command: testCommand }, human);
    }
  }
  expect(wg.view(t.id).ticket.status).toBe("in_review");
  return t.id;
}

const noCost = () => ({
  cost_usd: 0,
  measured_usd: 0,
  estimated_usd: 0,
  num_turns: 0,
  unknown_calls: 0,
  ledger_status: "unconfigured" as const,
});

const pass = (wg: Dispatch, id: string, commit: string, actor: Actor = testerAgent) =>
  wg.testerPass(
    id,
    { summary: "black-box tests pass", tested_commit: commit, replay: "passed" },
    actor,
  );

function refusal(fn: () => unknown): DispatchError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(DispatchError);
    return err as DispatchError;
  }
  throw new Error("expected a refusal");
}

describe("tester first: the lifecycle with the lane on", () => {
  it("delivery -> in_testing (runner) -> PASS -> in_review -> a person approves the tested commit -> ready_for_merge", () => {
    const { wg } = world({ testingEnabled: true });
    const id = delivered(wg);

    const [route] = wg.routeToTester(id, runner);
    expect(route!.routed).toBe(true);
    expect(route!.code).toBe("routed");
    expect(wg.view(id).ticket.status).toBe("in_testing");
    const routed = wg.view(id).events.filter((e) => e.event_type === "ticket.routed_to_testing");
    expect(JSON.parse(routed.at(-1)!.payload_json ?? "{}")).toMatchObject({
      from: "in_review",
      before_review: true,
      head: SHA1,
    });

    const res = pass(wg, id, SHA1);
    expect(res.ticket.status).toBe("in_review");
    const ev = wg
      .view(id)
      .events.filter((e) => e.event_type === "ticket.tester_passed")
      .at(-1)!;
    expect(JSON.parse(ev.payload_json ?? "{}")).toMatchObject({
      tested_head: SHA1,
      to: "in_review",
    });

    // The outcome names the tested commit, and the approval goes straight to merge.
    const outcome = wg.approveOutcome(id, { mergeCommand: false });
    expect(outcome.kind).toBe("waits_for_merge");
    expect(outcome.sentence).toContain(`You approve tested commit ${SHA1.slice(0, 12)}`);
    const ok = wg.approveReview(id, reviewer, { commits: shown(wg, id) });
    expect(ok.ticket.status).toBe("ready_for_merge");
  });

  it("a person cannot approve a commit the tester has not passed (held server-side, not_tested)", () => {
    const { wg } = world({ testingEnabled: true });
    const id = delivered(wg);
    const outcome = wg.approveOutcome(id, { mergeCommand: false });
    expect(outcome.kind).toBe("held_untested");
    expect(outcome.approvable).toBe(false);
    expect(outcome.label).toBe("Approve held: not tested on this commit");
    const err = refusal(() => wg.approveReview(id, reviewer));
    expect(err.code).toBe("STATE_CONFLICT");
    expect(err.details).toMatchObject({ reason: "not_tested", why: "no_verdict", head: SHA1 });
    expect(err.message).toContain("is not tested on this commit");
    expect(wg.view(id).ticket.status).toBe("in_review");
  });

  it("a push after the tester's PASS: not approvable until re-tested; the runner re-routes it", () => {
    const { wg, head } = world({ testingEnabled: true });
    const id = delivered(wg);
    wg.routeToTester(id, runner);
    pass(wg, id, SHA1);
    expect(wg.view(id).ticket.status).toBe("in_review");

    head.sha = SHA2; // someone pushed to the delivery branch after the PASS
    const outcome = wg.approveOutcome(id, { mergeCommand: false });
    expect(outcome.kind).toBe("held_untested");
    expect(outcome.sentence).toContain(`passed ${SHA1.slice(0, 12)}`);
    expect(outcome.sentence).toContain(SHA2.slice(0, 12));
    const err = refusal(() => wg.approveReview(id, reviewer, { commits: shown(wg, id) }));
    expect(err.details).toMatchObject({
      reason: "not_tested",
      why: "other_commit",
      tested: SHA1,
      head: SHA2,
    });

    const all = wg.routeToTester(null, runner);
    expect(all.find((r) => r.ticketId === id)?.routed).toBe(true);
    pass(wg, id, SHA2);
    expect(wg.approveReview(id, reviewer, { commits: shown(wg, id) }).ticket.status).toBe(
      "ready_for_merge",
    );
  });

  it("Poll for work counts an in_review ticket the tester pass would send to the tester", () => {
    const { wg, head } = world({ testingEnabled: true });
    const id = delivered(wg);
    expect(wg.pendingTesterRoutes()).toBe(1);
    wg.routeToTester(id, runner);
    pass(wg, id, SHA1);
    expect(wg.pendingTesterRoutes()).toBe(0);
    head.sha = SHA2; // a push after the PASS
    expect(wg.pendingTesterRoutes()).toBe(1);
  });

  it("routing is a no-op once a PASS covers the head, and refuses an agent", () => {
    const { wg } = world({ testingEnabled: true });
    const id = delivered(wg);
    wg.routeToTester(id, runner);
    pass(wg, id, SHA1);
    const [again] = wg.routeToTester(id, runner);
    expect(again!.routed).toBe(false);
    expect(again!.why).toContain("already passed");
    expect(again!.code).toBe("covered");
    expect(refusal(() => wg.routeToTester(id, agentActor)).code).toBe("ACTOR_NOT_PERMITTED");
    expect(refusal(() => wg.routeToTester(id, reviewer)).code).toBe("ACTOR_NOT_PERMITTED");
  });

  it("a tester FAIL sends it back to refining with the tester's observation as the feedback", () => {
    const { wg } = world({ testingEnabled: true });
    const id = delivered(wg);
    wg.routeToTester(id, runner);
    const res = wg.testerFail(
      id,
      { summary: "GET /todos returns 500 on an empty list", tested_commit: SHA1 },
      testerAgent,
    );
    expect(res.ticket.status).toBe("refining");
    const t = wg.view(id);
    const back = t.events.filter((e) => e.event_type === "ticket.transitioned").at(-1)!;
    expect(JSON.parse(back.payload_json ?? "{}")).toMatchObject({
      from: "in_testing",
      to: "refining",
      reason: "tester_failed:GET /todos returns 500 on an empty list",
    });
  });

  it("a person's PASS (a waiver) from a hold returns it to review and covers the head then", () => {
    const { wg } = world({ testingEnabled: true });
    const id = delivered(wg);
    wg.routeToTester(id, runner);
    const res = wg.testerPass(id, { summary: "I checked it by hand" }, human, asPerson(wg, human));
    expect(res.ticket.status).toBe("in_review");
    expect(wg.approveReview(id, reviewer).ticket.status).toBe("ready_for_merge");
  });

  it("an agent's approval of an untested commit routes it to the tester, and its PASS goes to merge", () => {
    process.env.DISPATCH_ALLOW_AGENT_APPROVE = "1";
    try {
      const { wg } = world({ testingEnabled: true });
      const id = delivered(wg);
      const rv = wg.registerAgent({ display_name: "rv" }, human);
      const res = wg.approveReview(id, { type: "agent", id: rv.id });
      expect(res.ticket.status).toBe("in_testing");
      expect(pass(wg, id, SHA1).ticket.status).toBe("ready_for_merge");
    } finally {
      delete process.env.DISPATCH_ALLOW_AGENT_APPROVE;
    }
  });

  it("a board drag can neither send a ticket to the tester nor bring it back to review", () => {
    const { wg } = world({ testingEnabled: true });
    const id = delivered(wg);
    expect(refusal(() => wg.moveTicket(id, "in_testing", human)).code).toBe("ILLEGAL_TRANSITION");
    wg.routeToTester(id, runner);
    expect(refusal(() => wg.moveTicket(id, "in_review", human)).code).toBe("ILLEGAL_TRANSITION");
  });

  it("the Review packet shows the PASS recorded before the ticket re-entered review", () => {
    const { wg } = world({ testingEnabled: true });
    const id = delivered(wg);
    wg.routeToTester(id, runner);
    pass(wg, id, SHA1);
    const packet = wg.reviewPacket(id, noCost);
    expect(packet.tester).toMatchObject({ verdict: "pass", tested_commit: SHA1 });
    expect(packet.candidate[0]?.tester_tested).toBe(SHA1);
    expect(
      packet.backing.some((b) => b.fact === "The independent tester passed this commit" && b.holds),
    ).toBe(true);
  });

  it("the person is pinged when the tester's PASS returns it to review, not at submit", () => {
    const events: NotifyEvent[] = [];
    const notifier: Notifier = {
      enabled: true,
      notify: (e) => {
        events.push(e);
      },
    } as Notifier;
    const { wg } = world({ testingEnabled: true, notifier });
    const id = delivered(wg);
    expect(events.filter((e) => e.kind === "review_needed")).toHaveLength(0);
    wg.routeToTester(id, runner);
    pass(wg, id, SHA1);
    expect(events.filter((e) => e.kind === "review_needed")).toHaveLength(1);
  });

  it("with the lane off nothing routes and approval is unchanged", () => {
    const { wg } = world({ testingEnabled: false });
    const id = delivered(wg);
    const [r] = wg.routeToTester(id, runner);
    expect(r!.routed).toBe(false);
    expect(r!.code).toBe("not_gated");
    expect(wg.approveReview(id, reviewer).ticket.status).toBe("ready_for_merge");
  });
});

describe("tester first: the adaptive lane default", () => {
  it("reads GAFFER_TESTING as on / off / auto (unset is auto)", () => {
    expect(testingLaneMode({})).toBe("auto");
    expect(testingLaneMode({ GAFFER_TESTING: "" })).toBe("auto");
    expect(testingLaneMode({ GAFFER_TESTING: "auto" })).toBe("auto");
    expect(testingLaneMode({ GAFFER_TESTING: "1" })).toBe("on");
    expect(testingLaneMode({ GAFFER_TESTING: "on" })).toBe("on");
    expect(testingLaneMode({ GAFFER_TESTING: "0" })).toBe("off");
    expect(testingLaneMode({ GAFFER_TESTING: "nope" })).toBe("off");
  });

  it("auto is on only when every write repo has a registered test command; explicit wins", () => {
    const withCmd = { name: "a", test_command: "npm test" };
    const without = { name: "b", test_command: null };
    expect(testerLaneFor("auto", [withCmd]).on).toBe(true);
    expect(testerLaneFor("auto", [withCmd, without])).toMatchObject({
      on: false,
      missing_test_command: ["b"],
    });
    expect(testerLaneFor("auto", []).on).toBe(false);
    expect(testerLaneFor("on", [without]).on).toBe(true);
    expect(testerLaneFor("off", [withCmd]).on).toBe(false);
  });

  it("auto with a registered test command: the tester gates the ticket", () => {
    const saved = process.env.GAFFER_TESTING;
    delete process.env.GAFFER_TESTING;
    try {
      const { wg } = world();
      const id = delivered(wg, "Ship it", "npm test");
      expect(wg.testerLane(id)).toMatchObject({ mode: "auto", on: true });
      expect(wg.routeToTester(id, runner)[0]!.routed).toBe(true);
    } finally {
      if (saved !== undefined) process.env.GAFFER_TESTING = saved;
    }
  });

  it("auto without one: the lane is off and Review says why", () => {
    const saved = process.env.GAFFER_TESTING;
    delete process.env.GAFFER_TESTING;
    try {
      const { wg } = world({ testCommand: null });
      const id = delivered(wg);
      expect(wg.testerLane(id)).toMatchObject({
        mode: "auto",
        on: false,
        missing_test_command: ["delivery-repo", "svc"],
      });
      expect(wg.routeToTester(id, runner)[0]!.routed).toBe(false);
      const packet = wg.reviewPacket(id, noCost);
      expect(packet.tester_expected).toBe(false);
      expect(packet.tester_lane).toMatchObject({ mode: "auto", on: false });
      const notice = packet.backing.find((b) => b.fact === testerOffNotice("svc"));
      expect(notice).toMatchObject({ holds: false, cell: "tester" });
      expect(notice!.fact).toBe("independent tester off: no test command registered for svc");
      expect(wg.approveReview(id, reviewer).ticket.status).toBe("ready_for_merge");
    } finally {
      if (saved !== undefined) process.env.GAFFER_TESTING = saved;
    }
  });

  it("Health lists each repository where auto leaves the tester off", () => {
    const saved = process.env.GAFFER_TESTING;
    delete process.env.GAFFER_TESTING;
    try {
      const { wg } = world({ testCommand: "npm test" });
      wg.registerRepository({ name: "web", default_branch: "main" }, human);
      expect(wg.testerLaneHealth()).toEqual({
        mode: "auto",
        repos_without_test_command: ["web"],
        notices: ["independent tester off: no test command registered for web"],
        // lane-hook R1: no runner record yet, so nothing to compare.
        runner: null,
        runner_differs: false,
      });
    } finally {
      if (saved !== undefined) process.env.GAFFER_TESTING = saved;
    }
  });

  it("an explicit off wins over a registered test command", () => {
    const saved = process.env.GAFFER_TESTING;
    process.env.GAFFER_TESTING = "0";
    try {
      const { wg } = world();
      const id = delivered(wg, "Ship it", "npm test");
      expect(wg.testerLane(id)).toMatchObject({ mode: "off", on: false });
      expect(wg.routeToTester(id, runner)[0]!.routed).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.GAFFER_TESTING;
      else process.env.GAFFER_TESTING = saved;
    }
  });
});

describe("tester first: acceptance tickets keep their gate", () => {
  it("an acceptance ticket is tested before review even with the lane off", () => {
    const { wg } = world({ testingEnabled: false });
    const id = delivered(wg, "Accept the build");
    wg.db.prepare("UPDATE tickets SET acceptance = 1 WHERE id = ?").run(id);
    expect(refusal(() => wg.approveReview(id, reviewer)).details).toMatchObject({
      reason: "not_tested",
    });
    expect(wg.routeToTester(id, runner)[0]!.routed).toBe(true);
    // An automated PASS on an acceptance ticket must still be bound (strict).
    expect(
      refusal(() => wg.testerPass(id, { summary: "ok", replay: "passed" }, testerAgent)).code,
    ).toBe("BINDING_REQUIRED");
  });
});

describe("tester first: review findings (coverage edges)", () => {
  /** A git runner whose head is per delivery branch (two write repos, two heads). */
  function perBranch(heads: Record<string, string>): GitRunner {
    return (cwd, args) => {
      const last = String(args.at(-1));
      const m = /^refs\/heads\/(.+)\^\{commit\}$/.exec(last);
      if (args[0] === "rev-parse" && m) {
        return { status: 0, stdout: `${heads[m[1]!] ?? SHA1}\n`, stderr: "" };
      }
      return movableHead({ sha: SHA1 })(cwd, args);
    };
  }

  it("two write repos: the tester's commit is shown on the repo it tested, as approval reads it", () => {
    const heads: Record<string, string> = { "feat/delivery": SHA1 };
    const wg = Dispatch.open(":memory:", new TestClock(), perBranch(heads), {
      testingEnabled: true,
    });
    wg.registerRepository({ name: "svc", default_branch: "main" }, human);
    const id = delivered(wg);
    const order = wg.ticketHeads(id).heads;
    expect(order.length).toBe(2);
    // The tester ran in the write repo that is NOT first in dispatch's order.
    const second = wg.view(id).repositories.find((r) => r.name === order[1]!.repo)!;
    wg.recordRepoDelivery({ ticket_id: id, repo_id: second.id, branch_name: "feat/other" }, human);
    heads["feat/other"] = SHA2;
    wg.routeToTester(id, runner);
    pass(wg, id, SHA2);
    expect(wg.view(id).ticket.status).toBe("in_review");

    const packet = wg.reviewPacket(id, noCost);
    const tested = packet.candidate.find((c) => c.repo === second.name)!;
    expect(tested.tester_tested).toBe(SHA2);
    expect(tested.same || tested.gated_sha === null).toBe(true);
    expect(packet.candidate[0]!.tester_tested).toBeNull();
    expect(
      packet.backing.some((b) => b.fact === "The independent tester passed this commit" && b.holds),
    ).toBe(true);
    expect(wg.approveReview(id, reviewer, { commits: shown(wg, id) }).ticket.status).toBe(
      "ready_for_merge",
    );
  });

  it("a test contract edited in review after a person's PASS (a waiver) needs the tester again", () => {
    const { wg } = world({ testingEnabled: true });
    const id = delivered(wg);
    wg.routeToTester(id, runner);
    wg.testerPass(id, { summary: "I checked it by hand" }, human, asPerson(wg, human));
    expect(wg.view(id).ticket.status).toBe("in_review");
    wg.setTestContract(
      id,
      {
        changed_surfaces: ["POST /api/widgets"],
        runtime_deps: [],
        env_vars: [],
        run_command: "curl localhost:3000",
        harness_ready: true,
      },
      human,
    );
    const err = refusal(() => wg.approveReview(id, reviewer, { commits: shown(wg, id) }));
    expect(err.details).toMatchObject({ reason: "not_tested", why: "contract_changed" });
    expect(wg.routeToTester(id, runner)[0]!.routed).toBe(true);
  });

  it("CI required and not passed on the head: not routed and not counted; routed once it passes", () => {
    const { wg } = world({ testingEnabled: true });
    const id = delivered(wg);
    wg.recordCiRequired(id, {}, runner);
    wg.recordCiResult(id, { commit: SHA1, state: "pending" }, runner);
    const [r] = wg.routeToTester(id, runner);
    expect(r!.routed).toBe(false);
    expect(r!.why).toContain("CI has not passed");
    expect(r!.code).toBe("ci_pending");
    expect(wg.pendingTesterRoutes()).toBe(0);
    expect(wg.view(id).ticket.status).toBe("in_review");

    wg.recordCiResult(id, { commit: SHA1, state: "pass" }, runner);
    expect(wg.pendingTesterRoutes()).toBe(1);
    expect(wg.routeToTester(id, runner)[0]!.routed).toBe(true);
  });

  it("Poll for work does not count a ticket whose write repo head cannot be read", () => {
    const { wg } = world({ testingEnabled: true });
    const id = delivered(wg);
    expect(wg.pendingTesterRoutes()).toBe(1);
    wg.db.prepare("UPDATE repositories SET local_path = NULL").run();
    const [r] = wg.routeToTester(id, runner);
    expect(r!.routed).toBe(false);
    expect(r!.code).toBe("head_unreadable");
    expect(wg.pendingTesterRoutes()).toBe(0);
  });
});

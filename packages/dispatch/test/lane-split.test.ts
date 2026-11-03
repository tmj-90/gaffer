import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import type { GitRunner } from "../src/services/diffService.js";
import { TestClock } from "../src/util/clock.js";
import { DispatchError } from "../src/util/errors.js";
import { recordRunnerTesterLane } from "../src/health/runnerTesterLane.js";
import { runCli } from "./helpers/cli.js";
import { FAKE_MERGE_BASE, giveTicketRealDelivery } from "./helpers/realDiff.js";

/**
 * LANE-SETTING CONSISTENCY (lane-hook R1, tester-first review R1): the dashboard and the
 * runner each read GAFFER_TESTING from their own environment. With the runner's shell at
 * GAFFER_TESTING=0 and the dashboard unset (auto) with a test command registered, the
 * dashboard refused a person's approval saying "the runner sends this one to the tester"
 * while the runner never routed it. The runner's CLI now records the lane it routes under
 * (runner.tester_lane), and the dashboard names the split on Health, in the packet and in
 * the refusal.
 */

const human: Actor = { type: "human", id: "tom" };
const agentActor: Actor = { type: "agent", id: "agent-runner" };
const SHA1 = "1".repeat(40);

const fixedHead: GitRunner = (_cwd, args) => {
  const joined = args.join(" ");
  if (args[0] === "rev-parse" && /^refs\/heads\/.+\^\{commit\}$/.test(String(args.at(-1))))
    return { status: 0, stdout: `${SHA1}\n`, stderr: "" };
  if (args[0] === "merge-base") return { status: 0, stdout: `${FAKE_MERGE_BASE}\n`, stderr: "" };
  if (joined.startsWith("diff --name-status"))
    return { status: 0, stdout: "M\0src/x.ts\0", stderr: "" };
  if (joined.startsWith("diff --numstat"))
    return { status: 0, stdout: "5\t1\tsrc/x.ts\n", stderr: "" };
  if (joined.startsWith("diff"))
    return { status: 0, stdout: "diff --git a/src/x.ts b/src/x.ts\n+a change\n", stderr: "" };
  return { status: 0, stdout: "", stderr: "" };
};

let dir = "";
let dbPath = "";
let savedLane: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wg-lane-split-"));
  dbPath = join(dir, "dispatch.sqlite");
  savedLane = process.env.GAFFER_TESTING;
  delete process.env.GAFFER_TESTING; // the dashboard: unset, the `auto` default
});
afterEach(() => {
  if (savedLane === undefined) delete process.env.GAFFER_TESTING;
  else process.env.GAFFER_TESTING = savedLane;
  rmSync(dir, { recursive: true, force: true });
});

/** The dashboard's Dispatch on the shared DB: GAFFER_TESTING from this process (auto). */
const dashboard = () => Dispatch.open(dbPath, new TestClock(), fixedHead);

/** A testable ticket delivered to in_review, every write repo with a test command. */
function delivered(wg: Dispatch): string {
  wg.registerRepository({ name: "svc", default_branch: "main" }, human);
  const t = wg.createTicket(
    { title: "Ship it", description: "deliver it", policy_pack: "team_light" },
    human,
  );
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
  for (const r of wg.view(t.id).repositories)
    wg.setRepoCommands(r.id, { test_command: "npm test" }, human);
  expect(wg.view(t.id).ticket.status).toBe("in_review");
  return t.id;
}

const laneRows = (wg: Dispatch) =>
  wg.db
    .prepare(
      "SELECT actor_type, payload_json FROM work_events WHERE event_type = 'runner.tester_lane' ORDER BY rowid",
    )
    .all() as Array<{ actor_type: string; payload_json: string }>;

/** The runner's tester route, as tick.sh runs it, in the runner's environment. */
const runnerRoute = (lane: string, as = "system") =>
  runCli(dbPath, ["ticket", "tester-route", "--all", "--as", as], { GAFFER_TESTING: lane });

const noCost = () => ({
  cost_usd: 0,
  measured_usd: 0,
  estimated_usd: 0,
  num_turns: 0,
  unknown_calls: 0,
  ledger_status: "unconfigured" as const,
});

function refusal(fn: () => unknown): DispatchError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(DispatchError);
    return err as DispatchError;
  }
  throw new Error("expected a refusal");
}

describe("lane-setting consistency: the runner records the tester lane it routes under", () => {
  it("records the runner's mode once, again when it changes, never for an admin's route", () => {
    const wg = dashboard();
    delivered(wg);
    expect(runnerRoute("0").error).toBeUndefined();
    expect(runnerRoute("0").error).toBeUndefined(); // unchanged: no second row
    expect(laneRows(wg).map((r) => JSON.parse(r.payload_json))).toEqual([{ mode: "off" }]);
    expect(laneRows(wg)[0]!.actor_type).toBe("system");
    runnerRoute("1");
    expect(laneRows(wg).map((r) => JSON.parse(r.payload_json))).toEqual([
      { mode: "off" },
      { mode: "on", was: "off" },
    ]);
    runnerRoute("0", "admin"); // a person's route is not the runner's lane
    expect(laneRows(wg)).toHaveLength(2);
    expect(wg.runnerTesterLane()?.mode).toBe("on");
    wg.db.close();
  });

  it("re-records an unchanged mode only once a day, and a broken database records nothing", () => {
    const wg = dashboard();
    expect(recordRunnerTesterLane(wg.db, "off")).toBe(true);
    const at = Date.parse(wg.runnerTesterLane()!.at);
    expect(recordRunnerTesterLane(wg.db, "off", at + 23 * 3600_000)).toBe(false);
    expect(recordRunnerTesterLane(wg.db, "off", at + 25 * 3600_000)).toBe(true);
    expect(laneRows(wg).map((r) => JSON.parse(r.payload_json))).toEqual([
      { mode: "off" },
      { mode: "off" },
    ]);
    wg.db.close();
    expect(recordRunnerTesterLane(wg.db, "on")).toBe(false); // closed: fail-soft
  });

  it("the refusal names the split instead of promising a route the runner will not make", () => {
    const wg = dashboard();
    const id = delivered(wg);
    // The runner (GAFFER_TESTING=0 in its shell) leaves the ticket in review.
    const routed = runnerRoute("0");
    expect((routed.json as { routed: number }).routed).toBe(0);
    expect(wg.view(id).ticket.status).toBe("in_review");
    // The dashboard (auto, a test command registered) still waits for a PASS.
    const err = refusal(() => wg.approveReview(id, human));
    expect(err.code).toBe("STATE_CONFLICT");
    expect(err.details).toMatchObject({ reason: "not_tested", runner_tester_lane: "off" });
    expect(err.message).toContain("the runner last routed with GAFFER_TESTING off");
    expect(err.message).not.toContain("the runner sends this one to the tester");
    wg.db.close();
  });

  it("the refusal keeps its promise when the runner's lane also sends the ticket", () => {
    const wg = dashboard();
    const id = delivered(wg);
    wg.recordRunnerTesterLane(); // the runner with the same (auto) environment
    const err = refusal(() => wg.approveReview(id, human));
    expect(err.message).toContain("the runner sends this one to the tester");
    expect(err.details).not.toHaveProperty("runner_tester_lane");
    wg.db.close();
  });

  it("Health says the runner's lane differs, first among the tester-lane notices", () => {
    const wg = dashboard();
    delivered(wg);
    expect(wg.testerLaneHealth()).toMatchObject({ runner: null, runner_differs: false });
    runnerRoute("0");
    const h = wg.testerLaneHealth();
    expect(h.mode).toBe("auto");
    expect(h.runner?.mode).toBe("off");
    expect(h.runner_differs).toBe(true);
    expect(h.notices[0]).toMatch(
      /^tester lane differs: the runner last routed with GAFFER_TESTING off .* this dashboard reads auto/,
    );
    runnerRoute("auto");
    expect(wg.testerLaneHealth()).toMatchObject({ runner_differs: false });
    expect(wg.testerLaneHealth().notices.some((n) => n.startsWith("tester lane differs"))).toBe(
      false,
    );
    wg.db.close();
  });

  it("the Review packet carries the runner's lane for the ticket only when it differs", () => {
    const wg = dashboard();
    const id = delivered(wg);
    const lane = () => wg.reviewPacket(id, noCost).tester_lane;
    runnerRoute("auto");
    expect(lane()).not.toHaveProperty("runner");
    runnerRoute("0");
    expect(lane()?.runner).toMatchObject({ mode: "off", on: false, gates: false });
    expect(wg.reviewPacket(id, noCost).tester_expected).toBe(true);
    wg.db.close();
  });
});

/**
 * THE AUTONOMY LADDER under a concurrent writer, external review 20: an agent's approval
 * racing with an approve step-down.
 *
 * The reviewer, with two connections to one database: the agent's approval passed its
 * autonomy check, the other connection committed an approve step-down while the approval
 * was reading its Git metadata, and the approval still committed review_approved and
 * returned ready_for_merge (the event order showed the step-down first). Only the later
 * landing check refused it. The hold was read before the Git reads and neither approval
 * transaction read it again.
 *
 * Pinned here, for BOTH approval transactions (straight to ready_for_merge, and to the
 * tester when the lane gates the ticket): wherever in the Git window the other connection
 * commits the step-down, or turns the approve policy off, the agent's approval is refused
 * and the ticket stays in review with nothing recorded. A person's approval is not held.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor, RiskLevel } from "../src/domain/types.js";
import { writeEvent } from "../src/events/eventWriter.js";
import { fileGateKeyring } from "../src/events/gateSeal.js";
import { AUTONOMY_STEPPED_DOWN_EVENT } from "../src/services/autonomyStepDownStore.js";
import type { GitRunner } from "../src/services/diffService.js";
import { systemClock } from "../src/util/clock.js";
import { FAKE_HEAD, giveTicketRealDelivery, nonEmptyDiffRunner } from "./helpers/realDiff.js";

const human: Actor = { type: "human", id: "tom" };
const agent: Actor = { type: "agent", id: "gaffer-factory" };
const agentRunner: Actor = { type: "agent", id: "agent-runner" };

const FLAGS = ["AUTO_MERGE", "MERGE_ON_AGENT_REVIEW", "DISPATCH_ALLOW_AGENT_APPROVE"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const f of FLAGS) {
    saved[f] = process.env[f];
    delete process.env[f];
  }
});
const roots: string[] = [];
const open: Dispatch[] = [];
afterEach(() => {
  for (const wg of open.splice(0)) wg.db.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  for (const f of FLAGS) {
    if (saved[f] === undefined) delete process.env[f];
    else process.env[f] = saved[f];
  }
});

type Lane = "ready_for_merge" | "in_testing";

/**
 * A factory on disk (connection A, whose Git reads can be interrupted) and a second
 * trusted connection B to the same file with the same key.
 */
function world(lane: Lane) {
  const root = mkdtempSync(join(tmpdir(), "r20-approve-race-"));
  roots.push(root);
  const data = join(root, "data");
  mkdirSync(data, { recursive: true });
  const dbPath = join(data, "dispatch.sqlite");
  const keysDir = join(root, "keys");
  const git = { calls: 0, fireAt: 0, write: () => {}, fired: false };
  const runner: GitRunner = (cwd, args, opts) => {
    const out =
      args[0] === "merge-base" && args[1] === "--is-ancestor"
        ? { status: 1, stdout: "", stderr: "" }
        : nonEmptyDiffRunner(cwd, args, opts);
    git.calls += 1;
    if (git.fireAt > 0 && git.calls === git.fireAt && !git.fired) {
      git.fired = true;
      git.write();
    }
    return out;
  };
  const opts = (testing: boolean) => ({
    gateKeyring: fileGateKeyring({ dbPath, keysDir }),
    testingEnabled: testing,
  });
  const a = Dispatch.open(dbPath, systemClock, runner, opts(lane === "in_testing"));
  open.push(a);
  const b = Dispatch.open(dbPath, systemClock, nonEmptyDiffRunner, opts(lane === "in_testing"));
  open.push(b);
  return { a, b, git };
}

/** A real delivery in review on repoA at `risk`, with the approve gate automatic. */
function delivered(wg: Dispatch, lane: Lane, risk: RiskLevel = "low") {
  const t = wg.createTicket(
    { title: "Ship", description: "x", policy_pack: "team_light", risk_level: risk },
    human,
  );
  const { ac } = wg.addAcceptanceCriterion({ ticket_id: t.id, text: "ok" }, human);
  const { repoId } = giveTicketRealDelivery(wg, t.id, human, { repoName: "repoA" });
  if (lane === "in_testing") wg.setTestable(t.id, true, human);
  wg.markReady(t.id, human);
  const reg = wg.registerAgent({ display_name: "a", max_risk: "critical" }, human);
  const claim = wg.claimNextTicket({ agentId: reg.id, ttlSeconds: 600 }, agentRunner);
  wg.recordEvidence(
    {
      claimToken: claim!.claimToken,
      ticket_id: t.id,
      ac_id: ac.id,
      evidence_type: "test_output",
      summary: "passed",
    },
    agentRunner,
  );
  wg.submitForReview({ claimToken: claim!.claimToken, ticket_id: t.id, reason: "d" }, agentRunner);
  wg.setAutonomyPolicy(
    { repoId, riskLevel: risk, gate: "approve", mode: "auto", confirm: true },
    human,
  );
  return { id: t.id, repoId };
}

const shown = { commits: [{ repo: "repoA", sha: FAKE_HEAD }] };

function stepDownOn(wg: Dispatch, repoId: string, risk: RiskLevel) {
  writeEvent(wg.db, {
    entity_type: "repository",
    entity_id: repoId,
    actor: human,
    event_type: AUTONOMY_STEPPED_DOWN_EVENT,
    payload: {
      risk_level: risk,
      gate: "approve",
      trigger: "tester_failures",
      why: "two tester FAILs on automatic approvals",
      tickets: [],
      cascade_from: null,
    },
  });
}

function outcome(wg: Dispatch, fn: () => { ticket: { status: string } }) {
  try {
    return { status: fn().ticket.status };
  } catch (err) {
    const e = err as { code?: string; details?: { reason?: string } };
    return { refused: e.code, reason: e.details?.reason };
  }
}

function approvalEvents(wg: Dispatch, id: string): string[] {
  return (
    wg.db
      .prepare(
        `SELECT json_extract(payload_json, '$.reason') AS r FROM work_events
          WHERE entity_type = 'ticket' AND entity_id = ? AND event_type = 'ticket.transitioned'
            AND json_extract(payload_json, '$.reason') IN ('review_approved', 'review_approved_to_testing')`,
      )
      .all(id) as Array<{ r: string }>
  ).map((r) => r.r);
}

/** How many Git calls an agent's approval makes on this lane (measured on a twin world). */
function gitCallsOfApproval(lane: Lane): number {
  const { a, git } = world(lane);
  const { id } = delivered(a, lane);
  const before = git.calls;
  const r = outcome(a, () => a.approveReview(id, agent, shown));
  expect(r).toEqual({ status: lane });
  return git.calls - before;
}

for (const lane of ["ready_for_merge", "in_testing"] as const) {
  describe(`an agent's approval to ${lane} racing a concurrent change`, () => {
    it("without a race, the agent's approval goes through (the fixture is sound)", () => {
      expect(gitCallsOfApproval(lane)).toBeGreaterThan(0);
    });

    it("an approve step-down committed at any point of the Git window refuses it", () => {
      const calls = gitCallsOfApproval(lane);
      const results: unknown[] = [];
      for (let at = 1; at <= calls; at++) {
        const { a, b, git } = world(lane);
        const { id, repoId } = delivered(a, lane);
        git.fireAt = git.calls + at;
        git.write = () => stepDownOn(b, repoId, "low");
        const r = outcome(a, () => a.approveReview(id, agent, shown));
        results.push({
          at,
          fired: git.fired,
          ...r,
          status_now: a.resolveTicket(id).status,
          approvals: approvalEvents(a, id),
        });
      }
      expect(results).toEqual(
        Array.from({ length: calls }, (_, i) => ({
          at: i + 1,
          fired: true,
          refused: "ACTOR_NOT_PERMITTED",
          reason: "autonomy_stepped_down",
          status_now: "in_review",
          approvals: [],
        })),
      );
    });

    it("the approve policy turned off at any point of the Git window refuses it", () => {
      const calls = gitCallsOfApproval(lane);
      const results: unknown[] = [];
      for (let at = 1; at <= calls; at++) {
        const { a, b, git } = world(lane);
        const { id, repoId } = delivered(a, lane);
        git.fireAt = git.calls + at;
        git.write = () =>
          b.setAutonomyPolicy({ repoId, riskLevel: "low", gate: "approve", mode: "off" }, human);
        const r = outcome(a, () => a.approveReview(id, agent, shown));
        results.push({
          at,
          fired: git.fired,
          refused: "refused" in r ? r.refused : r.status,
          status_now: a.resolveTicket(id).status,
          approvals: approvalEvents(a, id),
        });
      }
      expect(results).toEqual(
        Array.from({ length: calls }, (_, i) => ({
          at: i + 1,
          fired: true,
          refused: "ACTOR_NOT_PERMITTED",
          status_now: "in_review",
          approvals: [],
        })),
      );
    });

    it("a person's approval is not held by a step-down committed in the window", () => {
      const { a, b, git } = world(lane);
      const { id, repoId } = delivered(a, lane);
      git.fireAt = git.calls + 1;
      git.write = () => stepDownOn(b, repoId, "low");
      const r = outcome(a, () => a.approveReview(id, human, shown));
      expect(git.fired).toBe(true);
      // Not refused by the hold (a person decides); a tester-gated ticket may still route
      // the untested commit by its own rule, which is no autonomy hold.
      expect(r).not.toMatchObject({ reason: "autonomy_stepped_down" });
    });
  });
}

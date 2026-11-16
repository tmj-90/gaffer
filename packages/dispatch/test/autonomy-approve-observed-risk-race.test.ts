/**
 * THE AUTO-SHIP GATE under a moving branch (independent review of external review 20).
 *
 * An agent's approval reads the delivery's OBSERVED risk from the real diff, then, later
 * and outside any transaction, resolves the heads it pins. When a new commit landed on
 * the delivery branch between the two reads, the risk had been judged on the old diff
 * while the approval pinned (and the agent named) the new head: a high-risk commit was
 * approved as low risk. The approval transactions recheck the holds but not this, since
 * the declared risk is frozen; the observed one is not.
 *
 * Pinned here, for both approval transactions: a risky commit pushed at any point of the
 * approval's Git window, the agent naming it, is never approved (refused as escalated or
 * as a moved branch) and the ticket stays in review.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { fileGateKeyring } from "../src/events/gateSeal.js";
import type { GitRunner } from "../src/services/diffService.js";
import { systemClock } from "../src/util/clock.js";
import {
  FAKE_HEAD,
  giveTicketRealDelivery,
  highRiskDiffRunner,
  nonEmptyDiffRunner,
} from "./helpers/realDiff.js";

const human: Actor = { type: "human", id: "tom" };
const agent: Actor = { type: "agent", id: "gaffer-factory" };
const agentRunner: Actor = { type: "agent", id: "agent-runner" };
const NEW_HEAD = "b".repeat(40);

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

/** A factory whose delivery branch moves to a risky commit after Git call `moveAfter`. */
function world(lane: Lane) {
  const root = mkdtempSync(join(tmpdir(), "r20-observed-race-"));
  roots.push(root);
  const data = join(root, "data");
  mkdirSync(data, { recursive: true });
  const dbPath = join(data, "dispatch.sqlite");
  const git = { calls: 0, moveAfter: Infinity };
  const runner: GitRunner = (cwd, args, opts) => {
    git.calls += 1;
    const moved = git.calls > git.moveAfter;
    if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
      return { status: 1, stdout: "", stderr: "" };
    }
    const out = (moved ? highRiskDiffRunner : nonEmptyDiffRunner)(cwd, args, opts);
    return moved ? { ...out, stdout: out.stdout.split(FAKE_HEAD).join(NEW_HEAD) } : out;
  };
  const wg = Dispatch.open(dbPath, systemClock, runner, {
    gateKeyring: fileGateKeyring({ dbPath, keysDir: join(root, "keys") }),
    testingEnabled: lane === "in_testing",
  });
  open.push(wg);
  return { wg, git };
}

function delivered(wg: Dispatch, lane: Lane) {
  const t = wg.createTicket(
    { title: "Ship", description: "x", policy_pack: "team_light", risk_level: "low" },
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
    { repoId, riskLevel: "low", gate: "approve", mode: "auto", confirm: true },
    human,
  );
  return t.id;
}

function outcome(fn: () => { ticket: { status: string } }) {
  try {
    return { status: fn().ticket.status };
  } catch (err) {
    return { refused: (err as { code?: string }).code };
  }
}

const naming = (sha: string) => ({ commits: [{ repo: "repoA", sha }] });

for (const lane of ["ready_for_merge", "in_testing"] as const) {
  describe(`an agent's approval to ${lane} while a risky commit lands`, () => {
    it("without a move the low-risk delivery is approved; the risky one alone is held", () => {
      const calm = world(lane);
      const id = delivered(calm.wg, lane);
      expect(outcome(() => calm.wg.approveReview(id, agent, naming(FAKE_HEAD)))).toEqual({
        status: lane,
      });
      const risky = world(lane);
      const id2 = delivered(risky.wg, lane);
      risky.git.moveAfter = risky.git.calls;
      expect(outcome(() => risky.wg.approveReview(id2, agent, naming(NEW_HEAD)))).toEqual({
        refused: "OBSERVED_RISK_ESCALATED",
      });
    });

    it("a risky commit pushed at any point of the Git window is never approved", () => {
      const twin = world(lane);
      const twinId = delivered(twin.wg, lane);
      const start = twin.git.calls;
      twin.wg.approveReview(twinId, agent, naming(FAKE_HEAD));
      const calls = twin.git.calls - start;
      expect(calls).toBeGreaterThan(0);
      const results: unknown[] = [];
      for (let at = 0; at <= calls; at++) {
        const { wg, git } = world(lane);
        const id = delivered(wg, lane);
        git.moveAfter = git.calls + at;
        const r = outcome(() => wg.approveReview(id, agent, naming(NEW_HEAD)));
        results.push({ at, approved: "status" in r, status_now: wg.resolveTicket(id).status });
      }
      expect(results).toEqual(
        Array.from({ length: calls + 1 }, (_, at) => ({
          at,
          approved: false,
          status_now: "in_review",
        })),
      );
    });
  });
}

/**
 * AUTONOMY STEP-DOWN, the independent review's cases (backlog 58):
 *
 *  - who approved: the landing check closest to the merge decides "a person's approval" the
 *    way the merge lane does (the review approval on the ticket's current path), so a
 *    person's tester PASS (a waiver) on an AGENT's approval is not a person's approval, and
 *    a step-down recorded while that landing is prepared stops it;
 *  - the trigger and its act commit together: when the step-down cannot be written, the
 *    tester FAIL, the UNPROVABLE hold or the person's reopen that carries it is not kept
 *    either (no evidence on record that the gate does not hold for);
 *  - a step-down read that fails holds every decision point (fail closed);
 *  - the refusal at landing tells the person what lands it.
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
import { autonomyHold } from "../src/services/autonomyPolicyService.js";
import { assertMergeGateNotHeld } from "../src/services/reviewGate/landing.js";
import { systemClock } from "../src/util/clock.js";
import { agentApprover, landedChange, repoNamed, ticketOn } from "./helpers/autonomyLadder.js";
import { FAKE_HEAD, giveTicketRealDelivery, nonEmptyDiffRunner } from "./helpers/realDiff.js";

const human: Actor = { type: "human", id: "tom" };
const admin: Actor = { type: "admin", id: "ops" };
const system: Actor = { type: "system" };
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
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  for (const f of FLAGS) {
    if (saved[f] === undefined) delete process.env[f];
    else process.env[f] = saved[f];
  }
});

function refusal(fn: () => unknown): { code?: string; reason?: string; message?: string } {
  try {
    fn();
  } catch (err) {
    const e = err as { code?: string; details?: { reason?: string }; message?: string };
    return { code: e.code, reason: e.details?.reason, message: e.message };
  }
  throw new Error("expected a refusal, but the call succeeded");
}

function stepDown(wg: Dispatch, repoId: string, risk: RiskLevel, gate: "approve" | "merge") {
  writeEvent(wg.db, {
    entity_type: "repository",
    entity_id: repoId,
    actor: human,
    event_type: AUTONOMY_STEPPED_DOWN_EVENT,
    payload: {
      risk_level: risk,
      gate,
      trigger: "regression",
      why: "a regression",
      tickets: [],
      cascade_from: null,
    },
  });
}

function stepDownCount(wg: Dispatch): number {
  return (
    wg.db
      .prepare(`SELECT COUNT(*) AS n FROM work_events WHERE event_type = ?`)
      .get(AUTONOMY_STEPPED_DOWN_EVENT) as { n: number }
  ).n;
}

/** Make every step-down write fail, as a full disk or a broken chain would. */
function breakStepDownWrites(wg: Dispatch): void {
  wg.db.exec(
    `CREATE TRIGGER r58_no_step_down BEFORE INSERT ON work_events
       WHEN NEW.event_type = '${AUTONOMY_STEPPED_DOWN_EVENT}'
       BEGIN SELECT RAISE(ABORT, 'injected: the step-down cannot be written'); END;`,
  );
}

/** A world on disk with this factory's gate keyring (signed approvals and verdicts). */
function freshWg(): Dispatch {
  const root = mkdtempSync(join(tmpdir(), "r58-step-down-"));
  roots.push(root);
  const data = join(root, "data");
  mkdirSync(data, { recursive: true });
  const dbPath = join(data, "dispatch.sqlite");
  const gateKeyring = fileGateKeyring({ dbPath, keysDir: join(root, "keys") });
  return Dispatch.open(
    dbPath,
    systemClock,
    (cwd, args, o) => {
      if (args[0] === "merge-base" && args[1] === "--is-ancestor")
        return { status: 1, stdout: "", stderr: "" };
      return nonEmptyDiffRunner(cwd, args, o);
    },
    { gateKeyring },
  );
}

/** A real delivery in review on repoA at `risk`. */
function delivered(wg: Dispatch, risk: RiskLevel) {
  const t = wg.createTicket(
    { title: "Ship", description: "x", policy_pack: "team_light", risk_level: risk },
    human,
  );
  const { ac } = wg.addAcceptanceCriterion({ ticket_id: t.id, text: "ok" }, human);
  const { repoId } = giveTicketRealDelivery(wg, t.id, human, { repoName: "repoA" });
  wg.markReady(t.id, human);
  const a = wg.registerAgent({ display_name: "a", max_risk: "critical" }, human);
  const claim = wg.claimNextTicket({ agentId: a.id, ttlSeconds: 600 }, agentRunner);
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
  return { id: t.id, repoId };
}

function enable(wg: Dispatch, repoId: string, risk: RiskLevel, gate: "approve" | "merge") {
  wg.setAutonomyPolicy({ repoId, riskLevel: risk, gate, mode: "auto", confirm: true }, human);
}

describe("who approved: the landing check reads the review approval, as the merge lane does", () => {
  /** An agent's approval to testing, then a person's tester PASS (a waiver) to ready_for_merge. */
  function waivedAgentApproval(wg: Dispatch, repo: string, risk: RiskLevel) {
    const t = ticketOn(wg, repo, risk);
    writeEvent(wg.db, {
      entity_type: "ticket",
      entity_id: t.id,
      actor: agentApprover,
      event_type: "ticket.transitioned",
      payload: { from: "in_review", to: "in_testing", reason: "review_approved_to_testing" },
    });
    const approval = writeEvent(wg.db, {
      entity_type: "ticket",
      entity_id: t.id,
      actor: human,
      event_type: "ticket.transitioned",
      payload: { from: "in_testing", to: "ready_for_merge", reason: "tester_passed" },
    });
    wg.db.prepare(`UPDATE tickets SET status='ready_for_merge' WHERE id=?`).run(t.id);
    return { ticket: wg.resolveTicket(t.id), approval };
  }

  it("a person's tester PASS on an agent's approval is not a person's approval: a step-down stops the landing", () => {
    const wg = Dispatch.open(":memory:");
    try {
      const api = repoNamed(wg, "api");
      const { ticket, approval } = waivedAgentApproval(wg, "api", "low");
      const internals = {
        db: wg.db,
        autonomyHoldFn: (t: typeof ticket, gate: "approve" | "merge") =>
          autonomyHold(wg.autonomyPolicy, [api], t.risk_level, gate),
      };
      // Nothing held yet: the check lets it through.
      expect(() => assertMergeGateNotHeld(internals, ticket, approval)).not.toThrow();
      // The merge lane asked the merge gate (allow) and runs the gate checks; meanwhile:
      stepDown(wg, api, "low", "merge");
      expect(refusal(() => assertMergeGateNotHeld(internals, ticket, approval))).toMatchObject({
        code: "STATE_CONFLICT",
        reason: "autonomy_stepped_down",
      });
    } finally {
      wg.db.close();
    }
  });

  it("a regression of that change steps the merge gate down too (it landed on an agent's approval)", () => {
    const wg = Dispatch.open(":memory:");
    try {
      const api = repoNamed(wg, "api");
      const t = ticketOn(wg, "api", "low");
      writeEvent(wg.db, {
        entity_type: "ticket",
        entity_id: t.id,
        actor: agentApprover,
        event_type: "ticket.transitioned",
        payload: { from: "in_review", to: "in_testing", reason: "review_approved_to_testing" },
      });
      writeEvent(wg.db, {
        entity_type: "ticket",
        entity_id: t.id,
        actor: human,
        event_type: "ticket.transitioned",
        payload: { from: "in_testing", to: "ready_for_merge", reason: "tester_passed" },
      });
      wg.db.prepare(`UPDATE tickets SET status='done' WHERE id=?`).run(t.id);
      writeEvent(wg.db, {
        entity_type: "ticket",
        entity_id: t.id,
        actor: system,
        event_type: "ticket.transitioned",
        payload: { from: "ready_for_merge", to: "done", reason: "merge_completed" },
      });
      const defect = ticketOn(wg, "api", "low", "Broken");
      const res = wg.fileRegression(defect.id, t.id, human);
      expect(res.stepped_down.map((r) => `${r.riskLevel}/${r.gate}`)).toContain("low/merge");
      expect(api).toBeTruthy();
    } finally {
      wg.db.close();
    }
  });

  it("the person's own approval still lands, and the refusal before it says how", () => {
    const wg = freshWg();
    try {
      const { id, repoId } = delivered(wg, "low");
      enable(wg, repoId, "low", "approve");
      enable(wg, repoId, "low", "merge");
      expect(wg.approveReview(id, agent).ticket.status).toBe("ready_for_merge");
      stepDown(wg, repoId, "low", "merge");
      const r = refusal(() =>
        wg.beginLanding(
          id,
          {
            repo: "repoA",
            commit: FAKE_HEAD,
            approval: wg.landingApproval(id)!,
            via: "local",
          },
          system,
        ),
      );
      expect(r.reason).toBe("autonomy_stepped_down");
      // It names what lands it: a person's own approval, or lifting the step-down.
      expect(r.message).toMatch(/reopen-for-review/);
      expect(r.message).toMatch(/approve/i);
      expect(r.message).toMatch(/autonomy lift/);
      // The person does exactly that, and the landing goes through.
      wg.reopenForReview(id, { reason: "a person approves it", resolution: "re-review" }, admin);
      expect(wg.approveReview(id, human).ticket.status).toBe("ready_for_merge");
      expect(
        wg.beginLanding(
          id,
          { repo: "repoA", commit: FAKE_HEAD, approval: wg.landingApproval(id)!, via: "local" },
          system,
        ).commit,
      ).toBe(FAKE_HEAD);
    } finally {
      wg.db.close();
    }
  });
});

describe("the trigger and its act commit together", () => {
  function autoApprovedInTesting(wg: Dispatch, repo: string, risk: RiskLevel) {
    const t = ticketOn(wg, repo, risk);
    writeEvent(wg.db, {
      entity_type: "ticket",
      entity_id: t.id,
      actor: agentApprover,
      event_type: "ticket.transitioned",
      payload: { from: "in_review", to: "in_testing", reason: "review_approved_to_testing" },
    });
    wg.db.prepare(`UPDATE tickets SET status='in_testing' WHERE id=?`).run(t.id);
    return t;
  }
  const tester: Actor = { type: "agent", id: "tester" };

  it("trigger (c), tester FAIL: a step-down that cannot be written keeps no FAIL either; the retry steps down", () => {
    const wg = Dispatch.open(":memory:");
    try {
      const api = repoNamed(wg, "api");
      process.env.DISPATCH_ALLOW_AGENT_APPROVE = "1";
      const a = autoApprovedInTesting(wg, "api", "low");
      wg.testerFail(a.id, { summary: "first strike" }, tester);
      const b = autoApprovedInTesting(wg, "api", "low");
      breakStepDownWrites(wg);
      expect(() => wg.testerFail(b.id, { summary: "second strike" }, tester)).toThrow(/injected/);
      // Not kept: the ticket is still in testing and no FAIL is on record for it.
      expect(wg.resolveTicket(b.id).status).toBe("in_testing");
      expect(wg.view(b.id).events.some((e) => e.event_type === "ticket.tester_failed")).toBe(false);
      wg.db.exec("DROP TRIGGER r58_no_step_down");
      wg.testerFail(b.id, { summary: "second strike" }, tester);
      expect(stepDownCount(wg)).toBe(1);
      expect(wg.autonomyGateDecision(wg.resolveTicket(b.id), "approve").decision).toBe("deny");
      expect(api).toBeTruthy();
    } finally {
      wg.db.close();
    }
  });

  it("trigger (c), UNPROVABLE hold: the same", () => {
    const wg = Dispatch.open(":memory:");
    try {
      repoNamed(wg, "api");
      const held = (id: string) =>
        wg.recordLaneVerdict(
          id,
          { lane: "tester", verdict: "held", held_code: "tester_unprovable", held_reason: "x" },
          system,
        );
      held(autoApprovedInTesting(wg, "api", "medium").id);
      const b = autoApprovedInTesting(wg, "api", "medium");
      breakStepDownWrites(wg);
      expect(() => held(b.id)).toThrow(/injected/);
      expect(wg.view(b.id).events.some((e) => e.event_type === "ticket.lane_verdict")).toBe(false);
      wg.db.exec("DROP TRIGGER r58_no_step_down");
      held(b.id);
      expect(stepDownCount(wg)).toBe(1);
    } finally {
      wg.db.close();
    }
  });

  it("trigger (b), a person's reopen: a step-down that cannot be written keeps the ticket done", () => {
    const wg = Dispatch.open(":memory:");
    try {
      repoNamed(wg, "api");
      const change = landedChange(wg, "api", "medium");
      breakStepDownWrites(wg);
      expect(() =>
        wg.reopenForReview(
          change.id,
          { reason: "not what we wanted", resolution: "redo", cause: "other" },
          admin,
        ),
      ).toThrow(/injected/);
      expect(wg.resolveTicket(change.id).status).toBe("done");
      wg.db.exec("DROP TRIGGER r58_no_step_down");
      const r = wg.reopenForReview(
        change.id,
        { reason: "not what we wanted", resolution: "redo", cause: "other" },
        admin,
      );
      expect(r.status).toBe("in_review");
      expect(r.stepped_down.length).toBeGreaterThan(0);
    } finally {
      wg.db.close();
    }
  });

  it("a stale tester FAIL is still refused with its evidence kept (the wrap does not roll it back)", () => {
    const wg = Dispatch.open(":memory:");
    try {
      repoNamed(wg, "api");
      const t = autoApprovedInTesting(wg, "api", "low");
      const before = (
        wg.db.prepare(`SELECT COUNT(*) AS n FROM evidence WHERE ticket_id = ?`).get(t.id) as {
          n: number;
        }
      ).n;
      expect(
        refusal(() => wg.testerFail(t.id, { summary: "late", round: "old-round" }, tester)).code,
      ).toBeTruthy();
      const after = (
        wg.db.prepare(`SELECT COUNT(*) AS n FROM evidence WHERE ticket_id = ?`).get(t.id) as {
          n: number;
        }
      ).n;
      expect(after).toBe(before + 1);
    } finally {
      wg.db.close();
    }
  });
});

describe("a step-down read that fails holds every decision point", () => {
  it("the gate decision, an agent's approve and a landing on an agent's approval", () => {
    const wg = freshWg();
    try {
      const { id, repoId } = delivered(wg, "low");
      enable(wg, repoId, "low", "approve");
      enable(wg, repoId, "low", "merge");
      process.env.AUTO_MERGE = "1";
      process.env.MERGE_ON_AGENT_REVIEW = "1";
      expect(wg.approveReview(id, agent).ticket.status).toBe("ready_for_merge");
      const approval = wg.landingApproval(id)!;
      wg.autonomyPolicy.stepDownInForce = () => {
        throw new Error("database is locked");
      };
      expect(wg.autonomyGateDecision(wg.resolveTicket(id), "merge")).toMatchObject({
        decision: "deny",
        held: { kind: "stepped_down" },
      });
      expect(
        refusal(() =>
          wg.beginLanding(id, { repo: "repoA", commit: FAKE_HEAD, approval, via: "local" }, system),
        ),
      ).toMatchObject({ code: "STATE_CONFLICT", reason: "autonomy_stepped_down" });
    } finally {
      wg.db.close();
    }
  });
});

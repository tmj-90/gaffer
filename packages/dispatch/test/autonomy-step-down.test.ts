/**
 * AUTONOMY STEP-DOWN: when the evidence turns bad for a repo x risk x gate that worked
 * automatically, autonomy is taken back automatically and visibly; giving it back is a
 * person's act.
 *
 *  - triggers: (a) a regression linked to an automatic change; (b) a person reopening an
 *    automatically landed change; (c) N tester FAILs / UNPROVABLE holds on automatically
 *    approved changes (N = GAFFER_AUTONOMY_STEPDOWN_FAILS, default 2);
 *  - effect: an `autonomy.stepped_down` event per row; the gate holds the row for a person
 *    (the policy row stays, the env floor does not reach past it); the suggestion's count
 *    restarts; a merge step-down cascades to every higher risk;
 *  - lift: a person only (shared token or a human/admin principal with full capability),
 *    never an agent, the runner or MCP; re-enable after the bar is cleared again, or an
 *    override with a reason;
 *  - the in-flight race: a step-down recorded while a landing is prepared stops it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setPrincipalResolver } from "../src/api/auth.js";
import { createApiServer } from "../src/api/server.js";
import { Dispatch } from "../src/core.js";
import type { Actor, RiskLevel } from "../src/domain/types.js";
import { writeEvent } from "../src/events/eventWriter.js";
import { makeHandlers } from "../src/mcp/tools.js";
import { isAutonomyAllowed } from "../src/services/autonomyPolicyService.js";
import { AUTONOMY_STEPPED_DOWN_EVENT } from "../src/services/autonomyStepDownStore.js";
import { systemClock } from "../src/util/clock.js";
import { CLI_BUILT, oneLineError, runBin } from "./helpers/cliBin.js";
import {
  agentApprover,
  decisions,
  humanActor as human,
  landedChange,
  repoNamed,
  ticketOn,
} from "./helpers/autonomyLadder.js";
import { principalFor } from "./helpers/principal.js";
import { FAKE_HEAD, giveTicketRealDelivery, nonEmptyDiffRunner } from "./helpers/realDiff.js";

const admin: Actor = { type: "admin", id: "ops" };
const system: Actor = { type: "system" };
const agent: Actor = { type: "agent", id: "gaffer-factory" };
const FLAGS = [
  "AUTO_MERGE",
  "MERGE_ON_AGENT_REVIEW",
  "DISPATCH_ALLOW_AGENT_APPROVE",
  "GAFFER_AUTONOMY_STEPDOWN_FAILS",
];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const f of FLAGS) {
    saved[f] = process.env[f];
    delete process.env[f];
  }
});
afterEach(() => {
  for (const f of FLAGS) {
    if (saved[f] === undefined) delete process.env[f];
    else process.env[f] = saved[f];
  }
});

function stepDowns(wg: Dispatch, repoId: string) {
  return (
    wg.db
      .prepare(
        `SELECT actor_type, actor_id, payload_json FROM work_events
          WHERE entity_type = 'repository' AND entity_id = ? AND event_type = ? ORDER BY rowid`,
      )
      .all(repoId, AUTONOMY_STEPPED_DOWN_EVENT) as Array<{
      actor_type: string;
      actor_id: string | null;
      payload_json: string;
    }>
  ).map((r) => ({
    by: `${r.actor_type}:${r.actor_id ?? ""}`,
    ...(JSON.parse(r.payload_json) as {
      risk_level: string;
      gate: string;
      trigger: string;
      why: string;
      tickets: Array<{ id: string; number: number | null }>;
      cascade_from: string | null;
    }),
  }));
}

function rows(wg: Dispatch, repoId: string): string[] {
  return stepDowns(wg, repoId).map((s) => `${s.risk_level}/${s.gate}/${s.trigger}`);
}

function allowed(wg: Dispatch, repoId: string, risk: RiskLevel, gate: "approve" | "merge") {
  return isAutonomyAllowed(wg.autonomyPolicy, [repoId], risk, gate);
}

function enable(wg: Dispatch, repoId: string, risk: RiskLevel, gate: "approve" | "merge") {
  wg.setAutonomyPolicy({ repoId, riskLevel: risk, gate, mode: "auto", confirm: true }, human);
}

function refusal(fn: () => unknown): { code?: string; reason?: string; message?: string } {
  try {
    fn();
  } catch (err) {
    const e = err as { code?: string; details?: { reason?: string }; message?: string };
    return { code: e.code, reason: e.details?.reason, message: e.message };
  }
  throw new Error("expected a refusal, but the call succeeded");
}

describe("trigger (a): a regression of an automatic change", () => {
  let wg: Dispatch;
  beforeEach(() => {
    wg = Dispatch.open(":memory:");
  });
  afterEach(() => wg.db.close());

  it("steps down approve and merge at that repo/risk, cascades merge upward, and the gate holds", () => {
    const api = repoNamed(wg, "api");
    enable(wg, api, "low", "merge");
    enable(wg, api, "low", "approve");
    enable(wg, api, "high", "merge");
    const change = landedChange(wg, "api", "low");
    expect(allowed(wg, api, "low", "merge")).toBe(true);
    const defect = ticketOn(wg, "api", "low", "Export crashes");
    const res = wg.fileRegression(defect.id, String(change.number), human, "crashes");
    expect(res.recorded).toBe(true);
    expect(res.stepped_down.map((r) => `${r.riskLevel}/${r.gate}/${r.trigger}`)).toEqual([
      "low/approve/regression",
      "low/merge/regression",
      "medium/merge/cascade",
      "high/merge/cascade",
      "critical/merge/cascade",
    ]);
    const first = stepDowns(wg, api)[0]!;
    expect(first.by).toBe("human:tom");
    expect(first.tickets.map((t) => t.number)).toEqual([defect.number, change.number]);
    expect(first.why).toContain(`#${defect.number} was linked by human:tom as a regression of #${change.number}`);
    expect(stepDowns(wg, api)[2]!.cascade_from).toBe("low");
    // The gate: a person decides, even with the policy rows still on.
    expect(allowed(wg, api, "low", "merge")).toBe(false);
    expect(allowed(wg, api, "low", "approve")).toBe(false);
    expect(allowed(wg, api, "high", "merge")).toBe(false);
    expect(wg.autonomyPolicy.get(api, "low", "merge")?.mode).toBe("auto"); // suspended, not deleted
    // The env floor does not reach past a step-down either.
    process.env.AUTO_MERGE = "1";
    process.env.MERGE_ON_AGENT_REVIEW = "1";
    expect(allowed(wg, api, "low", "merge")).toBe(false);
    expect(allowed(wg, api, "medium", "approve")).toBe(true); // not stepped down
    // The ladder shows it with its reason and what lifts it.
    const cell = wg.autonomyLadder().repos[0]!.rows[0]!.gates.merge;
    expect(cell.rung).toBe("person");
    expect(cell.step_down?.trigger).toBe("regression");
    expect(cell.step_down?.lift.text).toMatch(/re-enables it once the evidence/);
    expect(wg.autonomyLadder().recent_step_downs.length).toBe(5);
  });

  it("a change a person approved is not a reason to step down; nor is filing the same link twice", () => {
    const api = repoNamed(wg, "api");
    const change = landedChange(wg, "api", "low", human);
    const defect = ticketOn(wg, "api", "low");
    expect(wg.fileRegression(defect.id, change.id, human).stepped_down).toEqual([]);
    expect(rows(wg, api)).toEqual([]);
    const auto = landedChange(wg, "api", "medium");
    const d2 = ticketOn(wg, "api", "medium");
    expect(wg.fileRegression(d2.id, auto.id, human).stepped_down.length).toBeGreaterThan(0);
    expect(wg.fileRegression(d2.id, auto.id, admin).stepped_down).toEqual([]);
  });

  it("an automatically approved change that a person merged steps down approve (and merge: fail closed)", () => {
    const api = repoNamed(wg, "api");
    // An agent approval that never landed: only the approve gate was automatic.
    const t = ticketOn(wg, "api", "low");
    writeEvent(wg.db, {
      entity_type: "ticket",
      entity_id: t.id,
      actor: agentApprover,
      event_type: "ticket.transitioned",
      payload: { from: "in_review", to: "in_testing", reason: "review_approved_to_testing" },
    });
    wg.db.prepare(`UPDATE tickets SET status='done' WHERE id=?`).run(t.id);
    const d = ticketOn(wg, "api", "low");
    wg.fileRegression(d.id, t.id, human);
    expect(rows(wg, api)).toEqual(["low/approve/regression"]);
  });
});

describe("trigger (b): a person reopens an automatically landed change", () => {
  it("steps down when a person reopens it; the runner's own reopen does not", () => {
    const wg = Dispatch.open(":memory:");
    const api = repoNamed(wg, "api");
    const byRunner = landedChange(wg, "api", "medium");
    const r0 = wg.reopenForReview(
      byRunner.id,
      { reason: "conflict", resolution: "resolved", cause: "merge_conflict" },
      system,
    );
    expect(r0.stepped_down).toEqual([]);
    const change = landedChange(wg, "api", "medium");
    const r = wg.reopenForReview(
      change.id,
      { reason: "not what we wanted", resolution: "redo the export", cause: "other" },
      admin,
    );
    expect(r.status).toBe("in_review");
    expect(rows(wg, api)).toEqual([
      "medium/approve/reopened",
      "medium/merge/reopened",
      "high/merge/cascade",
      "critical/merge/cascade",
    ]);
    expect(stepDowns(wg, api)[0]!.why).toContain("reopened for review by admin:ops");
    wg.db.close();
  });
});

describe("trigger (c): tester FAILs and UNPROVABLE holds on automatic approvals", () => {
  function autoApprovedInTesting(wg: Dispatch, repo: string, risk: RiskLevel, approver = agentApprover) {
    const t = ticketOn(wg, repo, risk);
    writeEvent(wg.db, {
      entity_type: "ticket",
      entity_id: t.id,
      actor: approver,
      event_type: "ticket.transitioned",
      payload: { from: "in_review", to: "in_testing", reason: "review_approved_to_testing" },
    });
    wg.db.prepare(`UPDATE tickets SET status='in_testing' WHERE id=?`).run(t.id);
    return t;
  }
  const unprovable = (wg: Dispatch, id: string) =>
    wg.recordLaneVerdict(
      id,
      { lane: "tester", verdict: "held", held_code: "tester_unprovable", held_reason: "no display" },
      system,
    );

  it("the second strike on automatic approvals steps the approve gate down (not merge)", () => {
    const wg = Dispatch.open(":memory:");
    const api = repoNamed(wg, "api");
    // A strike on a change a person approved does not count.
    unprovable(wg, autoApprovedInTesting(wg, "api", "low", human).id);
    const a = autoApprovedInTesting(wg, "api", "low");
    wg.testerFail(a.id, { summary: "export fails on empty list" }, { type: "agent", id: "tester" });
    expect(rows(wg, api)).toEqual([]);
    const b = autoApprovedInTesting(wg, "api", "low");
    unprovable(wg, b.id);
    expect(rows(wg, api)).toEqual(["low/approve/tester_failures"]);
    const sd = stepDowns(wg, api)[0]!;
    expect(sd.by).toBe("system:");
    expect(sd.tickets.map((t) => t.number)).toEqual([a.number, b.number]);
    expect(sd.why).toContain("2 tester FAILs or unprovable holds");
    // Another repo and another risk are untouched.
    expect(allowed(wg, api, "medium", "approve")).toBe(false); // nothing grants it either
    process.env.DISPATCH_ALLOW_AGENT_APPROVE = "1";
    expect(allowed(wg, api, "medium", "approve")).toBe(true);
    expect(allowed(wg, api, "low", "approve")).toBe(false);
    wg.db.close();
  });

  it("the knob: GAFFER_AUTONOMY_STEPDOWN_FAILS=3 needs a third", () => {
    process.env.GAFFER_AUTONOMY_STEPDOWN_FAILS = "3";
    const wg = Dispatch.open(":memory:");
    const api = repoNamed(wg, "api");
    for (let i = 0; i < 2; i += 1) unprovable(wg, autoApprovedInTesting(wg, "api", "high").id);
    expect(rows(wg, api)).toEqual([]);
    unprovable(wg, autoApprovedInTesting(wg, "api", "high").id);
    expect(rows(wg, api)).toEqual(["high/approve/tester_failures"]);
    wg.db.close();
  });
});

describe("the count restarts at the step-down", () => {
  it("evidence before the step-down no longer counts toward the suggestion", () => {
    const wg = Dispatch.open(":memory:");
    const api = repoNamed(wg, "api");
    decisions(wg, "api", "low", 10);
    const recs = () =>
      wg.autonomyRecommendationsList().filter((r) => r.repoId === api && r.riskLevel === "low");
    expect(recs().map((r) => r.gate).sort()).toEqual(["approve", "merge"]);
    const change = landedChange(wg, "api", "low");
    wg.fileRegression(ticketOn(wg, "api", "low").id, change.id, human);
    expect(recs()).toEqual([]);
    const ladder = () => wg.autonomyLadder().repos[0]!.rows[0]!.gates;
    expect(ladder().approve.evidence.n).toBe(0);
    expect(ladder().approve.evidence.since).toBeTruthy();
    expect(ladder().approve.distance.text).toBe("Stepped down: 0 of 10 decisions: 10 more to re-enable.");
    decisions(wg, "api", "low", 10);
    expect(recs().map((r) => r.gate).sort()).toEqual(["approve", "merge"]);
    expect(ladder().approve.step_down?.lift.reenable_ready).toBe(true);
    wg.db.close();
  });
});

describe("lifting is a person's act", () => {
  let wg: Dispatch;
  let api: string;
  beforeEach(() => {
    wg = Dispatch.open(":memory:");
    api = repoNamed(wg, "api");
    enable(wg, api, "low", "merge");
    wg.fileRegression(ticketOn(wg, "api", "low").id, landedChange(wg, "api", "low").id, human);
  });
  afterEach(() => wg.db.close());

  const lift = (actor: Actor, authority: Parameters<Dispatch["liftAutonomyStepDown"]>[2], how: "reenable" | "override" = "override", gate: "approve" | "merge" = "merge", risk: RiskLevel = "low") =>
    wg.liftAutonomyStepDown(
      { repo: "api", riskLevel: risk, gate, how, reason: how === "override" ? "the regression was in a dependency" : null },
      actor,
      authority,
    );

  it("an agent, the runner, the tokenless CLI and a read-only principal are refused", () => {
    expect(refusal(() => lift(agent, { sharedOperator: true }))).toMatchObject({
      code: "ACTOR_NOT_PERMITTED",
      reason: "person_required",
    });
    expect(refusal(() => lift(system, { sharedOperator: true })).code).toBe("ACTOR_NOT_PERMITTED");
    expect(refusal(() => lift(human, {})).code).toBe("ACTOR_NOT_PERMITTED");
    const { principal } = wg.createPrincipal(
      { name: "reader", capability: "read", actorType: "human", actorId: "rae" },
      human,
    );
    expect(
      refusal(() => lift({ type: "human", id: "rae" }, { principal })).message,
    ).toMatch(/read-only/);
    const { principal: bot } = wg.createPrincipal(
      { name: "bot", actorType: "agent", actorId: "bot" },
      human,
    );
    expect(refusal(() => lift({ type: "agent", id: "bot" }, { principal: bot })).code).toBe(
      "ACTOR_NOT_PERMITTED",
    );
    expect(allowed(wg, api, "low", "merge")).toBe(false);
  });

  it("re-enable waits for the bar; override needs a reason; both are events and the gate opens again", () => {
    expect(refusal(() => lift(human, { sharedOperator: true }, "reenable"))).toMatchObject({
      code: "STATE_CONFLICT",
      reason: "evidence_short",
    });
    expect(
      refusal(() =>
        wg.liftAutonomyStepDown(
          { repo: "api", riskLevel: "low", gate: "merge", how: "override", reason: " " },
          human,
          { sharedOperator: true },
        ),
      ).code,
    ).toBe("VALIDATION_ERROR");
    // Medium merge is stepped down by the cascade: it cannot go first.
    expect(
      refusal(() => lift(human, { sharedOperator: true }, "override", "merge", "medium")),
    ).toMatchObject({ reason: "lower_risk_stepped_down" });
    const p = principalFor(wg, human);
    const done = lift(human, { principal: p.principal }, "override");
    expect(done.how).toBe("override");
    expect(allowed(wg, api, "low", "merge")).toBe(true);
    const ev = wg.db
      .prepare(`SELECT actor_type, payload_json FROM work_events WHERE id = ?`)
      .get(done.eventId) as { actor_type: string; payload_json: string };
    expect(ev.actor_type).toBe("human");
    expect(JSON.parse(ev.payload_json)).toMatchObject({
      how: "override",
      gate: "merge",
      risk_level: "low",
      reason: "the regression was in a dependency",
    });
    expect(refusal(() => lift(human, { sharedOperator: true })).reason).toBe("not_stepped_down");
    // Re-enable after the evidence since the step-down clears the bar.
    decisions(wg, "api", "low", 10);
    expect(lift(human, { sharedOperator: true }, "reenable", "approve").how).toBe("reenabled");
  });

  it("MCP has no tool that lifts a step-down", () => {
    const names = Object.keys(makeHandlers(wg, agent));
    expect(names.length).toBeGreaterThan(5);
    expect(names.filter((n) => /lift|autonomy|step/i.test(n))).toEqual([]);
  });
});

describe("REST and CLI lift", () => {
  const FULL = "shared-full-token-for-step-down-tests-0123456789abcdef";
  const savedToken = process.env.DISPATCH_API_TOKEN;
  afterEach(() => {
    setPrincipalResolver(null);
    if (savedToken === undefined) delete process.env.DISPATCH_API_TOKEN;
    else process.env.DISPATCH_API_TOKEN = savedToken;
  });

  it("POST /api/autonomy/lift: an agent principal is refused, the shared token lifts", async () => {
    process.env.DISPATCH_AUDIT_OFF = "1";
    process.env.DISPATCH_API_TOKEN = FULL;
    const wg = Dispatch.open(":memory:");
    const api = repoNamed(wg, "api");
    wg.fileRegression(ticketOn(wg, "api", "low").id, landedChange(wg, "api", "low").id, human);
    const { token: botToken } = wg.createPrincipal(
      { name: "factory-bot", actorType: "agent", actorId: "gaffer-factory" },
      human,
    );
    const server = createApiServer(wg);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = async (tok: string, body: unknown) => {
      const res = await fetch(`${base}/api/autonomy/lift`, {
        method: "POST",
        headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
    try {
      const body = { repo_id: api, risk_level: "low", gate: "approve", how: "override", reason: "known flake" };
      const bot = await post(botToken, body);
      expect(bot.status).toBe(403);
      expect(bot.body.error.code).toBe("ACTOR_NOT_PERMITTED");
      const ok = await post(FULL, body);
      expect(ok.status).toBe(200);
      expect(ok.body.lifted.how).toBe("override");
      expect(isAutonomyAllowed(wg.autonomyPolicy, [api], "low", "approve")).toBe(false); // nothing grants it
      expect(wg.autonomyPolicy.stepDownInForce(api, "low", "approve")).toBe(false);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      wg.db.close();
    }
  });

  it.skipIf(!CLI_BUILT)("wg autonomy lift: the tokenless CLI is refused, a person's principal token lifts", () => {
    const dir = mkdtempSync(join(tmpdir(), "step-down-cli-"));
    try {
      const db = join(dir, "d.db");
      const wg = Dispatch.open(db);
      const api = repoNamed(wg, "api");
      wg.fileRegression(ticketOn(wg, "api", "low").id, landedChange(wg, "api", "low").id, human);
      const { token } = wg.createPrincipal({ name: "tom", actorType: "human", actorId: "tom" }, human);
      wg.db.close();
      const args = ["autonomy", "lift", "api", "--risk", "low", "--gate", "merge", "--override", "--reason", "flaky dependency"];
      const bare = runBin(db, args, { env: { GAFFER_PRINCIPAL_TOKEN: undefined } });
      expect(bare.status).not.toBe(0);
      expect(oneLineError(bare.stderr).code).toBe("ACTOR_NOT_PERMITTED");
      const asAgent = runBin(db, [...args, "--as", "agent"], { env: { GAFFER_PRINCIPAL_TOKEN: undefined } });
      expect(asAgent.status).not.toBe(0);
      const ok = runBin(db, args, { env: { GAFFER_PRINCIPAL_TOKEN: token } });
      expect(ok.status).toBe(0);
      expect(JSON.parse(ok.stdout)).toMatchObject({ ok: true, how: "override" });
      const wg2 = Dispatch.open(db);
      expect(wg2.autonomyPolicy.stepDownInForce(api, "low", "merge")).toBe(false);
      wg2.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the gate on the live path", () => {
  const agentActor: Actor = { type: "agent", id: "agent-runner" };
  let onDefault = false;
  function delivered(wg: Dispatch, risk: RiskLevel) {
    const t = wg.createTicket(
      { title: "Ship", description: "x", policy_pack: "team_light", risk_level: risk },
      human,
    );
    const { ac } = wg.addAcceptanceCriterion({ ticket_id: t.id, text: "ok" }, human);
    const { repoId } = giveTicketRealDelivery(wg, t.id, human, { repoName: "repoA" });
    wg.markReady(t.id, human);
    const a = wg.registerAgent({ display_name: "a", max_risk: "critical" }, human);
    const claim = wg.claimNextTicket({ agentId: a.id, ttlSeconds: 600 }, agentActor);
    wg.recordEvidence(
      { claimToken: claim!.claimToken, ticket_id: t.id, ac_id: ac.id, evidence_type: "test_output", summary: "passed" },
      agentActor,
    );
    wg.submitForReview({ claimToken: claim!.claimToken, ticket_id: t.id, reason: "d" }, agentActor);
    return { id: t.id, repoId };
  }
  function freshWg(): Dispatch {
    onDefault = false;
    return Dispatch.open(":memory:", systemClock, (cwd, args, opts) => {
      if (args[0] === "merge-base" && args[1] === "--is-ancestor")
        return { status: onDefault ? 0 : 1, stdout: "", stderr: "" };
      return nonEmptyDiffRunner(cwd, args, opts);
    });
  }

  it("an agent's approve is held while the approve gate is stepped down, even with the env flag on", () => {
    const wg = freshWg();
    process.env.DISPATCH_ALLOW_AGENT_APPROVE = "1";
    const { id, repoId } = delivered(wg, "low");
    writeEvent(wg.db, {
      entity_type: "repository",
      entity_id: repoId,
      actor: system,
      event_type: AUTONOMY_STEPPED_DOWN_EVENT,
      payload: { risk_level: "low", gate: "approve", trigger: "tester_failures", why: "two strikes", tickets: [], cascade_from: null },
    });
    expect(refusal(() => wg.approveReview(id, agent))).toMatchObject({
      code: "ACTOR_NOT_PERMITTED",
      reason: "autonomy_stepped_down",
    });
    expect(wg.autonomyGateDecision(wg.resolveTicket(id), "approve")).toMatchObject({
      decision: "deny",
      held: { kind: "stepped_down", repo_id: repoId },
    });
    // A person still approves.
    expect(wg.approveReview(id, human).ticket.status).toBe("ready_for_merge");
    wg.db.close();
  });

  it("the in-flight race: a step-down recorded after an agent's approval stops the landing", () => {
    const wg = freshWg();
    const { id, repoId } = delivered(wg, "low");
    enable(wg, repoId, "low", "approve");
    enable(wg, repoId, "low", "merge");
    expect(wg.approveReview(id, agent).ticket.status).toBe("ready_for_merge");
    const approval = wg.landingApproval(id)!;
    expect(wg.autonomyGateDecision(wg.resolveTicket(id), "merge").decision).toBe("allow");
    // ... the runner asked the merge gate and is running the merge gate's checks; meanwhile:
    writeEvent(wg.db, {
      entity_type: "repository",
      entity_id: repoId,
      actor: human,
      event_type: AUTONOMY_STEPPED_DOWN_EVENT,
      payload: { risk_level: "low", gate: "merge", trigger: "regression", why: "a regression", tickets: [], cascade_from: null },
    });
    expect(
      refusal(() => wg.beginLanding(id, { repo: "repoA", commit: FAKE_HEAD, approval, via: "local" }, system)),
    ).toMatchObject({ code: "STATE_CONFLICT", reason: "autonomy_stepped_down" });
    expect(wg.view(id).events.some((e) => e.event_type === "ticket.landing_started")).toBe(false);
    wg.db.close();
  });

  it("a person's approval still lands while the merge gate is stepped down", () => {
    const wg = freshWg();
    const { id, repoId } = delivered(wg, "low");
    writeEvent(wg.db, {
      entity_type: "repository",
      entity_id: repoId,
      actor: human,
      event_type: AUTONOMY_STEPPED_DOWN_EVENT,
      payload: { risk_level: "low", gate: "merge", trigger: "regression", why: "a regression", tickets: [], cascade_from: null },
    });
    expect(wg.approveReview(id, human).ticket.status).toBe("ready_for_merge");
    const approval = wg.landingApproval(id)!;
    expect(
      wg.beginLanding(id, { repo: "repoA", commit: FAKE_HEAD, approval, via: "local" }, system).commit,
    ).toBe(FAKE_HEAD);
    wg.db.close();
  });
});

/**
 * THE CEILING (backlog 58, product rule): risk=critical is never automatic, at either gate.
 *  - enabling such a policy is refused (service and REST) with one clear sentence; turning
 *    one off stays allowed;
 *  - a row that already exists is ignored at decision time: a person decides, whatever the
 *    row or the mode's env floor says (the gate decision, an agent's approve, a landing on
 *    an agent's approval);
 *  - nothing is suggested at critical, and HIGH needs the full evidence bar: the cross-repo
 *    prior never counts there (low and medium may use it).
 */
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApiServer } from "../src/api/server.js";
import { Dispatch } from "../src/core.js";
import type { Actor, RiskLevel } from "../src/domain/types.js";
import { writeEvent } from "../src/events/eventWriter.js";
import { newId } from "../src/util/id.js";
import { CEILING_MESSAGE, isAutonomyAllowed } from "../src/services/autonomyPolicyService.js";
import { computeRecommendations } from "../src/services/autonomyRecommendationService.js";
import type { ReviewDecisionRow } from "../src/repositories/eventRepository.js";
import { systemClock } from "../src/util/clock.js";
import { decisions, humanActor as human, repoNamed } from "./helpers/autonomyLadder.js";
import { FAKE_HEAD, giveTicketRealDelivery, nonEmptyDiffRunner } from "./helpers/realDiff.js";

const agent: Actor = { type: "agent", id: "gaffer-factory" };
const system: Actor = { type: "system" };
const FLAGS = ["AUTO_MERGE", "MERGE_ON_AGENT_REVIEW", "DISPATCH_ALLOW_AGENT_APPROVE"];
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

function refusal(fn: () => unknown): { code?: string; reason?: string; message?: string } {
  try {
    fn();
  } catch (err) {
    const e = err as { code?: string; details?: { reason?: string }; message?: string };
    return { code: e.code, reason: e.details?.reason, message: e.message };
  }
  throw new Error("expected a refusal, but the call succeeded");
}

/** A critical `auto` row written straight into the store (as before the ceiling existed). */
function legacyCriticalRow(wg: Dispatch, repoId: string, gate: "approve" | "merge"): void {
  wg.autonomyPolicy.upsert({
    id: newId(),
    repoId,
    riskLevel: "critical",
    gate,
    mode: "auto",
    enabledBy: "tom",
    enabledAt: new Date().toISOString(),
    evidenceJson: null,
    now: new Date().toISOString(),
  });
}

describe("enabling a critical policy is refused", () => {
  it("the service refuses every enabling mode at critical, for both gates; off stays allowed", () => {
    const wg = Dispatch.open(":memory:");
    try {
      const api = repoNamed(wg, "api");
      for (const gate of ["approve", "merge"] as const) {
        for (const mode of ["auto", "recommend"] as const) {
          expect(
            refusal(() =>
              wg.setAutonomyPolicy(
                { repoId: api, riskLevel: "critical", gate, mode, confirm: true },
                human,
              ),
            ),
          ).toEqual({
            code: "VALIDATION_ERROR",
            reason: "autonomy_ceiling",
            message: CEILING_MESSAGE,
          });
        }
        expect(
          wg.setAutonomyPolicy(
            { repoId: api, riskLevel: "critical", gate, mode: "off", confirm: true },
            human,
          ).mode,
        ).toBe("off");
      }
      // High stays allowed.
      expect(
        wg.setAutonomyPolicy(
          { repoId: api, riskLevel: "high", gate: "merge", mode: "auto", confirm: true },
          human,
        ).mode,
      ).toBe("auto");
    } finally {
      wg.db.close();
    }
  });

  it("POST /api/autonomy/policy at critical answers 422 with the ceiling's sentence", async () => {
    const wg = Dispatch.open(":memory:");
    const api = repoNamed(wg, "api");
    const server = createApiServer(wg);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const res = await fetch(`${base}/api/autonomy/policy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repo_id: api,
          risk_level: "critical",
          gate: "merge",
          mode: "auto",
          confirm: true,
        }),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.message).toBe(CEILING_MESSAGE);
      expect(wg.autonomyPolicy.get(api, "critical", "merge")).toBeUndefined();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      wg.db.close();
    }
  });
});

describe("a critical row that already exists is ignored at decision time", () => {
  it("the gate decision holds for a person, even with the env floor on", () => {
    const wg = Dispatch.open(":memory:");
    try {
      const api = repoNamed(wg, "api");
      legacyCriticalRow(wg, api, "approve");
      legacyCriticalRow(wg, api, "merge");
      process.env.AUTO_MERGE = "1";
      process.env.MERGE_ON_AGENT_REVIEW = "1";
      process.env.DISPATCH_ALLOW_AGENT_APPROVE = "1";
      for (const gate of ["approve", "merge"] as const) {
        expect(isAutonomyAllowed(wg.autonomyPolicy, [api], "critical", gate)).toBe(false);
        expect(isAutonomyAllowed(wg.autonomyPolicy, [api], "high", gate)).toBe(true);
      }
    } finally {
      wg.db.close();
    }
  });

  it("an agent cannot approve a critical change, and an agent's approval of one cannot land", () => {
    const wg = Dispatch.open(":memory:", systemClock, (cwd, args, opts) => {
      if (args[0] === "merge-base" && args[1] === "--is-ancestor")
        return { status: 1, stdout: "", stderr: "" };
      return nonEmptyDiffRunner(cwd, args, opts);
    });
    try {
      const deliver = (risk: RiskLevel) => {
        const t = wg.createTicket(
          { title: "Ship", description: "x", policy_pack: "team_light", risk_level: risk },
          human,
        );
        const { ac } = wg.addAcceptanceCriterion({ ticket_id: t.id, text: "ok" }, human);
        const { repoId } = giveTicketRealDelivery(wg, t.id, human, { repoName: "repoA" });
        wg.markReady(t.id, human);
        const a = wg.registerAgent({ display_name: "a", max_risk: "critical" }, human);
        const runner: Actor = { type: "agent", id: "agent-runner" };
        const claim = wg.claimNextTicket({ agentId: a.id, ttlSeconds: 600 }, runner);
        wg.recordEvidence(
          {
            claimToken: claim!.claimToken,
            ticket_id: t.id,
            ac_id: ac.id,
            evidence_type: "test_output",
            summary: "passed",
          },
          runner,
        );
        wg.submitForReview({ claimToken: claim!.claimToken, ticket_id: t.id, reason: "d" }, runner);
        return { id: t.id, repoId };
      };
      process.env.DISPATCH_ALLOW_AGENT_APPROVE = "1";
      const { id, repoId } = deliver("critical");
      legacyCriticalRow(wg, repoId, "approve");
      legacyCriticalRow(wg, repoId, "merge");
      expect(refusal(() => wg.approveReview(id, agent))).toMatchObject({
        code: "ACTOR_NOT_PERMITTED",
        reason: "autonomy_ceiling",
      });
      expect(wg.autonomyGateDecision(wg.resolveTicket(id), "merge")).toMatchObject({
        decision: "deny",
        held: { kind: "ceiling", message: CEILING_MESSAGE },
      });
      // An agent approval that got on record anyway (written before the ceiling) does not
      // land: the landing check refuses it.
      wg.db.prepare(`UPDATE tickets SET status = 'ready_for_merge' WHERE id = ?`).run(id);
      writeEvent(wg.db, {
        entity_type: "ticket",
        entity_id: id,
        actor: agent,
        event_type: "ticket.transitioned",
        payload: { from: "in_review", to: "ready_for_merge", reason: "review_approved" },
      });
      const approval = wg.landingApproval(id);
      expect(
        refusal(() =>
          wg.beginLanding(
            id,
            { repo: "repoA", commit: FAKE_HEAD, approval: approval ?? undefined, via: "local" },
            system,
          ),
        ),
      ).toMatchObject({ code: "STATE_CONFLICT", reason: "autonomy_ceiling" });
      // A person still approves a critical change.
      expect(wg.autonomyGateDecision(wg.resolveTicket(id), "approve").decision).toBe("deny");
    } finally {
      wg.db.close();
    }
  });
});

describe("suggestions: none at critical, and no cross-repo prior at high", () => {
  const row = (repo: string, risk: string, i: number, unchanged = true): ReviewDecisionRow => ({
    decisionId: `${repo}-${risk}-${i}`,
    repoId: repo,
    repoName: repo,
    riskLevel: risk,
    actorType: "human",
    fromStatus: "in_review",
    toStatus: "ready_for_merge",
    reason: "review_approved",
    approvedUnchanged: unchanged,
  });

  it("ten agreeing decisions at critical suggest nothing; at high they do", () => {
    const wg = Dispatch.open(":memory:");
    try {
      repoNamed(wg, "api");
      decisions(wg, "api", "critical", 10);
      decisions(wg, "api", "high", 10);
      const recs = wg.autonomyRecommendationsList();
      expect(recs.filter((r) => r.riskLevel === "critical")).toEqual([]);
      expect(
        recs
          .filter((r) => r.riskLevel === "high")
          .map((r) => r.gate)
          .sort(),
      ).toEqual(["approve", "merge"]);
    } finally {
      wg.db.close();
    }
  });

  it("the prior pooled from other repos counts at low and medium, never at high", () => {
    const rows: ReviewDecisionRow[] = [];
    for (const risk of ["low", "medium", "high"]) {
      for (let i = 0; i < 5; i += 1) rows.push(row("a", risk, i), row("b", risk, i));
    }
    const priors = computeRecommendations(rows).filter((r) => r.repoId === "*");
    expect([...new Set(priors.map((r) => r.riskLevel))].sort()).toEqual(["low", "medium"]);
  });
});

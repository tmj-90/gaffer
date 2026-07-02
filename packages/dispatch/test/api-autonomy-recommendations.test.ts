/**
 * Integration tests for GET /api/autonomy/recommendations (Spec 2, Phase 2).
 *
 * Drives REAL review events through the CLI/service surface (approve + reject) so the
 * work_events → tickets → ticket_repos join in EventRepository.reviewDecisions() is
 * exercised end-to-end, then asserts the advisory endpoint shape. Includes the
 * NEGATIVE CONTROL: a repo below the sample floor yields no recommendation.
 */
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApiServer } from "../src/api/server.js";
import { Dispatch } from "../src/core.js";
import { MIN_SAMPLES } from "../src/services/autonomyRecommendationService.js";
import { nonEmptyDiffRunner } from "./helpers/realDiff.js";
import type { Actor } from "../src/domain/types.js";

const human: Actor = { type: "human", id: "tom" };
const agentActor: Actor = { type: "agent", id: "agt-1" };

/** Drive a fresh ticket on `repoName` to in_review, then approve or reject it. */
function reviewCycle(
  d: Dispatch,
  repoName: string,
  outcome: "approve" | "reject",
  seq: number,
): void {
  const repo =
    d.repos.findByName(repoName) ??
    d.registerRepository(
      { name: repoName, default_branch: "main", local_path: process.cwd() },
      human,
    );
  const ticket = d.createTicket({ title: `T-${repoName}-${seq}`, risk_level: "low" }, human);
  d.linkRepository(ticket.id, repoName, "primary", human);
  const { ac } = d.addAcceptanceCriterion({ ticket_id: ticket.id, text: "Works" }, human);
  d.markReady(ticket.id, human);
  const agent = d.registerAgent({ display_name: "Bot" }, human);
  const claim = d.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, agentActor);
  if (!claim) throw new Error("expected a claim");
  d.recordEvidence(
    {
      claimToken: claim.claimToken,
      ticket_id: ticket.id,
      ac_id: ac.id,
      evidence_type: "test_output",
      summary: "passing",
    },
    agentActor,
  );
  d.recordRepoDelivery(
    { ticket_id: ticket.id, repo_id: repo.id, branch_name: `feat/${repoName}-${seq}` },
    agentActor,
  );
  d.submitForReview(
    { claimToken: claim.claimToken, ticket_id: ticket.id, reason: "done" },
    agentActor,
  );
  if (outcome === "approve") {
    d.approveReview(ticket.id, human);
  } else {
    d.rejectReview(ticket.id, "refining", human, "needs work");
  }
}

interface Harness {
  wg: Dispatch;
  baseUrl: string;
  close: () => Promise<void>;
}

async function startHarness(): Promise<Harness> {
  process.env.DISPATCH_AUDIT_OFF = "1";
  // nonEmptyDiffRunner satisfies the real-diff done-gate; rev-parse returns "" so the
  // approved_unchanged signal stays null (unknown) — fine, this suite tests agreement.
  const wg = Dispatch.open(":memory:", undefined, nonEmptyDiffRunner);
  const server = createApiServer(wg);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    wg,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          wg.db.close();
          resolve();
        });
      }),
  };
}

async function get(baseUrl: string, path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

describe("GET /api/autonomy/recommendations", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("returns an empty list when there is no track record", async () => {
    const { status, body } = await get(h.baseUrl, "/api/autonomy/recommendations");
    expect(status).toBe(200);
    expect(body.recommendations).toEqual([]);
  });

  it("recommends the approve gate once a repo clears the sample floor", async () => {
    for (let i = 0; i < MIN_SAMPLES; i += 1) reviewCycle(h.wg, "api-repo", "approve", i);
    const { status, body } = await get(h.baseUrl, "/api/autonomy/recommendations");
    expect(status).toBe(200);
    const recs = body.recommendations as Array<Record<string, unknown>>;
    const approve = recs.find((r) => r.gate === "approve");
    expect(approve).toBeDefined();
    expect(approve!.repoName).toBe("api-repo");
    expect(approve!.riskLevel).toBe("low");
    expect(typeof approve!.confidence).toBe("number");
    expect(String(approve!.headline)).toContain("api-repo");
  });

  it("does NOT recommend a repo below the sample floor [negative control]", async () => {
    // Only MIN_SAMPLES-1 approvals for this repo — below the floor.
    for (let i = 0; i < MIN_SAMPLES - 1; i += 1) reviewCycle(h.wg, "thin-repo", "approve", i);
    const { body } = await get(h.baseUrl, "/api/autonomy/recommendations");
    const recs = body.recommendations as Array<Record<string, unknown>>;
    expect(recs.find((r) => r.repoName === "thin-repo")).toBeUndefined();
  });

  it("withholds the recommendation when agreement is low (many rejects)", async () => {
    // 6 approvals + 6 rejects = 0.5 agreement, well below threshold.
    for (let i = 0; i < 6; i += 1) reviewCycle(h.wg, "noisy-repo", "approve", i);
    for (let i = 0; i < 6; i += 1) reviewCycle(h.wg, "noisy-repo", "reject", 100 + i);
    const { body } = await get(h.baseUrl, "/api/autonomy/recommendations");
    const recs = body.recommendations as Array<Record<string, unknown>>;
    expect(recs.find((r) => r.repoName === "noisy-repo")).toBeUndefined();
  });

  it("returns 405 for POST", async () => {
    const res = await fetch(`${h.baseUrl}/api/autonomy/recommendations`, { method: "POST" });
    expect(res.status).toBe(405);
  });
});

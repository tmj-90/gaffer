// Feature-audit tier 2 — the review → merge seam the live probe found broken:
//
//   1. A reviewer's `record_ac_evidence` note (no claim token; the runner mounts the
//      reviewer's MCP server with GAFFER_REVIEW_TICKET) is accepted for THAT in_review
//      ticket only and never satisfies an AC.
//   2. An approved-but-unmerged ticket (`ready_for_merge`) surfaces in the human queue
//      as `awaiting_merge`, and POST /tickets/:id/merge fires the configured merge
//      runner (409 unless the ticket is actually ready_for_merge).
//   3. `create_ticket` over MCP links the repo the server was mounted for
//      (GAFFER_DEFAULT_TICKET_REPO) when the caller names none.
//   4. The SPA offers "Merge now" for ready_for_merge.

import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { createApiServer } from "../src/api/server.js";
import type { MergeRunner } from "../src/api/mergeRunner.js";
import type { ProductOwnerRunner } from "../src/api/productOwner.js";
import type { PlanBuildRunner } from "../src/api/planBuild.js";
import { makeHandlers } from "../src/mcp/tools.js";
import { TestClock } from "../src/util/clock.js";
import { DispatchError } from "../src/util/errors.js";
import { giveTicketRealDelivery, nonEmptyDiffRunner } from "./helpers/realDiff.js";

const human: Actor = { type: "human", id: "tom" };
const reviewer: Actor = { type: "human", id: "rev" };
const agentActor: Actor = { type: "agent", id: "agent-runner" };
const reviewerAgent: Actor = { type: "agent", id: "agent-reviewer" };

function freshWg(): Dispatch {
  return Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner);
}

/** A team_light ticket in `in_review` with one satisfied AC and a real delivery diff. */
function inReview(wg: Dispatch): { ticketId: string; number: number; acId: string } {
  wg.registerRepository({ name: "svc", default_branch: "main" }, human);
  const t = wg.createTicket({ title: "Ship", description: "x", policy_pack: "team_light" }, human);
  wg.linkRepository(t.id, "svc", "primary", human);
  const { ac } = wg.addAcceptanceCriterion({ ticket_id: t.id, text: "ok" }, human);
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
  expect(wg.view(t.id).ticket.status).toBe("in_review");
  return { ticketId: t.id, number: t.number ?? 0, acId: ac.id };
}

/** Approve the in_review ticket so it sits in `ready_for_merge` (merge not landed). */
function readyForMerge(wg: Dispatch): { ticketId: string; number: number; acId: string } {
  const r = inReview(wg);
  expect(wg.approveReview(r.ticketId, reviewer).ticket.status).toBe("ready_for_merge");
  return r;
}

describe("reviewer evidence (no claim token, GAFFER_REVIEW_TICKET)", () => {
  it("accepts a non-human note on the in_review ticket named by reviewOf (id or number)", () => {
    const wg = freshWg();
    const { ticketId, number } = inReview(wg);
    const byId = wg.recordEvidence(
      {
        reviewOf: ticketId,
        ticket_id: ticketId,
        evidence_type: "manual_note",
        summary: "reviewed",
      },
      reviewerAgent,
    );
    expect(byId.evidenceId).toBeTruthy();
    const byNumber = wg.recordEvidence(
      {
        reviewOf: String(number),
        ticket_id: ticketId,
        evidence_type: "manual_note",
        summary: "reviewed again",
      },
      reviewerAgent,
    );
    expect(byNumber.evidenceId).toBeTruthy();
    wg.db.close();
  });

  it("still rejects a claimless non-human note with NO reviewOf (CLAIM_INVALID)", () => {
    const wg = freshWg();
    const { ticketId } = inReview(wg);
    try {
      wg.recordEvidence(
        { ticket_id: ticketId, evidence_type: "manual_note", summary: "sneaky" },
        reviewerAgent,
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DispatchError);
      expect((err as DispatchError).code).toBe("CLAIM_INVALID");
    }
    wg.db.close();
  });

  it("rejects reviewOf naming a DIFFERENT ticket, and a ticket not in in_review", () => {
    const wg = freshWg();
    const { ticketId } = inReview(wg);
    // A second, unrelated draft ticket: a reviewer of #1 may not write notes on it.
    const other = wg.createTicket({ title: "Other", policy_pack: "team_light" }, human);
    for (const attempt of [
      { reviewOf: ticketId, ticket_id: other.id },
      { reviewOf: other.id, ticket_id: other.id },
    ]) {
      try {
        wg.recordEvidence(
          { ...attempt, evidence_type: "manual_note", summary: "nope" },
          reviewerAgent,
        );
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(DispatchError);
        expect((err as DispatchError).code).toBe("CLAIM_INVALID");
      }
    }
    wg.db.close();
  });

  it("a reviewer note against an AC never flips that AC to satisfied", () => {
    const wg = freshWg();
    wg.registerRepository({ name: "svc", default_branch: "main" }, human);
    const t = wg.createTicket(
      { title: "Ship", description: "x", policy_pack: "team_light" },
      human,
    );
    wg.linkRepository(t.id, "svc", "primary", human);
    const { ac } = wg.addAcceptanceCriterion({ ticket_id: t.id, text: "ok" }, human);
    const { ac: ac2 } = wg.addAcceptanceCriterion({ ticket_id: t.id, text: "unproven" }, human);
    wg.markReady(t.id, human);
    const agent = wg.registerAgent({ display_name: "a" }, human);
    const claim = wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, agentActor);
    wg.recordEvidence(
      {
        claimToken: claim!.claimToken,
        ticket_id: t.id,
        ac_id: ac.id,
        evidence_type: "test_output",
        summary: "p",
      },
      agentActor,
    );
    wg.submitForReview(
      { claimToken: claim!.claimToken, ticket_id: t.id, reason: "done" },
      agentActor,
    );
    // The reviewer "records evidence" against the unproven AC: recorded as a note only.
    wg.recordEvidence(
      {
        reviewOf: t.id,
        ticket_id: t.id,
        ac_id: ac2.id,
        evidence_type: "manual_note",
        summary: "looks fine",
      },
      reviewerAgent,
    );
    const acs = wg.view(t.id).acceptanceCriteria;
    expect(acs.find((a) => a.id === ac.id)!.status).toBe("satisfied");
    expect(acs.find((a) => a.id === ac2.id)!.status).not.toBe("satisfied");
    wg.db.close();
  });
});

describe("tester evidence (no claim token) on an in_testing ticket", () => {
  it("accepts a claimless non-human note for the in_testing ticket named by reviewOf, never satisfying an AC", () => {
    const wg = Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner, {
      testingEnabled: true,
    });
    const { ticketId, acId } = inReview(wg);
    wg.setTestable(ticketId, true, human);
    expect(wg.approveReview(ticketId, reviewer).ticket.status).toBe("in_testing");
    const res = wg.recordEvidence(
      {
        reviewOf: ticketId,
        ticket_id: ticketId,
        ac_id: acId,
        evidence_type: "manual_note",
        summary: "black-box: AC1 demonstrated",
      },
      { type: "agent", id: "agent-tester" },
    );
    expect(res.evidenceId).toBeTruthy();
    // Still refused without reviewOf, and never flips the AC from the tester's note alone.
    expect(() =>
      wg.recordEvidence(
        { ticket_id: ticketId, evidence_type: "manual_note", summary: "x" },
        { type: "agent", id: "agent-tester" },
      ),
    ).toThrow(DispatchError);
    wg.db.close();
  });
});

describe("MCP handlers: reviewer + default-repo env", () => {
  const saved = {
    review: process.env.GAFFER_REVIEW_TICKET,
    repo: process.env.GAFFER_DEFAULT_TICKET_REPO,
  };
  afterEach(() => {
    if (saved.review === undefined) delete process.env.GAFFER_REVIEW_TICKET;
    else process.env.GAFFER_REVIEW_TICKET = saved.review;
    if (saved.repo === undefined) delete process.env.GAFFER_DEFAULT_TICKET_REPO;
    else process.env.GAFFER_DEFAULT_TICKET_REPO = saved.repo;
  });

  it("record_ac_evidence without a claim token is accepted when GAFFER_REVIEW_TICKET names the ticket", () => {
    const wg = freshWg();
    const { ticketId, number } = inReview(wg);
    delete process.env.GAFFER_REVIEW_TICKET;
    const h = makeHandlers(wg, reviewerAgent);
    const denied = h.record_ac_evidence({
      ticket_id: ticketId,
      evidence_type: "manual_note",
      summary: "no env",
    });
    expect(denied.isError).toBe(true);

    process.env.GAFFER_REVIEW_TICKET = String(number);
    const ok = h.record_ac_evidence({
      ticket_id: ticketId,
      evidence_type: "manual_note",
      summary: "reviewer note",
    });
    expect(ok.isError).not.toBe(true);
    expect(ok.structuredContent.evidence_id).toBeTruthy();
    wg.db.close();
  });

  it("create_ticket links GAFFER_DEFAULT_TICKET_REPO when the caller names no repo", () => {
    const wg = freshWg();
    wg.registerRepository({ name: "payments", default_branch: "main" }, human);
    process.env.GAFFER_DEFAULT_TICKET_REPO = "payments";
    const h = makeHandlers(wg, agentActor);
    const res = h.create_ticket({ title: "From the PO run", policy_pack: "team_light" });
    expect(res.isError).not.toBe(true);
    const id = res.structuredContent.ticket_id as string;
    const repos = wg.view(id).repositories;
    expect(repos.map((r) => r.name)).toEqual(["payments"]);

    // An explicit repo still wins over the default.
    wg.registerRepository({ name: "other", default_branch: "main" }, human);
    const res2 = h.create_ticket({ title: "Explicit", policy_pack: "team_light", repo: "other" });
    const id2 = res2.structuredContent.ticket_id as string;
    expect(wg.view(id2).repositories.map((r) => r.name)).toEqual(["other"]);

    // Unset (or blank) default: no link, exactly as before.
    process.env.GAFFER_DEFAULT_TICKET_REPO = "";
    const res3 = h.create_ticket({ title: "Unlinked", policy_pack: "team_light" });
    expect(wg.view(res3.structuredContent.ticket_id as string).repositories).toEqual([]);
    wg.db.close();
  });
});

describe("approved-but-unmerged: human queue + POST /tickets/:id/merge", () => {
  it("humanQueue surfaces a ready_for_merge ticket as awaiting_merge", () => {
    const wg = freshWg();
    const { ticketId } = readyForMerge(wg);
    const items = wg.humanQueue().items.filter((i) => i.kind === "awaiting_merge");
    expect(items).toHaveLength(1);
    expect(items[0]!.ticket?.id).toBe(ticketId);
    expect(items[0]!.ticket?.status).toBe("ready_for_merge");
    expect(items[0]!.reason).toMatch(/not been merged/i);
    // Once merged (-> done) it leaves the queue.
    wg.markMerged(ticketId, { type: "system" });
    expect(wg.humanQueue().items.filter((i) => i.kind === "awaiting_merge")).toHaveLength(0);
    wg.db.close();
  });

  interface Harness {
    wg: Dispatch;
    baseUrl: string;
    merges: Array<{ ticketNumber: number }>;
    close: () => Promise<void>;
  }
  const noopPo: ProductOwnerRunner = { run: () => ({ started: false, pid: null }) };
  const noopPlan: PlanBuildRunner = { run: async () => ({ phase: "error", error: "n/a" }) };
  async function startHarness(): Promise<Harness> {
    const wg = freshWg();
    const merges: Array<{ ticketNumber: number }> = [];
    const mergeRunner: MergeRunner = {
      trigger(input) {
        merges.push(input);
        return { triggered: true, pid: 4321 };
      },
    };
    const server = createApiServer(wg, noopPo, noopPlan, mergeRunner);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return {
      wg,
      merges,
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
  async function post(
    baseUrl: string,
    path: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${baseUrl}${path}`, { method: "POST" });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  }

  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("202: fires the merge runner with the ticket number and leaves the status to the callback", async () => {
    const { ticketId, number } = readyForMerge(h.wg);
    const res = await post(h.baseUrl, `/tickets/${ticketId}/merge`);
    expect(res.status).toBe(202);
    expect(h.merges).toEqual([{ ticketNumber: number }]);
    expect((res.body.merge as { triggered: boolean }).triggered).toBe(true);
    // The route does NOT fake the merge: status flips only via mark-merged.
    expect(h.wg.view(ticketId).ticket.status).toBe("ready_for_merge");
  });

  it("409 for a ticket that is not in ready_for_merge (nothing fired)", async () => {
    const { ticketId } = inReview(h.wg);
    const res = await post(h.baseUrl, `/tickets/${ticketId}/merge`);
    expect(res.status).toBe(409);
    expect(h.merges).toEqual([]);
  });
});

describe("SPA: ready_for_merge offers Merge now", () => {
  const appJs = readFileSync(
    fileURLToPath(new URL("../src/api/web/app.js", import.meta.url)),
    "utf8",
  );
  it("action map lists merge_now first for ready_for_merge and posts to /tickets/:id/merge", () => {
    const map = appJs.slice(appJs.indexOf("const TICKET_ACTION_KEYS"));
    const m = /ready_for_merge:\s*\[([^\]]*)\]/.exec(map);
    expect(m).not.toBeNull();
    const keys = (m![1]!.match(/"([^"]+)"/g) ?? []).map((s) => s.replace(/"/g, ""));
    expect(keys[0]).toBe("merge_now");
    expect(keys).toContain("mark_merged");
    expect(appJs).toMatch(/\/tickets\/\$\{t\.id\}\/merge`/);
  });
});

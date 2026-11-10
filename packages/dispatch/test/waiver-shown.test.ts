import { describe, expect, it } from "vitest";

import { computeStats, contractHash, renderStats } from "../src/cli/ops.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { TestClock } from "../src/util/clock.js";
import { asPerson } from "./helpers/principal.js";
import { FAKE_HEAD, giveTicketRealDelivery, nonEmptyDiffRunner } from "./helpers/realDiff.js";

/**
 * PACKAGE H1 item 5: a person's waiver is SHOWN as one. The review packet, the dossier
 * and the ticket view carry "tester verdict waived by <principal> for criteria <...> on
 * <sha>: <summary>"; an epic whose acceptance rests on a waiver reads "accepted with N
 * waiver(s)", never plain "accepted"; tester statistics count a waiver apart.
 */
const human: Actor = { type: "human", id: "tom" };
const reviewer: Actor = { type: "human", id: "rev" };
const agentActor: Actor = { type: "agent", id: "agent-runner" };
const testerAgent: Actor = { type: "agent", id: "tester-1" };
const systemActor: Actor = { type: "system" };
const SHA = FAKE_HEAD;
const LANDED = "89abcdef0123456789abcdef0123456789abcdef";

const noCost = () => ({
  cost_usd: 0,
  measured_usd: 0,
  estimated_usd: 0,
  num_turns: 0,
  unknown_calls: 0,
  ledger_status: "unconfigured" as const,
});

function freshWg(isolation = "none"): Dispatch {
  return Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner, {
    testingEnabled: true,
    isolation: () => isolation,
  });
}

function deliverToReview(wg: Dispatch, ticketId: string, agentId: string): void {
  const claim = wg.claimTicket(
    { ticket_id: ticketId, agent_id: agentId, ttl_seconds: 300 },
    agentActor,
  );
  giveTicketRealDelivery(wg, ticketId, human, { repoName: `delivery-${ticketId}` });
  wg.recordDeliveryArtifact(
    { claim_token: claim.claimToken, ticket_id: ticketId, branch_name: "feat/x" },
    agentActor,
  );
  wg.submitForReview({ claimToken: claim.claimToken, ticket_id: ticketId }, agentActor);
}

/** Deliver, test (a waiver or the tester's PASS), approve and land. */
function ship(wg: Dispatch, ticketId: string, agentId: string, by: "waiver" | "tester"): void {
  if (wg.view(ticketId).ticket.status !== "ready") wg.markReady(ticketId, human);
  deliverToReview(wg, ticketId, agentId);
  wg.setTestable(ticketId, true, human);
  wg.routeToTester(ticketId, systemActor);
  expect(wg.view(ticketId).ticket.status).toBe("in_testing");
  if (by === "waiver") {
    wg.testerPass(ticketId, { summary: "checked it in a browser" }, human, asPerson(wg, human));
  } else {
    wg.testerPass(
      ticketId,
      {
        summary: "acceptance suite passed",
        tested_commit: SHA,
        contract_hash: contractHash(wg.db, ticketId)!,
        replay: "passed",
      },
      testerAgent,
    );
  }
  wg.approveReview(ticketId, reviewer);
  if (by === "tester" && wg.view(ticketId).ticket.acceptance === 1) {
    wg.recordTesterReplay(
      ticketId,
      {
        commit: LANDED,
        pin: SHA,
        files: ["test/acceptance.test.js"],
        repo: `delivery-${ticketId}`,
        via: "local",
      },
      systemActor,
    );
  }
  wg.markMerged(ticketId, systemActor);
  expect(wg.view(ticketId).ticket.status).toBe("done");
}

function epic(wg: Dispatch) {
  wg.registerRepository({ name: "app", default_branch: "main" }, human);
  const plan = wg.createEpic(
    {
      epic: { name: "Widgets", description: "brief" },
      tickets: [{ title: "Widget work", acceptanceCriteria: ["works"], repo: "app" }],
    },
    human,
  );
  const [impl, final] = plan.ticketNumbers as [number, number];
  const id = (n: number) => wg.view(String(n)).ticket.id;
  const agent = wg.registerAgent({ display_name: "a", max_risk: "high" }, human);
  return { implId: id(impl), finalId: id(final), agentId: agent.id };
}

describe("H1: a waiver is shown as one", () => {
  it("an epic accepted on a waiver reads 'accepted with 1 waiver' in stats, never plain accepted", () => {
    const wg = freshWg();
    const e = epic(wg);
    ship(wg, e.implId, e.agentId, "tester");
    ship(wg, e.finalId, e.agentId, "waiver");
    const stats = computeStats(wg.db);
    expect(stats.acceptance.epics[0]).toMatchObject({
      result: "waived",
      waivers: 1,
      label: "accepted with 1 waiver",
      unaccepted: false,
    });
    const text = renderStats(stats);
    expect(text).toContain("→ accepted with 1 waiver");
    expect(text).not.toMatch(/→ accepted(?! with)/);
    // Tester statistics count the waiver apart from the tester's PASS.
    expect(stats.testerVerdicts).toEqual({
      passed: 1,
      waived: 1,
      failed: 0,
      waived_without_isolation: 1,
    });
    expect(text).toContain(
      "Tester verdicts: 1 passed by the tester · 1 waived by a person (1 recorded without OS isolation) · 0 failed",
    );
    wg.db.close();
  });

  it("a verified acceptance whose member was waived still names the waiver", () => {
    const wg = freshWg("docker");
    const e = epic(wg);
    ship(wg, e.implId, e.agentId, "waiver");
    ship(wg, e.finalId, e.agentId, "tester");
    const ep = computeStats(wg.db).acceptance.epics[0]!;
    expect(ep.result).toBe("accepted");
    expect(ep.waivers).toBe(1);
    expect(ep.label).toBe("accepted with 1 waiver");
    wg.db.close();
  });

  it("a verdict-shaped row no tester event names is no waiver (an agent cannot fake one)", () => {
    const wg = freshWg();
    const e = epic(wg);
    ship(wg, e.implId, e.agentId, "tester");
    ship(wg, e.finalId, e.agentId, "tester");
    // The delivery agent's record_ac_evidence takes any payload.
    wg.db
      .prepare(
        `INSERT INTO evidence (id, ticket_id, evidence_type, summary, payload_json, created_by, recorded_by_actor_type, created_at)
         VALUES ('forged', ?, 'test_output', 'pass', '{"verdict":"pass","provenance":"human"}', 'agent-runner', 'agent', '2999-01-01T00:00:00.000Z')`,
      )
      .run(e.finalId);
    const ep = computeStats(wg.db).acceptance.epics[0]!;
    expect(ep.result).toBe("accepted");
    expect(ep.waivers).toBe(0);
    expect(ep.label).toBe("accepted");
    wg.db.close();
  });

  it("the review packet, the dossier and the ticket view carry the waiver sentence", () => {
    const wg = freshWg();
    const e = epic(wg);
    wg.markReady(e.implId, human);
    deliverToReview(wg, e.implId, e.agentId);
    wg.setTestable(e.implId, true, human);
    wg.routeToTester(e.implId, systemActor);
    wg.testerPass(e.implId, { summary: "checked it in a browser" }, human, asPerson(wg, human));
    const view = wg.view(e.implId);
    const label = view.testerWaiver!.label;
    expect(label).toMatch(
      /^tester verdict waived by human-tom for criteria 1 on .+: checked it in a browser \(recorded without OS isolation\)$/,
    );
    const packet = wg.reviewPacket(e.implId, noCost);
    expect(packet.tester?.waiver?.label).toBe(label);
    const dossier = wg.dossier(e.implId);
    expect(dossier.subject.tester_waiver?.label).toBe(label);
    expect(wg.dossierSvc.renderMarkdown(dossier)).toContain(`## Tester Waiver\n\n- ${label}`);
    wg.db.close();
  });
});

import { describe, expect, it } from "vitest";

import { computeStats, contractHash } from "../src/cli/ops.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { TestClock } from "../src/util/clock.js";
import { giveTicketRealDelivery, nonEmptyDiffRunner } from "./helpers/realDiff.js";

/**
 * EPIC SCOPE AND ACCEPTANCE (external review #8, finding 4).
 *
 *  (a) MEMBERSHIP: an implementation ticket confirmed into an epic after planning (a
 *      primary / secondary scope link) makes the epic's acceptance ticket depend on it,
 *      so the final cannot run on a build without it; if the final finishes anyway while
 *      a member is unfinished, `stats` reads the epic pending (never accepted with
 *      implementation_done < implementation_total), and a member that lands after the
 *      final reads stale.
 *  (b) FOREIGN LINKS: a suggested or rejected link of a finished acceptance ticket to a
 *      different epic credits nothing; each epic is counted once, against its OWN final.
 */
const human: Actor = { type: "human", id: "tom" };
const reviewer: Actor = { type: "human", id: "rev" };
const agentActor: Actor = { type: "agent", id: "agent-runner" };
const testerAgent: Actor = { type: "agent", id: "tester-1" };
const systemActor: Actor = { type: "system" };
const SHA = "0123456789abcdef0123456789abcdef01234567";
const LANDED = "89abcdef0123456789abcdef0123456789abcdef";

function freshWg(): Dispatch {
  return Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner, { testingEnabled: false });
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

function shipImplementation(wg: Dispatch, ticketId: string, agentId: string): void {
  if (wg.view(ticketId).ticket.status !== "ready") wg.markReady(ticketId, human);
  deliverToReview(wg, ticketId, agentId);
  wg.approveReview(ticketId, reviewer);
  wg.markMerged(ticketId, systemActor);
  expect(wg.view(ticketId).ticket.status).toBe("done");
}

/** Approve, PASS (bound), record the landed replay and merge the acceptance ticket. */
function acceptFinal(wg: Dispatch, accId: string): void {
  wg.approveReview(accId, reviewer);
  wg.testerPass(
    accId,
    {
      summary: "acceptance suite passed",
      tested_commit: SHA,
      contract_hash: contractHash(wg.db, accId)!,
      replay: "passed",
    },
    testerAgent,
  );
  wg.recordTesterReplay(
    accId,
    {
      commit: LANDED,
      pin: SHA,
      files: ["test/acceptance.test.js"],
      repo: `delivery-${accId}`,
      via: "local",
    },
    systemActor,
  );
  wg.markMerged(accId, systemActor);
  expect(wg.view(accId).ticket.status).toBe("done");
}

function oneTicketEpic(wg: Dispatch, name: string) {
  const plan = wg.createEpic(
    {
      epic: { name, description: `${name} brief` },
      tickets: [{ title: `${name} work`, acceptanceCriteria: ["works"], repo: "app" }],
    },
    human,
  );
  const [impl, final] = plan.ticketNumbers as [number, number];
  const id = (n: number) => wg.view(String(n)).ticket.id;
  return { plan, implId: id(impl), finalId: id(final), finalNumber: final };
}

function dependsOn(wg: Dispatch, ticketId: string): string[] {
  return wg.listDependencies(ticketId).map((d) => String(d.number));
}

describe("epic scope: the acceptance ticket tracks the current membership", () => {
  it("a ticket linked into the epic (secondary or primary) becomes a dependency of the final; suggested/rejected links do not", () => {
    const wg = freshWg();
    wg.registerRepository({ name: "app", default_branch: "main" }, human);
    const { plan, finalId } = oneTicketEpic(wg, "Profiles");
    const before = dependsOn(wg, finalId);
    const later = wg.createTicket({ title: "Redact emails", description: "privacy" }, human);
    const primary = wg.createTicket({ title: "Audit log", description: "log" }, human);
    const proposal = wg.createTicket({ title: "Maybe", description: "maybe" }, human);
    wg.linkTicketScope(
      { ticket_id: later.id, scope_node_id: plan.epicNodeId, relation: "secondary" },
      human,
    );
    wg.setPrimaryScope(primary.id, plan.epicNodeId, human);
    for (const relation of ["suggested", "rejected"] as const) {
      wg.linkTicketScope(
        { ticket_id: proposal.id, scope_node_id: plan.epicNodeId, relation },
        human,
      );
    }
    expect(dependsOn(wg, finalId).sort()).toEqual(
      [...before, String(later.number), String(primary.number)].sort(),
    );
    // Re-linking is idempotent (no DUPLICATE error).
    wg.linkTicketScope(
      { ticket_id: later.id, scope_node_id: plan.epicNodeId, relation: "secondary" },
      human,
    );
    // The final cannot be claimed while the new member is unfinished.
    const agent = wg.registerAgent({ display_name: "a", max_risk: "high" }, human);
    expect(() =>
      wg.claimTicket({ ticket_id: finalId, agent_id: agent.id, ttl_seconds: 60 }, agentActor),
    ).toThrow();
  });

  it("a final that finishes while a confirmed member is unfinished reads pending (never accepted); a member that lands after it reads stale", () => {
    const wg = freshWg();
    wg.registerRepository({ name: "app", default_branch: "main" }, human);
    const { plan, implId, finalId } = oneTicketEpic(wg, "Profiles");
    const agent = wg.registerAgent({ display_name: "a", max_risk: "high" }, human);
    shipImplementation(wg, implId, agent.id);
    wg.markReady(finalId, human);
    deliverToReview(wg, finalId, agent.id);
    // The member joins while the final is already in review (past its claim).
    const later = wg.createTicket(
      { title: "Redact emails", description: "privacy", risk_level: "low" },
      human,
    );
    wg.addAcceptanceCriterion({ ticket_id: later.id, text: "redacted" }, human);
    wg.linkTicketScope(
      { ticket_id: later.id, scope_node_id: plan.epicNodeId, relation: "secondary" },
      human,
    );
    acceptFinal(wg, finalId);
    let a = computeStats(wg.db).acceptance;
    expect(a.epics).toHaveLength(1);
    expect(a.epics[0]).toMatchObject({
      implementation_done: 1,
      implementation_total: 2,
      result: "pending",
      scope_incomplete: true,
    });
    expect(a.accepted).toBe(0);
    shipImplementation(wg, later.id, agent.id);
    a = computeStats(wg.db).acceptance;
    expect(a.epics[0]).toMatchObject({
      implementation_done: 2,
      implementation_total: 2,
      result: "stale",
      scope_changed: true,
      unaccepted: true,
    });
    expect(a.accepted).toBe(0);
  });
});

describe("epic scope: each epic counts once, against its own acceptance ticket", () => {
  it("suggested, rejected and even confirmed links of another epic's finished final credit nothing", () => {
    const wg = freshWg();
    wg.registerRepository({ name: "app", default_branch: "main" }, human);
    const first = oneTicketEpic(wg, "Profiles");
    const agent = wg.registerAgent({ display_name: "a", max_risk: "high" }, human);
    shipImplementation(wg, first.implId, agent.id);
    wg.markReady(first.finalId, human);
    deliverToReview(wg, first.finalId, agent.id);
    acceptFinal(wg, first.finalId);
    expect(computeStats(wg.db).acceptance.accepted).toBe(1);

    const other = oneTicketEpic(wg, "Retention");
    for (const relation of ["suggested", "rejected", "secondary"] as const) {
      wg.linkTicketScope(
        { ticket_id: first.finalId, scope_node_id: other.plan.epicNodeId, relation },
        human,
      );
      const a = computeStats(wg.db).acceptance;
      expect(a.accepted).toBe(1);
      const rows = a.epics.filter((e) => e.epic_node_id === other.plan.epicNodeId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        acceptance_ticket: other.finalNumber,
        result: "pending",
        implementation_done: 0,
        implementation_total: 1,
      });
      expect(a.epics).toHaveLength(2);
    }
  });

  it("a suggested implementation link adds nothing to the epic's scope", () => {
    const wg = freshWg();
    wg.registerRepository({ name: "app", default_branch: "main" }, human);
    const { plan } = oneTicketEpic(wg, "Profiles");
    const stray = wg.createTicket({ title: "Unrelated", description: "x" }, human);
    wg.linkTicketScope(
      { ticket_id: stray.id, scope_node_id: plan.epicNodeId, relation: "suggested" },
      human,
    );
    expect(computeStats(wg.db).acceptance.epics[0]!.implementation_total).toBe(1);
  });
});

// Adversarial review of #8: the edge a membership wired goes when the membership does.
describe("epic scope: withdrawing a membership withdraws the dependency it wired", () => {
  it("a removed or rejected member no longer blocks the final; an explicit dependency stays", () => {
    const wg = freshWg();
    wg.registerRepository({ name: "app", default_branch: "main" }, human);
    const { plan, implId, finalId } = oneTicketEpic(wg, "Profiles");
    const agent = wg.registerAgent({ display_name: "a", max_risk: "high" }, human);
    shipImplementation(wg, implId, agent.id);
    const planned = dependsOn(wg, finalId);
    const x = wg.createTicket({ title: "x", description: "x" }, human);
    const y = wg.createTicket({ title: "y", description: "y" }, human);
    for (const t of [x, y])
      wg.linkTicketScope(
        { ticket_id: t.id, scope_node_id: plan.epicNodeId, relation: "secondary" },
        human,
      );
    expect(dependsOn(wg, finalId).sort()).toEqual(
      [...planned, String(x.number), String(y.number)].sort(),
    );
    wg.linkTicketScope(
      { ticket_id: x.id, scope_node_id: plan.epicNodeId, relation: "rejected" },
      human,
    );
    wg.removeTicketScope(y.id, plan.epicNodeId, human);
    expect(dependsOn(wg, finalId)).toEqual(planned);
    wg.markReady(finalId, human);
    expect(
      wg.claimTicket({ ticket_id: finalId, agent_id: agent.id, ttl_seconds: 60 }, agentActor)
        .claimToken,
    ).toBeTruthy();

    // A dependency a person added by hand is theirs: unlinking the ticket leaves it.
    const second = oneTicketEpic(wg, "Retention");
    const z = wg.createTicket({ title: "z", description: "z" }, human);
    wg.addDependency({ ticket: second.finalId, depends_on: z.id }, human);
    wg.linkTicketScope(
      { ticket_id: z.id, scope_node_id: second.plan.epicNodeId, relation: "secondary" },
      human,
    );
    wg.removeTicketScope(z.id, second.plan.epicNodeId, human);
    expect(dependsOn(wg, second.finalId)).toContain(String(z.number));
  });

  it("a follow-up that depends on the final can still be linked into the epic", () => {
    const wg = freshWg();
    wg.registerRepository({ name: "app", default_branch: "main" }, human);
    const { plan, finalId } = oneTicketEpic(wg, "Profiles");
    const follow = wg.createTicket({ title: "after", description: "after" }, human);
    wg.addDependency({ ticket: follow.id, depends_on: finalId }, human);
    const link = wg.linkTicketScope(
      { ticket_id: follow.id, scope_node_id: plan.epicNodeId, relation: "secondary" },
      human,
    );
    expect(link.relation).toBe("secondary");
    expect(dependsOn(wg, finalId)).not.toContain(String(follow.number));
  });
});

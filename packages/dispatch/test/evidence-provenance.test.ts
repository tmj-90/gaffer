// EVIDENCE-PROVENANCE: the ticket view stamps each evidence row with a derived
// `recorded_by_agent` flag from the RECORDING ACTOR'S TYPE captured at record
// time (`recorded_by_actor_type`), so the reviewer surface can reliably flag
// evidence self-reported by a delivery agent. This proves the signal is the
// actor type — NOT `created_by`, which for an agent is a runner-supplied id that
// never matches the registered agent identity — and that legacy rows recorded
// before the column existed read as unknown (flag false, no trust claim).

import { describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { TestClock } from "../src/util/clock.js";

const human: Actor = { type: "human", id: "tom" };
// The delivery agent records with a runner-supplied id that is deliberately NOT
// the registered agent's uuid — exactly like the live MCP (DISPATCH_AGENT_ID ??
// "mcp-agent"). If provenance were derived from created_by this id would fail to
// match the agents table; the actor TYPE is what makes the signal reliable.
const agentActor: Actor = { type: "agent", id: "mcp-agent" };

function freshWg(): Dispatch {
  return Dispatch.open(":memory:", new TestClock());
}

/** A claimed (in_progress) ticket the agent can record evidence against. */
function claimedTicket(wg: Dispatch): { ticketId: string; acId: string; claimToken: string } {
  const t = wg.createTicket(
    { title: "Ship it", description: "deliver the thing", policy_pack: "solo_loose" },
    human,
  );
  const { ac } = wg.addAcceptanceCriterion({ ticket_id: t.id, text: "Returns 200" }, human);
  wg.markReady(t.id, human);
  const agent = wg.registerAgent({ display_name: "delivery-bot" }, human);
  const claim = wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, agentActor);
  return { ticketId: t.id, acId: ac.id, claimToken: claim!.claimToken };
}

describe("evidence provenance — recorded_by_agent is derived from the recording actor type", () => {
  it("flags AGENT-recorded evidence even though created_by is not the registered agent id", () => {
    const wg = freshWg();
    const { ticketId, acId, claimToken } = claimedTicket(wg);
    wg.recordEvidence(
      {
        claimToken,
        ticket_id: ticketId,
        ac_id: acId,
        evidence_type: "diff_summary",
        summary: "agent: implemented the endpoint",
      },
      agentActor,
    );

    const row = wg.view(ticketId).evidence.find((e) => e.summary.startsWith("agent:"));
    expect(row).toBeTruthy();
    // created_by is the runner-supplied actor id, NOT a registered agent uuid …
    expect(row!.created_by).toBe("mcp-agent");
    // … yet the row is correctly flagged as an agent self-report, because the
    // stored actor TYPE — not created_by — drives the classification.
    expect(row!.recorded_by_actor_type).toBe("agent");
    expect(row!.recorded_by_agent).toBe(true);
  });

  it("does NOT flag HUMAN-recorded evidence (trusted principal)", () => {
    const wg = freshWg();
    const { ticketId, acId } = claimedTicket(wg);
    // A human actor may attach evidence with no claim token.
    wg.recordEvidence(
      {
        ticket_id: ticketId,
        ac_id: acId,
        evidence_type: "manual_note",
        summary: "human: eyeballed the diff",
      },
      human,
    );

    const row = wg.view(ticketId).evidence.find((e) => e.summary.startsWith("human:"));
    expect(row).toBeTruthy();
    expect(row!.recorded_by_actor_type).toBe("human");
    expect(row!.recorded_by_agent).toBe(false);
  });

  it("treats a legacy row (column NULL, pre-migration backfill) as unknown — flag false", () => {
    const wg = freshWg();
    const { ticketId, acId, claimToken } = claimedTicket(wg);
    wg.recordEvidence(
      {
        claimToken,
        ticket_id: ticketId,
        ac_id: acId,
        evidence_type: "diff_summary",
        summary: "agent: implemented the endpoint",
      },
      agentActor,
    );
    // Model the backfill state of a DB migrated from < v20: the column exists but
    // is NULL for rows written before it. Such rows must NOT be reported as an
    // agent self-report (and the UI asserts no "trusted" label — it shows who/when).
    wg.db.prepare("UPDATE evidence SET recorded_by_actor_type = NULL").run();

    for (const row of wg.view(ticketId).evidence) {
      expect(row.recorded_by_actor_type).toBeNull();
      expect(row.recorded_by_agent).toBe(false);
    }
  });
});

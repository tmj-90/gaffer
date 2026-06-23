import { describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { TestClock } from "../src/util/clock.js";
import { DispatchError } from "../src/util/errors.js";

const human: Actor = { type: "human", id: "tom" };
const admin: Actor = { type: "admin", id: "boss" };
const agentActor: Actor = { type: "agent", id: "agent-runner" };
const systemActor: Actor = { type: "system" };

function freshWg(clock = new TestClock()): Dispatch {
  return Dispatch.open(":memory:", clock);
}

/** Create a ready, claimable ticket. Returns its id. */
function readyTicket(
  wg: Dispatch,
  opts: { risk?: "low" | "medium" | "high" | "critical"; title?: string } = {},
): string {
  const t = wg.createTicket(
    { title: opts.title ?? "Task", policy_pack: "solo_loose", risk_level: opts.risk ?? "low" },
    human,
  );
  wg.markReady(t.id, human);
  return t.id;
}

// --- 1. record_delivery_artifact -----------------------------------------

describe("record_delivery_artifact", () => {
  it("an agent records branch/PR with a valid claim token; it persists onto the ticket", () => {
    const wg = freshWg();
    const ticketId = readyTicket(wg);
    const agent = wg.registerAgent({ display_name: "a" }, human);
    const claim = wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 300 }, agentActor);

    const res = wg.recordDeliveryArtifact(
      {
        ticket_id: ticketId,
        claim_token: claim!.claimToken,
        branch_name: "feature/x",
        pr_url: "https://example.com/pr/1",
        commit: "abc123",
        diff_summary: "+10 -2",
      },
      agentActor,
    );
    expect(res.branchName).toBe("feature/x");
    expect(res.prUrl).toBe("https://example.com/pr/1");

    // Visible via get_ticket / view.
    const view = wg.view(ticketId);
    expect(view.ticket.branch_name).toBe("feature/x");
    expect(view.ticket.pr_url).toBe("https://example.com/pr/1");

    // commit + diff_summary ride on the event payload.
    const ev = view.events.find((e) => e.event_type === "ticket.delivery_recorded");
    expect(ev).toBeDefined();
    expect(ev!.payload_json).toContain("abc123");
    expect(ev!.payload_json).toContain("+10 -2");
  });

  it("rejects an agent recording without a claim token (CLAIM_REQUIRED)", () => {
    const wg = freshWg();
    const ticketId = readyTicket(wg);
    const agent = wg.registerAgent({ display_name: "a" }, human);
    wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 300 }, agentActor);

    try {
      wg.recordDeliveryArtifact({ ticket_id: ticketId, branch_name: "b" }, agentActor);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DispatchError);
      expect((err as DispatchError).code).toBe("CLAIM_REQUIRED");
    }
  });

  it("rejects an agent token for a different ticket (CLAIM_INVALID)", () => {
    const wg = freshWg();
    const target = readyTicket(wg, { title: "target" });
    const other = readyTicket(wg, { title: "other" });
    const a1 = wg.registerAgent({ display_name: "a1" }, human);
    const a2 = wg.registerAgent({ display_name: "a2" }, human);
    const c1 = wg.claimNextTicket({ agentId: a1.id, ttlSeconds: 300 }, agentActor);
    const c2 = wg.claimNextTicket({ agentId: a2.id, ttlSeconds: 300 }, agentActor);
    const wrong = c2!.ticketId === target ? other : target;
    void c1;

    expect(() =>
      wg.recordDeliveryArtifact(
        { ticket_id: wrong, claim_token: c2!.claimToken, branch_name: "b" },
        agentActor,
      ),
    ).toThrowError(DispatchError);
  });

  it("a human may record tokenlessly", () => {
    const wg = freshWg();
    const ticketId = readyTicket(wg);
    const res = wg.recordDeliveryArtifact(
      { ticket_id: ticketId, pr_url: "https://example.com/pr/9" },
      human,
    );
    expect(res.prUrl).toBe("https://example.com/pr/9");
  });

  it("requires at least one of branch_name/pr_url", () => {
    const wg = freshWg();
    const ticketId = readyTicket(wg);
    expect(() =>
      wg.recordDeliveryArtifact({ ticket_id: ticketId, commit: "abc" }, human),
    ).toThrow();
  });
});

// --- 2. claim a chosen ticket --------------------------------------------

describe("claimTicket (claim a chosen ticket)", () => {
  it("claims the NAMED ticket, not a different higher-priority one", () => {
    const wg = freshWg();
    // Higher-priority ticket the agent could also claim.
    const high = wg.createTicket(
      { title: "high", policy_pack: "solo_loose", risk_level: "low", priority: 100 },
      human,
    );
    wg.markReady(high.id, human);
    const chosen = readyTicket(wg, { title: "chosen" });
    const agent = wg.registerAgent({ display_name: "a" }, human);

    const res = wg.claimTicket(
      { ticket_id: chosen, agent_id: agent.id, ttl_seconds: 300 },
      agentActor,
    );
    expect(res.ticketId).toBe(chosen);
    // The higher-priority ticket is untouched.
    expect(wg.view(high.id).ticket.status).toBe("ready");
  });

  it("claims by ticket number too", () => {
    const wg = freshWg();
    const chosen = readyTicket(wg, { title: "by-number" });
    const number = wg.view(chosen).ticket.number!;
    const agent = wg.registerAgent({ display_name: "a" }, human);

    const res = wg.claimTicket(
      { ticket_id: String(number), agent_id: agent.id, ttl_seconds: 300 },
      agentActor,
    );
    expect(res.ticketId).toBe(chosen);
  });

  it("rejects an ineligible (over-risk) ticket with TICKET_NOT_CLAIMABLE", () => {
    const wg = freshWg();
    const risky = readyTicket(wg, { risk: "critical", title: "risky" });
    const agent = wg.registerAgent({ display_name: "a", max_risk: "medium" }, human);

    try {
      wg.claimTicket({ ticket_id: risky, agent_id: agent.id, ttl_seconds: 300 }, agentActor);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DispatchError);
      expect((err as DispatchError).code).toBe("TICKET_NOT_CLAIMABLE");
    }
  });

  it("rejects a non-ready (draft) ticket", () => {
    const wg = freshWg();
    const draft = wg.createTicket({ title: "draft", policy_pack: "solo_loose" }, human);
    const agent = wg.registerAgent({ display_name: "a" }, human);

    expect(() =>
      wg.claimTicket({ ticket_id: draft.id, agent_id: agent.id, ttl_seconds: 300 }, agentActor),
    ).toThrowError(DispatchError);
  });

  it("rejects when an agent lacks a required capability", () => {
    const wg = freshWg();
    const ticketId = readyTicket(wg);
    wg.setRequiredCapabilities({ ticket_id: ticketId, capabilities: ["rust"] }, human);
    const agent = wg.registerAgent({ display_name: "a", capabilities: ["typescript"] }, human);

    expect(() =>
      wg.claimTicket({ ticket_id: ticketId, agent_id: agent.id, ttl_seconds: 300 }, agentActor),
    ).toThrowError(DispatchError);
  });

  it("rejects a ticket already actively claimed by someone else", () => {
    const wg = freshWg();
    const ticketId = readyTicket(wg);
    const a1 = wg.registerAgent({ display_name: "a1" }, human);
    const a2 = wg.registerAgent({ display_name: "a2" }, human);
    wg.claimTicket({ ticket_id: ticketId, agent_id: a1.id, ttl_seconds: 300 }, agentActor);

    try {
      wg.claimTicket({ ticket_id: ticketId, agent_id: a2.id, ttl_seconds: 300 }, agentActor);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as DispatchError).code).toBe("TICKET_NOT_CLAIMABLE");
    }
  });

  it("reclaims a chosen ticket whose claim has expired (no sweep needed)", () => {
    const clock = new TestClock();
    const wg = freshWg(clock);
    const ticketId = readyTicket(wg);
    const a1 = wg.registerAgent({ display_name: "a1" }, human);
    const a2 = wg.registerAgent({ display_name: "a2" }, human);
    wg.claimTicket({ ticket_id: ticketId, agent_id: a1.id, ttl_seconds: 60 }, agentActor);
    clock.advanceSeconds(120);

    const res = wg.claimTicket(
      { ticket_id: ticketId, agent_id: a2.id, ttl_seconds: 60 },
      agentActor,
    );
    expect(res.ticketId).toBe(ticketId);
    const active = wg.listActiveClaims().filter((c) => c.ticket_id === ticketId);
    expect(active).toHaveLength(1);
    expect(active[0]?.agent_id).toBe(a2.id);
  });
});

// --- 4. regulated readiness via persisted approval -----------------------

describe("regulated ready-approval gate", () => {
  /** Build a regulated ticket that passes every readiness gate except approval. */
  function regulatedReadyCandidate(wg: Dispatch): string {
    wg.registerRepository({ name: "web", default_branch: "main" }, human);
    const t = wg.createTicket(
      {
        title: "Regulated change",
        description: "A described change",
        policy_pack: "regulated",
        risk_level: "low",
      },
      human,
    );
    wg.linkRepository(t.id, "web", "primary", human);
    wg.addAcceptanceCriterion(
      { ticket_id: t.id, text: "Does the thing", verification_method: "test" },
      human,
    );
    // factory_strict/regulated require a reviewer on the ticket.
    wg.assignReviewer(t.id, "rev", human);
    return t.id;
  }

  it("cannot go ready without a human ready-approval", () => {
    const wg = freshWg();
    const ticketId = regulatedReadyCandidate(wg);
    try {
      wg.markReady(ticketId, human);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DispatchError);
      expect((err as DispatchError).code).toBe("POLICY_DENIED");
      const details = (err as DispatchError).details as {
        policy?: { failures?: Array<{ code: string }> };
      };
      const codes = (details.policy?.failures ?? []).map((f) => f.code);
      expect(codes).toContain("HUMAN_APPROVAL_REQUIRED");
    }
  });

  it("goes ready once a human grants the ready-approval", () => {
    const wg = freshWg();
    const ticketId = regulatedReadyCandidate(wg);
    wg.grantReadyApproval(ticketId, admin);
    const res = wg.markReady(ticketId, human);
    expect(res.ticket.status).toBe("ready");
  });

  it("an agent may not grant a ready-approval", () => {
    const wg = freshWg();
    const ticketId = regulatedReadyCandidate(wg);
    try {
      wg.grantReadyApproval(ticketId, agentActor);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as DispatchError).code).toBe("ACTOR_NOT_PERMITTED");
    }
  });
});

// --- 4b. reviewer-assignment gate (REVIEWER_REQUIRED) --------------------

describe("assignReviewer reviewer-assignment gate", () => {
  type StrictPack = "factory_strict" | "regulated";

  /**
   * Build a strict-pack ticket that passes every readiness gate EXCEPT the
   * reviewer requirement. For `regulated` the human ready-approval is granted
   * up front so the only remaining failure is REVIEWER_REQUIRED.
   */
  function strictReadyCandidate(wg: Dispatch, pack: StrictPack): string {
    wg.registerRepository({ name: "web", default_branch: "main" }, human);
    const t = wg.createTicket(
      {
        title: "Strict change",
        description: "A described change",
        policy_pack: pack,
        risk_level: "low",
      },
      human,
    );
    wg.linkRepository(t.id, "web", "primary", human);
    wg.addAcceptanceCriterion(
      { ticket_id: t.id, text: "Does the thing", verification_method: "test" },
      human,
    );
    if (pack === "regulated") {
      wg.grantReadyApproval(t.id, admin);
    }
    return t.id;
  }

  for (const pack of ["factory_strict", "regulated"] as const) {
    it(`a ${pack} ticket cannot go ready without a reviewer assigned`, () => {
      const wg = freshWg();
      const ticketId = strictReadyCandidate(wg, pack);
      try {
        wg.markReady(ticketId, human);
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(DispatchError);
        expect((err as DispatchError).code).toBe("POLICY_DENIED");
        const details = (err as DispatchError).details as {
          policy?: { failures?: Array<{ code: string }> };
        };
        const codes = (details.policy?.failures ?? []).map((f) => f.code);
        expect(codes).toContain("REVIEWER_REQUIRED");
      }
    });

    it(`a ${pack} ticket goes ready once a reviewer is assigned`, () => {
      const wg = freshWg();
      const ticketId = strictReadyCandidate(wg, pack);

      const res = wg.assignReviewer(ticketId, "alice", human);
      expect(res.reviewer).toBe("alice");
      expect(wg.view(ticketId).ticket.reviewer).toBe("alice");
      // Audit event recorded.
      const ev = wg.view(ticketId).events.find((e) => e.event_type === "ticket.reviewer_assigned");
      expect(ev).toBeDefined();

      const ready = wg.markReady(ticketId, human);
      expect(ready.ticket.status).toBe("ready");
    });
  }

  it("an admin may also assign a reviewer", () => {
    const wg = freshWg();
    const ticketId = strictReadyCandidate(wg, "factory_strict");
    wg.assignReviewer(ticketId, "rev", admin);
    expect(wg.markReady(ticketId, human).ticket.status).toBe("ready");
  });

  it("an agent may not assign a reviewer", () => {
    const wg = freshWg();
    const ticketId = strictReadyCandidate(wg, "factory_strict");
    try {
      wg.assignReviewer(ticketId, "rev", agentActor);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as DispatchError).code).toBe("ACTOR_NOT_PERMITTED");
    }
    // The reviewer was not set, so readiness is still blocked.
    expect(wg.view(ticketId).ticket.reviewer).toBeNull();
  });

  it("rejects an empty reviewer id", () => {
    const wg = freshWg();
    const ticketId = strictReadyCandidate(wg, "regulated");
    try {
      wg.assignReviewer(ticketId, "   ", human);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as DispatchError).code).toBe("VALIDATION_ERROR");
    }
  });
});

// --- 5. set required capabilities writer ---------------------------------

describe("setRequiredCapabilities", () => {
  it("round-trips the capability set and replaces it on a second call", () => {
    const wg = freshWg();
    const ticketId = readyTicket(wg);
    wg.setRequiredCapabilities({ ticket_id: ticketId, capabilities: ["rust", "tests"] }, human);
    expect(wg.listRequiredCapabilities(ticketId).sort()).toEqual(["rust", "tests"]);

    wg.setRequiredCapabilities({ ticket_id: ticketId, capabilities: ["go"] }, human);
    expect(wg.listRequiredCapabilities(ticketId)).toEqual(["go"]);

    wg.setRequiredCapabilities({ ticket_id: ticketId, capabilities: [] }, human);
    expect(wg.listRequiredCapabilities(ticketId)).toEqual([]);
  });

  it("is enforced by claim eligibility", () => {
    const wg = freshWg();
    const ticketId = readyTicket(wg);
    wg.setRequiredCapabilities({ ticket_id: ticketId, capabilities: ["rust"] }, human);

    const missing = wg.registerAgent({ display_name: "ts", capabilities: ["typescript"] }, human);
    expect(wg.claimNextTicket({ agentId: missing.id, ttlSeconds: 300 }, agentActor)).toBeNull();

    const holder = wg.registerAgent({ display_name: "rust", capabilities: ["rust"] }, human);
    const res = wg.claimNextTicket({ agentId: holder.id, ttlSeconds: 300 }, agentActor);
    expect(res?.ticketId).toBe(ticketId);
  });

  it("a system actor can also record a delivery artifact tokenlessly", () => {
    const wg = freshWg();
    const ticketId = readyTicket(wg);
    const res = wg.recordDeliveryArtifact(
      { ticket_id: ticketId, branch_name: "sys/branch" },
      systemActor,
    );
    expect(res.branchName).toBe("sys/branch");
  });
});

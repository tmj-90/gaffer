import { describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor, PolicyPack } from "../src/domain/types.js";
import { TestClock } from "../src/util/clock.js";
import { DispatchError } from "../src/util/errors.js";

const human: Actor = { type: "human", id: "tom" };

function fresh(): Dispatch {
  return Dispatch.open(":memory:", new TestClock());
}

/** Ready-failure codes for a ticket, or [] if ready would succeed. */
function readyFailures(wg: Dispatch, ticketId: string): string[] {
  const res = wg.transitions.preview(ticketId, "ready");
  return res?.allowed ? [] : (res?.failures.map((f) => f.code) ?? []);
}

/**
 * Build a ticket that satisfies every strict gate EXCEPT scope/repo, so each test
 * can layer in just the repo/scope state it wants to assert on. Sets reviewer +
 * a verified AC (factory_strict/regulated need both).
 */
function strictReadyBase(wg: Dispatch, pack: PolicyPack): string {
  const t = wg.createTicket({ title: "Strict", description: "desc", policy_pack: pack }, human);
  wg.addAcceptanceCriterion(
    { ticket_id: t.id, text: "Does X", verification_method: "unit test" },
    human,
  );
  wg.assignReviewer(t.id, "reviewer", human);
  if (pack === "regulated") wg.grantReadyApproval(t.id, human);
  return t.id;
}

describe("WG-003 / TEST-002: solo_loose", () => {
  it("can mark a scope-less, repo-less ticket ready (with ≥1 AC)", () => {
    const wg = fresh();
    const t = wg.createTicket({ title: "Quick", policy_pack: "solo_loose" }, human);
    wg.addAcceptanceCriterion({ ticket_id: t.id, text: "Does the thing" }, human);
    const res = wg.markReady(t.id, human);
    expect(res.ticket.status).toBe("ready");
    wg.db.close();
  });

  it("a missing repo is a warning, not a blocker", () => {
    const wg = fresh();
    const t = wg.createTicket({ title: "Quick", policy_pack: "solo_loose" }, human);
    wg.addAcceptanceCriterion({ ticket_id: t.id, text: "Does the thing" }, human);
    const res = wg.transitions.preview(t.id, "ready");
    expect(res?.allowed).toBe(true);
    expect(res?.warnings.map((w) => w.code)).toContain("REPO_RECOMMENDED");
    wg.db.close();
  });
});

// GUARD A (waste-guards): a 0-AC ticket must never be deliverable. Every
// delivery-bound policy, solo_loose included, rejects a 0-AC ticket at `ready`.
describe("GUARD A: ≥1 acceptance criterion required at ready (all packs)", () => {
  it("blocks a 0-AC solo_loose ticket with AC_REQUIRED", () => {
    const wg = fresh();
    const t = wg.createTicket({ title: "No ACs", policy_pack: "solo_loose" }, human);
    expect(readyFailures(wg, t.id)).toContain("AC_REQUIRED");
    expect(() => wg.markReady(t.id, human)).toThrowError(DispatchError);
    wg.db.close();
  });

  it("a 1-AC solo_loose ticket still readies (AC_REQUIRED cleared)", () => {
    const wg = fresh();
    const t = wg.createTicket({ title: "Has AC", policy_pack: "solo_loose" }, human);
    wg.addAcceptanceCriterion({ ticket_id: t.id, text: "Does X" }, human);
    expect(readyFailures(wg, t.id)).not.toContain("AC_REQUIRED");
    expect(wg.markReady(t.id, human).ticket.status).toBe("ready");
    wg.db.close();
  });

  it("blocks a 0-AC team_light ticket with AC_REQUIRED", () => {
    const wg = fresh();
    const t = wg.createTicket({ title: "T", description: "d", policy_pack: "team_light" }, human);
    expect(readyFailures(wg, t.id)).toContain("AC_REQUIRED");
    wg.db.close();
  });
});

describe("WG-003 / TEST-002: team_light", () => {
  it("blocks a ticket with NO repo at all", () => {
    const wg = fresh();
    const t = wg.createTicket({ title: "T", description: "d", policy_pack: "team_light" }, human);
    wg.addAcceptanceCriterion({ ticket_id: t.id, text: "AC" }, human);
    expect(readyFailures(wg, t.id)).toContain("REPO_REQUIRED");
    expect(() => wg.markReady(t.id, human)).toThrowError(DispatchError);
    wg.db.close();
  });

  it("accepts a single UNMAPPED repo as a valid write scope (mono fallback)", () => {
    const wg = fresh();
    const t = wg.createTicket({ title: "T", description: "d", policy_pack: "team_light" }, human);
    wg.addAcceptanceCriterion({ ticket_id: t.id, text: "AC" }, human);
    wg.registerRepository({ name: "solo" }, human);
    wg.linkRepository(t.id, "solo", "primary", human); // defaults to write/confirmed
    expect(wg.markReady(t.id, human).ticket.status).toBe("ready");
    wg.db.close();
  });

  it("accepts a MAPPED write repo", () => {
    const wg = fresh();
    const node = wg.createScopeNode({ name: "Prod", type: "product" }, human);
    const repo = wg.registerRepository({ name: "mapped" }, human);
    wg.linkScopeRepo({ scope_node_id: node.id, repo_id: repo.id, relation: "owns" }, human);
    const t = wg.createTicket({ title: "T", description: "d", policy_pack: "team_light" }, human);
    wg.addAcceptanceCriterion({ ticket_id: t.id, text: "AC" }, human);
    wg.linkRepository(t.id, "mapped", "primary", human);
    expect(wg.markReady(t.id, human).ticket.status).toBe("ready");
    wg.db.close();
  });

  it("blocks when the only repo has NO write access (read-only-only ticket)", () => {
    const wg = fresh();
    const t = wg.createTicket({ title: "T", description: "d", policy_pack: "team_light" }, human);
    wg.addAcceptanceCriterion({ ticket_id: t.id, text: "AC" }, human);
    const repo = wg.registerRepository({ name: "ctx" }, human);
    wg.setTicketRepoAccess(
      { ticket_id: t.id, repo_id: repo.id, access: "read", relation: "context_only" },
      human,
    );
    expect(readyFailures(wg, t.id)).toContain("WRITE_REPO_REQUIRED");
    wg.db.close();
  });
});

describe("WG-003 / TEST-002: factory_strict", () => {
  it("requires a primary scope when the repo is MAPPED (no mono fallback)", () => {
    const wg = fresh();
    const node = wg.createScopeNode({ name: "Prod", type: "product" }, human);
    const repo = wg.registerRepository({ name: "mapped" }, human);
    wg.linkScopeRepo(
      { scope_node_id: node.id, repo_id: repo.id, relation: "owns", default_access: "write" },
      human,
    );
    const t = strictReadyBase(wg, "factory_strict");
    wg.linkRepository(t, "mapped", "primary", human);

    // Mapped repo → mono_fallback does NOT apply → primary scope is required.
    expect(readyFailures(wg, t)).toContain("PRIMARY_SCOPE_REQUIRED");

    // Setting a primary scope clears the gate.
    wg.setPrimaryScope(t, node.id, human);
    expect(wg.markReady(t, human).ticket.status).toBe("ready");
    wg.db.close();
  });

  it("accepts mono fallback when exactly one DIRECT unmapped repo is selected", () => {
    const wg = fresh();
    const t = strictReadyBase(wg, "factory_strict");
    wg.registerRepository({ name: "solo" }, human);
    wg.linkRepository(t, "solo", "primary", human); // unmapped, single → mono fallback

    // No primary scope, but mono_fallback applies → ready passes.
    expect(readyFailures(wg, t)).not.toContain("PRIMARY_SCOPE_REQUIRED");
    expect(wg.markReady(t, human).ticket.status).toBe("ready");
    wg.db.close();
  });

  it("blocks unresolved 'suggested' repos until accepted or rejected", () => {
    const wg = fresh();
    const t = strictReadyBase(wg, "factory_strict");
    wg.registerRepository({ name: "solo" }, human);
    wg.linkRepository(t, "solo", "primary", human); // confirmed write → satisfies write + mono fallback
    const suggested = wg.registerRepository({ name: "maybe" }, human);
    wg.setTicketRepoAccess(
      {
        ticket_id: t,
        repo_id: suggested.id,
        access: "write",
        relation: "suggested",
        confidence: 0.5,
      },
      human,
    );

    expect(readyFailures(wg, t)).toContain("SUGGESTED_REPO_UNRESOLVED");

    // Rejecting the suggestion clears the block; the rejected row is retained.
    wg.setTicketRepoAccess(
      { ticket_id: t, repo_id: suggested.id, access: "none", relation: "rejected" },
      human,
    );
    expect(readyFailures(wg, t)).not.toContain("SUGGESTED_REPO_UNRESOLVED");
    // ... but now there are two repos, so mono fallback no longer applies and a
    // primary scope IS required. Confirm the rejected repo does not resurrect the
    // suggested block, and set a primary scope to finish.
    const node = wg.createScopeNode({ name: "Prod", type: "product" }, human);
    wg.setPrimaryScope(t, node.id, human);
    expect(wg.markReady(t, human).ticket.status).toBe("ready");
    wg.db.close();
  });

  it("accepting a suggested repo (→confirmed) also clears the block", () => {
    const wg = fresh();
    const node = wg.createScopeNode({ name: "Prod", type: "product" }, human);
    const t = strictReadyBase(wg, "factory_strict");
    wg.setPrimaryScope(t, node.id, human);
    const repo = wg.registerRepository({ name: "maybe" }, human);
    wg.setTicketRepoAccess(
      { ticket_id: t, repo_id: repo.id, access: "write", relation: "suggested", confidence: 0.5 },
      human,
    );
    expect(readyFailures(wg, t)).toContain("SUGGESTED_REPO_UNRESOLVED");
    wg.setTicketRepoAccess(
      { ticket_id: t, repo_id: repo.id, access: "write", relation: "confirmed" },
      human,
    );
    expect(wg.markReady(t, human).ticket.status).toBe("ready");
    wg.db.close();
  });
});

describe("WG-003 / TEST-002: regulated", () => {
  it("is factory_strict PLUS human ready approval (mono fallback)", () => {
    const wg = fresh();
    const t = wg.createTicket({ title: "Reg", description: "d", policy_pack: "regulated" }, human);
    wg.addAcceptanceCriterion({ ticket_id: t.id, text: "AC", verification_method: "test" }, human);
    wg.assignReviewer(t.id, "reviewer", human);
    wg.registerRepository({ name: "solo" }, human);
    wg.linkRepository(t.id, "solo", "primary", human); // mono fallback

    // Everything but approval is satisfied.
    expect(readyFailures(wg, t.id)).toEqual(["HUMAN_APPROVAL_REQUIRED"]);

    wg.grantReadyApproval(t.id, human);
    expect(wg.markReady(t.id, human).ticket.status).toBe("ready");
    wg.db.close();
  });

  it("requires a primary scope for a MAPPED repo, on top of approval", () => {
    const wg = fresh();
    const node = wg.createScopeNode({ name: "Prod", type: "product" }, human);
    const repo = wg.registerRepository({ name: "mapped" }, human);
    wg.linkScopeRepo(
      { scope_node_id: node.id, repo_id: repo.id, relation: "owns", default_access: "write" },
      human,
    );
    const t = strictReadyBase(wg, "regulated");
    wg.linkRepository(t, "mapped", "primary", human);

    expect(readyFailures(wg, t)).toContain("PRIMARY_SCOPE_REQUIRED");
    wg.setPrimaryScope(t, node.id, human);
    expect(wg.markReady(t, human).ticket.status).toBe("ready");
    wg.db.close();
  });
});

describe("WG-003: actionable error on a denied transition", () => {
  it("POLICY_DENIED carries the structured failure codes + messages", () => {
    const wg = fresh();
    const t = wg.createTicket({ title: "T", description: "d", policy_pack: "team_light" }, human);
    wg.addAcceptanceCriterion({ ticket_id: t.id, text: "AC" }, human);
    try {
      wg.markReady(t.id, human);
      throw new Error("expected POLICY_DENIED");
    } catch (err) {
      expect(err).toBeInstanceOf(DispatchError);
      const we = err as DispatchError;
      expect(we.code).toBe("POLICY_DENIED");
      const policy = we.details.policy as { failures: Array<{ code: string; message: string }> };
      const repoFail = policy.failures.find((f) => f.code === "REPO_REQUIRED");
      expect(repoFail?.message).toMatch(/repository/i);
    }
    wg.db.close();
  });
});

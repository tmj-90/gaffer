import { describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { TestClock } from "../src/util/clock.js";

const human: Actor = { type: "human", id: "po" };

function fresh(): Dispatch {
  return Dispatch.open(":memory:", new TestClock());
}

/**
 * WG-004 — the Product-Owner create flow composed from existing pieces:
 *   create draft → set scope / select direct repo → suggest → confirm access →
 *   report claimability.
 */
describe("WG-004: PO create flow — scope-based", () => {
  it("scope create: draft → primary scope → suggestions → confirm write → claimable", () => {
    const wg = fresh();

    // Map a product scope to its repo.
    const node = wg.createScopeNode({ name: "Marketplace", type: "product" }, human);
    const repo = wg.registerRepository({ name: "marketplace-api" }, human);
    wg.linkScopeRepo(
      { scope_node_id: node.id, repo_id: repo.id, relation: "owns", default_access: "write" },
      human,
    );

    // 1. Create draft.
    const ticket = wg.createTicket(
      { title: "Add cashout", description: "Add a cashout button", policy_pack: "team_light" },
      human,
    );

    // 2. Set the primary scope.
    wg.setPrimaryScope(ticket.id, node.id, human);

    // Not claimable yet — the scope is set but no repo is confirmed and no AC.
    const before = wg.claimability(ticket.id);
    expect(before.ready).toBe(false);
    expect(before.blockers.map((b) => b.code)).toContain("REPO_REQUIRED");
    expect(before.blockers.map((b) => b.code)).toContain("AC_REQUIRED");

    // 3. Fetch suggestions and 4. confirm the write target.
    const suggestions = wg.suggestReposForTicket({ ticketId: ticket.id }, human);
    const write = suggestions.find((s) => s.suggestedAccess === "write")!;
    expect(write).toBeDefined();
    wg.setTicketRepoAccess(
      {
        ticket_id: ticket.id,
        repo_id: write.repoId,
        access: "write",
        relation: "confirmed",
        source: "scope_inferred",
      },
      human,
    );
    wg.addAcceptanceCriterion({ ticket_id: ticket.id, text: "Cashout works" }, human);

    // 5. Now claimable.
    const after = wg.claimability(ticket.id);
    expect(after.ready).toBe(true);
    expect(after.blockers).toHaveLength(0);

    // And the boundary really has one confirmed write repo.
    const boundary = wg.workPacketRepos(ticket.id);
    expect(boundary.writeRepos).toHaveLength(1);
    expect(boundary.writeRepos[0]!.id).toBe(repo.id);
    wg.db.close();
  });
});

describe("WG-004: PO create flow — direct unmapped repo", () => {
  it("selecting an unmapped repo yields exactly one confirmed mono_fallback write repo", () => {
    const wg = fresh();
    const repo = wg.registerRepository({ name: "standalone" }, human);
    const ticket = wg.createTicket(
      { title: "Tidy README", description: "Tidy up", policy_pack: "team_light" },
      human,
    );

    // Direct repo selection (the PO picks an unmapped repo).
    wg.linkRepository(ticket.id, "standalone", "primary", human);

    // Suggestion engine confirms the mono-fallback shape.
    const suggestions = wg.suggestReposForTicket({ ticketId: ticket.id }, human);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.monoFallback).toBe(true);

    // Apply mono-fallback → exactly one confirmed write repo via implicit_single_repo.
    const result = wg.applyMonoFallback(ticket.id, human);
    expect(result.applied).toBe(true);
    expect(result.repoId).toBe(repo.id);

    const boundary = wg.workPacketRepos(ticket.id);
    expect(boundary.writeRepos).toHaveLength(1);
    expect(boundary.writeRepos[0]!.relation).toBe("implicit_single_repo");
    expect(boundary.writeRepos[0]!.source).toBe("mono_fallback");
    expect(boundary.suggestedRepos).toHaveLength(0);

    // Add an AC and it should be claimable under team_light.
    wg.addAcceptanceCriterion({ ticket_id: ticket.id, text: "README tidy" }, human);
    const claim = wg.claimability(ticket.id);
    expect(claim.ready).toBe(true);
    wg.db.close();
  });
});

describe("WG-004: claimability blockers", () => {
  it("reports actionable blockers for a strict ticket missing scope, repo, AC and reviewer", () => {
    const wg = fresh();
    const ticket = wg.createTicket(
      { title: "Strict", description: "needs everything", policy_pack: "factory_strict" },
      human,
    );

    const c = wg.claimability(ticket.id);
    expect(c.ready).toBe(false);
    const codes = c.blockers.map((b) => b.code);
    expect(codes).toContain("REPO_REQUIRED");
    expect(codes).toContain("AC_REQUIRED");
    expect(codes).toContain("PRIMARY_SCOPE_REQUIRED");
    expect(codes).toContain("REVIEWER_REQUIRED");
    // Each blocker carries a human message.
    expect(c.blockers.every((b) => b.message.length > 0)).toBe(true);
    wg.db.close();
  });

  it("solo_loose: a scope-less, repo-less ticket is claimable (warnings only)", () => {
    const wg = fresh();
    const ticket = wg.createTicket(
      { title: "Quick note", description: "", policy_pack: "solo_loose" },
      human,
    );
    const c = wg.claimability(ticket.id);
    expect(c.ready).toBe(true);
    expect(c.blockers).toHaveLength(0);
    // Non-blocking hints still surface.
    expect(c.warnings.map((w) => w.code)).toContain("REPO_RECOMMENDED");
    wg.db.close();
  });

  it("an unresolved suggested repo blocks a strict ticket until confirmed/rejected", () => {
    const wg = fresh();
    const node = wg.createScopeNode({ name: "S", type: "product" }, human);
    const repo = wg.registerRepository({ name: "s-api" }, human);
    wg.linkScopeRepo(
      { scope_node_id: node.id, repo_id: repo.id, relation: "owns", default_access: "write" },
      human,
    );
    const ticket = wg.createTicket(
      { title: "Strict suggested", description: "d", policy_pack: "factory_strict" },
      human,
    );
    wg.setPrimaryScope(ticket.id, node.id, human);
    wg.assignReviewer(ticket.id, "lead", human);
    wg.addAcceptanceCriterion(
      { ticket_id: ticket.id, text: "Works", verification_method: "test" },
      human,
    );
    // A suggested (not confirmed) repo link.
    wg.setTicketRepoAccess(
      {
        ticket_id: ticket.id,
        repo_id: repo.id,
        access: "write",
        relation: "suggested",
        source: "scope_inferred",
      },
      human,
    );

    const blocked = wg.claimability(ticket.id);
    expect(blocked.ready).toBe(false);
    expect(blocked.blockers.map((b) => b.code)).toContain("SUGGESTED_REPO_UNRESOLVED");

    // Confirm it → now claimable.
    wg.setTicketRepoAccess(
      {
        ticket_id: ticket.id,
        repo_id: repo.id,
        access: "write",
        relation: "confirmed",
        source: "scope_inferred",
      },
      human,
    );
    expect(wg.claimability(ticket.id).ready).toBe(true);
    wg.db.close();
  });
});

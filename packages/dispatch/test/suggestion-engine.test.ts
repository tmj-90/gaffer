import { describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { TestClock } from "../src/util/clock.js";

const human: Actor = { type: "human", id: "tom" };

function fresh(): Dispatch {
  return Dispatch.open(":memory:", new TestClock());
}

/**
 * FG-005 suggestion engine. The fixtures here build small slices of a
 * marketplace/trading factory graph: a product scope owning its API repo, a
 * shared library used as read context, a one-to-many scope, a multi-home repo,
 * and an unmapped standalone repo for the mono-fallback path.
 */
describe("FG-005: scope→repo suggestion engine", () => {
  it("one-to-one: a scope owning a repo suggests WRITE with high confidence", () => {
    const wg = fresh();
    const node = wg.createScopeNode({ name: "Marketplace", type: "product" }, human);
    const repo = wg.registerRepository({ name: "marketplace-api" }, human);
    wg.linkScopeRepo(
      { scope_node_id: node.id, repo_id: repo.id, relation: "owns", default_access: "write" },
      human,
    );

    const out = wg.suggestReposForTicket({ scopeNodeIds: [node.id] }, human);
    expect(out).toHaveLength(1);
    const s = out[0]!;
    expect(s.repoId).toBe(repo.id);
    expect(s.suggestedAccess).toBe("write");
    expect(s.confidence).toBeGreaterThanOrEqual(0.9);
    expect(s.lowConfidence).toBe(false);
    expect(s.monoFallback).toBe(false);
    expect(s.reasons.join(" ")).toContain("scope 'Marketplace' owns/targets this repo");
    wg.db.close();
  });

  it("one-to-many: a scope mapped to multiple repos suggests each", () => {
    const wg = fresh();
    const node = wg.createScopeNode({ name: "Trading", type: "system" }, human);
    const core = wg.registerRepository({ name: "trading-core" }, human);
    const feed = wg.registerRepository({ name: "trading-feed" }, human);
    const shared = wg.registerRepository({ name: "shared-utils" }, human);
    wg.linkScopeRepo(
      {
        scope_node_id: node.id,
        repo_id: core.id,
        relation: "write_target",
        default_access: "write",
      },
      human,
    );
    wg.linkScopeRepo(
      { scope_node_id: node.id, repo_id: feed.id, relation: "owns", default_access: "write" },
      human,
    );
    wg.linkScopeRepo(
      {
        scope_node_id: node.id,
        repo_id: shared.id,
        relation: "read_context",
        default_access: "read",
      },
      human,
    );

    const out = wg.suggestReposForTicket({ scopeNodeIds: [node.id] }, human);
    expect(out).toHaveLength(3);
    const byName = new Map(out.map((s) => [s.repoName, s]));
    expect(byName.get("trading-core")!.suggestedAccess).toBe("write");
    expect(byName.get("trading-feed")!.suggestedAccess).toBe("write");
    expect(byName.get("shared-utils")!.suggestedAccess).toBe("read");
    expect(byName.get("shared-utils")!.reasons.join(" ")).toContain(
      "read context for scope 'Trading'",
    );
    wg.db.close();
  });

  it("multi-home repo: a repo gets different access under different scopes", () => {
    const wg = fresh();
    const owner = wg.createScopeNode({ name: "Payments", type: "product" }, human);
    const consumer = wg.createScopeNode({ name: "Reporting", type: "product" }, human);
    const repo = wg.registerRepository({ name: "ledger" }, human);
    // Payments OWNS the ledger (write); Reporting only READS it as context.
    wg.linkScopeRepo(
      { scope_node_id: owner.id, repo_id: repo.id, relation: "owns", default_access: "write" },
      human,
    );
    wg.linkScopeRepo(
      {
        scope_node_id: consumer.id,
        repo_id: repo.id,
        relation: "read_context",
        default_access: "read",
      },
      human,
    );

    // Under the owning scope → write.
    const asOwner = wg.suggestReposForTicket({ scopeNodeIds: [owner.id] }, human);
    expect(asOwner).toHaveLength(1);
    expect(asOwner[0]!.suggestedAccess).toBe("write");

    // Under the consuming scope → read.
    const asConsumer = wg.suggestReposForTicket({ scopeNodeIds: [consumer.id] }, human);
    expect(asConsumer).toHaveLength(1);
    expect(asConsumer[0]!.suggestedAccess).toBe("read");

    // Both scopes at once → strongest access wins (write), reasons merged.
    const both = wg.suggestReposForTicket({ scopeNodeIds: [owner.id, consumer.id] }, human);
    expect(both).toHaveLength(1);
    expect(both[0]!.suggestedAccess).toBe("write");
    expect(both[0]!.reasons.length).toBeGreaterThanOrEqual(2);
    wg.db.close();
  });

  it("unmapped repo selected alone → single mono-fallback WRITE suggestion (confidence 1.0)", () => {
    const wg = fresh();
    const repo = wg.registerRepository({ name: "standalone" }, human);

    const out = wg.suggestReposForTicket({ repoIds: [repo.id] }, human);
    expect(out).toHaveLength(1);
    const s = out[0]!;
    expect(s.monoFallback).toBe(true);
    expect(s.suggestedAccess).toBe("write");
    expect(s.confidence).toBe(1.0);
    expect(s.reasons).toContain("single unmapped repo — mono fallback");
    wg.db.close();
  });

  it("a MAPPED repo selected alone does NOT trigger mono-fallback", () => {
    const wg = fresh();
    const node = wg.createScopeNode({ name: "Mapped", type: "product" }, human);
    const repo = wg.registerRepository({ name: "mapped-repo" }, human);
    wg.linkScopeRepo(
      { scope_node_id: node.id, repo_id: repo.id, relation: "owns", default_access: "write" },
      human,
    );

    const out = wg.suggestReposForTicket({ repoIds: [repo.id] }, human);
    expect(out.every((s) => s.monoFallback === false)).toBe(true);
    wg.db.close();
  });

  it("keyword overlap boosts confidence and adds a reason", () => {
    const wg = fresh();
    const node = wg.createScopeNode({ name: "Trading", type: "system" }, human);
    const repo = wg.registerRepository({ name: "pricing-engine", stack: "ts, pricing" }, human);
    // Map as read context so the base confidence is the lower READ value.
    wg.linkScopeRepo(
      {
        scope_node_id: node.id,
        repo_id: repo.id,
        relation: "read_context",
        default_access: "read",
      },
      human,
    );

    const withKeyword = wg.suggestReposForTicket(
      { title: "Improve pricing latency", scopeNodeIds: [node.id] },
      human,
    );
    const noKeyword = wg.suggestReposForTicket(
      { title: "Improve latency", scopeNodeIds: [node.id] },
      human,
    );
    const boosted = withKeyword.find((s) => s.repoName === "pricing-engine")!;
    const base = noKeyword.find((s) => s.repoName === "pricing-engine")!;
    expect(boosted.confidence).toBeGreaterThan(base.confidence);
    expect(boosted.reasons.join(" ")).toContain("ticket mentions 'pricing' matching repo");
    wg.db.close();
  });

  it("labels low-confidence suggestions with lowConfidence:true", () => {
    const wg = fresh();
    const node = wg.createScopeNode({ name: "Context", type: "system" }, human);
    const repo = wg.registerRepository({ name: "context-only-repo" }, human);
    // read_context with no keyword overlap → base 0.4 read, below the 0.5 threshold.
    wg.linkScopeRepo(
      {
        scope_node_id: node.id,
        repo_id: repo.id,
        relation: "read_context",
        default_access: "read",
      },
      human,
    );

    const out = wg.suggestReposForTicket({ scopeNodeIds: [node.id] }, human);
    expect(out).toHaveLength(1);
    expect(out[0]!.confidence).toBeLessThan(0.5);
    expect(out[0]!.lowConfidence).toBe(true);
    wg.db.close();
  });

  it("NEVER auto-confirms write: suggesting does not write ticket_repos", () => {
    const wg = fresh();
    const ticket = wg.createTicket({ title: "Work", description: "d" }, human);
    const node = wg.createScopeNode({ name: "Marketplace", type: "product" }, human);
    const repo = wg.registerRepository({ name: "marketplace-api" }, human);
    wg.linkScopeRepo(
      { scope_node_id: node.id, repo_id: repo.id, relation: "owns", default_access: "write" },
      human,
    );
    wg.setPrimaryScope(ticket.id, node.id, human);

    const out = wg.suggestReposForTicket({ ticketId: ticket.id }, human);
    expect(out.some((s) => s.suggestedAccess === "write")).toBe(true);

    // The execution boundary must remain empty — nothing was confirmed.
    const boundary = wg.workPacketRepos(ticket.id);
    expect(boundary.writeRepos).toHaveLength(0);
    expect(boundary.readOnlyRepos).toHaveLength(0);
    expect(boundary.suggestedRepos).toHaveLength(0);
    wg.db.close();
  });

  it("de-dupes by repo (max confidence wins, reasons merged) across scopes", () => {
    const wg = fresh();
    const a = wg.createScopeNode({ name: "A", type: "product" }, human);
    const b = wg.createScopeNode({ name: "B", type: "product" }, human);
    const repo = wg.registerRepository({ name: "shared-lib" }, human);
    wg.linkScopeRepo(
      { scope_node_id: a.id, repo_id: repo.id, relation: "read_context", default_access: "read" },
      human,
    );
    wg.linkScopeRepo(
      { scope_node_id: b.id, repo_id: repo.id, relation: "owns", default_access: "write" },
      human,
    );

    const out = wg.suggestReposForTicket({ scopeNodeIds: [a.id, b.id] }, human);
    expect(out).toHaveLength(1);
    expect(out[0]!.suggestedAccess).toBe("write");
    expect(out[0]!.reasons.length).toBe(2);
    wg.db.close();
  });

  it("suggesting for an existing ticket with a lone unmapped repo yields mono-fallback", () => {
    const wg = fresh();
    const ticket = wg.createTicket({ title: "Fix bug", description: "d" }, human);
    wg.registerRepository({ name: "solo" }, human);
    wg.linkRepository(ticket.id, "solo", "primary", human);

    const out = wg.suggestReposForTicket({ ticketId: ticket.id }, human);
    expect(out).toHaveLength(1);
    expect(out[0]!.monoFallback).toBe(true);
    expect(out[0]!.suggestedAccess).toBe("write");
    wg.db.close();
  });
});

import { describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { makeHandlers } from "../src/mcp/tools.js";
import { TestClock } from "../src/util/clock.js";

const human: Actor = { type: "human", id: "tom" };
const agentActor: Actor = { type: "agent", id: "mcp-agent" };

function fresh(): Dispatch {
  return Dispatch.open(":memory:", new TestClock());
}

/** A draft ticket plus a registered repo, returning both ids. */
function ticketWithRepo(wg: Dispatch, repoName = "api"): { ticketId: string; repoId: string } {
  const t = wg.createTicket({ title: "Feature", description: "d" }, human);
  const r = wg.registerRepository({ name: repoName }, human);
  return { ticketId: t.id, repoId: r.id };
}

describe("WG-001: ticket scope links", () => {
  it("links a scope node and lists it on the ticket", () => {
    const wg = fresh();
    const t = wg.createTicket({ title: "T", description: "d" }, human);
    const node = wg.createScopeNode({ name: "Sportsbook", type: "product" }, human);

    wg.linkTicketScope({ ticket_id: t.id, scope_node_id: node.id, relation: "secondary" }, human);
    const scopes = wg.listTicketScopes(t.id);
    expect(scopes).toHaveLength(1);
    expect(scopes[0]?.name).toBe("Sportsbook");
    expect(scopes[0]?.relation).toBe("secondary");
    wg.db.close();
  });

  it("enforces at most ONE primary scope per ticket", () => {
    const wg = fresh();
    const t = wg.createTicket({ title: "T", description: "d" }, human);
    const a = wg.createScopeNode({ name: "A", type: "product" }, human);
    const b = wg.createScopeNode({ name: "B", type: "product" }, human);

    wg.setPrimaryScope(t.id, a.id, human);
    wg.setPrimaryScope(t.id, b.id, human);

    const scopes = wg.listTicketScopes(t.id);
    const primaries = scopes.filter((s) => s.relation === "primary");
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.name).toBe("B");
    // The previous primary was demoted, not deleted.
    const demoted = scopes.find((s) => s.name === "A");
    expect(demoted?.relation).toBe("secondary");
    wg.db.close();
  });

  it("link with relation:'primary' demotes any existing primary", () => {
    const wg = fresh();
    const t = wg.createTicket({ title: "T", description: "d" }, human);
    const a = wg.createScopeNode({ name: "A", type: "product" }, human);
    const b = wg.createScopeNode({ name: "B", type: "product" }, human);
    wg.linkTicketScope({ ticket_id: t.id, scope_node_id: a.id, relation: "primary" }, human);
    wg.linkTicketScope({ ticket_id: t.id, scope_node_id: b.id, relation: "primary" }, human);
    expect(wg.listTicketScopes(t.id).filter((s) => s.relation === "primary")).toHaveLength(1);
    wg.db.close();
  });

  it("retains rejected scopes (suggested→rejected keeps the row)", () => {
    const wg = fresh();
    const t = wg.createTicket({ title: "T", description: "d" }, human);
    const node = wg.createScopeNode({ name: "Maybe", type: "product" }, human);
    wg.linkTicketScope(
      { ticket_id: t.id, scope_node_id: node.id, relation: "suggested", confidence: 0.4 },
      human,
    );
    wg.linkTicketScope({ ticket_id: t.id, scope_node_id: node.id, relation: "rejected" }, human);
    const scopes = wg.listTicketScopes(t.id);
    expect(scopes).toHaveLength(1);
    expect(scopes[0]?.relation).toBe("rejected");
    wg.db.close();
  });

  it("rejects manually setting the 'implicit_repo' relation", () => {
    const wg = fresh();
    const t = wg.createTicket({ title: "T", description: "d" }, human);
    const node = wg.createScopeNode({ name: "X", type: "product" }, human);
    expect(() =>
      wg.linkTicketScope(
        { ticket_id: t.id, scope_node_id: node.id, relation: "implicit_repo" },
        human,
      ),
    ).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    wg.db.close();
  });

  it("removeTicketScope unlinks; missing link throws NOT_FOUND", () => {
    const wg = fresh();
    const t = wg.createTicket({ title: "T", description: "d" }, human);
    const node = wg.createScopeNode({ name: "X", type: "product" }, human);
    wg.linkTicketScope({ ticket_id: t.id, scope_node_id: node.id, relation: "secondary" }, human);
    wg.removeTicketScope(t.id, node.id, human);
    expect(wg.listTicketScopes(t.id)).toHaveLength(0);
    expect(() => wg.removeTicketScope(t.id, node.id, human)).toThrowError(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
    wg.db.close();
  });

  it("records an implicit_repo scope automatically when a ticket targets an UNMAPPED repo", () => {
    const wg = fresh();
    const { ticketId } = ticketWithRepo(wg, "standalone");
    wg.linkRepository(ticketId, "standalone", "primary", human);

    const scopes = wg.listTicketScopes(ticketId);
    expect(scopes).toHaveLength(1);
    expect(scopes[0]?.relation).toBe("implicit_repo");
    expect(scopes[0]?.name).toBe("repo:standalone");
    wg.db.close();
  });

  it("does NOT record an implicit_repo scope when the repo is MAPPED", () => {
    const wg = fresh();
    const node = wg.createScopeNode({ name: "Mapped", type: "product" }, human);
    const { ticketId, repoId } = ticketWithRepo(wg, "mapped");
    wg.linkScopeRepo({ scope_node_id: node.id, repo_id: repoId, relation: "owns" }, human);
    wg.linkRepository(ticketId, "mapped", "primary", human);

    expect(wg.listTicketScopes(ticketId)).toHaveLength(0);
    wg.db.close();
  });

  it("ticket detail (view) includes confirmed + suggested scopes", () => {
    const wg = fresh();
    const t = wg.createTicket({ title: "T", description: "d" }, human);
    const primary = wg.createScopeNode({ name: "P", type: "product" }, human);
    const sug = wg.createScopeNode({ name: "S", type: "system" }, human);
    wg.setPrimaryScope(t.id, primary.id, human);
    wg.linkTicketScope({ ticket_id: t.id, scope_node_id: sug.id, relation: "suggested" }, human);

    const view = wg.view(t.id);
    expect(view.scopes.map((s) => s.relation)).toEqual(
      expect.arrayContaining(["primary", "suggested"]),
    );
    wg.db.close();
  });

  it("MCP get_ticket exposes a compact scope SUMMARY, not full graph internals", () => {
    const wg = fresh();
    const t = wg.createTicket({ title: "T", description: "d" }, human);
    const primary = wg.createScopeNode({ name: "P", type: "product" }, human);
    const sug = wg.createScopeNode({ name: "S", type: "system" }, human);
    wg.setPrimaryScope(t.id, primary.id, human);
    wg.linkTicketScope(
      {
        ticket_id: t.id,
        scope_node_id: sug.id,
        relation: "suggested",
        confidence: 0.9,
        reasons: ["secret reason"],
      },
      human,
    );

    const h = makeHandlers(wg, agentActor);
    const data = h.get_ticket({ ticket_id: t.id }).structuredContent as {
      scope_summary: {
        primary: { name: string } | null;
        counts: Record<string, number>;
        total: number;
      };
    };
    expect(data.scope_summary.primary?.name).toBe("P");
    expect(data.scope_summary.counts.suggested).toBe(1);
    expect(data.scope_summary.total).toBe(2);
    // Redaction: no confidence/reasons/graph internals leak into the summary.
    expect(JSON.stringify(data.scope_summary)).not.toContain("secret reason");
    expect(JSON.stringify(data.scope_summary)).not.toContain("0.9");
    wg.db.close();
  });
});

describe("WG-002: ticket_repos explicit access boundaries", () => {
  it("a plain linked repo defaults to access='write', relation='confirmed', source='manual'", () => {
    const wg = fresh();
    const { ticketId } = ticketWithRepo(wg, "api");
    wg.linkRepository(ticketId, "api", "primary", human);
    const repos = wg.view(ticketId).repositories;
    expect(repos[0]?.access).toBe("write");
    expect(repos[0]?.relation).toBe("confirmed");
    expect(repos[0]?.source).toBe("manual");
    wg.db.close();
  });

  it("setTicketRepoAccess upserts an explicit boundary", () => {
    const wg = fresh();
    const { ticketId, repoId } = ticketWithRepo(wg, "ctx");
    wg.setTicketRepoAccess(
      { ticket_id: ticketId, repo_id: repoId, access: "read", relation: "context_only" },
      human,
    );
    const repos = wg.view(ticketId).repositories;
    expect(repos[0]?.access).toBe("read");
    expect(repos[0]?.relation).toBe("context_only");
    wg.db.close();
  });

  it("work packet partitions write / read-only / test / denied by access", () => {
    const wg = fresh();
    const t = wg.createTicket({ title: "Multi", description: "d" }, human);
    const w = wg.registerRepository({ name: "write-repo" }, human);
    const r = wg.registerRepository({ name: "read-repo" }, human);
    const te = wg.registerRepository({ name: "test-repo" }, human);
    const d = wg.registerRepository({ name: "denied-repo" }, human);

    wg.setTicketRepoAccess({ ticket_id: t.id, repo_id: w.id, access: "write" }, human);
    wg.setTicketRepoAccess({ ticket_id: t.id, repo_id: r.id, access: "read" }, human);
    wg.setTicketRepoAccess({ ticket_id: t.id, repo_id: te.id, access: "test" }, human);
    wg.setTicketRepoAccess({ ticket_id: t.id, repo_id: d.id, access: "none" }, human);

    const packet = wg.workPacketRepos(t.id);
    expect(packet.writeRepos.map((x) => x.name)).toEqual(["write-repo"]);
    expect(packet.readOnlyRepos.map((x) => x.name)).toEqual(["read-repo"]);
    expect(packet.testRepos.map((x) => x.name)).toEqual(["test-repo"]);
    expect(packet.deniedRepos.map((x) => x.name)).toEqual(["denied-repo"]);
    wg.db.close();
  });

  it("suggested/rejected repos are EXCLUDED from write targets", () => {
    const wg = fresh();
    const t = wg.createTicket({ title: "T", description: "d" }, human);
    const s = wg.registerRepository({ name: "suggested-repo" }, human);
    const rej = wg.registerRepository({ name: "rejected-repo" }, human);
    // A suggested write-access repo must NOT count as an active write target.
    wg.setTicketRepoAccess(
      { ticket_id: t.id, repo_id: s.id, access: "write", relation: "suggested", confidence: 0.6 },
      human,
    );
    wg.setTicketRepoAccess(
      { ticket_id: t.id, repo_id: rej.id, access: "write", relation: "rejected" },
      human,
    );
    const packet = wg.workPacketRepos(t.id);
    expect(packet.writeRepos).toHaveLength(0);
    expect(packet.suggestedRepos.map((x) => x.name)).toEqual(["suggested-repo"]);
    expect(packet.rejectedRepos.map((x) => x.name)).toEqual(["rejected-repo"]);
    wg.db.close();
  });

  it("mono_fallback: a ticket whose ONLY repo is unmapped gets ONE confirmed write repo", () => {
    const wg = fresh();
    const { ticketId } = ticketWithRepo(wg, "solo");
    wg.linkRepository(ticketId, "solo", "primary", human);

    const res = wg.applyMonoFallback(ticketId, human);
    expect(res.applied).toBe(true);

    const packet = wg.workPacketRepos(ticketId);
    expect(packet.writeRepos).toHaveLength(1);
    expect(packet.writeRepos[0]?.name).toBe("solo");
    expect(packet.writeRepos[0]?.relation).toBe("implicit_single_repo");
    expect(packet.writeRepos[0]?.source).toBe("mono_fallback");
    wg.db.close();
  });

  it("mono_fallback does NOT apply with multiple repos or a mapped repo", () => {
    const wg = fresh();
    // Multiple repos.
    const t1 = wg.createTicket({ title: "Multi", description: "d" }, human);
    wg.registerRepository({ name: "r1" }, human);
    wg.registerRepository({ name: "r2" }, human);
    wg.linkRepository(t1.id, "r1", "primary", human);
    wg.linkRepository(t1.id, "r2", "secondary", human);
    expect(wg.applyMonoFallback(t1.id, human).applied).toBe(false);

    // Single but MAPPED repo.
    const node = wg.createScopeNode({ name: "Mapped", type: "product" }, human);
    const mapped = wg.registerRepository({ name: "mapped-solo" }, human);
    wg.linkScopeRepo({ scope_node_id: node.id, repo_id: mapped.id, relation: "owns" }, human);
    const t2 = wg.createTicket({ title: "Mapped", description: "d" }, human);
    wg.linkRepository(t2.id, "mapped-solo", "primary", human);
    expect(wg.applyMonoFallback(t2.id, human).applied).toBe(false);
    wg.db.close();
  });

  it("agents may only write where access='write' AND relation is active", () => {
    const wg = fresh();
    const t = wg.createTicket({ title: "T", description: "d" }, human);
    const ok = wg.registerRepository({ name: "ok" }, human);
    const ctx = wg.registerRepository({ name: "ctx" }, human);
    wg.setTicketRepoAccess(
      { ticket_id: t.id, repo_id: ok.id, access: "write", relation: "confirmed" },
      human,
    );
    // context_only is not an active write relation even at access='write' would be excluded;
    // here it is read access and context_only relation → read-only bucket.
    wg.setTicketRepoAccess(
      { ticket_id: t.id, repo_id: ctx.id, access: "read", relation: "context_only" },
      human,
    );

    const packet = wg.workPacketRepos(t.id);
    expect(packet.writeRepos.map((r) => r.name)).toEqual(["ok"]);
    expect(packet.readOnlyRepos.map((r) => r.name)).toEqual(["ctx"]);
    wg.db.close();
  });
});

describe("WG-002: migration of existing ticket_repos rows", () => {
  it("a row inserted via the legacy linkTicket path carries the backfilled defaults", () => {
    const wg = fresh();
    const { ticketId, repoId } = ticketWithRepo(wg, "legacy");
    // Simulate the pre-WG-002 path: a bare ticket_repos insert with only role.
    wg.repos.linkTicket(ticketId, repoId, "primary", wg.clock.now());
    const link = wg.repos.accessLinksForTicket(ticketId).find((r) => r.id === repoId);
    expect(link?.access).toBe("write");
    expect(link?.relation).toBe("confirmed");
    expect(link?.source).toBe("manual");
    wg.db.close();
  });
});

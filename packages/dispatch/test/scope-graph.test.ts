import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApiServer } from "../src/api/server.js";
import { Dispatch } from "../src/core.js";
import type { Actor, Repository } from "../src/domain/types.js";
import { makeHandlers } from "../src/mcp/tools.js";
import { TestClock } from "../src/util/clock.js";
import { DispatchError } from "../src/util/errors.js";

const human: Actor = { type: "human", id: "tom" };
const agentActor: Actor = { type: "agent", id: "mcp-agent" };

function fresh(): Dispatch {
  return Dispatch.open(":memory:", new TestClock());
}

function registerRepo(wg: Dispatch, name: string): Repository {
  return wg.registerRepository({ name }, human);
}

describe("Scope graph: data layer (FG-001 + FG-002)", () => {
  describe("scope nodes", () => {
    it("creates, lists, gets, renames and deletes a node", () => {
      const wg = fresh();
      const node = wg.createScopeNode(
        { name: "Sportsbook", type: "product", owner: "trading", tags: ["betting"] },
        human,
      );
      expect(node.id).toBeTruthy();
      expect(node.type).toBe("product");
      expect(node.tags_json).toBe(JSON.stringify(["betting"]));

      expect(wg.listScopeNodes()).toHaveLength(1);

      const view = wg.getScopeNode(node.id);
      expect(view.node.name).toBe("Sportsbook");
      expect(view.repos).toEqual([]);

      const renamed = wg.updateScopeNode(node.id, { name: "Sportsbook v2" }, human);
      expect(renamed.name).toBe("Sportsbook v2");

      wg.deleteScopeNode(node.id, human);
      expect(wg.listScopeNodes()).toHaveLength(0);
      wg.db.close();
    });

    it("allows the same name under different types", () => {
      const wg = fresh();
      const a = wg.createScopeNode({ name: "Cashout", type: "product" }, human);
      const b = wg.createScopeNode({ name: "Cashout", type: "system" }, human);
      expect(a.id).not.toBe(b.id);
      expect(wg.listScopeNodes()).toHaveLength(2);
      wg.db.close();
    });

    it("rejects an invalid node type", () => {
      const wg = fresh();
      expect(() => wg.createScopeNode({ name: "X", type: "nonsense" }, human)).toThrow();
      wg.db.close();
    });

    it("getScopeNode throws NOT_FOUND for an unknown id", () => {
      const wg = fresh();
      expect(() => wg.getScopeNode("missing")).toThrowError(
        expect.objectContaining({ code: "NOT_FOUND" }),
      );
      wg.db.close();
    });

    it("zero-state: listing nodes/edges/unmapped works with no nodes", () => {
      const wg = fresh();
      expect(wg.listScopeNodes()).toEqual([]);
      expect(wg.listScopeEdges()).toEqual([]);
      expect(wg.listUnmappedRepos()).toEqual([]);
      wg.db.close();
    });
  });

  describe("scope edges", () => {
    it("creates a contains edge and lists it (filtered by node)", () => {
      const wg = fresh();
      const parent = wg.createScopeNode({ name: "Sportsbook", type: "product" }, human);
      const child = wg.createScopeNode({ name: "In-play", type: "capability" }, human);
      const edge = wg.createScopeEdge(
        { from_node_id: parent.id, to_node_id: child.id, relation: "contains" },
        human,
      );
      expect(edge.relation).toBe("contains");
      expect(wg.listScopeEdges()).toHaveLength(1);
      expect(wg.listScopeEdges(child.id)).toHaveLength(1);

      wg.deleteScopeEdge(edge.id, human);
      expect(wg.listScopeEdges()).toHaveLength(0);
      wg.db.close();
    });

    it("rejects a self-edge", () => {
      const wg = fresh();
      const n = wg.createScopeNode({ name: "A", type: "system" }, human);
      expect(() =>
        wg.createScopeEdge({ from_node_id: n.id, to_node_id: n.id, relation: "contains" }, human),
      ).toThrowError(expect.objectContaining({ code: "INVALID_EDGE" }));
      wg.db.close();
    });

    it("rejects a duplicate edge", () => {
      const wg = fresh();
      const a = wg.createScopeNode({ name: "A", type: "system" }, human);
      const b = wg.createScopeNode({ name: "B", type: "system" }, human);
      wg.createScopeEdge({ from_node_id: a.id, to_node_id: b.id, relation: "depends_on" }, human);
      expect(() =>
        wg.createScopeEdge({ from_node_id: a.id, to_node_id: b.id, relation: "depends_on" }, human),
      ).toThrowError(expect.objectContaining({ code: "DUPLICATE" }));
      wg.db.close();
    });

    it("rejects a contains cycle", () => {
      const wg = fresh();
      const a = wg.createScopeNode({ name: "A", type: "system" }, human);
      const b = wg.createScopeNode({ name: "B", type: "system" }, human);
      const c = wg.createScopeNode({ name: "C", type: "system" }, human);
      wg.createScopeEdge({ from_node_id: a.id, to_node_id: b.id, relation: "contains" }, human);
      wg.createScopeEdge({ from_node_id: b.id, to_node_id: c.id, relation: "contains" }, human);
      // c -contains-> a would close the loop a->b->c->a.
      expect(() =>
        wg.createScopeEdge({ from_node_id: c.id, to_node_id: a.id, relation: "contains" }, human),
      ).toThrowError(expect.objectContaining({ code: "INVALID_EDGE" }));
      wg.db.close();
    });

    it("hides advanced relations unless advanced:true", () => {
      const wg = fresh();
      const a = wg.createScopeNode({ name: "A", type: "service" }, human);
      const b = wg.createScopeNode({ name: "B", type: "service" }, human);
      expect(() =>
        wg.createScopeEdge({ from_node_id: a.id, to_node_id: b.id, relation: "calls" }, human),
      ).toThrowError(expect.objectContaining({ code: "ADVANCED_RELATION_REQUIRED" }));
      // With the opt-in it is accepted and stored.
      const edge = wg.createScopeEdge(
        { from_node_id: a.id, to_node_id: b.id, relation: "calls", advanced: true },
        human,
      );
      expect(edge.relation).toBe("calls");
      wg.db.close();
    });
  });

  describe("scope↔repo associations", () => {
    it("links a repo into a node and reads it back via reposForScope", () => {
      const wg = fresh();
      const node = wg.createScopeNode({ name: "Trading", type: "product" }, human);
      const repo = registerRepo(wg, "odds-stream");
      const link = wg.linkScopeRepo(
        { scope_node_id: node.id, repo_id: repo.id, relation: "owns", default_access: "write" },
        human,
      );
      expect(link.default_access).toBe("write");

      const repos = wg.reposForScope(node.id);
      expect(repos).toHaveLength(1);
      expect(repos[0]?.name).toBe("odds-stream");
      expect(repos[0]?.relation).toBe("owns");
      expect(repos[0]?.default_access).toBe("write");

      // getScopeNode surfaces the linked repos too.
      expect(wg.getScopeNode(node.id).repos).toHaveLength(1);
      wg.db.close();
    });

    it("accepts a repo by name as well as id", () => {
      const wg = fresh();
      const node = wg.createScopeNode({ name: "Trading", type: "product" }, human);
      registerRepo(wg, "by-name-repo");
      const link = wg.linkScopeRepo(
        { scope_node_id: node.id, repo_id: "by-name-repo", relation: "uses" },
        human,
      );
      expect(link.default_access).toBe("read");
      wg.db.close();
    });

    it("supports a repo in MULTIPLE nodes with different access", () => {
      const wg = fresh();
      const trading = wg.createScopeNode({ name: "In-play Trading", type: "capability" }, human);
      const cashout = wg.createScopeNode({ name: "Cashout", type: "product" }, human);
      const repo = registerRepo(wg, "odds-stream-consumer");

      wg.linkScopeRepo(
        { scope_node_id: trading.id, repo_id: repo.id, relation: "owns", default_access: "write" },
        human,
      );
      wg.linkScopeRepo(
        { scope_node_id: cashout.id, repo_id: repo.id, relation: "uses", default_access: "read" },
        human,
      );

      const scopes = wg.scopesForRepo(repo.id);
      expect(scopes).toHaveLength(2);
      const byName = Object.fromEntries(scopes.map((s) => [s.name, s.default_access]));
      expect(byName["In-play Trading"]).toBe("write");
      expect(byName["Cashout"]).toBe("read");
      wg.db.close();
    });

    it("rejects a duplicate (node, repo, relation) link", () => {
      const wg = fresh();
      const node = wg.createScopeNode({ name: "N", type: "system" }, human);
      const repo = registerRepo(wg, "dup-repo");
      wg.linkScopeRepo({ scope_node_id: node.id, repo_id: repo.id, relation: "uses" }, human);
      expect(() =>
        wg.linkScopeRepo({ scope_node_id: node.id, repo_id: repo.id, relation: "uses" }, human),
      ).toThrowError(expect.objectContaining({ code: "DUPLICATE" }));
      wg.db.close();
    });

    it("rejects an invalid relation and an invalid access", () => {
      const wg = fresh();
      const node = wg.createScopeNode({ name: "N", type: "system" }, human);
      const repo = registerRepo(wg, "bad-repo");
      expect(() =>
        wg.linkScopeRepo({ scope_node_id: node.id, repo_id: repo.id, relation: "nope" }, human),
      ).toThrow();
      expect(() =>
        wg.linkScopeRepo(
          { scope_node_id: node.id, repo_id: repo.id, relation: "uses", default_access: "all" },
          human,
        ),
      ).toThrow();
      wg.db.close();
    });

    it("updates and unlinks an association", () => {
      const wg = fresh();
      const node = wg.createScopeNode({ name: "N", type: "system" }, human);
      const repo = registerRepo(wg, "upd-repo");
      const link = wg.linkScopeRepo(
        { scope_node_id: node.id, repo_id: repo.id, relation: "uses", default_access: "read" },
        human,
      );
      const updated = wg.updateScopeRepo(link.id, { default_access: "write" }, human);
      expect(updated.default_access).toBe("write");

      wg.unlinkScopeRepo(link.id, human);
      expect(wg.reposForScope(node.id)).toHaveLength(0);
      wg.db.close();
    });

    it("blocks node deletion while repos are linked, allows it after unlink", () => {
      const wg = fresh();
      const node = wg.createScopeNode({ name: "N", type: "system" }, human);
      const repo = registerRepo(wg, "block-repo");
      const link = wg.linkScopeRepo(
        { scope_node_id: node.id, repo_id: repo.id, relation: "owns" },
        human,
      );
      expect(() => wg.deleteScopeNode(node.id, human)).toThrowError(
        expect.objectContaining({ code: "SCOPE_NODE_IN_USE" }),
      );
      wg.unlinkScopeRepo(link.id, human);
      expect(() => wg.deleteScopeNode(node.id, human)).not.toThrow();
      wg.db.close();
    });
  });

  describe("unmapped repos", () => {
    it("lists only repos with no scope association", () => {
      const wg = fresh();
      const node = wg.createScopeNode({ name: "N", type: "system" }, human);
      const mapped = registerRepo(wg, "mapped");
      registerRepo(wg, "standalone");
      wg.linkScopeRepo({ scope_node_id: node.id, repo_id: mapped.id, relation: "owns" }, human);

      const unmapped = wg.listUnmappedRepos();
      expect(unmapped.map((r) => r.name)).toEqual(["standalone"]);
      wg.db.close();
    });
  });

  describe("MCP list_scopes (read-only)", () => {
    it("returns nodes with a repo summary and unmapped repos", () => {
      const wg = fresh();
      const node = wg.createScopeNode({ name: "Trading", type: "product" }, human);
      const repo = registerRepo(wg, "owned");
      registerRepo(wg, "loose");
      wg.linkScopeRepo(
        { scope_node_id: node.id, repo_id: repo.id, relation: "owns", default_access: "write" },
        human,
      );

      const h = makeHandlers(wg, agentActor);
      const result = h.list_scopes({});
      const data = result.structuredContent as {
        scopes: Array<{ name: string; repos: Array<{ name: string; default_access: string }> }>;
        unmapped_repos: string[];
      };
      expect(data.scopes).toHaveLength(1);
      expect(data.scopes[0]?.repos[0]?.name).toBe("owned");
      expect(data.scopes[0]?.repos[0]?.default_access).toBe("write");
      expect(data.unmapped_repos).toEqual(["loose"]);
      wg.db.close();
    });
  });
});

// --- REST surface -----------------------------------------------------------

interface Harness {
  wg: Dispatch;
  baseUrl: string;
  close: () => Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const wg = Dispatch.open(":memory:", new TestClock());
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

async function call(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

describe("Scope graph: REST surface", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("CRUD a node, link a repo, read it back, and see unmapped repos", async () => {
    const repo = h.wg.registerRepository({ name: "rest-repo" }, human);
    h.wg.registerRepository({ name: "rest-unmapped" }, human);

    const created = await call(h.baseUrl, "POST", "/scope/nodes", {
      name: "Payments",
      type: "product",
    });
    expect(created.status).toBe(201);
    const nodeId = (created.body.node as { id: string }).id;

    const list = await call(h.baseUrl, "GET", "/scope/nodes");
    expect((list.body.nodes as unknown[]).length).toBe(1);

    const linked = await call(h.baseUrl, "POST", "/scope/repos", {
      scope_node_id: nodeId,
      repo_id: repo.id,
      relation: "owns",
      default_access: "write",
    });
    expect(linked.status).toBe(201);

    const detail = await call(h.baseUrl, "GET", `/scope/nodes/${nodeId}`);
    expect((detail.body.repos as unknown[]).length).toBe(1);

    const repoScopes = await call(h.baseUrl, "GET", `/repos/${repo.id}/scopes`);
    expect((repoScopes.body.scopes as unknown[]).length).toBe(1);

    const unmapped = await call(h.baseUrl, "GET", "/scope/unmapped-repos");
    expect((unmapped.body.repositories as Array<{ name: string }>).map((r) => r.name)).toEqual([
      "rest-unmapped",
    ]);
  });

  it("creates an edge and rejects a self-edge with 422", async () => {
    const a = await call(h.baseUrl, "POST", "/scope/nodes", { name: "A", type: "system" });
    const b = await call(h.baseUrl, "POST", "/scope/nodes", { name: "B", type: "system" });
    const aId = (a.body.node as { id: string }).id;
    const bId = (b.body.node as { id: string }).id;

    const edge = await call(h.baseUrl, "POST", "/scope/edges", {
      from_node_id: aId,
      to_node_id: bId,
      relation: "contains",
    });
    expect(edge.status).toBe(201);

    const selfEdge = await call(h.baseUrl, "POST", "/scope/edges", {
      from_node_id: aId,
      to_node_id: aId,
      relation: "contains",
    });
    expect(selfEdge.status).toBe(422);
    expect((selfEdge.body.error as { code: string }).code).toBe("INVALID_EDGE");
  });

  it("blocks DELETE node with linked repos (409)", async () => {
    const repo = h.wg.registerRepository({ name: "rest-block" }, human);
    const node = await call(h.baseUrl, "POST", "/scope/nodes", { name: "N", type: "system" });
    const nodeId = (node.body.node as { id: string }).id;
    await call(h.baseUrl, "POST", "/scope/repos", {
      scope_node_id: nodeId,
      repo_id: repo.id,
      relation: "owns",
    });
    const del = await call(h.baseUrl, "DELETE", `/scope/nodes/${nodeId}`);
    expect(del.status).toBe(409);
    expect((del.body.error as { code: string }).code).toBe("SCOPE_NODE_IN_USE");
  });

  it("returns 422 for an invalid node type", async () => {
    const bad = await call(h.baseUrl, "POST", "/scope/nodes", { name: "X", type: "nope" });
    expect(bad.status).toBe(422);
  });
});

// --- CLI surface ------------------------------------------------------------

describe("Scope graph: CLI facade flow", () => {
  it("create node -> link repo -> list -> unmapped via facade (CLI maps 1:1)", () => {
    const wg = fresh();
    // The CLI commands are thin wrappers over these facade calls; exercising the
    // facade with CLI-shaped string args covers the wiring deterministically.
    const node = wg.createScopeNode({ name: "CliProduct", type: "product" }, human);
    wg.registerRepository({ name: "cli-repo" }, human);
    wg.registerRepository({ name: "cli-loose" }, human);

    const link = wg.linkScopeRepo(
      { scope_node_id: node.id, repo_id: "cli-repo", relation: "owns", default_access: "write" },
      human,
    );
    expect(link.default_access).toBe("write");

    expect(wg.reposForScope(node.id)).toHaveLength(1);
    expect(wg.listUnmappedRepos().map((r) => r.name)).toEqual(["cli-loose"]);

    expect(() => wg.unlinkScopeRepo("missing-association", human)).toThrowError(DispatchError);
    wg.db.close();
  });
});

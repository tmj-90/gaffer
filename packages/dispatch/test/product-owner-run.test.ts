import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { createApiServer } from "../src/api/server.js";
import { createProductOwnerRunner, type ProductOwnerRunner } from "../src/api/productOwner.js";

const human: Actor = { type: "human", id: "tom" };

interface Harness {
  wg: Dispatch;
  baseUrl: string;
  runs: Array<{ repo?: string }>;
  close: () => Promise<void>;
}

/**
 * Start the API behind an in-memory Dispatch with a fake product-owner runner
 * so we never spawn a real headless process. The fake records each call and (to
 * simulate what the skill does) files a draft ticket into the backlog.
 */
async function startHarness(runner?: ProductOwnerRunner): Promise<Harness> {
  const wg = Dispatch.open(":memory:");
  const runs: Array<{ repo?: string }> = [];
  const fake: ProductOwnerRunner = runner ?? {
    run(input) {
      runs.push(input);
      wg.createTicket({ title: "PO suggestion" }, { type: "agent", id: "product-owner" });
      return { started: true, pid: 4242 };
    },
  };
  const server = createApiServer(wg, fake);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    wg,
    runs,
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

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

async function call(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<JsonResponse> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

/** Pull the cards of one board column from a GET /api/board response. */
function column(board: Record<string, unknown>, name: string): Array<Record<string, unknown>> {
  const columns = board.columns as Array<{ column: string; cards: Array<Record<string, unknown>> }>;
  return columns.find((c) => c.column === name)?.cards ?? [];
}

describe("API: product-owner runs (Suggest work)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("POST /product-owner/runs kicks off a run and returns 202", async () => {
    const res = await call(h.baseUrl, "POST", "/product-owner/runs", {});
    expect(res.status).toBe(202);
    expect(res.body.run).toMatchObject({ started: true, pid: 4242 });
    expect(h.runs).toHaveLength(1);
  });

  it("passes a supplied repo through to the runner", async () => {
    await call(h.baseUrl, "POST", "/product-owner/runs", { repo: "dispatch" });
    expect(h.runs).toEqual([{ repo: "dispatch" }]);
  });

  it("draft tickets produced by the run appear on the board", async () => {
    const before = await call(h.baseUrl, "GET", "/api/board");
    expect(column(before.body, "draft")).toHaveLength(0);

    await call(h.baseUrl, "POST", "/product-owner/runs", {});

    const after = await call(h.baseUrl, "GET", "/api/board");
    const drafts = column(after.body, "draft");
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ title: "PO suggestion", status: "draft" });
  });

  it("rejects a non-string repo with a 422", async () => {
    const res = await call(h.baseUrl, "POST", "/product-owner/runs", { repo: 123 });
    expect(res.status).toBe(422);
    expect(h.runs).toHaveLength(0);
  });

  it("returns 405 for a non-POST method", async () => {
    const res = await call(h.baseUrl, "GET", "/product-owner/runs");
    expect(res.status).toBe(405);
  });
});

describe("product-owner runner: configuration", () => {
  it("rejects with 503 NOT_CONFIGURED when no command is set", async () => {
    const runner = createProductOwnerRunner({}); // empty env → unconfigured
    const h = await startHarness(runner);
    try {
      const res = await call(h.baseUrl, "POST", "/product-owner/runs", {});
      expect(res.status).toBe(503);
      expect((res.body.error as { code: string }).code).toBe("NOT_CONFIGURED");
    } finally {
      await h.close();
    }
  });

  it("still returns NOT_CONFIGURED for a node-level run when unset", async () => {
    const runner = createProductOwnerRunner({});
    const h = await startHarness(runner);
    try {
      const node = h.wg.createScopeNode({ name: "Prod", type: "product" }, human);
      const repo = h.wg.registerRepository({ name: "api" }, human);
      h.wg.linkScopeRepo(
        { scope_node_id: node.id, repo_id: repo.id, relation: "owns", default_access: "write" },
        human,
      );
      const res = await call(h.baseUrl, "POST", "/product-owner/runs", { scopeNodeId: node.id });
      expect(res.status).toBe(503);
      expect((res.body.error as { code: string }).code).toBe("NOT_CONFIGURED");
    } finally {
      await h.close();
    }
  });
});

/**
 * Feature B: "Suggest work" is now repo-level OR node-level. The picker posts a
 * `repo` (repo-level) or a `scopeNodeId` (node-level). Node-level resolves the
 * scope node to its repos and fans the per-repo runner out once per repo.
 */
describe("Feature B: repo-level vs node-level product-owner runs", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("repo-level run targets a single repo and surfaces the target", async () => {
    const res = await call(h.baseUrl, "POST", "/product-owner/runs", { repo: "api" });
    expect(res.status).toBe(202);
    expect(res.body.target).toMatchObject({ level: "repo", repo: "api" });
    expect(h.runs).toEqual([{ repo: "api" }]);
  });

  it("node-level run expands the scope node to its repos and runs once per repo", async () => {
    const node = h.wg.createScopeNode({ name: "Checkout", type: "product" }, human);
    const apiRepo = h.wg.registerRepository({ name: "api" }, human);
    const webRepo = h.wg.registerRepository({ name: "web" }, human);
    const dbRepo = h.wg.registerRepository({ name: "db" }, human);
    for (const repo of [apiRepo, webRepo, dbRepo]) {
      h.wg.linkScopeRepo(
        { scope_node_id: node.id, repo_id: repo.id, relation: "owns", default_access: "write" },
        human,
      );
    }

    const res = await call(h.baseUrl, "POST", "/product-owner/runs", { scopeNodeId: node.id });
    expect(res.status).toBe(202);
    const target = res.body.target as { level: string; scope_node_name: string };
    expect(target.level).toBe("node");
    expect(target.scope_node_name).toBe("Checkout");
    expect(res.body.ran).toBe(3);
    expect(res.body.repo_count).toBe(3);
    expect(res.body.truncated).toBe(false);

    // The per-repo runner fired once for every repo mapped to the node.
    expect(h.runs.map((r) => r.repo).sort()).toEqual(["api", "db", "web"]);
  });

  it("node-level run for a node with no repos runs nothing but still 202s", async () => {
    const node = h.wg.createScopeNode({ name: "Empty", type: "product" }, human);
    const res = await call(h.baseUrl, "POST", "/product-owner/runs", { scopeNodeId: node.id });
    expect(res.status).toBe(202);
    expect(res.body.ran).toBe(0);
    expect(h.runs).toHaveLength(0);
  });

  it("rejects an unknown scope node with a 404", async () => {
    const res = await call(h.baseUrl, "POST", "/product-owner/runs", {
      scopeNodeId: "does-not-exist",
    });
    expect(res.status).toBe(404);
    expect(h.runs).toHaveLength(0);
  });

  it("rejects providing both repo and scopeNodeId with a 422", async () => {
    const node = h.wg.createScopeNode({ name: "X", type: "product" }, human);
    const res = await call(h.baseUrl, "POST", "/product-owner/runs", {
      repo: "api",
      scopeNodeId: node.id,
    });
    expect(res.status).toBe(422);
    expect(h.runs).toHaveLength(0);
  });
});

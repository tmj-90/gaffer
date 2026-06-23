import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApiServer } from "../src/api/server.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { TestClock } from "../src/util/clock.js";

const human: Actor = { type: "human", id: "tom" };

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

interface RepoSuggestionDto {
  repoName: string;
  suggestedAccess: string;
  confidence: number;
  monoFallback: boolean;
  reasons: string[];
}

describe("FG-005 / WG-004 REST surface", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("GET /tickets/:id/repo-suggestions returns scope-derived suggestions", async () => {
    const node = h.wg.createScopeNode({ name: "Sportsbook", type: "product" }, human);
    const repo = h.wg.registerRepository({ name: "sportsbook-api" }, human);
    h.wg.linkScopeRepo(
      { scope_node_id: node.id, repo_id: repo.id, relation: "owns", default_access: "write" },
      human,
    );
    const t = h.wg.createTicket({ title: "Cashout", description: "d" }, human);
    h.wg.setPrimaryScope(t.id, node.id, human);

    const r = await call(h.baseUrl, "GET", `/tickets/${t.id}/repo-suggestions`);
    expect(r.status).toBe(200);
    const suggestions = r.body.suggestions as RepoSuggestionDto[];
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.suggestedAccess).toBe("write");
    expect(suggestions[0]!.repoName).toBe("sportsbook-api");
  });

  it("POST /scope/repo-suggestions returns pre-create suggestions", async () => {
    const node = h.wg.createScopeNode({ name: "Trading", type: "system" }, human);
    const repo = h.wg.registerRepository({ name: "trading-core" }, human);
    h.wg.linkScopeRepo(
      { scope_node_id: node.id, repo_id: repo.id, relation: "owns", default_access: "write" },
      human,
    );

    const r = await call(h.baseUrl, "POST", "/scope/repo-suggestions", {
      title: "New pricing path",
      scopeNodeIds: [node.id],
    });
    expect(r.status).toBe(200);
    const suggestions = r.body.suggestions as RepoSuggestionDto[];
    expect(suggestions.map((s) => s.repoName)).toContain("trading-core");
  });

  it("POST /scope/repo-suggestions with a lone unmapped repoId returns mono-fallback", async () => {
    const repo = h.wg.registerRepository({ name: "standalone" }, human);
    const r = await call(h.baseUrl, "POST", "/scope/repo-suggestions", {
      repoIds: [repo.id],
    });
    expect(r.status).toBe(200);
    const suggestions = r.body.suggestions as RepoSuggestionDto[];
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.monoFallback).toBe(true);
    expect(suggestions[0]!.confidence).toBe(1.0);
  });

  it("GET /tickets/:id/claimability reports blockers then ready", async () => {
    const repo = h.wg.registerRepository({ name: "solo" }, human);
    const t = h.wg.createTicket(
      { title: "Tidy", description: "d", policy_pack: "team_light" },
      human,
    );

    const before = await call(h.baseUrl, "GET", `/tickets/${t.id}/claimability`);
    expect(before.status).toBe(200);
    expect(before.body.ready).toBe(false);
    expect((before.body.blockers as { code: string }[]).map((b) => b.code)).toContain(
      "REPO_REQUIRED",
    );

    // Select the unmapped repo + mono-fallback + add an AC.
    h.wg.linkRepository(t.id, "solo", "primary", human);
    await call(h.baseUrl, "POST", `/tickets/${t.id}/mono-fallback`);
    h.wg.addAcceptanceCriterion({ ticket_id: t.id, text: "done" }, human);

    const after = await call(h.baseUrl, "GET", `/tickets/${t.id}/claimability`);
    expect(after.body.ready).toBe(true);
    expect((after.body.blockers as unknown[]).length).toBe(0);
    expect(repo.id).toBeTruthy();
  });
});

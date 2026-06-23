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

/**
 * Feature A: the create form attaches one or more repos (each with an access
 * level) plus optional scope node(s). These tests drive the wired POST /tickets
 * endpoint and assert the resulting ticket is immediately deliverable — a real
 * write target exists in its work-repo partition.
 */
describe("Feature A: create ticket with repos + access + scope", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("attaches multiple repos with per-repo access and makes the ticket deliverable", async () => {
    const writeRepo = h.wg.registerRepository({ name: "api" }, human);
    const readRepo = h.wg.registerRepository({ name: "design-docs" }, human);
    const testRepo = h.wg.registerRepository({ name: "e2e" }, human);

    const created = await call(h.baseUrl, "POST", "/tickets", {
      title: "Ship the dashboard",
      repoIds: [
        { repo_id: writeRepo.id, access: "write" },
        { repo_id: readRepo.id, access: "read" },
        { repo_id: testRepo.id, access: "test" },
      ],
    });
    expect(created.status).toBe(201);
    const ticketId = (created.body.ticket as { id: string }).id;

    // Deliverable: the write target resolves in the work-repo partition.
    const packet = await call(h.baseUrl, "GET", `/tickets/${ticketId}/work-repos`);
    const wr = packet.body.work_repos as {
      writeRepos: Array<{ name: string }>;
      readOnlyRepos: Array<{ name: string }>;
      testRepos: Array<{ name: string }>;
    };
    expect(wr.writeRepos.map((r) => r.name)).toEqual(["api"]);
    expect(wr.readOnlyRepos.map((r) => r.name)).toEqual(["design-docs"]);
    expect(wr.testRepos.map((r) => r.name)).toEqual(["e2e"]);
  });

  it("defaults a bare repo attachment to write access", async () => {
    const repo = h.wg.registerRepository({ name: "solo" }, human);
    const created = await call(h.baseUrl, "POST", "/tickets", {
      title: "Bare repo defaults to write",
      repoIds: [{ repo_id: repo.id }],
    });
    expect(created.status).toBe(201);
    const ticketId = (created.body.ticket as { id: string }).id;

    const packet = await call(h.baseUrl, "GET", `/tickets/${ticketId}/work-repos`);
    const wr = packet.body.work_repos as { writeRepos: Array<{ name: string }> };
    expect(wr.writeRepos.map((r) => r.name)).toEqual(["solo"]);
  });

  it("links the chosen scope node(s) — first primary, rest secondary", async () => {
    const product = h.wg.createScopeNode({ name: "Checkout", type: "product" }, human);
    const service = h.wg.createScopeNode({ name: "Payments", type: "service" }, human);
    const repo = h.wg.registerRepository({ name: "api" }, human);

    const created = await call(h.baseUrl, "POST", "/tickets", {
      title: "Scoped ticket",
      scopeNodeIds: [product.id, service.id],
      repoIds: [{ repo_id: repo.id, access: "write" }],
    });
    expect(created.status).toBe(201);
    const ticketId = (created.body.ticket as { id: string }).id;

    const scopes = await call(h.baseUrl, "GET", `/tickets/${ticketId}/scopes`);
    // listTicketScopes joins to the scope-node row, so each entry's `id` is the
    // node id and `relation` is the ticket↔scope relation.
    const list = scopes.body.scopes as Array<{ id: string; relation: string }>;
    const byNode = new Map(list.map((s) => [s.id, s.relation]));
    expect(byNode.get(product.id)).toBe("primary");
    expect(byNode.get(service.id)).toBe("secondary");
  });

  it("a zero-repo create still works but leaves no write target (UI enforces ≥1 write)", async () => {
    // The REST layer accepts a repo-less create (back-compat); the ≥1-write rule
    // is enforced in the create form. This asserts the un-deliverable shape so a
    // regression that silently drops the repoIds wiring is caught.
    const created = await call(h.baseUrl, "POST", "/tickets", { title: "No repos" });
    expect(created.status).toBe(201);
    const ticketId = (created.body.ticket as { id: string }).id;
    const packet = await call(h.baseUrl, "GET", `/tickets/${ticketId}/work-repos`);
    const wr = packet.body.work_repos as { writeRepos: unknown[] };
    expect(wr.writeRepos).toHaveLength(0);
  });

  it("rejects a non-write/read/test access value with a 422", async () => {
    const repo = h.wg.registerRepository({ name: "api" }, human);
    const bad = await call(h.baseUrl, "POST", "/tickets", {
      title: "Bad access",
      repoIds: [{ repo_id: repo.id, access: "none" }],
    });
    expect(bad.status).toBe(422);
  });

  it("rejects attaching repos with zero write access (422) and creates no ticket", async () => {
    const readRepo = h.wg.registerRepository({ name: "docs" }, human);
    const testRepo = h.wg.registerRepository({ name: "e2e" }, human);
    const before = h.wg.listTickets({});
    const bad = await call(h.baseUrl, "POST", "/tickets", {
      title: "All read/test, no write",
      repoIds: [
        { repo_id: readRepo.id, access: "read" },
        { repo_id: testRepo.id, access: "test" },
      ],
    });
    expect(bad.status).toBe(422);
    // The guard runs before createTicket, so no orphaned ticket is left behind.
    expect(h.wg.listTickets({}).length).toBe(before.length);
  });
});

import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createApiServer } from "../src/api/server.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { makeHandlers } from "../src/mcp/tools.js";
import { TestClock } from "../src/util/clock.js";

/**
 * A failed create (an unknown repo or scope node) used to commit the ticket before
 * the link failed, so every 404 left an orphan draft and a retrying client or agent
 * accumulated duplicates. The create and its links are now one transaction.
 */

const human: Actor = { type: "human", id: "tom" };
const agent: Actor = { type: "agent", id: "mcp-agent" };

function counts(wg: Dispatch): { tickets: number; events: number } {
  const events = wg.db.prepare("SELECT COUNT(*) AS n FROM work_events").get() as { n: number };
  return { tickets: wg.listTickets().length, events: events.n };
}

let close: (() => Promise<void>) | undefined;
const savedRepo = process.env.GAFFER_DEFAULT_TICKET_REPO;
afterEach(async () => {
  await close?.();
  close = undefined;
  if (savedRepo === undefined) delete process.env.GAFFER_DEFAULT_TICKET_REPO;
  else process.env.GAFFER_DEFAULT_TICKET_REPO = savedRepo;
});

async function start(): Promise<{ wg: Dispatch; base: string }> {
  process.env.DISPATCH_AUDIT_OFF = "1";
  const wg = Dispatch.open(":memory:", new TestClock());
  const server = createApiServer(wg);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  close = () =>
    new Promise<void>((resolve) =>
      server.close(() => {
        wg.db.close();
        resolve();
      }),
    );
  return { wg, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function createTicket(base: string, body: unknown): Promise<number> {
  const res = await fetch(`${base}/tickets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.status;
}

describe("POST /tickets is atomic", () => {
  for (const [label, body] of [
    ["unknown repo", { title: "t1", repo: "nope" }],
    ["unknown scope node", { title: "t2", scopeNodeIds: ["zzz"] }],
    ["unknown repo in repoIds", { title: "t3", repoIds: [{ repo_id: "zz", access: "write" }] }],
  ] as const) {
    it(`${label}: 404 and no ticket or event left behind`, async () => {
      const { wg, base } = await start();
      wg.registerRepository({ name: "app", path: "/tmp/app" }, human);
      const before = counts(wg);
      expect(await createTicket(base, body)).toBe(404);
      expect(await createTicket(base, body)).toBe(404);
      expect(counts(wg)).toEqual(before);
      // The next successful create gets the next number — nothing was burned.
      expect(await createTicket(base, { title: "ok", repo: "app" })).toBe(201);
      expect(wg.listTickets().map((t) => t.number)).toEqual([1]);
    });
  }

  it("a good create still links repo, scope and access", async () => {
    const { wg, base } = await start();
    const repo = wg.registerRepository({ name: "app", path: "/tmp/app" }, human);
    const node = wg.createScopeNode({ name: "Product", type: "product" }, human);
    expect(
      await createTicket(base, {
        title: "ok",
        scopeNodeIds: [node.id],
        repoIds: [{ repo_id: repo.id, access: "write" }],
      }),
    ).toBe(201);
    const t = wg.listTickets()[0]!;
    expect(wg.ticketScopeSummary(t.id).primary?.id).toBe(node.id);
    expect(wg.workPacketRepos(t.id).writeRepos.map((r) => r.name)).toEqual(["app"]);
  });
});

describe("MCP create_ticket is atomic", () => {
  it("an unknown repo errors twice and leaves no draft", () => {
    const wg = Dispatch.open(":memory:", new TestClock());
    const h = makeHandlers(wg, agent);
    const before = counts(wg);
    expect(h.create_ticket({ title: "dup", repo: "nope" }).isError).toBe(true);
    expect(h.create_ticket({ title: "dup", repo: "nope" }).isError).toBe(true);
    expect(counts(wg)).toEqual(before);
  });

  it("an unregistered GAFFER_DEFAULT_TICKET_REPO fallback also leaves no draft", () => {
    const wg = Dispatch.open(":memory:", new TestClock());
    process.env.GAFFER_DEFAULT_TICKET_REPO = "unregistered";
    const h = makeHandlers(wg, agent);
    expect(h.create_ticket({ title: "po draft" }).isError).toBe(true);
    expect(wg.listTickets()).toEqual([]);
  });
});

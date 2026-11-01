import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createApiServer } from "../src/api/server.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { TestClock } from "../src/util/clock.js";

/**
 * Batched and bounded reads for the dashboard (exploratory findings api-robustness/F9
 * and F10). The dashboard read GET /tickets/:id once per ticket (6 at a time): the Map
 * at 2000 tickets made ~1000 requests and took 2–4 s. And a bare GET /tickets or
 * GET /api/board answered every row: 54 MB and 7 MB on a 20k-ticket board.
 *   - GET /tickets/details?ids=…&include=… answers many tickets' detail parts at once,
 *     or (without ids) a page of every ticket;
 *   - GET /scope/repos?all=1 answers every repo's scopes at once;
 *   - GET /tickets and GET /api/board answer a bounded page by default.
 */

const human: Actor = { type: "human", id: "tom" };

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function start(n: number): Promise<{ wg: Dispatch; base: string; ids: string[] }> {
  process.env.DISPATCH_AUDIT_OFF = "1";
  const wg = Dispatch.open(":memory:", new TestClock());
  const repo = wg.registerRepository({ name: "svc", default_branch: "main" }, human);
  const ids: string[] = [];
  wg.db.exec("BEGIN");
  for (let i = 0; i < n; i++) {
    const t = wg.createTicketWithLinks(
      { title: `t${i + 1}`, description: "x".repeat(500), policy_pack: "solo_loose" },
      { repoAccess: [{ repo_id: repo.id, access: "write" }] },
      human,
    );
    ids.push(t.id);
  }
  wg.db.exec("COMMIT");
  const server = createApiServer(wg);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  close = () =>
    new Promise<void>((resolve) =>
      server.close(() => {
        wg.db.close();
        resolve();
      }),
    );
  return { wg, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, ids };
}

async function get<T = Record<string, unknown>>(
  base: string,
  path: string,
): Promise<{ status: number; body: T }> {
  const res = await fetch(base + path);
  return { status: res.status, body: (await res.json()) as T };
}

interface DetailsBody {
  details: Array<{
    ticket: Record<string, unknown>;
    repositories?: Array<{ name: string; access: string }>;
    scopes?: Array<{ id: string }>;
    dependencies?: Array<{ depends_on_ticket_id: string; satisfied: boolean }>;
    events?: unknown[];
    evidence?: unknown[];
    rework_trail?: unknown[];
  }>;
  missing: string[];
  total: number;
  next_offset?: number | null;
}

describe("GET /tickets/details (exploratory finding api-robustness/F9)", () => {
  it("answers the links of the named tickets in one read, the summary row with each", async () => {
    const { wg, base, ids } = await start(4);
    const epic = wg.createScopeNode({ name: "Epic", type: "epic" }, human);
    wg.linkTicketScope({ ticket_id: ids[0], scope_node_id: epic.id, relation: "primary" }, human);
    wg.addDependency({ ticket: ids[1], depends_on: ids[0] }, human);
    const r = await get<DetailsBody>(base, `/tickets/details?ids=${ids[0]},${ids[1]},nope`);
    expect(r.status).toBe(200);
    expect(r.body.details.map((d) => d.ticket.id)).toEqual([ids[0], ids[1]]);
    expect(r.body.missing).toEqual(["nope"]);
    const [a, b] = r.body.details;
    expect(a!.scopes!.map((s) => s.id)).toContain(epic.id);
    expect(a!.repositories!.map((x) => [x.name, x.access])).toEqual([["svc", "write"]]);
    expect(b!.dependencies!.map((d) => d.depends_on_ticket_id)).toEqual([ids[0]]);
    // The default parts only: no events or evidence, and no description on the row.
    expect(a).not.toHaveProperty("events");
    expect(a!.ticket).not.toHaveProperty("description");
    expect(a!.ticket.title).toBe("t1");
  });

  it("include= picks the parts, the full set included", async () => {
    const { base, ids } = await start(2);
    const r = await get<DetailsBody>(
      base,
      `/tickets/details?ids=${ids[0]}&include=events,evidence,rework_trail`,
    );
    const d = r.body.details[0]!;
    expect(Array.isArray(d.events)).toBe(true);
    expect(d.events!.length).toBeGreaterThan(0);
    expect(Array.isArray(d.evidence)).toBe(true);
    expect(Array.isArray(d.rework_trail)).toBe(true);
    expect(d).not.toHaveProperty("scopes");
  });

  it("without ids it pages every ticket, with next_offset", async () => {
    const { base } = await start(30);
    const p1 = await get<DetailsBody>(base, "/tickets/details?limit=20");
    expect(p1.body.details).toHaveLength(20);
    expect(p1.body).toMatchObject({ total: 30, next_offset: 20 });
    const p2 = await get<DetailsBody>(base, "/tickets/details?limit=20&offset=20");
    expect(p2.body.details).toHaveLength(10);
    expect(p2.body.next_offset).toBeNull();
  });

  it("refuses an unknown part, an empty or oversized id list", async () => {
    const { base, ids } = await start(1);
    expect((await get(base, `/tickets/details?ids=${ids[0]}&include=secrets`)).status).toBe(422);
    expect((await get(base, "/tickets/details?ids=,")).status).toBe(422);
    const many = Array.from({ length: 201 }, (_, i) => `id${i}`).join(",");
    expect((await get(base, `/tickets/details?ids=${many}`)).status).toBe(422);
  });

  it("GET /scope/repos?all=1 answers every repo's scopes in one read", async () => {
    const { wg, base } = await start(1);
    const repo = wg.listRepositories()[0]!;
    const node = wg.createScopeNode({ name: "Ground", type: "product" }, human);
    wg.linkScopeRepo({ scope_node_id: node.id, repo_id: repo.id, relation: "owns" }, human);
    const r = await get<{ by_repo: Record<string, Array<{ id: string }>> }>(
      base,
      "/scope/repos?all=1",
    );
    expect(r.status).toBe(200);
    expect(r.body.by_repo[repo.id]!.map((s) => s.id)).toEqual([node.id]);
    expect((await get(base, "/scope/repos")).status).toBe(422);
  });
});

describe("bounded pages by default (exploratory finding api-robustness/F10)", () => {
  it("a bare GET /tickets answers 500 rows and next_offset; following it reaches the rest", async () => {
    const { base } = await start(520);
    const p1 = await get<{ tickets: unknown[]; total: number; next_offset: number | null }>(
      base,
      "/tickets",
    );
    expect(p1.body.tickets).toHaveLength(500);
    expect(p1.body).toMatchObject({ total: 520, limit: 500, offset: 0, next_offset: 500 });
    const p2 = await get<{ tickets: unknown[]; next_offset: number | null }>(
      base,
      `/tickets?offset=${p1.body.next_offset}`,
    );
    expect(p2.body.tickets).toHaveLength(20);
    expect(p2.body.next_offset).toBeNull();
  });

  it("a bare GET /api/board answers a window of 500 cards per area, counts intact", async () => {
    const { base } = await start(520);
    const r = await get<{
      columns: Array<{ column: string; cards: unknown[] }>;
      counts: { columns: Record<string, number> };
      window: unknown;
    }>(base, "/api/board");
    const drafts = r.body.columns.find((c) => c.column === "draft");
    expect(drafts?.cards).toHaveLength(500);
    expect(r.body.counts.columns.draft).toBe(520);
    expect(r.body.window).toMatchObject({ limit: 500, offset: 0 });
  });
});

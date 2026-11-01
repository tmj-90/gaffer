import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createApiServer } from "../src/api/server.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { TestClock } from "../src/util/clock.js";

/**
 * GET /tickets had no paging and silently ignored `limit`, so every view moved the
 * whole backlog (every row's description, test contract and review feedback).
 * Paging is opt-in (no `limit` ⇒ every row, as before) and `fields=summary` drops
 * the large text columns.
 */

const human: Actor = { type: "human", id: "tom" };
const N = 25;

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function start(): Promise<{ wg: Dispatch; base: string }> {
  process.env.DISPATCH_AUDIT_OFF = "1";
  const wg = Dispatch.open(":memory:", new TestClock());
  for (let i = 0; i < N; i++) {
    wg.createTicket(
      { title: `t${i + 1}`, description: "x".repeat(2_000), policy_pack: "solo_loose" },
      human,
    );
  }
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

interface ListBody {
  tickets: Array<Record<string, unknown>>;
  total: number;
  limit?: number;
  offset?: number;
}

async function list(base: string, qs: string): Promise<{ status: number; body: ListBody }> {
  const res = await fetch(`${base}/tickets${qs}`);
  return { status: res.status, body: (await res.json()) as ListBody };
}

describe("GET /tickets paging", () => {
  it("with no params every row is returned, with the total", async () => {
    const { base } = await start();
    const r = await list(base, "");
    expect(r.status).toBe(200);
    expect(r.body.tickets).toHaveLength(N);
    expect(r.body.total).toBe(N);
    expect(r.body.tickets[0]?.description).toBe("x".repeat(2_000));
  });

  it("limit=10 returns 10 rows and the full total; offset pages are disjoint", async () => {
    const { base } = await start();
    const p1 = await list(base, "?limit=10");
    expect(p1.body.tickets).toHaveLength(10);
    expect(p1.body).toMatchObject({ total: N, limit: 10, offset: 0 });
    const p2 = await list(base, "?limit=10&offset=10");
    const p3 = await list(base, "?limit=10&offset=20");
    expect(p3.body.tickets).toHaveLength(N - 20);
    const ids = [p1, p2, p3].flatMap((p) => p.body.tickets.map((t) => t.id));
    expect(new Set(ids).size).toBe(N);
  });

  it("the total honours the filters", async () => {
    const { base, wg } = await start();
    const t = wg.listTickets()[0]!;
    wg.addAcceptanceCriterion({ ticket_id: t.id, text: "a" }, human);
    wg.markReady(t.id, human);
    const r = await list(base, "?status=ready&limit=1");
    expect(r.body.total).toBe(1);
    expect(r.body.tickets.map((x) => x.id)).toEqual([t.id]);
  });

  it("fields=summary leaves out the large text columns", async () => {
    const { base } = await start();
    const r = await list(base, "?fields=summary&limit=3");
    expect(r.body.tickets).toHaveLength(3);
    for (const t of r.body.tickets) {
      expect(t).not.toHaveProperty("description");
      expect(t).not.toHaveProperty("test_contract");
      expect(t).not.toHaveProperty("last_review_feedback");
      expect(t).toMatchObject({ status: "draft" });
      expect(typeof t.title).toBe("string");
    }
  });

  it("limit is clamped; a non-numeric limit or unknown fields value is a 422", async () => {
    const { base } = await start();
    expect((await list(base, "?limit=5000")).body.limit).toBe(1_000);
    expect((await list(base, "?limit=0")).body.tickets).toHaveLength(1);
    expect((await list(base, "?limit=abc")).status).toBe(422);
    expect((await list(base, "?fields=everything")).status).toBe(422);
  });
});

describe("GET /tickets order", () => {
  it("same-millisecond tickets come back in ticket-number order, however they were stored (exploratory finding api-robustness/F15)", async () => {
    // TestClock never advances: all 25 share one created_at, as tickets created in one
    // burst (or imported) do. Ties came back in storage order, so #12/#13 swapped after
    // an import. Move #1 and #2 to the end of the table's storage order.
    const { wg, base } = await start();
    wg.db.prepare("UPDATE tickets SET rowid = 10000 + number WHERE number IN (1, 2)").run();
    const expected = Array.from({ length: N }, (_, i) => i + 1);
    const all = await list(base, "");
    expect(all.body.tickets.map((t) => t.number)).toEqual(expected);
    const paged = [
      ...(await list(base, "?limit=10")).body.tickets,
      ...(await list(base, "?limit=10&offset=10")).body.tickets,
      ...(await list(base, "?limit=10&offset=20")).body.tickets,
    ];
    expect(paged.map((t) => t.number)).toEqual(expected);
    expect(wg.listTickets({ status: "draft" }).map((t) => t.number)).toEqual(expected);
    expect(wg.listTickets({}).map((t) => t.number)).toEqual(expected);
  });
});

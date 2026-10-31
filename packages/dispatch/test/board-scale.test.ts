import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiServer } from "../src/api/server.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";

// ---------------------------------------------------------------------------
// Board scaling (third external review, LOW). The unfiltered board loaded 32,766
// tickets and failed at 32,767 with "too many SQL variables": every card's repository
// link was looked up with one bound parameter per ticket. The lookup now binds ONE
// JSON array whatever the count, and the API serves a visible window per lane with
// whole-board counts. Seeded straight into a temp database so it stays well under 30 s.
// ---------------------------------------------------------------------------

const N = 40_000;
const human: Actor = { type: "human", id: "tom" };
let dir: string;
let wg: Dispatch;
let repoId: string;

beforeAll(() => {
  process.env.DISPATCH_AUDIT_OFF = "1";
  dir = mkdtempSync(join(tmpdir(), "dispatch-board-scale-"));
  wg = Dispatch.open(join(dir, "board.sqlite"));
  repoId = wg.registerRepository({ name: "svc", default_branch: "main" }, human).id;
  const now = new Date().toISOString();
  const ticket = wg.db.prepare(
    `INSERT INTO tickets (id, number, title, description, status, priority, risk_level, created_at, updated_at)
     VALUES (?, ?, ?, '', ?, 0, 'low', ?, ?)`,
  );
  const link = wg.db.prepare(
    `INSERT INTO ticket_repos (ticket_id, repo_id, access, relation) VALUES (?, ?, 'write', 'confirmed')`,
  );
  // Mostly history, as a long-lived factory's board is: done and won't-do dominate.
  const statuses = ["done", "done", "done", "done", "cancelled", "ready", "draft", "in_review"];
  wg.db.transaction(() => {
    for (let i = 1; i <= N; i++) {
      ticket.run(`t${i}`, i, `ticket ${i}`, statuses[i % statuses.length], now, now);
      link.run(`t${i}`, repoId);
    }
  })();
}, 60_000);

afterAll(() => {
  wg.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("board at 40,000 tickets", () => {
  it("the unfiltered board loads every ticket, each with its repository link", () => {
    const board = wg.board();
    const cards = [...board.columns.flatMap((c) => c.cards), ...board.closed, ...board.wontDo];
    expect(cards).toHaveLength(N);
    expect(cards.every((c) => c.repos.length === 1 && c.repos[0]!.name === "svc")).toBe(true);
    expect(board.counts.columns.done).toBe(N / 2);
    expect(board.counts.wontDo).toBe(N / 8);
    expect(board.window).toBeNull();
  }, 30_000);

  it("a window returns at most `limit` cards per lane with whole-board counts", () => {
    const board = wg.board(undefined, { limit: 50, offset: 0 });
    for (const col of board.columns) {
      expect(col.cards.length).toBe(Math.min(50, board.counts.columns[col.column]));
    }
    expect(board.counts.columns.done).toBe(N / 2);
    expect(board.counts.columns.ready).toBe(N / 8);
    expect(board.wontDo).toHaveLength(50);
    expect(board.columns.find((c) => c.column === "done")!.cards[0]!.repos[0]!.name).toBe("svc");

    // One lane's next page, the others empty but still counted.
    const more = wg.board(undefined, { limit: 50, offset: 50, area: "done" });
    const done = more.columns.find((c) => c.column === "done")!.cards;
    const firstPage = board.columns.find((c) => c.column === "done")!.cards;
    expect(done).toHaveLength(50);
    expect(new Set([...done, ...firstPage].map((c) => c.id)).size).toBe(100);
    expect(more.columns.find((c) => c.column === "ready")!.cards).toHaveLength(0);
    expect(more.counts.columns.ready).toBe(N / 8);
  }, 30_000);

  it("GET /api/board?limit= serves the window; a bad window is refused (422)", async () => {
    const server = createApiServer(wg);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/board?limit=100`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        columns: Array<{ column: string; cards: unknown[] }>;
        counts: { columns: Record<string, number>; wontDo: number };
        window: { limit: number; offset: number } | null;
      };
      expect(body.window).toEqual({ limit: 100, offset: 0 });
      expect(body.columns.find((c) => c.column === "done")!.cards).toHaveLength(100);
      expect(body.counts.columns.done).toBe(N / 2);
      const bad = await fetch(`http://127.0.0.1:${port}/api/board?limit=0`);
      expect(bad.status).toBe(422);
      const badArea = await fetch(`http://127.0.0.1:${port}/api/board?limit=10&area=nope`);
      expect(badArea.status).toBe(422);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 30_000);
});

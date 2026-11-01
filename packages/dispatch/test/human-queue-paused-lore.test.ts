// The Team Sheet is "everything waiting on you" (exploratory finding ui-explore/F-04).
// README "What still needs you" lists approving or rejecting lore drafts, and a
// delivery paused at a cap waits for the human's Continue or Stop. Neither was in
// GET /api/human-queue: the paused ticket only showed in the Injury list, the drafts
// only on Memory.

import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { createApiServer } from "../src/api/server.js";
import type { LoreSummary, MemoryReader } from "../src/api/memoryReader.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";

const human: Actor = { type: "human", id: "tom" };
const system: Actor = { type: "system" };

interface QueueItem {
  kind: string;
  label: string;
  reason: string;
  ticket: { id: string } | null;
  suggestedAction?: string | null;
  loreDrafts?: number;
}
interface Queue {
  items: QueueItem[];
  counts: { total: number; paused: number; loreDrafts: number };
}

/** A Memory with `drafts` lore drafts awaiting approval (counts its list calls). */
function memoryWith(drafts: string[]): MemoryReader & { calls: number } {
  const lore = (title: string): LoreSummary => ({
    id: "abcdefgh",
    title,
    summary: "s",
    status: "draft",
    confidence: null,
    source: null,
    repos: [],
    tags: [],
    stale: false,
    flagged: false,
  });
  const reader = {
    calls: 0,
    listLore(opts?: { status?: readonly string[]; limit?: number }) {
      reader.calls++;
      const all = (opts?.status ?? []).includes("draft") ? drafts.map(lore) : [];
      return {
        available: true as const,
        lore: all.slice(0, opts?.limit ?? 50),
        total: all.length,
        limit: opts?.limit ?? 50,
        offset: 0,
      };
    },
  };
  return reader as unknown as MemoryReader & { calls: number };
}

let server: Server | null = null;
let wg: Dispatch | null = null;
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  wg?.db.close();
  server = null;
  wg = null;
});
async function queue(reader: MemoryReader): Promise<Queue> {
  if (!server) {
    server = createApiServer(wg!, undefined, undefined, undefined, undefined, "127.0.0.1", reader);
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  }
  const { port } = server.address() as AddressInfo;
  return (await (await fetch(`http://127.0.0.1:${port}/api/human-queue`)).json()) as Queue;
}

/** A ticket claimed by an agent, then paused at the turn cap. */
function pausedTicket(): string {
  const t = wg!.createTicket({ title: "Capped", description: "d" }, human);
  wg!.addAcceptanceCriterion({ ticket_id: t.id, text: "ok" }, human);
  wg!.markReady(t.id, human);
  const agent = wg!.registerAgent({ display_name: "a" }, human);
  wg!.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, human);
  wg!.pauseDelivery(t.id, { reason: "cap_hit", turns: 999, spend: "$0.02" }, system);
  expect(wg!.view(t.id).ticket.status).toBe("paused");
  return t.id;
}

describe("GET /api/human-queue: paused deliveries and lore drafts wait on the human", () => {
  it("a paused delivery is a row (Continue or Stop), until Continue is pressed", async () => {
    wg = Dispatch.open(":memory:");
    const id = pausedTicket();
    const q = await queue(memoryWith([]));
    const row = q.items.find((i) => i.kind === "paused");
    expect(row?.ticket?.id).toBe(id);
    expect(row?.label).toBe("Paused");
    expect(row?.reason).toContain("hit the turn cap after 999 turns");
    expect(row?.reason).toContain("$0.02 spent so far");
    expect(row?.suggestedAction).toBe("continue");
    expect(q.counts.paused).toBe(1);

    wg.continuePaused(id, human);
    const after = await queue(memoryWith([]));
    expect(after.items.find((i) => i.kind === "paused")).toBeUndefined();
    expect(after.counts.paused).toBe(0);
  });

  it("lore drafts awaiting approval are ONE row that names them and counts them", async () => {
    wg = Dispatch.open(":memory:");
    const reader = memoryWith(["Use pnpm", "Never mock the DB", "Tabs not spaces", "Fourth"]);
    const q = await queue(reader);
    const row = q.items.filter((i) => i.kind === "lore_drafts");
    expect(row).toHaveLength(1);
    expect(row[0]!.loreDrafts).toBe(4);
    expect(row[0]!.ticket).toBeNull();
    expect(row[0]!.reason).toContain("4 lore drafts await your approval in Memory");
    expect(row[0]!.reason).toContain("“Use pnpm”");
    expect(row[0]!.reason).toContain("and more");
    expect(q.counts.loreDrafts).toBe(4);
    expect(q.counts.total).toBe(1);
    // The Memory CLI is a child process: a second read inside the memo window reuses it.
    await queue(reader);
    expect(reader.calls).toBe(1);
  });

  it("no drafts (or no Memory) is no row", async () => {
    wg = Dispatch.open(":memory:");
    const q = await queue(memoryWith([]));
    expect(q.items).toEqual([]);
    expect(q.counts.loreDrafts).toBe(0);
  });
});

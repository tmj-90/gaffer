/**
 * BOUNDED MEMORY READS on GET /api/review-rules (measure review O2, lane-hook package).
 * Each proposed rule's lore status is a synchronous memory CLI call with a 10 s timeout,
 * and the report read up to 20 per request, so a slow or hung memory held the request
 * (and the server) for minutes. Answers are now reused for a minute; once memory cannot
 * answer the rest of the report asks nothing, and later reports wait a minute.
 */
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import type { MemoryReader } from "../src/api/memoryReader.js";
import { createMemoryReader } from "../src/api/memoryReader.js";
import { createPlanBuildRunner } from "../src/api/planBuild.js";
import { createApiServer } from "../src/api/server.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { writeEvent } from "../src/events/eventWriter.js";
import { createLoreStatusCache } from "../src/services/reviewRuleService.js";
import { TestClock } from "../src/util/clock.js";

const human: Actor = { type: "human", id: "tom" };
const IDS = ["rulea234", "ruleb234", "rulec234"];

async function serverWith(loreHistory: MemoryReader["loreHistory"]) {
  process.env.DISPATCH_AUDIT_OFF = "1";
  const wg = Dispatch.open(":memory:", new TestClock());
  const memoryReader: MemoryReader = {
    ...createMemoryReader({} as NodeJS.ProcessEnv),
    loreHistory,
  };
  const noop = { run: () => ({ started: true }) } as never;
  const server = createApiServer(
    wg,
    noop,
    createPlanBuildRunner(),
    noop,
    noop,
    "127.0.0.1",
    memoryReader,
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const [i, id] of IDS.entries())
    writeEvent(wg.db, {
      entity_type: "repository",
      entity_id: "app",
      actor: human,
      event_type: "review_rule.proposed",
      payload: { repo: "app", key: `rule ${i}`, count: 3, tickets: [], lore_id: id },
    });
  const read = async () => {
    const res = await fetch(`${base}/api/review-rules`);
    expect(res.status).toBe(200);
    return (await res.json()) as {
      proposed: Array<{ lore_id: string; lore_status: string | null }>;
    };
  };
  const close = () =>
    new Promise<void>((r) =>
      server.close(() => {
        wg.db.close();
        r();
      }),
    );
  return { read, close };
}

const active = (id: string) =>
  ({
    available: true,
    id,
    current: { status: "active" },
    approvedAt: "2026-06-01T09:00:00.000Z",
    versions: [],
  }) as unknown as ReturnType<MemoryReader["loreHistory"]>;

describe("GET /api/review-rules bounds its memory reads", () => {
  it("reuses memory's answers: a second read within a minute asks memory nothing", async () => {
    const asked: string[] = [];
    const s = await serverWith((id) => {
      asked.push(id);
      return active(id);
    });
    try {
      const first = await s.read();
      expect(first.proposed.map((p) => p.lore_status)).toEqual(["active", "active", "active"]);
      expect(asked).toHaveLength(3);
      const second = await s.read();
      expect(second.proposed.map((p) => p.lore_status)).toEqual(["active", "active", "active"]);
      expect(asked).toHaveLength(3);
    } finally {
      await s.close();
    }
  });

  it("a memory that cannot answer is asked once per minute, not once per rule per read", async () => {
    let asked = 0;
    const s = await serverWith(() => {
      asked += 1;
      return { available: false, reason: "memory CLI timed out" } as ReturnType<
        MemoryReader["loreHistory"]
      >;
    });
    try {
      const first = await s.read();
      expect(first.proposed.map((p) => p.lore_status)).toEqual([null, null, null]);
      expect(asked).toBe(1);
      await s.read();
      expect(asked).toBe(1);
    } finally {
      await s.close();
    }
  });
});

describe("the lore-status cache", () => {
  it("expires answers, backs off after a miss, forgets a decided id, and never serves a stale one while memory is down", () => {
    let t = 0;
    const cache = createLoreStatusCache({ ttlMs: 1000, backoffMs: 500, now: () => t });
    let up = true;
    let calls = 0;
    const base = () => {
      calls += 1;
      return up ? { status: "draft", approvedAt: null } : null;
    };
    expect(cache.lookup(base)("a")).toEqual({ status: "draft", approvedAt: null });
    expect(cache.lookup(base)("a")).toEqual({ status: "draft", approvedAt: null });
    expect(calls).toBe(1);
    cache.forget("a");
    cache.lookup(base)("a");
    expect(calls).toBe(2);
    t = 2000; // expired
    up = false;
    const report = cache.lookup(base);
    expect(report("a")).toBeNull(); // asked, memory down: unknown, not the stale draft
    expect(report("b")).toBeNull(); // the same report asks nothing more
    expect(calls).toBe(3);
    t = 2400; // inside the back-off
    expect(cache.lookup(base)("a")).toBeNull();
    expect(calls).toBe(3);
    t = 2600;
    up = true;
    expect(cache.lookup(base)("a")).toEqual({ status: "draft", approvedAt: null });
    expect(calls).toBe(4);
  });
});

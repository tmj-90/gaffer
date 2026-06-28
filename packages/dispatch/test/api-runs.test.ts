import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Run } from "../src/domain/types.js";
import { createApiServer } from "../src/api/server.js";
import { TestClock } from "../src/util/clock.js";

/**
 * RUN-ACTIVITY — the REST surface:
 *   GET /api/runs?active=1&limit=N  → { active: Run[], recent: Run[] }
 *   GET /api/runs/:id/log           → text/plain tail (404 when missing)
 */

interface Harness {
  baseUrl: string;
  wg: Dispatch;
  close: () => Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const wg = Dispatch.open(":memory:", new TestClock());
  const server = createApiServer(wg);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    wg,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          wg.db.close();
          resolve();
        });
      }),
  };
}

describe("RUN-ACTIVITY REST: GET /api/runs", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("returns active runs and the finished tail separately", async () => {
    const running = h.wg.recordRunStart({ kind: "product_owner", repo: "gaffer", pid: 1 });
    const ok = h.wg.recordRunStart({ kind: "onboard", repo: "crew", pid: 2 });
    h.wg.markRunEnd(ok.id, { exit_code: 0 });
    const bad = h.wg.recordRunStart({ kind: "poll_work", pid: 3 });
    h.wg.markRunEnd(bad.id, { exit_code: 1 });

    const res = await fetch(`${h.baseUrl}/api/runs?active=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = (await res.json()) as { active: Run[]; recent: Run[] };

    expect(body.active.map((r) => r.id)).toEqual([running.id]);
    expect(body.active[0]!.status).toBe("running");

    const recentIds = body.recent.map((r) => r.id);
    expect(recentIds).toContain(ok.id);
    expect(recentIds).toContain(bad.id);
    // The still-running one is NOT in the finished tail.
    expect(recentIds).not.toContain(running.id);
    const byId = new Map(body.recent.map((r) => [r.id, r]));
    expect(byId.get(ok.id)!.status).toBe("succeeded");
    expect(byId.get(bad.id)!.status).toBe("failed");
  });

  it("honours a limit on the recent tail", async () => {
    for (let i = 0; i < 5; i++) {
      const r = h.wg.recordRunStart({ kind: "other", repo: `r${i}` });
      h.wg.markRunEnd(r.id, { exit_code: 0 });
    }
    const res = await fetch(`${h.baseUrl}/api/runs?limit=2`);
    const body = (await res.json()) as { active: Run[]; recent: Run[] };
    expect(body.recent).toHaveLength(2);
  });
});

describe("RUN-ACTIVITY REST: GET /api/runs/:id/log", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("returns the captured log tail as text/plain", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wg-runlog-"));
    const logPath = join(dir, "run.log");
    writeFileSync(logPath, "filed 3 tickets\nall good\n");
    const run = h.wg.recordRunStart({ kind: "product_owner", repo: "gaffer", log_path: logPath });
    h.wg.markRunEnd(run.id, { exit_code: 0 });

    const res = await fetch(`${h.baseUrl}/api/runs/${run.id}/log`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);
    const text = await res.text();
    expect(text).toContain("filed 3 tickets");
    expect(text).toContain("all good");
  });

  it("caps the tail to the last bytes of a large log", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wg-runlog-"));
    const logPath = join(dir, "big.log");
    // 80KB of 'a' then a unique marker at the very end.
    writeFileSync(logPath, "a".repeat(80 * 1024) + "TAIL-MARKER");
    const run = h.wg.recordRunStart({ kind: "merge", log_path: logPath });

    const res = await fetch(`${h.baseUrl}/api/runs/${run.id}/log`);
    expect(res.status).toBe(200);
    const text = await res.text();
    // The end marker survives; the response is bounded (< the full 80KB+).
    expect(text).toContain("TAIL-MARKER");
    expect(text.length).toBeLessThanOrEqual(64 * 1024);
  });

  it("404s for an unknown run id", async () => {
    const res = await fetch(`${h.baseUrl}/api/runs/does-not-exist/log`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("404s when the run exists but its log file is missing", async () => {
    const run = h.wg.recordRunStart({ kind: "onboard", log_path: "/no/such/run.log" });
    const res = await fetch(`${h.baseUrl}/api/runs/${run.id}/log`);
    expect(res.status).toBe(404);
  });

  it("404s when the run has no log path at all", async () => {
    const run = h.wg.recordRunStart({ kind: "poll_work" });
    const res = await fetch(`${h.baseUrl}/api/runs/${run.id}/log`);
    expect(res.status).toBe(404);
  });
});

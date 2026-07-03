/**
 * Integration tests for GET /api/health (models api-cost.test.ts).
 *
 * Covers:
 *   - Zero-state envelope when no ledger and no tickets exist
 *   - The full envelope shape (ledger ROI + delivery flow in one response)
 *   - cost-per-shipped derived from the real done-ticket count (and its
 *     no-divide-by-zero null when nothing has shipped)
 *   - measured-vs-unknown coverage from a mixed ledger
 *   - cycle-time / throughput served authoritatively from the endpoint
 *   - Method-not-allowed for non-GET
 *   - Read-only open on loopback even with a token configured
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApiServer } from "../src/api/server.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { TestClock } from "../src/util/clock.js";

const human: Actor = { type: "human", id: "tom" };
const DAY = 86_400_000;

interface Harness {
  wg: Dispatch;
  clock: TestClock;
  baseUrl: string;
  close: () => Promise<void>;
}

async function startHarness(extraEnv: Record<string, string | undefined> = {}): Promise<Harness> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(extraEnv)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  process.env.DISPATCH_AUDIT_OFF = "1";
  const clock = new TestClock();
  const wg = Dispatch.open(":memory:", clock);
  const server = createApiServer(wg);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    wg,
    clock,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          wg.db.close();
          for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
          }
          resolve();
        });
      }),
  };
}

interface JsonResp {
  status: number;
  body: Record<string, unknown>;
}

async function get(baseUrl: string, path: string, token?: string): Promise<JsonResp> {
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, { headers });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

/**
 * Create a ticket and force it to `done` with explicit created/updated stamps —
 * a test-only shortcut to seed the delivery-flow read model without running the
 * whole claim→deliver→review→merge pipeline.
 */
function makeDoneTicket(
  wg: Dispatch,
  nowMs: number,
  title: string,
  createdMsAgo: number,
  doneMsAgo: number,
): void {
  const t = wg.createTicket({ title }, human);
  wg.db.prepare(`UPDATE tickets SET status='done', created_at=@c, updated_at=@u WHERE id=@id`).run({
    id: t.id,
    c: new Date(nowMs - createdMsAgo).toISOString(),
    u: new Date(nowMs - doneMsAgo).toISOString(),
  });
}

describe("GET /api/health", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "gaffer-api-health-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns a zero-state envelope when no ledger and no tickets exist", async () => {
    const h = await startHarness({
      GAFFER_DATA: undefined,
      GAFFER_USAGE_LEDGER: undefined,
      GAFFER_SKILL_TELEMETRY: undefined,
      MEMORY_CLI_BIN: undefined,
      MEMORY_DB: undefined,
    });
    try {
      const { status, body } = await get(h.baseUrl, "/api/health");
      expect(status).toBe(200);
      expect(body.total_usd).toBe(0);
      expect(body.shipped_count).toBe(0);
      expect(body.cost_per_shipped_usd).toBeNull();
      expect(body.coverage).toEqual({ measured_count: 0, total_count: 0, coverage_pct: 0 });
      expect(body.by_kind).toEqual([]);
      expect(body.by_model).toEqual([]);
      expect(body.daily_spend).toEqual([]);
      expect(body.last_record_at).toBeNull();

      // The two newly-wired sources degrade gracefully in the zero-state:
      // skill telemetry is a zero-state (null overall hit-rate); recall is
      // unavailable (Memory not wired) but NEVER breaks the endpoint.
      const skills = body.skills as {
        total_records: number;
        overall_hit_rate_pct: number | null;
        by_skill: unknown[];
      };
      expect(skills.total_records).toBe(0);
      expect(skills.overall_hit_rate_pct).toBeNull();
      expect(skills.by_skill).toEqual([]);
      const recall = body.recall as { available: boolean };
      expect(recall.available).toBe(false);
      // Delivery flow is always present (ticket-derived, not ledger-derived).
      const cycle = body.cycle_time as { median_days: number; series: number[] };
      const thr = body.throughput as { last7: number; prev7: number; series: number[] };
      expect(cycle.median_days).toBe(0);
      expect(cycle.series).toHaveLength(14);
      expect(thr.last7).toBe(0);
      expect(thr.series).toHaveLength(14);
    } finally {
      await h.close();
    }
  });

  it("computes cost-per-shipped from the real done-ticket count and reports full coverage", async () => {
    const ledger = join(tmpDir, "usage-ledger.jsonl");
    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(
      ledger,
      [
        JSON.stringify({
          ts: `${today}T10:00:00Z`,
          ticket: 1,
          kind: "delivery",
          measured: true,
          total_cost_usd: 0.6,
          duration_ms: 10000,
          models: {
            opus: { input: 100, output: 50, cache_read: 0, cache_create: 0, cost_usd: 0.6 },
          },
        }),
        JSON.stringify({
          ts: `${today}T11:00:00Z`,
          ticket: 2,
          kind: "review",
          measured: true,
          total_cost_usd: 0.4,
          duration_ms: 4000,
        }),
      ].join("\n"),
    );

    const h = await startHarness({ GAFFER_USAGE_LEDGER: ledger, GAFFER_DATA: undefined });
    try {
      // Two shipped tickets → cost-per-shipped = 1.0 / 2 = 0.5. Timestamps are
      // anchored to the server clock so they land inside the 14-day window.
      const nowMs = h.clock.nowMs();
      makeDoneTicket(h.wg, nowMs, "shipped a", 4 * DAY, 2 * DAY);
      makeDoneTicket(h.wg, nowMs, "shipped b", 6 * DAY, 1 * DAY);

      const { status, body } = await get(h.baseUrl, "/api/health");
      expect(status).toBe(200);
      expect(body.total_usd as number).toBeCloseTo(1.0);
      expect(body.shipped_count).toBe(2);
      expect(body.cost_per_shipped_usd as number).toBeCloseTo(0.5);

      const coverage = body.coverage as { coverage_pct: number };
      expect(coverage.coverage_pct).toBe(100);

      const byKind = body.by_kind as Array<{ kind: string }>;
      expect(byKind.map((k) => k.kind).sort()).toEqual(["delivery", "review"]);

      const byModel = body.by_model as Array<{ model: string; input: number }>;
      expect(byModel.find((m) => m.model === "opus")!.input).toBe(100);

      // Throughput saw both shipments in the trailing week.
      const thr = body.throughput as { last7: number };
      expect(thr.last7).toBe(2);
      // Cycle time = median(2, 5) = 3.5 days.
      const cycle = body.cycle_time as { median_days: number };
      expect(cycle.median_days).toBeCloseTo(3.5);
    } finally {
      await h.close();
    }
  });

  it("returns null cost-per-shipped when tickets exist but none have shipped", async () => {
    const ledger = join(tmpDir, "usage-ledger.jsonl");
    writeFileSync(
      ledger,
      JSON.stringify({
        ts: "2025-01-15T10:00:00Z",
        ticket: 1,
        measured: true,
        total_cost_usd: 2.0,
      }),
    );
    const h = await startHarness({ GAFFER_USAGE_LEDGER: ledger, GAFFER_DATA: undefined });
    try {
      h.wg.createTicket({ title: "still open" }, human); // exists, not done
      const { status, body } = await get(h.baseUrl, "/api/health");
      expect(status).toBe(200);
      expect(body.total_usd as number).toBeCloseTo(2.0);
      expect(body.shipped_count).toBe(0);
      expect(body.cost_per_shipped_usd).toBeNull();
    } finally {
      await h.close();
    }
  });

  it("reports partial coverage for a mixed measured/unmeasured ledger", async () => {
    const ledger = join(tmpDir, "usage-ledger.jsonl");
    writeFileSync(
      ledger,
      [
        JSON.stringify({
          ts: "2025-01-15T10:00:00Z",
          ticket: 1,
          measured: true,
          total_cost_usd: 0.5,
        }),
        JSON.stringify({ ts: "2025-01-15T11:00:00Z", ticket: 2, measured: false }),
      ].join("\n"),
    );
    const h = await startHarness({ GAFFER_USAGE_LEDGER: ledger, GAFFER_DATA: undefined });
    try {
      const { status, body } = await get(h.baseUrl, "/api/health");
      expect(status).toBe(200);
      const coverage = body.coverage as {
        measured_count: number;
        total_count: number;
        coverage_pct: number;
      };
      expect(coverage.measured_count).toBe(1);
      expect(coverage.total_count).toBe(2);
      expect(coverage.coverage_pct).toBe(50);
    } finally {
      await h.close();
    }
  });

  it("surfaces the skill selected-vs-applied hit-rate from the telemetry file", async () => {
    const telemetry = join(tmpDir, "skills-telemetry.jsonl");
    writeFileSync(
      telemetry,
      [
        JSON.stringify({
          ts: "2025-01-10T10:00:00Z",
          selected: ["run-tests", "frontend-component"],
          applied: ["run-tests"],
        }),
        JSON.stringify({
          ts: "2025-01-11T10:00:00Z",
          selected: ["run-tests"],
          applied: ["run-tests"],
        }),
        "garbage line that must be skipped",
      ].join("\n"),
    );
    const h = await startHarness({
      GAFFER_SKILL_TELEMETRY: telemetry,
      GAFFER_DATA: undefined,
      GAFFER_USAGE_LEDGER: undefined,
    });
    try {
      const { status, body } = await get(h.baseUrl, "/api/health");
      expect(status).toBe(200);
      const skills = body.skills as {
        total_records: number;
        overall_hit_rate_pct: number;
        by_skill: Array<{ skill: string; selected: number; applied: number; hit_rate_pct: number }>;
      };
      // 2 valid rows; run-tests selected 2/applied 2, frontend selected 1/applied 0.
      expect(skills.total_records).toBe(2);
      // 2 applied of 3 selections = 66.7%.
      expect(skills.overall_hit_rate_pct).toBeCloseTo(66.7);
      const runTests = skills.by_skill.find((s) => s.skill === "run-tests")!;
      expect(runTests.hit_rate_pct).toBe(100);
      const frontend = skills.by_skill.find((s) => s.skill === "frontend-component")!;
      expect(frontend.hit_rate_pct).toBe(0);
    } finally {
      await h.close();
    }
  });

  it("returns 405 for POST /api/health", async () => {
    const h = await startHarness({ GAFFER_DATA: undefined, GAFFER_USAGE_LEDGER: undefined });
    try {
      const res = await fetch(`${h.baseUrl}/api/health`, { method: "POST" });
      expect(res.status).toBe(405);
    } finally {
      await h.close();
    }
  });

  it("leaves the read-only health endpoint open on loopback even with a token set", async () => {
    const savedToken = process.env.DISPATCH_API_TOKEN;
    process.env.DISPATCH_API_TOKEN = "secret-token-for-test";
    const h = await startHarness({});
    try {
      const { status } = await get(h.baseUrl, "/api/health");
      expect(status).toBe(200);
      const { status: ok } = await get(h.baseUrl, "/api/health", "secret-token-for-test");
      expect(ok).toBe(200);
    } finally {
      await h.close();
      process.env.DISPATCH_API_TOKEN = savedToken;
    }
  });
});

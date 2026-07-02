/**
 * Integration tests for GET /api/cost.
 *
 * Covers:
 *   - Zero-state response when no ledger is configured
 *   - Correct JSON envelope shape (total_usd, today_usd, ticket_count, by_repo,
 *     top_tickets, last_record_at)
 *   - Populated response when a real JSONL ledger file is provided
 *   - Method-not-allowed for non-GET verbs
 *   - 401 when auth is configured and token is absent
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApiServer } from "../src/api/server.js";
import { Dispatch } from "../src/core.js";
import { TestClock } from "../src/util/clock.js";

interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
}

async function startHarness(extraEnv: Record<string, string | undefined> = {}): Promise<Harness> {
  // Apply env patches before creating the server so the handler sees them.
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(extraEnv)) {
    saved[k] = process.env[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }

  process.env.DISPATCH_AUDIT_OFF = "1";
  const wg = Dispatch.open(":memory:", new TestClock());
  const server = createApiServer(wg);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          wg.db.close();
          // Restore env
          for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) {
              delete process.env[k];
            } else {
              process.env[k] = v;
            }
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/cost", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "gaffer-api-cost-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns zero-state envelope when no ledger is configured", async () => {
    const h = await startHarness({ GAFFER_DATA: undefined, GAFFER_USAGE_LEDGER: undefined });
    try {
      const { status, body } = await get(h.baseUrl, "/api/cost");
      expect(status).toBe(200);
      expect(body.total_usd).toBe(0);
      expect(body.today_usd).toBe(0);
      expect(body.ticket_count).toBe(0);
      expect(body.by_repo).toEqual([]);
      expect(body.top_tickets).toEqual([]);
      expect(body.last_record_at).toBeNull();
    } finally {
      await h.close();
    }
  });

  it("returns zero-state when ledger file does not exist", async () => {
    const h = await startHarness({ GAFFER_DATA: tmpDir, GAFFER_USAGE_LEDGER: undefined });
    try {
      // No file written → ledger absent
      const { status, body } = await get(h.baseUrl, "/api/cost");
      expect(status).toBe(200);
      expect(body.total_usd).toBe(0);
    } finally {
      await h.close();
    }
  });

  it("returns populated response when ledger has measured rows", async () => {
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
          total_cost_usd: 0.1,
          num_turns: 5,
          duration_ms: 10000,
        }),
        JSON.stringify({
          ts: `${today}T11:00:00Z`,
          ticket: 1,
          kind: "review",
          measured: true,
          total_cost_usd: 0.05,
          num_turns: 3,
          duration_ms: 5000,
        }),
        JSON.stringify({
          ts: `${today}T12:00:00Z`,
          ticket: 2,
          kind: "delivery",
          measured: true,
          total_cost_usd: 0.3,
          num_turns: 10,
          duration_ms: 20000,
        }),
      ].join("\n"),
    );

    const h = await startHarness({ GAFFER_DATA: tmpDir, GAFFER_USAGE_LEDGER: undefined });
    try {
      const { status, body } = await get(h.baseUrl, "/api/cost");
      expect(status).toBe(200);
      expect(typeof body.total_usd).toBe("number");
      expect(body.total_usd as number).toBeCloseTo(0.45);
      expect(body.ticket_count).toBe(2);
      expect(body.today_usd as number).toBeCloseTo(0.45);

      // top_tickets: sorted by cost desc
      const tops = body.top_tickets as Array<{
        ticket: number;
        total_cost_usd: number;
        num_turns: number;
      }>;
      expect(tops.length).toBe(2);
      expect(tops[0]!.ticket).toBe(2); // highest cost
      expect(tops[0]!.total_cost_usd).toBeCloseTo(0.3);
      expect(tops[1]!.ticket).toBe(1);
      expect(tops[1]!.total_cost_usd).toBeCloseTo(0.15);
      expect(tops[1]!.num_turns).toBe(8); // 5 + 3

      // by_repo: no registered repos, so all unlinked
      const byRepo = body.by_repo as Array<{
        repo: string;
        total_cost_usd: number;
        ticket_count: number;
      }>;
      expect(byRepo.length).toBe(1);
      expect(byRepo[0]!.repo).toBe("(unlinked)");
      expect(byRepo[0]!.total_cost_usd).toBeCloseTo(0.45);
      expect(byRepo[0]!.ticket_count).toBe(2);

      expect(typeof body.last_record_at).toBe("string");
    } finally {
      await h.close();
    }
  });

  it("skips malformed lines without failing", async () => {
    const ledger = join(tmpDir, "usage-ledger.jsonl");
    writeFileSync(
      ledger,
      [
        "NOT JSON AT ALL",
        "{broken",
        JSON.stringify({
          ts: "2025-01-15T10:00:00Z",
          ticket: 5,
          measured: true,
          total_cost_usd: 0.5,
          num_turns: 2,
        }),
        "",
        "another bad line",
      ].join("\n"),
    );

    const h = await startHarness({ GAFFER_DATA: tmpDir, GAFFER_USAGE_LEDGER: undefined });
    try {
      const { status, body } = await get(h.baseUrl, "/api/cost");
      expect(status).toBe(200);
      // Only the one valid row is counted
      expect(body.total_usd as number).toBeCloseTo(0.5);
      expect(body.ticket_count).toBe(1);
    } finally {
      await h.close();
    }
  });

  it("uses GAFFER_USAGE_LEDGER path when set", async () => {
    const explicitLedger = join(tmpDir, "custom-ledger.jsonl");
    writeFileSync(
      explicitLedger,
      JSON.stringify({
        ts: "2025-01-15T10:00:00Z",
        ticket: 7,
        measured: true,
        total_cost_usd: 1.23,
        num_turns: 4,
      }),
    );

    const h = await startHarness({ GAFFER_USAGE_LEDGER: explicitLedger, GAFFER_DATA: undefined });
    try {
      const { status, body } = await get(h.baseUrl, "/api/cost");
      expect(status).toBe(200);
      expect(body.total_usd as number).toBeCloseTo(1.23);
      expect(body.ticket_count).toBe(1);
    } finally {
      await h.close();
    }
  });

  it("caps top_tickets and by_repo at 25 entries each", async () => {
    const ledger = join(tmpDir, "usage-ledger.jsonl");
    // Write 30 distinct tickets
    const lines = Array.from({ length: 30 }, (_, i) =>
      JSON.stringify({
        ts: "2025-01-15T10:00:00Z",
        ticket: i + 1,
        measured: true,
        total_cost_usd: 0.01,
        num_turns: 1,
      }),
    );
    writeFileSync(ledger, lines.join("\n"));

    const h = await startHarness({ GAFFER_DATA: tmpDir, GAFFER_USAGE_LEDGER: undefined });
    try {
      const { status, body } = await get(h.baseUrl, "/api/cost");
      expect(status).toBe(200);
      expect((body.top_tickets as unknown[]).length).toBeLessThanOrEqual(25);
      expect((body.by_repo as unknown[]).length).toBeLessThanOrEqual(25);
    } finally {
      await h.close();
    }
  });

  it("returns 405 for POST /api/cost", async () => {
    const h = await startHarness({ GAFFER_DATA: undefined, GAFFER_USAGE_LEDGER: undefined });
    try {
      const res = await fetch(`${h.baseUrl}/api/cost`, { method: "POST" });
      expect(res.status).toBe(405);
    } finally {
      await h.close();
    }
  });

  it("leaves the read-only cost endpoint open on loopback but gates mutations behind the token", async () => {
    // Temporarily set a token (will be restored in close())
    const savedToken = process.env.DISPATCH_API_TOKEN;
    process.env.DISPATCH_API_TOKEN = "secret-token-for-test";
    const h = await startHarness({});
    try {
      // Read-only GET stays open on a loopback bind even with a token configured
      // (dashboard UX) — never a 401, with or without a bearer.
      const { status } = await get(h.baseUrl, "/api/cost");
      expect(status).toBe(200);
      const { status: ok } = await get(h.baseUrl, "/api/cost", "secret-token-for-test");
      expect(ok).toBe(200);
      // A mutating request without the token is refused; with it, permitted.
      const noToken = await fetch(`${h.baseUrl}/tickets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "x" }),
      });
      expect(noToken.status).toBe(401);
      const withToken = await fetch(`${h.baseUrl}/tickets`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer secret-token-for-test",
        },
        body: JSON.stringify({ title: "x" }),
      });
      expect(withToken.status).toBe(201);
    } finally {
      await h.close();
      process.env.DISPATCH_API_TOKEN = savedToken;
    }
  });
});

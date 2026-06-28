/**
 * Tests for:
 *   - GET /api/runs/:id          (200 populated, 200 zero-state, 401, 404)
 *   - ROUTE-line parsing         (parseRouteLine, parseLastRouteInfo)
 *   - per-ticket cost join       (ticketCostInfo via a temp ledger)
 *   - log tail line-cap          (logTailLines)
 *   - outcome detection          (detectOutcome)
 *   - full detail assembly       (buildRunDetail)
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import { createApiServer } from "../src/api/server.js";
import {
  buildRunDetail,
  detectOutcome,
  logTailLines,
  parseLastRouteInfo,
  parseRouteLine,
  ticketCostInfo,
  DETAIL_LOG_TAIL_LINES,
} from "../src/api/runDetail.js";
import { TestClock } from "../src/util/clock.js";

// ── Test harness ─────────────────────────────────────────────────────────────

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

// ── parseRouteLine ───────────────────────────────────────────────────────────

describe("parseRouteLine", () => {
  it("parses a full ROUTE line with ticket, phase, and model", () => {
    const line =
      "2026-01-15T12:00:00 ROUTE #42 phase=implement risk=medium ac=3 attempt=1 budget=unlimited → tier=mid model=claude-sonnet-4-6 [risk≤medium]";
    const result = parseRouteLine(line);
    expect(result).not.toBeNull();
    expect(result!.ticket).toBe(42);
    expect(result!.phase).toBe("implement");
    expect(result!.model).toBe("claude-sonnet-4-6");
  });

  it("parses an explicit-override ROUTE line", () => {
    const line =
      "2026-01-15T12:00:01 ROUTE #7 phase=implement risk=low ac=1 attempt=1 budget=unlimited → model=claude-opus-4-6 (explicit GAFFER_*_MODEL override)";
    const result = parseRouteLine(line);
    expect(result).not.toBeNull();
    expect(result!.ticket).toBe(7);
    expect(result!.phase).toBe("implement");
    // model is the string before the parens
    expect(result!.model).toContain("claude-opus");
  });

  it("parses a ROUTE line with no ticket number", () => {
    const line =
      "ROUTE phase=decompose risk=high ac=5 attempt=1 budget=unlimited → tier=high model=claude-opus-4-6 [high risk]";
    const result = parseRouteLine(line);
    expect(result).not.toBeNull();
    expect(result!.ticket).toBeNull();
    expect(result!.phase).toBe("decompose");
    expect(result!.model).toBe("claude-opus-4-6");
  });

  it("returns null for non-ROUTE lines", () => {
    expect(parseRouteLine("delivery tick for #5 finished (rc=0)")).toBeNull();
    expect(parseRouteLine("2026-01-01T00:00:00 created worktree for repo")).toBeNull();
    expect(parseRouteLine("")).toBeNull();
    expect(parseRouteLine("   ")).toBeNull();
  });

  it("returns null for a line that starts with ROUTE but has no useful fields", () => {
    expect(parseRouteLine("ROUTE")).toBeNull();
  });
});

// ── parseLastRouteInfo ───────────────────────────────────────────────────────

describe("parseLastRouteInfo", () => {
  it("returns the LAST ROUTE line when multiple are present", () => {
    const log = [
      "2026-01-01T10:00:00 ROUTE #1 phase=implement risk=low ac=1 attempt=1 budget=unlimited → tier=low model=claude-haiku-4-6 [low risk]",
      "2026-01-01T10:05:00 delivery tick for #1 finished (rc=1)",
      "2026-01-01T10:06:00 ROUTE #1 phase=implement risk=low ac=1 attempt=2 budget=unlimited → tier=mid model=claude-sonnet-4-6 [retry]",
      "2026-01-01T10:10:00 delivery tick for #1 finished (rc=0)",
    ].join("\n");

    const result = parseLastRouteInfo(log);
    expect(result).not.toBeNull();
    expect(result!.phase).toBe("implement");
    expect(result!.model).toBe("claude-sonnet-4-6");
    expect(result!.ticket).toBe(1);
  });

  it("returns null when no ROUTE lines are present", () => {
    const log = "delivery tick for #5 finished (rc=0)\ncreated worktree\n";
    expect(parseLastRouteInfo(log)).toBeNull();
  });

  it("handles an empty string", () => {
    expect(parseLastRouteInfo("")).toBeNull();
  });
});

// ── detectOutcome ─────────────────────────────────────────────────────────────

describe("detectOutcome", () => {
  it("returns null for a running run", () => {
    const log = "delivery tick for #1 finished (rc=0)";
    expect(detectOutcome(log, "running")).toBeNull();
  });

  it("detects in_review on a clean rc=0 delivery", () => {
    const log = "delivery tick for #42 finished (rc=0)";
    expect(detectOutcome(log, "succeeded")).toBe("in_review");
  });

  it("detects FAILED on a hard delivery failure", () => {
    const log = "delivery FAILED for #5 (rc=1) — no commits produced; removed worktrees + branch";
    expect(detectOutcome(log, "failed")).toBe("FAILED");
  });

  it("detects refining when skipping is present", () => {
    const log =
      "delivery FAILED for #3 (rc=1) — no commits produced; removed worktrees + branch gaffer/ticket-3; skipping it for the rest of this run";
    expect(detectOutcome(log, "failed")).toBe("refining");
  });

  it("detects FLAGGED on hygiene violation", () => {
    const log =
      "HYGIENE: delivery for #7 is NOT hygienic:\n[repo] some hygiene reason\nHYGIENE: parked #7 (in_review → refining)";
    expect(detectOutcome(log, "succeeded")).toBe("FLAGGED");
  });

  it("returns null when log text has no conclusive markers", () => {
    const log = "ready=2 → delivering #3 ('Add feature') in myrepo [stack=node]";
    expect(detectOutcome(log, "failed")).toBeNull();
  });
});

// ── logTailLines ─────────────────────────────────────────────────────────────

describe("logTailLines", () => {
  it("returns text unchanged when under the cap", () => {
    const text = "line1\nline2\nline3";
    expect(logTailLines(text, 10)).toBe(text);
  });

  it("returns only the last N lines when over the cap", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line${i + 1}`);
    const text = lines.join("\n");
    const result = logTailLines(text, DETAIL_LOG_TAIL_LINES);
    const resultLines = result.split("\n");
    expect(resultLines).toHaveLength(DETAIL_LOG_TAIL_LINES);
    expect(resultLines[0]).toBe(`line${60 - DETAIL_LOG_TAIL_LINES + 1}`);
    expect(resultLines[resultLines.length - 1]).toBe("line60");
  });

  it("uses DETAIL_LOG_TAIL_LINES as the default cap", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `L${i}`);
    const result = logTailLines(lines.join("\n"));
    expect(result.split("\n")).toHaveLength(DETAIL_LOG_TAIL_LINES);
  });
});

// ── ticketCostInfo ────────────────────────────────────────────────────────────

describe("ticketCostInfo", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wg-cost-"));
  });

  it("returns zeros when the ledger file is absent", () => {
    const info = ticketCostInfo(1, { GAFFER_DATA: join(tmpDir, "nonexistent") });
    expect(info.cost_usd).toBe(0);
    expect(info.num_turns).toBe(0);
  });

  it("returns zeros when the ticket has no ledger rows", () => {
    const ledgerPath = join(tmpDir, "usage-ledger.jsonl");
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        ts: "2026-01-01T00:00:00.000Z",
        ticket: 99,
        kind: "delivery",
        measured: true,
        total_cost_usd: 0.5,
        num_turns: 10,
        duration_ms: 30000,
      }) + "\n",
    );
    const info = ticketCostInfo(42, { GAFFER_DATA: tmpDir });
    expect(info.cost_usd).toBe(0);
    expect(info.num_turns).toBe(0);
  });

  it("sums cost and turns across multiple rows for the same ticket", () => {
    const ledgerPath = join(tmpDir, "usage-ledger.jsonl");
    const rows = [
      {
        ts: "2026-01-01T00:00:00.000Z",
        ticket: 5,
        kind: "delivery",
        measured: true,
        total_cost_usd: 0.1,
        num_turns: 4,
        duration_ms: 10000,
      },
      {
        ts: "2026-01-01T01:00:00.000Z",
        ticket: 5,
        kind: "delivery",
        measured: true,
        total_cost_usd: 0.05,
        num_turns: 2,
        duration_ms: 5000,
      },
      // A different ticket — should not be included.
      {
        ts: "2026-01-01T02:00:00.000Z",
        ticket: 6,
        kind: "delivery",
        measured: true,
        total_cost_usd: 1.0,
        num_turns: 20,
        duration_ms: 60000,
      },
    ];
    writeFileSync(ledgerPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const info = ticketCostInfo(5, { GAFFER_DATA: tmpDir });
    expect(info.cost_usd).toBeCloseTo(0.15, 6);
    expect(info.num_turns).toBe(6);
  });
});

// ── buildRunDetail ─────────────────────────────────────────────────────────────

describe("buildRunDetail", () => {
  const baseRun: Run = {
    id: "run-abc",
    kind: "poll_work",
    repo: null,
    pid: 123,
    status: "succeeded",
    started_at: "2026-01-01T00:00:00.000Z",
    ended_at: "2026-01-01T00:05:00.000Z",
    exit_code: 0,
    log_path: "/tmp/runs/run-abc.log",
    detail: null,
  };

  it("returns zero-state fields when logText is null", () => {
    const detail = buildRunDetail(baseRun, null, {});
    expect(detail.run).toBe(baseRun);
    expect(detail.ticket_number).toBeNull();
    expect(detail.phase).toBeNull();
    expect(detail.model).toBeNull();
    expect(detail.num_turns).toBe(0);
    expect(detail.cost_usd).toBe(0);
    expect(detail.log_tail).toBeNull();
    expect(detail.outcome).toBeNull();
  });

  it("parses route info and detects outcome from log text", () => {
    const log = [
      "2026-01-01T00:01:00 ROUTE #12 phase=implement risk=medium ac=2 attempt=1 budget=unlimited → tier=mid model=claude-sonnet-4-6 [medium risk]",
      "2026-01-01T00:04:50 delivery tick for #12 finished (rc=0)",
    ].join("\n");

    const detail = buildRunDetail(baseRun, log, {});
    expect(detail.ticket_number).toBe(12);
    expect(detail.phase).toBe("implement");
    expect(detail.model).toBe("claude-sonnet-4-6");
    expect(detail.outcome).toBe("in_review");
  });

  it("caps the log tail to DETAIL_LOG_TAIL_LINES", () => {
    const lines = Array.from({ length: 80 }, (_, i) => `log line ${i}`);
    const detail = buildRunDetail(baseRun, lines.join("\n"), {});
    expect(detail.log_tail).not.toBeNull();
    expect(detail.log_tail!.split("\n")).toHaveLength(DETAIL_LOG_TAIL_LINES);
  });

  it("joins cost from the ledger when a ticket number is found", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "wg-detail-cost-"));
    const ledgerPath = join(tmpDir, "usage-ledger.jsonl");
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        ts: "2026-01-01T00:03:00.000Z",
        ticket: 12,
        kind: "delivery",
        measured: true,
        total_cost_usd: 0.25,
        num_turns: 8,
        duration_ms: 20000,
      }) + "\n",
    );

    const log =
      "2026-01-01T00:01:00 ROUTE #12 phase=implement risk=medium ac=2 attempt=1 budget=unlimited → tier=mid model=claude-sonnet-4-6 [medium risk]";
    const detail = buildRunDetail(baseRun, log, { GAFFER_DATA: tmpDir });
    expect(detail.cost_usd).toBeCloseTo(0.25, 6);
    expect(detail.num_turns).toBe(8);
  });
});

// ── GET /api/runs/:id (REST) ──────────────────────────────────────────────────

describe("RUN-DETAIL REST: GET /api/runs/:id", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("returns 404 for an unknown run id", async () => {
    const res = await fetch(`${h.baseUrl}/api/runs/no-such-id`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("returns 200 with a zero-state detail for a run with no log path", async () => {
    const run = h.wg.recordRunStart({ kind: "poll_work", pid: 1 });
    h.wg.markRunEnd(run.id, { exit_code: 0 });

    const res = await fetch(`${h.baseUrl}/api/runs/${run.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      detail: {
        run: { id: string; status: string };
        ticket_number: number | null;
        phase: string | null;
        model: string | null;
        num_turns: number;
        cost_usd: number;
        log_tail: string | null;
        outcome: string | null;
      };
    };

    expect(body.detail.run.id).toBe(run.id);
    expect(body.detail.run.status).toBe("succeeded");
    expect(body.detail.ticket_number).toBeNull();
    expect(body.detail.phase).toBeNull();
    expect(body.detail.model).toBeNull();
    expect(body.detail.num_turns).toBe(0);
    expect(body.detail.cost_usd).toBe(0);
    expect(body.detail.log_tail).toBeNull();
    expect(body.detail.outcome).toBeNull();
  });

  it("returns 200 with populated detail when the run has a real log file", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "wg-detail-rest-"));
    const logPath = join(tmpDir, "run.log");
    const logContent = [
      "2026-01-01T00:01:00 ROUTE #7 phase=implement risk=low ac=1 attempt=1 budget=unlimited → tier=low model=claude-haiku-4-6 [low risk]",
      "2026-01-01T00:04:00 delivery tick for #7 finished (rc=0)",
    ].join("\n");
    writeFileSync(logPath, logContent);

    const run = h.wg.recordRunStart({ kind: "poll_work", pid: 2, log_path: logPath });
    h.wg.markRunEnd(run.id, { exit_code: 0 });

    const res = await fetch(`${h.baseUrl}/api/runs/${run.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      detail: {
        ticket_number: number | null;
        phase: string | null;
        model: string | null;
        log_tail: string | null;
        outcome: string | null;
      };
    };

    expect(body.detail.ticket_number).toBe(7);
    expect(body.detail.phase).toBe("implement");
    expect(body.detail.model).toBe("claude-haiku-4-6");
    expect(body.detail.log_tail).toContain("ROUTE #7");
    expect(body.detail.outcome).toBe("in_review");
  });

  it("returns 200 for a running run (outcome null)", async () => {
    const run = h.wg.recordRunStart({ kind: "product_owner", pid: 3 });

    const res = await fetch(`${h.baseUrl}/api/runs/${run.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      detail: { run: { status: string }; outcome: string | null };
    };
    expect(body.detail.run.status).toBe("running");
    expect(body.detail.outcome).toBeNull();
  });

  it("returns 405 for a non-GET method", async () => {
    const run = h.wg.recordRunStart({ kind: "other" });
    const res = await fetch(`${h.baseUrl}/api/runs/${run.id}`, { method: "POST" });
    expect(res.status).toBe(405);
  });
});

// ── Auth gate ─────────────────────────────────────────────────────────────────

describe("RUN-DETAIL REST: auth gate", () => {
  it("returns 401 when DISPATCH_API_TOKEN is set and no bearer is sent", async () => {
    const original = process.env.DISPATCH_API_TOKEN;
    process.env.DISPATCH_API_TOKEN = "secret-tok";
    let h: Harness | null = null;
    try {
      h = await startHarness();
      const res = await fetch(`${h.baseUrl}/api/runs/any-id`);
      expect(res.status).toBe(401);
    } finally {
      if (original === undefined) delete process.env.DISPATCH_API_TOKEN;
      else process.env.DISPATCH_API_TOKEN = original;
      if (h) await h.close();
    }
  });
});

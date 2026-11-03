/**
 * ESCAPED-DEFECT ATTRIBUTION (delta roadmap gap 5, gap-specialists MF5).
 *
 *  - A person links a later ticket (the defect or its fix) to the accepted change it
 *    regresses: `ticket.defect_escaped` on the later ticket, the actor columns saying who
 *    filed it; `ticket.defect_escaped_withdrawn` takes a link back.
 *  - Human or admin only (an agent and the runner are refused), the target must be another
 *    ticket that is an accepted change (done), and a second identical link records nothing.
 *  - REST, the CLI and the ticket view expose it; MCP get_ticket shows it read-only.
 *  - Health's escaped-defect rate is escaped accepted changes over accepted changes in the
 *    window, and its sentence says it counts only what a person filed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { deriveReadToken } from "../src/api/auth.js";
import { createApiServer } from "../src/api/server.js";
import { computeStats, renderStats } from "../src/cli/ops.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { writeEvent } from "../src/events/eventWriter.js";
import { escapedDefectReport } from "../src/health/escapedDefects.js";
import { makeHandlers } from "../src/mcp/tools.js";
import {
  currentRegressionLinks,
  DEFECT_ESCAPED_EVENT,
  DEFECT_ESCAPED_WITHDRAWN_EVENT,
  type RegressionEventRow,
} from "../src/services/escapedDefects.js";
import { TestClock } from "../src/util/clock.js";
import { CLI_BUILT, runBin } from "./helpers/cliBin.js";

const human: Actor = { type: "human", id: "tom" };
const admin: Actor = { type: "admin", id: "ops" };
const system: Actor = { type: "system" };
const agent: Actor = { type: "agent", id: "gaffer-factory" };

const DAY = 86_400_000;
const NOW = Date.parse("2026-06-30T12:00:00.000Z");

/** A ticket that reached done the way the log records it. */
function accepted(wg: Dispatch, title = "Shipped"): { id: string; number: number } {
  const t = wg.createTicket({ title }, human);
  wg.db.prepare(`UPDATE tickets SET status='done' WHERE id=?`).run(t.id);
  writeEvent(wg.db, {
    entity_type: "ticket",
    entity_id: t.id,
    actor: system,
    event_type: "ticket.transitioned",
    payload: { from: "ready_for_merge", to: "done", reason: "merged" },
  });
  return { id: t.id, number: t.number ?? 0 };
}

const eventsOf = (wg: Dispatch, id: string, type: string) =>
  wg.db
    .prepare(
      `SELECT actor_type, actor_id, payload_json FROM work_events WHERE entity_id = ? AND event_type = ? ORDER BY rowid`,
    )
    .all(id, type) as Array<{ actor_type: string; actor_id: string | null; payload_json: string }>;

describe("escaped-defect read model (hand-worked fixture)", () => {
  const ev = (
    ticketId: string,
    eventType: string,
    regressionOf: string,
    actorType = "human",
    at = "2026-06-20T00:00:00.000Z",
  ): RegressionEventRow => ({
    ticketId,
    eventType,
    regressionOf,
    actorType,
    actorId: actorType === "human" ? "tom" : null,
    note: null,
    at,
  });

  it("folds filed and withdrawn links per pair, in order", () => {
    const links = currentRegressionLinks([
      ev("D1", DEFECT_ESCAPED_EVENT, "A"),
      ev("D2", DEFECT_ESCAPED_EVENT, "B"),
      ev("D2", DEFECT_ESCAPED_WITHDRAWN_EVENT, "B"),
      ev("D3", DEFECT_ESCAPED_EVENT, "C"),
      ev("D3", DEFECT_ESCAPED_WITHDRAWN_EVENT, "C"),
      ev("D3", DEFECT_ESCAPED_EVENT, "C"),
    ]);
    expect(links.map((l) => `${l.ticketId}->${l.regressionOf}`).sort()).toEqual(["D1->A", "D3->C"]);
  });

  it("escaped accepted changes over accepted changes, in the window and all time", () => {
    // Accepted: A (5 days ago), B (10 days ago), C (40 days ago), E (2 days ago, reopened
    // once then done again), F (done with no recorded move: all time only). G is in review
    // (not accepted) and has a link: it does not count.
    // Links: D1->A (human), D2->A (admin, a second defect in the same change), D3->C
    // (human, outside the 30-day window), D4->G (not accepted), D5->B (agent: refused by
    // the service, ignored by the reader too).
    const tickets = [
      { id: "A", status: "done" },
      { id: "B", status: "done" },
      { id: "C", status: "done" },
      { id: "E", status: "done" },
      { id: "F", status: "done" },
      { id: "G", status: "in_review" },
    ];
    const tr = (ticketId: string, daysAgo: number, toStatus = "done") => ({
      ticketId,
      toStatus,
      atMs: NOW - daysAgo * DAY,
    });
    const transitions = [
      tr("A", 5),
      tr("B", 10),
      tr("C", 40),
      tr("E", 50),
      tr("E", 45, "in_review"),
      tr("E", 2),
      tr("G", 20),
      tr("G", 19, "in_review"),
    ];
    const links = currentRegressionLinks([
      ev("D1", DEFECT_ESCAPED_EVENT, "A"),
      ev("D2", DEFECT_ESCAPED_EVENT, "A", "admin"),
      ev("D3", DEFECT_ESCAPED_EVENT, "C"),
      ev("D4", DEFECT_ESCAPED_EVENT, "G"),
      ev("D5", DEFECT_ESCAPED_EVENT, "B", "agent"),
    ]);
    const r = escapedDefectReport({ links, transitions, tickets, nowMs: NOW, windowDays: 30 });
    // Window: A, B, E accepted in the last 30 days; A escaped -> 1 of 3 = 33.3%.
    expect(r).toMatchObject({
      measure: "escaped_defect_rate",
      recorded: true,
      window_days: 30,
      accepted_changes: 3,
      escaped: 1,
      rate_pct: 33.3,
    });
    // All time: A, B, C, E, F; A and C escaped -> 2 of 5 = 40%.
    expect(r.all_time).toEqual({ accepted_changes: 5, escaped: 2, rate_pct: 40 });
    // Links a person filed: D1, D2, D3, D4 (D5 is an agent's).
    expect(r.links).toBe(4);
    expect(r.filed_by).toEqual({ human: 3, admin: 1 });
    expect(r.note).toMatch(/Counts only what a person filed/);
  });

  it("is null-honest with nothing accepted", () => {
    const r = escapedDefectReport({
      links: [],
      transitions: [],
      tickets: [],
      nowMs: NOW,
      windowDays: 30,
    });
    expect(r.rate_pct).toBeNull();
    expect(r.all_time.rate_pct).toBeNull();
  });
});

describe("filing a regression link", () => {
  let wg: Dispatch;
  beforeEach(() => {
    process.env.DISPATCH_AUDIT_OFF = "1";
    wg = Dispatch.open(":memory:", new TestClock());
  });
  afterEach(() => wg.db.close());

  it("a person files it on the later ticket, with who filed it, and can withdraw it", () => {
    const change = accepted(wg, "Add the export button");
    const defect = wg.createTicket({ title: "Export button crashes" }, human);
    const r = wg.fileRegression(defect.id, String(change.number), human, "crashes on empty list");
    expect(r).toMatchObject({ recorded: true, regressionOf: change.id });
    const rows = eventsOf(wg, defect.id, "ticket.defect_escaped");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_type: "human", actor_id: "tom" });
    expect(JSON.parse(rows[0]!.payload_json)).toEqual({
      regression_of: change.id,
      regression_of_number: change.number,
      note: "crashes on empty list",
    });
    // The same link again records nothing.
    expect(wg.fileRegression(defect.id, change.id, admin).recorded).toBe(false);
    expect(eventsOf(wg, defect.id, "ticket.defect_escaped")).toHaveLength(1);

    const view = wg.view(defect.id);
    expect(view.regression.regression_of).toMatchObject([
      { ticket_id: change.id, number: change.number, filed_by: { type: "human", id: "tom" } },
    ]);
    expect(wg.view(change.id).regression.regressed_by).toMatchObject([
      { ticket_id: defect.id, number: defect.number },
    ]);

    expect(wg.withdrawRegression(defect.id, change.id, admin).recorded).toBe(true);
    expect(eventsOf(wg, defect.id, "ticket.defect_escaped_withdrawn")).toHaveLength(1);
    expect(wg.view(defect.id).regression.regression_of).toEqual([]);
    // Nothing left to withdraw.
    expect(wg.withdrawRegression(defect.id, change.id, admin).recorded).toBe(false);
  });

  it("an agent or the runner is refused, and the target must be another accepted change", () => {
    const change = accepted(wg);
    const defect = wg.createTicket({ title: "Broke it" }, human);
    expect(() => wg.fileRegression(defect.id, change.id, agent)).toThrow(/Only a person/);
    expect(() => wg.fileRegression(defect.id, change.id, system)).toThrow(/Only a person/);
    expect(() => wg.withdrawRegression(defect.id, change.id, agent)).toThrow(/Only a person/);
    const open = wg.createTicket({ title: "Still open" }, human);
    expect(() => wg.fileRegression(defect.id, open.id, human)).toThrow(/accepted change/);
    expect(() => wg.fileRegression(change.id, change.id, human)).toThrow(/itself/);
    expect(eventsOf(wg, defect.id, "ticket.defect_escaped")).toHaveLength(0);
  });

  it("MCP get_ticket shows the links read-only, and no MCP tool files one", () => {
    const change = accepted(wg);
    const defect = wg.createTicket({ title: "Regressed" }, human);
    wg.fileRegression(defect.id, change.id, human, "a note an agent never sees");
    const h = makeHandlers(wg, agent);
    const view = h.get_ticket({ ticket_id: defect.id }).structuredContent as Record<
      string,
      unknown
    >;
    expect(view.regression_links).toEqual({
      regression_of: [{ ticket_id: change.id, number: change.number, status: "done" }],
      regressed_by: [],
    });
    expect(JSON.stringify(view)).not.toContain("a note an agent never sees");
    expect(Object.keys(h).filter((k) => /regress|defect/i.test(k))).toEqual([]);
  });

  it("wg stats prints the escaped-defect rate and what it counts", () => {
    const change = accepted(wg);
    accepted(wg, "Another");
    const defect = wg.createTicket({ title: "Regressed" }, human);
    wg.fileRegression(defect.id, change.id, human);
    const out = renderStats(computeStats(wg.db, new Date().toISOString(), {}));
    expect(out).toMatch(/Escaped-defect rate: 50% \(1 of 2 accepted changes in the last 30 days/);
    expect(out).toMatch(/Counts only what a person filed/);
  });
});

describe("REST and CLI", () => {
  let wg: Dispatch;
  let baseUrl: string;
  let close: () => Promise<void>;
  beforeEach(async () => {
    process.env.DISPATCH_AUDIT_OFF = "1";
    wg = Dispatch.open(":memory:", new TestClock());
    const server = createApiServer(wg);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () =>
      new Promise<void>((resolve) =>
        server.close(() => {
          wg.db.close();
          resolve();
        }),
      );
  });
  afterEach(async () => close());

  const post = async (path: string, body: unknown, token?: string) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers["authorization"] = `Bearer ${token}`;
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it("POST /tickets/:id/regression-of files and withdraws; /api/health serves the rate", async () => {
    const change = accepted(wg);
    const defect = wg.createTicket({ title: "Regressed" }, human);
    const r = await post(`/tickets/${defect.id}/regression-of`, { of: String(change.number) });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ recorded: true, regression_of: change.id });
    const health = (await (await fetch(`${baseUrl}/api/health`)).json()) as Record<string, unknown>;
    expect(health.escaped_defects).toMatchObject({
      recorded: true,
      accepted_changes: 1,
      escaped: 1,
      rate_pct: 100,
    });
    const w = await post(`/tickets/${defect.id}/regression-of`, {
      of: change.id,
      withdraw: true,
    });
    expect(w.body).toMatchObject({ recorded: true, withdrawn: true });
    const after = (await (await fetch(`${baseUrl}/api/health`)).json()) as Record<string, unknown>;
    expect(after.escaped_defects).toMatchObject({ escaped: 0, rate_pct: 0 });
  });

  it("a read-only token cannot file one", async () => {
    const saved = process.env.DISPATCH_API_TOKEN;
    process.env.DISPATCH_API_TOKEN = "full-secret-for-regression";
    try {
      const change = accepted(wg);
      const defect = wg.createTicket({ title: "Regressed" }, human);
      const r = await post(
        `/tickets/${defect.id}/regression-of`,
        { of: change.id },
        deriveReadToken("full-secret-for-regression"),
      );
      expect(r.status).toBe(403);
      expect(eventsOf(wg, defect.id, "ticket.defect_escaped")).toHaveLength(0);
    } finally {
      if (saved === undefined) delete process.env.DISPATCH_API_TOKEN;
      else process.env.DISPATCH_API_TOKEN = saved;
    }
  });
});

describe.skipIf(!CLI_BUILT)("wg ticket regression-of", () => {
  it("files as the person running it, withdraws, and refuses a non-accepted target", () => {
    const dir = mkdtempSync(join(tmpdir(), "gaffer-regression-of-"));
    try {
      const db = join(dir, "dispatch.sqlite");
      const wg = Dispatch.open(db, new TestClock());
      const change = accepted(wg);
      const defect = wg.createTicket({ title: "Regressed" }, human);
      const open = wg.createTicket({ title: "Open" }, human);
      wg.db.close();
      const ok = runBin(db, [
        "ticket",
        "regression-of",
        String(defect.number),
        "--of",
        String(change.number),
        "--note",
        "broke the export",
      ]);
      expect(ok.status).toBe(0);
      expect(JSON.parse(ok.stdout)).toMatchObject({ ok: true, recorded: true });
      const bad = runBin(db, [
        "ticket",
        "regression-of",
        String(defect.number),
        "--of",
        String(open.number),
      ]);
      expect(bad.status).not.toBe(0);
      const w = runBin(db, [
        "ticket",
        "regression-of",
        String(defect.number),
        "--of",
        String(change.number),
        "--withdraw",
      ]);
      expect(w.status).toBe(0);
      expect(JSON.parse(w.stdout)).toMatchObject({ ok: true, recorded: true, withdrawn: true });
      const check = Dispatch.open(db, new TestClock());
      expect(eventsOf(check, defect.id, "ticket.defect_escaped")[0]?.actor_type).toBe("human");
      check.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

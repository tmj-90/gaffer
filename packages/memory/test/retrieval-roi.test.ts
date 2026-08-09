/**
 * Retrieval-ROI attribution — core unit tests (migration 011).
 *
 * Covers the two halves of core/retrievalRoi.ts:
 *   - logRetrieval: writes rows, idempotent per (ticket,item_type,item_id,tool),
 *     skips empties, admits all four item_types (unlike recall_event).
 *   - retrievalRoi: the join to recall_feedback aggregates correctly, flags
 *     bounce-correlated + never-retrieved records, reports sample size, and is
 *     empty (not a crash) at zero-state.
 *   - ISOLATION: logging a retrieval never touches lore.confidence /
 *     flagged_for_review / recall_event — the confidence loop is untouched.
 *   - HONESTY: the report shape carries no percentage/ratio field.
 */
import BetterSqlite3 from "better-sqlite3";
import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { addLore } from "../src/core/lore.js";
import { newLoreId } from "../src/core/ids.js";
import { logRecall } from "../src/core/recallFeedback.js";
import { logRetrieval, retrievalRoi } from "../src/core/retrievalRoi.js";
import { runMigrations } from "../src/db/migrations.js";

let db: Database;

function newDb(): Database {
  const d = new BetterSqlite3(":memory:");
  d.pragma("foreign_keys = ON");
  runMigrations(d);
  return d;
}

/** Insert a recorded ticket outcome directly into the recall_feedback ledger. */
function seedOutcome(repo: string, ticket: string, outcome: string): void {
  db.prepare(
    `INSERT INTO recall_feedback (id, repo, ticket, outcome, items_adjusted, applied_at)
     VALUES (?, ?, ?, ?, 0, ?)`,
  ).run(newLoreId(), repo, ticket, outcome, new Date().toISOString());
}

/** Insert an active file_card row directly (bypasses the disk-reading upsert). */
function seedCard(id: string, repo: string, path: string): void {
  const ts = new Date().toISOString();
  db.prepare(
    `INSERT INTO file_card (id, repo_key, repo, path, content_hash, loc, symbols, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'h', 1, '[]', 'test', ?, ?)`,
  ).run(id, `k-${repo}`, repo, path, ts, ts);
}

beforeEach(() => {
  db = newDb();
});
afterEach(() => {
  db.close();
});

describe("logRetrieval", () => {
  it("writes one row per served id", () => {
    const r = logRetrieval(db, {
      repo: "app",
      ticket: "7",
      tool: "search_lore",
      items: [
        { type: "lore", id: "abc" },
        { type: "lore", id: "def" },
      ],
    });
    expect(r.logged).toBe(2);
    const n = (db.prepare("SELECT COUNT(*) AS n FROM retrieval_event").get() as { n: number }).n;
    expect(n).toBe(2);
  });

  it("is idempotent per (ticket, item_type, item_id, tool)", () => {
    const input = {
      repo: "app",
      ticket: "7",
      tool: "search_lore",
      items: [{ type: "lore" as const, id: "abc" }],
    };
    expect(logRetrieval(db, input).logged).toBe(1);
    expect(logRetrieval(db, input).logged).toBe(0); // second is a no-op
    const n = (db.prepare("SELECT COUNT(*) AS n FROM retrieval_event").get() as { n: number }).n;
    expect(n).toBe(1);
  });

  it("keeps the same id under a DIFFERENT tool as a distinct edge", () => {
    logRetrieval(db, {
      repo: "app",
      ticket: "7",
      tool: "search_lore",
      items: [{ type: "lore", id: "abc" }],
    });
    logRetrieval(db, {
      repo: "app",
      ticket: "7",
      tool: "cards_for_scope",
      items: [{ type: "lore", id: "abc" }],
    });
    const n = (db.prepare("SELECT COUNT(*) AS n FROM retrieval_event").get() as { n: number }).n;
    expect(n).toBe(2);
  });

  it("skips empty ids and de-dupes within a call", () => {
    const r = logRetrieval(db, {
      repo: "app",
      ticket: "7",
      tool: "search_lore",
      items: [
        { type: "lore", id: "abc" },
        { type: "lore", id: "  " },
        { type: "lore", id: "abc" },
      ],
    });
    expect(r.logged).toBe(1);
  });

  it("logs nothing without a ticket, or without a tool, or with no items", () => {
    expect(
      logRetrieval(db, {
        repo: "app",
        ticket: "",
        tool: "search_lore",
        items: [{ type: "lore", id: "x" }],
      }).logged,
    ).toBe(0);
    expect(
      logRetrieval(db, { repo: "app", ticket: "7", tool: "", items: [{ type: "lore", id: "x" }] })
        .logged,
    ).toBe(0);
    expect(
      logRetrieval(db, { repo: "app", ticket: "7", tool: "search_lore", items: [] }).logged,
    ).toBe(0);
    const n = (db.prepare("SELECT COUNT(*) AS n FROM retrieval_event").get() as { n: number }).n;
    expect(n).toBe(0);
  });

  it("admits digest + feature item_types (which recall_event forbids)", () => {
    const r = logRetrieval(db, {
      repo: "app",
      ticket: "7",
      tool: "cards_for_scope",
      items: [
        { type: "digest", id: "app" },
        { type: "feature", id: "feat1" },
        { type: "card", id: "card1" },
      ],
    });
    expect(r.logged).toBe(3);
  });
});

describe("retrievalRoi — join + aggregation", () => {
  it("returns an empty report at zero-state (no crash)", () => {
    const report = retrievalRoi(db);
    expect(report.sampleSize).toBe(0);
    expect(report.ticketsWithOutcome).toBe(0);
    expect(report.records).toEqual([]);
    expect(report.neverRetrieved).toEqual([]);
    expect(report.neverRetrievedTotal).toBe(0);
  });

  it("counts consulted-in and joins to the recorded outcome per record", () => {
    const lore = addLore(db, {
      title: "Webhook retry policy",
      summary: "s",
      body: "b",
      repos: ["app"],
      confidence: "medium",
    });
    // Consulted in three tickets; two clean, one reworked.
    for (const t of ["1", "2", "3"]) {
      logRetrieval(db, {
        repo: "app",
        ticket: t,
        tool: "search_lore",
        items: [{ type: "lore", id: lore.id }],
      });
    }
    seedOutcome("app", "1", "clean");
    seedOutcome("app", "2", "clean");
    seedOutcome("app", "3", "reworked");

    const report = retrievalRoi(db);
    expect(report.sampleSize).toBe(3);
    expect(report.ticketsWithOutcome).toBe(3);
    const rec = report.records.find((r) => r.itemId === lore.id)!;
    expect(rec.consultedIn).toBe(3);
    expect(rec.approvedClean).toBe(2);
    expect(rec.reworked).toBe(1);
    expect(rec.blocked).toBe(0);
    expect(rec.outcomePending).toBe(0);
    expect(rec.bounceCorrelated).toBe(false);
    expect(rec.label).toBe("Webhook retry policy");
  });

  it("marks outcome_pending when no feedback row exists for the ticket", () => {
    const lore = addLore(db, {
      title: "t",
      summary: "s",
      body: "b",
      repos: ["app"],
      confidence: "low",
    });
    logRetrieval(db, {
      repo: "app",
      ticket: "9",
      tool: "search_lore",
      items: [{ type: "lore", id: lore.id }],
    });
    const report = retrievalRoi(db);
    expect(report.ticketsWithOutcome).toBe(0);
    const rec = report.records.find((r) => r.itemId === lore.id)!;
    expect(rec.outcomePending).toBe(1);
    expect(rec.approvedClean).toBe(0);
  });

  it("flags bounce-correlated records (reworked/blocked > 0 and approved-clean = 0)", () => {
    const bad = addLore(db, {
      title: "Legacy cron format",
      summary: "s",
      body: "b",
      repos: ["app"],
      confidence: "low",
    });
    logRetrieval(db, {
      repo: "app",
      ticket: "1",
      tool: "search_lore",
      items: [{ type: "lore", id: bad.id }],
    });
    logRetrieval(db, {
      repo: "app",
      ticket: "2",
      tool: "search_lore",
      items: [{ type: "lore", id: bad.id }],
    });
    seedOutcome("app", "1", "reworked");
    seedOutcome("app", "2", "blocked");
    const rec = retrievalRoi(db).records.find((r) => r.itemId === bad.id)!;
    expect(rec.bounceCorrelated).toBe(true);
    expect(rec.reworked).toBe(1);
    expect(rec.blocked).toBe(1);
    expect(rec.approvedClean).toBe(0);
  });

  it("lists active records never seen in retrieval_event as pruning candidates", () => {
    const seen = addLore(db, {
      title: "seen",
      summary: "s",
      body: "b",
      repos: ["app"],
      confidence: "medium",
    });
    const unseen = addLore(db, {
      title: "never consulted",
      summary: "s",
      body: "b",
      repos: ["app"],
      confidence: "low",
    });
    seedCard("card-unseen", "app", "src/dead.ts");
    logRetrieval(db, {
      repo: "app",
      ticket: "1",
      tool: "search_lore",
      items: [{ type: "lore", id: seen.id }],
    });

    const report = retrievalRoi(db);
    const neverIds = report.neverRetrieved.map((n) => n.itemId);
    expect(neverIds).toContain(unseen.id);
    expect(neverIds).toContain("card-unseen");
    expect(neverIds).not.toContain(seen.id);
    expect(report.neverRetrievedTotal).toBe(2);
  });

  it("honours the repo filter on both the aggregate and the never-retrieved list", () => {
    const a = addLore(db, {
      title: "a",
      summary: "s",
      body: "b",
      repos: ["app"],
      confidence: "medium",
    });
    logRetrieval(db, {
      repo: "app",
      ticket: "1",
      tool: "search_lore",
      items: [{ type: "lore", id: a.id }],
    });
    logRetrieval(db, {
      repo: "other",
      ticket: "2",
      tool: "search_lore",
      items: [{ type: "lore", id: a.id }],
    });
    const report = retrievalRoi(db, { repo: "app" });
    expect(report.sampleSize).toBe(1); // only ticket 1 (repo=app)
    const rec = report.records.find((r) => r.itemId === a.id)!;
    expect(rec.consultedIn).toBe(1);
  });

  it("presents COUNTS only — no percentage/ratio field on the report (honesty guard)", () => {
    const lore = addLore(db, {
      title: "t",
      summary: "s",
      body: "b",
      repos: ["app"],
      confidence: "medium",
    });
    logRetrieval(db, {
      repo: "app",
      ticket: "1",
      tool: "search_lore",
      items: [{ type: "lore", id: lore.id }],
    });
    seedOutcome("app", "1", "clean");
    const report = retrievalRoi(db);
    const blob = JSON.stringify(report).toLowerCase();
    expect(blob).not.toContain("pct");
    expect(blob).not.toContain("percent");
    expect(blob).not.toContain("ratio");
    expect(blob).not.toContain("effectiveness");
    // No numeric field is a fraction (0<x<1) — every count is an integer.
    for (const rec of report.records) {
      for (const v of [
        rec.consultedIn,
        rec.approvedClean,
        rec.reworked,
        rec.blocked,
        rec.outcomePending,
      ]) {
        expect(Number.isInteger(v)).toBe(true);
      }
    }
  });
});

describe("retrievalRoi — isolation from the confidence loop", () => {
  it("logging a retrieval does NOT alter lore.confidence, flagged_for_review, or recall_event", () => {
    const lore = addLore(db, {
      title: "t",
      summary: "s",
      body: "b",
      repos: ["app"],
      confidence: "medium",
    });
    // Seed the confidence loop's own read edge for comparison.
    logRecall(db, { repo: "app", ticket: "1", loreIds: [lore.id] });
    const before = db
      .prepare("SELECT confidence, flagged_for_review FROM lore WHERE id = ?")
      .get(lore.id);
    const recallBefore = (
      db.prepare("SELECT COUNT(*) AS n FROM recall_event").get() as { n: number }
    ).n;

    logRetrieval(db, {
      repo: "app",
      ticket: "1",
      tool: "search_lore",
      items: [{ type: "lore", id: lore.id }],
    });

    const after = db
      .prepare("SELECT confidence, flagged_for_review FROM lore WHERE id = ?")
      .get(lore.id);
    const recallAfter = (
      db.prepare("SELECT COUNT(*) AS n FROM recall_event").get() as { n: number }
    ).n;
    expect(after).toEqual(before);
    expect(recallAfter).toBe(recallBefore); // retrieval logging never touches recall_event
  });
});

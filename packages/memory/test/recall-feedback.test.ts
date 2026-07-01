import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { addLore, getLore } from "../src/core/lore.js";
import { repoKey, upsertFileCard } from "../src/core/fileCards.js";
import { listFlaggedForReview, logRecall, recallFeedback } from "../src/core/recallFeedback.js";
import { runMigrations } from "../src/db/migrations.js";
import type { Database } from "better-sqlite3";
import type { LoreConfidence } from "../src/db/types.js";

function newInMemoryDb(): Database {
  const db = new BetterSqlite3(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

const CANON = "https://example.com/acme/app";

function seedCard(db: Database, path: string): string {
  const card = upsertFileCard(db, {
    repoKey: repoKey(CANON),
    canonical: CANON,
    repo: "app",
    path,
    contentHash: "hash-" + path,
    loc: 10,
    symbols: ["thing"],
    source: "test",
  });
  return card.id;
}

function confOf(db: Database, id: string): LoreConfidence {
  return getLore(db, id)!.confidence;
}

function flaggedRaw(db: Database, id: string): number {
  return (
    db.prepare("SELECT flagged_for_review AS f FROM lore WHERE id = ?").get(id) as { f: number }
  ).f;
}

describe("core/recallFeedback", () => {
  let db: Database;
  beforeEach(() => {
    db = newInMemoryDb();
    // Avoid the read-event telemetry noise from getLore in these tests.
    process.env["MEMORY_NO_TELEMETRY"] = "1";
  });

  it("logs served items as a set (re-priming does not double-count)", () => {
    const l = addLore(db, {
      title: "t",
      summary: "s",
      body: "b",
      repos: ["app"],
      confidence: "low",
    });
    const first = logRecall(db, { repo: "app", ticket: "1", loreIds: [l.id] });
    expect(first.logged).toBe(1);
    // Re-priming the same ticket with the same item is a no-op edge.
    const second = logRecall(db, { repo: "app", ticket: "1", loreIds: [l.id] });
    expect(second.logged).toBe(0);
    const rows = db
      .prepare("SELECT COUNT(*) AS n FROM recall_event WHERE repo = ? AND ticket = ?")
      .get("app", "1") as { n: number };
    expect(rows.n).toBe(1);
  });

  it("clean outcome BUMPS confidence of served lore and clears the flag", () => {
    const l = addLore(db, {
      title: "t",
      summary: "s",
      body: "b",
      repos: ["app"],
      confidence: "low",
    });
    logRecall(db, { repo: "app", ticket: "1", loreIds: [l.id] });

    const res = recallFeedback(db, { repo: "app", ticket: "1", outcome: "clean" });
    expect(res.alreadyApplied).toBe(false);
    expect(res.loreAdjusted).toEqual([l.id]);
    expect(confOf(db, l.id)).toBe("medium"); // low → medium
    expect(flaggedRaw(db, l.id)).toBe(0);
    // Verification bump: last_verified_at is stamped.
    expect(getLore(db, l.id)!.lastVerifiedAt).toBeTruthy();
  });

  it("blocked outcome DEMOTES confidence of served lore and flags it", () => {
    const l = addLore(db, {
      title: "t",
      summary: "s",
      body: "b",
      repos: ["app"],
      confidence: "high",
      source: "https://example.com/adr",
    });
    logRecall(db, { repo: "app", ticket: "9", loreIds: [l.id] });

    const res = recallFeedback(db, { repo: "app", ticket: "9", outcome: "blocked" });
    expect(res.loreAdjusted).toEqual([l.id]);
    expect(confOf(db, l.id)).toBe("medium"); // high → medium
    expect(flaggedRaw(db, l.id)).toBe(1);
  });

  it("reworked outcome demotes + flags (same demote path as blocked)", () => {
    const l = addLore(db, {
      title: "t",
      summary: "s",
      body: "b",
      repos: ["app"],
      confidence: "medium",
    });
    logRecall(db, { repo: "app", ticket: "3", loreIds: [l.id] });
    recallFeedback(db, { repo: "app", ticket: "3", outcome: "reworked" });
    expect(confOf(db, l.id)).toBe("low"); // medium → low
    expect(flaggedRaw(db, l.id)).toBe(1);
  });

  it("is BOUNDED — one outcome cannot flip a strong signal end to end", () => {
    // A single clean moves low→medium, NOT low→high.
    const lo = addLore(db, {
      title: "a",
      summary: "s",
      body: "b",
      repos: ["app"],
      confidence: "low",
    });
    logRecall(db, { repo: "app", ticket: "10", loreIds: [lo.id] });
    recallFeedback(db, { repo: "app", ticket: "10", outcome: "clean" });
    expect(confOf(db, lo.id)).toBe("medium");

    // A single blocked moves high→medium, NOT high→low.
    const hi = addLore(db, {
      title: "b",
      summary: "s",
      body: "b",
      repos: ["app"],
      confidence: "high",
      source: "https://example.com/adr",
    });
    logRecall(db, { repo: "app", ticket: "11", loreIds: [hi.id] });
    recallFeedback(db, { repo: "app", ticket: "11", outcome: "blocked" });
    expect(confOf(db, hi.id)).toBe("medium");
  });

  it("caps at the ladder ends (high stays high on clean; low stays low on blocked)", () => {
    const hi = addLore(db, {
      title: "h",
      summary: "s",
      body: "b",
      repos: ["app"],
      confidence: "high",
      source: "https://example.com/adr",
    });
    logRecall(db, { repo: "app", ticket: "20", loreIds: [hi.id] });
    recallFeedback(db, { repo: "app", ticket: "20", outcome: "clean" });
    expect(confOf(db, hi.id)).toBe("high");

    const lo = addLore(db, {
      title: "l",
      summary: "s",
      body: "b",
      repos: ["app"],
      confidence: "low",
    });
    logRecall(db, { repo: "app", ticket: "21", loreIds: [lo.id] });
    recallFeedback(db, { repo: "app", ticket: "21", outcome: "blocked" });
    expect(confOf(db, lo.id)).toBe("low");
  });

  it("is IDEMPOTENT per (ticket, outcome) — re-running does not double-apply", () => {
    const l = addLore(db, {
      title: "t",
      summary: "s",
      body: "b",
      repos: ["app"],
      confidence: "low",
    });
    logRecall(db, { repo: "app", ticket: "1", loreIds: [l.id] });

    recallFeedback(db, { repo: "app", ticket: "1", outcome: "clean" });
    expect(confOf(db, l.id)).toBe("medium");

    const again = recallFeedback(db, { repo: "app", ticket: "1", outcome: "clean" });
    expect(again.alreadyApplied).toBe(true);
    expect(again.loreAdjusted).toEqual([]);
    expect(confOf(db, l.id)).toBe("medium"); // unchanged — not bumped to high
  });

  it("a DIFFERENT outcome on the same ticket still applies (only same outcome is idempotent)", () => {
    const l = addLore(db, {
      title: "t",
      summary: "s",
      body: "b",
      repos: ["app"],
      confidence: "medium",
    });
    logRecall(db, { repo: "app", ticket: "1", loreIds: [l.id] });
    recallFeedback(db, { repo: "app", ticket: "1", outcome: "clean" }); // → high
    expect(confOf(db, l.id)).toBe("high");
    const blocked = recallFeedback(db, { repo: "app", ticket: "1", outcome: "blocked" }); // → medium
    expect(blocked.alreadyApplied).toBe(false);
    expect(confOf(db, l.id)).toBe("medium");
  });

  it("flags cards too, and clean clears the card flag", () => {
    const cardId = seedCard(db, "src/thing.ts");
    logRecall(db, { repo: "app", ticket: "1", cardIds: [cardId] });
    recallFeedback(db, { repo: "app", ticket: "1", outcome: "blocked" });
    let f = (
      db.prepare("SELECT flagged_for_review AS f FROM file_card WHERE id = ?").get(cardId) as {
        f: number;
      }
    ).f;
    expect(f).toBe(1);

    logRecall(db, { repo: "app", ticket: "2", cardIds: [cardId] });
    recallFeedback(db, { repo: "app", ticket: "2", outcome: "clean" });
    f = (
      db.prepare("SELECT flagged_for_review AS f FROM file_card WHERE id = ?").get(cardId) as {
        f: number;
      }
    ).f;
    expect(f).toBe(0);
  });

  it("surfaces flagged lore + cards, with optional repo filter", () => {
    const l = addLore(db, {
      title: "flagme",
      summary: "s",
      body: "b",
      repos: ["app"],
      confidence: "medium",
    });
    const cardId = seedCard(db, "src/x.ts");
    logRecall(db, { repo: "app", ticket: "7", loreIds: [l.id], cardIds: [cardId] });
    recallFeedback(db, { repo: "app", ticket: "7", outcome: "reworked" });

    const all = listFlaggedForReview(db);
    expect(all.some((i) => i.type === "lore" && i.id === l.id)).toBe(true);
    expect(all.some((i) => i.type === "card" && i.id === cardId)).toBe(true);

    // Repo filter includes items for "app", excludes an unrelated repo.
    const filtered = listFlaggedForReview(db, { repo: "app" });
    expect(filtered.length).toBe(2);
    expect(listFlaggedForReview(db, { repo: "other" })).toEqual([]);
  });

  it("is a harmless no-op when the ticket has no recall log (served=0)", () => {
    const res = recallFeedback(db, { repo: "app", ticket: "nope", outcome: "clean" });
    expect(res.served).toBe(0);
    expect(res.loreAdjusted).toEqual([]);
    expect(res.cardsAdjusted).toEqual([]);
    expect(res.alreadyApplied).toBe(false);
  });

  it("BOUNDARY: adjusts from its OWN read-event log only — never imports dispatch", () => {
    // Structural guard: the feedback module must not reach into the dispatch
    // control-plane DB. Memory learns from recall_event + the passed outcome.
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, "../src/core/recallFeedback.ts"), "utf8");
    const importLines = src.split("\n").filter((l) => /^\s*import\b|require\(/.test(l));
    for (const line of importLines) {
      expect(line).not.toMatch(/dispatch|\bcrew\b/i);
    }

    // Behavioural guard: with ONLY the memory DB present, the whole loop works.
    const l = addLore(db, {
      title: "t",
      summary: "s",
      body: "b",
      repos: ["app"],
      confidence: "low",
    });
    logRecall(db, { repo: "app", ticket: "1", loreIds: [l.id] });
    const res = recallFeedback(db, { repo: "app", ticket: "1", outcome: "clean" });
    expect(res.served).toBe(1);
    expect(confOf(db, l.id)).toBe("medium");
  });
});

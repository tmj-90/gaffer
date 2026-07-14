import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { addLore, getLore, listRecent } from "../src/core/lore.js";
import { renderSummary } from "../src/cli/format.js";
import { repoKey, upsertFileCard } from "../src/core/fileCards.js";
import {
  listFlaggedForReview,
  logRecall,
  recallEffectiveness,
  recallFeedback,
} from "../src/core/recallFeedback.js";
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

  it("surfaces the flag on LoreSummary + in the CLI brief line (feeds the Memory view badge)", () => {
    const flagged = addLore(db, {
      title: "Flagged convention",
      summary: "served into rework",
      body: "b",
      repos: ["app"],
      confidence: "high",
    });
    const clean = addLore(db, {
      title: "Healthy convention",
      summary: "no signal",
      body: "b",
      repos: ["app"],
      confidence: "high",
    });
    logRecall(db, { repo: "app", ticket: "42", loreIds: [flagged.id] });
    recallFeedback(db, { repo: "app", ticket: "42", outcome: "reworked" });

    const summaries = listRecent(db, 50);
    const fs = summaries.find((s) => s.id === flagged.id)!;
    const cs = summaries.find((s) => s.id === clean.id)!;
    // The per-record recall signal is exposed on the summary the API/UI consume…
    expect(fs.flaggedForReview).toBe(true);
    expect(cs.flaggedForReview).toBe(false);
    // …and rendered as the "⚑ flagged" marker the dashboard's parseLore reads.
    expect(renderSummary(fs)).toContain("⚑ flagged");
    expect(renderSummary(cs)).not.toContain("⚑ flagged");
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

describe("core/recallEffectiveness", () => {
  let db: Database;
  beforeEach(() => {
    db = newInMemoryDb();
    process.env["MEMORY_NO_TELEMETRY"] = "1";
  });

  /** Seed a recall_feedback ledger row directly (the read-back reads THIS table). */
  function seedOutcome(
    repo: string,
    ticket: string,
    outcome: "clean" | "reworked" | "blocked",
    appliedAt: string,
    itemsAdjusted = 1,
  ): void {
    db.prepare(
      `INSERT INTO recall_feedback (id, repo, ticket, outcome, items_adjusted, applied_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(`fb-${repo}-${ticket}-${outcome}`, repo, ticket, outcome, itemsAdjusted, appliedAt);
  }

  it("returns a zero-state (null effectiveness) when nothing has been recorded", () => {
    const stats = recallEffectiveness(db);
    expect(stats.total).toBe(0);
    expect(stats.effectiveness_pct).toBeNull(); // no divide-by-zero
    expect(stats.by_day).toEqual([]);
    expect(stats.last_applied_at).toBeNull();
  });

  it("computes clean-share effectiveness + a per-day trend across outcomes", () => {
    seedOutcome("app", "1", "clean", "2025-01-10T09:00:00Z", 2);
    seedOutcome("app", "2", "clean", "2025-01-10T10:00:00Z", 1);
    seedOutcome("app", "3", "reworked", "2025-01-11T09:00:00Z", 3);
    seedOutcome("app", "4", "blocked", "2025-01-11T10:00:00Z", 0);

    const stats = recallEffectiveness(db);
    expect(stats.total).toBe(4);
    expect(stats.clean).toBe(2);
    expect(stats.reworked).toBe(1);
    expect(stats.blocked).toBe(1);
    // clean / total = 2/4 = 50%.
    expect(stats.effectiveness_pct).toBe(50);
    expect(stats.items_adjusted).toBe(6);
    expect(stats.last_applied_at).toBe("2025-01-11T10:00:00Z");

    // Two calendar days, ascending, each with its own clean-share.
    expect(stats.by_day.map((d) => d.date)).toEqual(["2025-01-10", "2025-01-11"]);
    expect(stats.by_day[0]!.effectiveness_pct).toBe(100); // 2 clean of 2
    expect(stats.by_day[1]!.effectiveness_pct).toBe(0); // 0 clean of 2
  });

  it("scopes to a single repo when --repo is given", () => {
    seedOutcome("app", "1", "clean", "2025-01-10T09:00:00Z");
    seedOutcome("other", "2", "reworked", "2025-01-10T10:00:00Z");

    const scoped = recallEffectiveness(db, { repo: "app" });
    expect(scoped.total).toBe(1);
    expect(scoped.clean).toBe(1);
    expect(scoped.effectiveness_pct).toBe(100);

    const all = recallEffectiveness(db);
    expect(all.total).toBe(2);
  });

  it("NEGATIVE CONTROL: an outcome for an unrelated repo does not count in a scoped roll-up", () => {
    seedOutcome("app", "1", "clean", "2025-01-10T09:00:00Z");
    seedOutcome("unrelated", "9", "clean", "2025-01-10T09:30:00Z");
    // Scoped to a repo with NO outcomes → zero-state, not the global tally.
    const empty = recallEffectiveness(db, { repo: "ghost" });
    expect(empty.total).toBe(0);
    expect(empty.effectiveness_pct).toBeNull();
  });
});

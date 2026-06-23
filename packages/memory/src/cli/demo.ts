/**
 * `memory demo` — seed a handful of realistic-but-clearly-illustrative
 * records so a new user can try `list`, `search`, and `review` without
 * having to think up content. Safety constraints:
 *
 *   - refuses to seed into a non-empty DB unless `--force`
 *   - every record carries the `demo` tag so `memory demo --clean` can
 *     undo the seed without touching real lore
 *   - no fake credentials, no fake PII, nothing that looks plausibly
 *     sensitive
 *   - includes one draft so the review-flow is visible without users
 *     having to wire up the MCP server first
 *   - one record is intentionally stale (review_after in the past) so
 *     the `stale: true` warning is observable
 */
import type { Database } from "better-sqlite3";

import { addLore, suggestLore } from "../core/lore.js";

export interface DemoResult {
  readonly inserted: number;
  readonly ids: ReadonlyArray<string>;
}

const DEMO_TAG = "demo";

/**
 * Returns the number of lore rows in the DB. Used by the CLI to refuse
 * `memory demo` (without `--force`) on a non-empty store so we don't
 * mix demo content into a real working set.
 */
export function countLore(db: Database): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM lore").get() as {
    n: number;
  };
  return row.n;
}

/**
 * Hard-delete every record carrying the demo tag. Returns the count
 * removed. Safe to run on a DB that has never been seeded — returns 0.
 */
export function cleanDemo(db: Database): number {
  const ids = (
    db
      .prepare("SELECT lore_id AS id FROM lore_tags WHERE tag = ? ORDER BY lore_id")
      .all(DEMO_TAG) as Array<{ id: string }>
  ).map((r) => r.id);
  if (ids.length === 0) return 0;
  const tx = db.transaction(() => {
    const rowidStmt = db.prepare("SELECT rowid FROM lore WHERE id = ?");
    const delFts = db.prepare("DELETE FROM lore_fts WHERE rowid = ?");
    const delLore = db.prepare("DELETE FROM lore WHERE id = ?");
    const evt = db.prepare("INSERT INTO events (lore_id, kind, ts) VALUES (?, 'deleted', ?)");
    const ts = new Date().toISOString();
    for (const id of ids) {
      const row = rowidStmt.get(id) as { rowid: number } | undefined;
      if (!row) continue;
      delFts.run(row.rowid);
      delLore.run(id);
      evt.run(id, ts);
    }
  });
  tx();
  return ids.length;
}

/**
 * Insert the five demo records. Returns the inserted ids. The caller is
 * expected to have already gated on `countLore(db) === 0 || force`.
 */
export function seedDemo(db: Database): DemoResult {
  const stale = "2024-01-01";

  const r1 = addLore(db, {
    title: "Use Argon2id for password hashing",
    summary: "Demo decision: Argon2id (m=64MB, t=3, p=4) is the password-hash default.",
    body:
      "This is an example lore record installed by `memory demo`.\n\n" +
      "In a real team, you'd record decisions like this so future agents " +
      "stop suggesting bcrypt. Source URL would link to your ADR or PR.\n\n" +
      "Demo only — no production effect.",
    repos: ["payments-svc", "auth-svc"],
    tags: [DEMO_TAG, "security", "passwords"],
    team: "Platform",
    author: "demo",
    source: "https://example.com/adrs/014",
    confidence: "high",
  });

  const r2 = addLore(db, {
    title: "TypeScript strict mode is mandatory in service code",
    summary: "Demo convention: tsconfig must enable strict for new packages.",
    body:
      "Example convention record. Real version would explain the policy, " +
      "exceptions, and the PR that enforced it in CI.\n\n" +
      "Demo only — no production effect.",
    repos: ["payments-svc", "auth-svc", "billing-svc"],
    tags: [DEMO_TAG, "conventions", "typescript"],
    author: "demo",
    confidence: "medium",
  });

  const r3 = addLore(db, {
    title: "API dates must include timezone offsets",
    summary: "Demo gotcha: naive timestamps caused INC-411; validation rejects them now.",
    body:
      "Example gotcha. Future agents searching for 'dates' or 'timezone' " +
      "find this record and avoid re-introducing the bug.\n\n" +
      "This demo record is intentionally STALE (review_after in 2024) so " +
      "you can see `stale: true` in search results.\n\n" +
      "Demo only — no production effect.",
    repos: ["payments-svc"],
    tags: [DEMO_TAG, "dates", "api", "gotchas"],
    author: "demo",
    reviewAfter: stale,
    confidence: "medium",
  });

  const r4 = addLore(db, {
    title: "Webhook retries cap at 2 hours of exponential backoff",
    summary: "Demo incident lesson: unbounded retries DoS'd downstream — cap added.",
    body:
      "Example incident-lesson record. Real version would link to the " +
      "incident write-up.\n\n" +
      "Demo only — no production effect.",
    repos: ["billing-svc"],
    tags: [DEMO_TAG, "reliability", "incident-lessons"],
    author: "demo",
    confidence: "medium",
  });

  // One draft so `memory review` has something to triage.
  const r5 = suggestLore(db, {
    title: "Prefer feature flags over branching for risky changes",
    summary: "Demo draft: agent-suggested convention, awaiting human review.",
    body:
      "This is an example draft installed by `memory demo`. In a real " +
      "session an agent would call suggest_lore after spotting a pattern. " +
      "Run `memory review` to see the triage flow.\n\n" +
      "Demo only — no production effect.",
    repos: ["payments-svc"],
    tags: [DEMO_TAG, "conventions", "deploys"],
    author: "demo",
    confidence: "low",
  });

  return { inserted: 5, ids: [r1.id, r2.id, r3.id, r4.id, r5.id] };
}

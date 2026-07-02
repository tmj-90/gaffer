/**
 * Repo-key normalisation end-to-end: cross-form lookup, fail-loud
 * diagnostics, and the legacy re-key migration.
 *
 * Pins:
 *   - migration 007 adds the `canonical` column to file_card + repo_sync
 *   - a card onboarded via the SSH canonical is found via the HTTPS canonical
 *     (and vice versa) — the normalisation fix, no re-key needed
 *   - diagnoseRepoKeyMismatch fires when a query resolves to 0 cards but the
 *     store holds cards for the same display name under a different key
 *   - rekeyRepo moves legacy rows onto the normalised key in one transaction,
 *     keeps FTS working, backfills canonical, and re-keys the watermark
 *   - a path collision under the new key drops the stale duplicate, not both
 */
import { createHash } from "node:crypto";

import BetterSqlite3 from "better-sqlite3";
import type { Database } from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  cardKeysForRepoName,
  countActiveCards,
  diagnoseRepoKeyMismatch,
  getFileCard,
  getWatermark,
  rekeyRepo,
  repoKey,
  searchFileCards,
  setWatermark,
  upsertFileCard,
} from "../src/core/fileCards.js";
import { cardsForScope } from "../src/core/scopePacket.js";
import { runMigrations } from "../src/db/migrations.js";

const SSH = "git@github.com:acme/widget.git";
const HTTPS = "https://github.com/acme/widget.git";
const REPO = "widget";

/** The pre-fix, un-normalised key: raw sha256 of the ssh URL (what legacy rows carry). */
const LEGACY_KEY = createHash("sha256").update(SSH).digest("hex");

function newDb(): Database {
  const db = new BetterSqlite3(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function baseCard(over: Partial<Parameters<typeof upsertFileCard>[1]> = {}) {
  return {
    repoKey: repoKey(SSH),
    canonical: SSH,
    repo: REPO,
    path: "src/api/price.ts",
    contentHash: "a".repeat(64),
    loc: 42,
    symbols: ["getPrice", "PriceService"],
    source: "onboard",
    tldr: "price lookup service",
    modelStatus: "active" as const,
    ...over,
  };
}

describe("migration 007 — canonical column", () => {
  it("adds canonical to file_card and repo_sync", () => {
    const db = newDb();
    const fcCols = (
      db.prepare("PRAGMA table_info(file_card)").all() as Array<{ name: string }>
    ).map((r) => r.name);
    const rsCols = (
      db.prepare("PRAGMA table_info(repo_sync)").all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(fcCols).toContain("canonical");
    expect(rsCols).toContain("canonical");
  });
});

describe("cross-form lookup (the normalisation fix)", () => {
  let db: Database;
  beforeEach(() => {
    db = newDb();
    upsertFileCard(db, baseCard());
  });

  it("a card written via the SSH canonical is found via the HTTPS canonical", () => {
    const packet = cardsForScope(db, { repoCanonical: HTTPS, repo: REPO, query: "price" });
    expect(packet.cards.map((c) => c.path)).toContain("src/api/price.ts");
    expect(packet.diagnostics ?? []).toHaveLength(0);
  });

  it("searchFileCards agrees across ssh/https/bare forms", () => {
    for (const form of [SSH, HTTPS, "github.com/acme/widget"]) {
      const hits = searchFileCards(db, repoKey(form), "price", 20);
      expect(hits.map((c) => c.path)).toContain("src/api/price.ts");
    }
  });

  it("persists the normalised canonical on the row", () => {
    const card = getFileCard(db, repoKey(HTTPS), "src/api/price.ts");
    expect(card?.canonical).toBe("github.com/acme/widget");
  });
});

describe("fail-loud diagnostics", () => {
  it("warns when a query resolves to 0 cards but cards exist under another key", () => {
    const db = newDb();
    // Seed a LEGACY row directly under the un-normalised key (bypassing the
    // normalising repoKey, to simulate a pre-fix onboard).
    upsertFileCard(db, baseCard({ repoKey: LEGACY_KEY, canonical: undefined }));

    const goodKey = repoKey(HTTPS);
    expect(countActiveCards(db, goodKey)).toBe(0); // query-time key finds nothing
    const warn = diagnoseRepoKeyMismatch(db, goodKey, REPO, HTTPS);
    expect(warn).toBeTruthy();
    expect(warn).toContain("github.com/acme/widget");
    expect(warn).toContain("cards rekey");

    // And the scope packet surfaces it rather than returning empty silently.
    const packet = cardsForScope(db, { repoCanonical: HTTPS, repo: REPO, query: "price" });
    expect(packet.cards).toHaveLength(0);
    expect(packet.diagnostics?.[0]).toContain("mismatch");
  });

  it("does NOT warn when the repo genuinely has no cards", () => {
    const db = newDb();
    expect(diagnoseRepoKeyMismatch(db, repoKey(HTTPS), REPO, HTTPS)).toBeNull();
  });
});

describe("rekeyRepo — legacy migration", () => {
  it("moves legacy rows onto the normalised key and keeps FTS + search working", () => {
    const db = newDb();
    upsertFileCard(db, baseCard({ repoKey: LEGACY_KEY, canonical: undefined }));
    setWatermark(db, LEGACY_KEY, REPO, "deadbeef");

    // Before: the normalised key finds nothing.
    expect(searchFileCards(db, repoKey(HTTPS), "price", 20)).toHaveLength(0);

    const result = rekeyRepo(db, REPO, HTTPS);
    expect(result.noop).toBe(false);
    expect(result.cardsRekeyed).toBe(1);
    expect(result.newKey).toBe(repoKey(HTTPS));
    expect(result.canonical).toBe("github.com/acme/widget");
    expect(result.fromKeys.map((k) => k.repoKey)).toContain(LEGACY_KEY);

    // After: found via the normalised key, through FTS and getFileCard.
    const hits = searchFileCards(db, repoKey(HTTPS), "price", 20);
    expect(hits.map((c) => c.path)).toContain("src/api/price.ts");
    const card = getFileCard(db, repoKey(SSH), "src/api/price.ts");
    expect(card).not.toBeNull();
    expect(card?.canonical).toBe("github.com/acme/widget");

    // Watermark re-keyed + canonical backfilled.
    expect(getWatermark(db, LEGACY_KEY)).toBeNull();
    const wm = getWatermark(db, repoKey(HTTPS));
    expect(wm?.syncedCommit).toBe("deadbeef");
    expect(wm?.canonical).toBe("github.com/acme/widget");

    // The legacy key no longer owns any cards.
    expect(countActiveCards(db, LEGACY_KEY)).toBe(0);
  });

  it("is a no-op when the repo is already on the normalised key", () => {
    const db = newDb();
    upsertFileCard(db, baseCard()); // written via normalising repoKey → newKey already
    const result = rekeyRepo(db, REPO, SSH);
    expect(result.noop).toBe(true);
    expect(result.cardsRekeyed).toBe(0);
  });

  it("drops a stale duplicate on path collision rather than orphaning both", () => {
    const db = newDb();
    // A legacy row AND a fresh (normalised) row for the SAME path.
    upsertFileCard(db, baseCard({ repoKey: LEGACY_KEY, canonical: undefined, tldr: "OLD" }));
    upsertFileCard(db, baseCard({ tldr: "NEW price lookup" })); // normalised key

    const result = rekeyRepo(db, REPO, HTTPS);
    expect(result.collisionsDropped).toBe(1);
    expect(result.cardsRekeyed).toBe(0);

    // Exactly one active card remains under the normalised key — the newer one.
    expect(countActiveCards(db, repoKey(HTTPS))).toBe(1);
    const card = getFileCard(db, repoKey(HTTPS), "src/api/price.ts");
    expect(card?.tldr).toBe("NEW price lookup");
    // FTS still returns exactly one hit (no dangling FTS row from the dropped dup).
    expect(searchFileCards(db, repoKey(HTTPS), "price", 20)).toHaveLength(1);
  });

  it("re-keys rows for two legacy keys of the same display name", () => {
    const db = newDb();
    const otherLegacy = createHash("sha256").update(HTTPS).digest("hex");
    upsertFileCard(db, baseCard({ repoKey: LEGACY_KEY, canonical: undefined, path: "a.ts" }));
    upsertFileCard(db, baseCard({ repoKey: otherLegacy, canonical: undefined, path: "b.ts" }));

    const result = rekeyRepo(db, REPO, HTTPS);
    expect(result.cardsRekeyed).toBe(2);
    expect(cardKeysForRepoName(db, REPO)).toEqual([{ repoKey: repoKey(HTTPS), count: 2 }]);
  });

  it("does NOT re-key legacy rows whose key is not a provable form of this canonical", () => {
    const db = newDb();
    // A legacy row keyed off some OTHER (non-derivable) identity for the same
    // display name — e.g. a symlinked pwd that differs from realpath. Its key is
    // NOT reconstructable from this canonical, so it must be left alone (loudly
    // diagnosable) rather than blindly claimed.
    const unrelatedKey = createHash("sha256").update("/some/other/symlinked/widget").digest("hex");
    upsertFileCard(db, baseCard({ repoKey: unrelatedKey, canonical: undefined, path: "x.ts" }));

    const result = rekeyRepo(db, REPO, HTTPS);
    expect(result.noop).toBe(true);
    expect(result.cardsRekeyed).toBe(0);
    // The row is untouched under its original key.
    expect(countActiveCards(db, unrelatedKey)).toBe(1);
    expect(countActiveCards(db, repoKey(HTTPS))).toBe(0);
  });
});

// ── B1 (blocking): cross-repo isolation — a shared display name must NEVER let
// onboarding one repo re-key/corrupt another repo's cards. ──────────────────
describe("rekeyRepo — cross-repo isolation (B1)", () => {
  // Two DISTINCT repos that happen to share the display name "api" (extremely
  // common: every org has an `api`/`web`/`utils`). Their canonicals — hence
  // their keys — differ. Onboarding one must not touch the other's rows.
  const SHARED = "api";
  const ORG_A_SSH = "git@github.com:orgA/api.git";
  const ORG_B_SSH = "git@gitlab.com:orgB/api.git";
  const ORG_A_LEGACY = createHash("sha256").update(ORG_A_SSH).digest("hex");
  const ORG_B_LEGACY = createHash("sha256").update(ORG_B_SSH).digest("hex");

  function apiCard(over: Partial<Parameters<typeof upsertFileCard>[1]> = {}) {
    return {
      repoKey: repoKey(ORG_A_SSH),
      canonical: ORG_A_SSH,
      repo: SHARED,
      path: "src/server.ts",
      contentHash: "b".repeat(64),
      loc: 10,
      symbols: ["serve"],
      source: "onboard",
      tldr: "the api server",
      modelStatus: "active" as const,
      ...over,
    };
  }

  it("onboarding orgB does NOT re-key orgA's legacy cards (no display-name match)", () => {
    const db = newDb();
    // orgA has a legacy card under its OWN legacy key, display name "api".
    upsertFileCard(db, apiCard({ repoKey: ORG_A_LEGACY, canonical: undefined, tldr: "ORG-A" }));

    // orgB onboards (same display name, DIFFERENT canonical).
    const result = rekeyRepo(db, SHARED, ORG_B_SSH);

    // orgB found nothing of its own to migrate — and critically did NOT steal
    // orgA's row (the old display-name match would have re-keyed it onto orgB).
    expect(result.cardsRekeyed).toBe(0);
    expect(result.noop).toBe(true);

    // orgA's card is intact under orgA's key; orgB's key holds nothing.
    expect(countActiveCards(db, ORG_A_LEGACY)).toBe(1);
    expect(getFileCard(db, ORG_A_LEGACY, "src/server.ts")?.tldr).toBe("ORG-A");
    expect(countActiveCards(db, repoKey(ORG_B_SSH))).toBe(0);
  });

  it("migrates ONLY the onboarding repo's own rows, leaving the namesake untouched", () => {
    const db = newDb();
    // Both repos have a legacy card, same display name, same path.
    upsertFileCard(db, apiCard({ repoKey: ORG_A_LEGACY, canonical: undefined, tldr: "ORG-A" }));
    upsertFileCard(db, apiCard({ repoKey: ORG_B_LEGACY, canonical: undefined, tldr: "ORG-B" }));

    const result = rekeyRepo(db, SHARED, ORG_B_SSH);

    // Exactly orgB's one row migrated onto orgB's normalised key.
    expect(result.cardsRekeyed).toBe(1);
    expect(getFileCard(db, repoKey(ORG_B_SSH), "src/server.ts")?.tldr).toBe("ORG-B");

    // orgA's row is exactly where it was — NOT moved, NOT dropped, NOT polluted.
    expect(countActiveCards(db, ORG_A_LEGACY)).toBe(1);
    expect(getFileCard(db, ORG_A_LEGACY, "src/server.ts")?.tldr).toBe("ORG-A");
    // And orgB's key does NOT contain orgA's card.
    expect(countActiveCards(db, repoKey(ORG_B_SSH))).toBe(1);
  });

  it("isolates the watermark too — orgB's onboard leaves orgA's watermark intact", () => {
    const db = newDb();
    setWatermark(db, ORG_A_LEGACY, SHARED, "aaaaaaa");
    upsertFileCard(db, apiCard({ repoKey: ORG_A_LEGACY, canonical: undefined }));

    rekeyRepo(db, SHARED, ORG_B_SSH);

    // orgA's legacy watermark is not stolen/dropped by orgB's rekey.
    expect(getWatermark(db, ORG_A_LEGACY)?.syncedCommit).toBe("aaaaaaa");
    expect(getWatermark(db, repoKey(ORG_B_SSH))).toBeNull();
  });
});

// ── N1: on a multi-key same-path collision the NEWEST card must win. ─────────
describe("rekeyRepo — newest-wins on multi-key same-path collision (N1)", () => {
  it("keeps the most recently updated card when two legacy keys share a path", () => {
    const db = newDb();
    const otherLegacy = createHash("sha256").update(HTTPS).digest("hex");
    // Two legacy rows for the SAME repo + SAME path under different legacy keys.
    upsertFileCard(db, baseCard({ repoKey: LEGACY_KEY, canonical: undefined, tldr: "OLDER" }));
    upsertFileCard(db, baseCard({ repoKey: otherLegacy, canonical: undefined, tldr: "NEWER" }));
    // Make the ordering deterministic and unambiguous.
    db.prepare("UPDATE file_card SET updated_at = ? WHERE repo_key = ?").run(
      "2020-01-01T00:00:00.000Z",
      LEGACY_KEY,
    );
    db.prepare("UPDATE file_card SET updated_at = ? WHERE repo_key = ?").run(
      "2024-06-01T00:00:00.000Z",
      otherLegacy,
    );

    const result = rekeyRepo(db, REPO, HTTPS);
    // One migrated, one dropped as the stale duplicate.
    expect(result.cardsRekeyed).toBe(1);
    expect(result.collisionsDropped).toBe(1);

    // Exactly one active card survives — the NEWER one.
    expect(countActiveCards(db, repoKey(HTTPS))).toBe(1);
    expect(getFileCard(db, repoKey(HTTPS), "src/api/price.ts")?.tldr).toBe("NEWER");
  });
});

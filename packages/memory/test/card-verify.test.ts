/**
 * Verify-before-complete for the file-card index (third external review, HIGH memory
 * accuracy).
 *
 * Two overlapping tickets: A renamed src/archive.ts → src/ledger.ts, B changed a
 * function in the original file. Git merged both and the change lives in ledger.ts,
 * but the refresh re-carded archive.ts from B's branch and the watermark still said
 * the merged commit was fully indexed. These pin the memory half of the fix:
 *   - verifyFileCards finds a card whose path is not in the tree (missing) and one
 *     whose content hash differs (stale), and calls a matching set clean;
 *   - `card verify --fix --commit` removes the missing card, re-cards the stale one
 *     (keeping its summary), and records the watermark ONLY when the result is clean;
 *   - without --fix a dirty index leaves the watermark alone and exits 1;
 *   - `card upsert --carry-from` carries a renamed file's summary to the new path.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "../src/cli/index.js";
import { sha256 } from "../src/core/cardValidation.js";
import {
  getFileCard,
  getWatermark,
  repoKey,
  searchFileCards,
  upsertFileCard,
  verifyFileCards,
} from "../src/core/fileCards.js";
import { runMigrations } from "../src/db/migrations.js";
import { openDb } from "../src/db/index.js";

const ARCHIVE = "export function settle(amount) {\n  return amount;\n}\n";
const LEDGER = "export function settleWithFees(amount, fee = 1) {\n  return amount - fee;\n}\n";

describe("verifyFileCards", () => {
  it("reports missing and stale cards, and clean when the cards match the tree", () => {
    const db = new BetterSqlite3(":memory:");
    runMigrations(db);
    const rk = repoKey("/repos/r");
    const card = (path: string, content: string): void => {
      upsertFileCard(db, {
        repoKey: rk,
        repo: "r",
        path,
        contentHash: sha256(content),
        loc: 3,
        symbols: [],
        source: "onboard",
      });
    };
    card("src/archive.ts", ARCHIVE);
    card("src/ledger.ts", ARCHIVE); // carded before B's change landed in it
    const tree: Record<string, string> = { "src/ledger.ts": LEDGER };
    const hashOf = (p: string): string | null => (p in tree ? sha256(tree[p]!) : null);

    const dirty = verifyFileCards(db, rk, hashOf);
    expect(dirty).toEqual({
      checked: 2,
      missing: ["src/archive.ts"],
      stale: ["src/ledger.ts"],
      clean: false,
    });

    db.prepare("DELETE FROM file_card WHERE path = 'src/archive.ts'").run();
    card("src/ledger.ts", LEDGER);
    expect(verifyFileCards(db, rk, hashOf)).toEqual({
      checked: 1,
      missing: [],
      stale: [],
      clean: true,
    });
    db.close();
  });
});

describe("memory card verify (CLI)", () => {
  let dir: string;
  let root: string;
  let out: string;
  const prev: Record<string, string | undefined> = {};
  const canonical = "/repos/overlap";
  const rk = repoKey(canonical);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memory-card-verify-"));
    root = join(dir, "tree");
    mkdirSync(join(root, "src"), { recursive: true });
    for (const k of ["MEMORY_DB", "MEMORY_AUDIT_OFF"]) prev[k] = process.env[k];
    process.env["MEMORY_DB"] = join(dir, "lore.db");
    process.env["MEMORY_AUDIT_OFF"] = "1";
    out = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      out += chunk.toString();
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (...args: string[]): Promise<number> => main(["node", "memory", ...args]);
  const repoArgs = ["--canonical", canonical, "--repo", "overlap"];

  /** The state the overlapping merges left: archive.ts carded, ledger.ts carded stale. */
  async function seedOverlap(): Promise<void> {
    writeFileSync(join(root, "src", "archive.ts"), ARCHIVE);
    writeFileSync(join(root, "src", "ledger.ts"), ARCHIVE);
    // prettier-ignore
    expect(await run("card", "upsert", ...repoArgs, "--repo-root", root, "--path", "src/archive.ts",
      "--tldr", "Settles and records closed accounts", "--role-primary", "domain")).toBe(0);
    expect(
      await run("card", "upsert", ...repoArgs, "--repo-root", root, "--path", "src/ledger.ts"),
    ).toBe(0);
    // The merged commit: archive.ts gone, B's change in ledger.ts.
    rmSync(join(root, "src", "archive.ts"));
    writeFileSync(join(root, "src", "ledger.ts"), LEDGER);
  }

  it("without --fix: reports the problems, exits 1 and leaves the watermark alone", async () => {
    await seedOverlap();
    out = "";
    const rc = await run(
      "card",
      "verify",
      ...repoArgs,
      "--repo-root",
      root,
      "--commit",
      "c0ffee",
      "--json",
    );
    expect(rc).toBe(1);
    const report = JSON.parse(out);
    expect(report.missing).toEqual(["src/archive.ts"]);
    expect(report.stale).toEqual(["src/ledger.ts"]);
    expect(report.clean).toBe(false);
    expect(report.watermark).toBeNull();
    const db = openDb();
    try {
      expect(getWatermark(db, rk)).toBeNull();
    } finally {
      db.close();
    }
  });

  it("--fix --commit: repairs the index against the tree, THEN records the watermark", async () => {
    await seedOverlap();
    out = "";
    const rc = await run(
      "card",
      "verify",
      ...repoArgs,
      "--repo-root",
      root,
      "--fix",
      "--commit",
      "c0ffee",
      "--json",
    );
    expect(rc).toBe(0);
    const report = JSON.parse(out);
    expect(report.fixed).toEqual({ deleted: 1, refreshed: 1 });
    expect(report.clean).toBe(true);
    expect(report.watermark).toBe("c0ffee");
    const db = openDb();
    try {
      expect(getFileCard(db, rk, "src/archive.ts")).toBeNull();
      const ledger = getFileCard(db, rk, "src/ledger.ts")!;
      expect(ledger.contentHash).toBe(sha256(LEDGER));
      expect(ledger.symbols).toContain("settleWithFees");
      expect(searchFileCards(db, rk, "settleWithFees", 10).map((c) => c.path)).toEqual([
        "src/ledger.ts",
      ]);
      expect(getWatermark(db, rk)?.syncedCommit).toBe("c0ffee");
    } finally {
      db.close();
    }
  });

  it("card upsert --carry-from carries a renamed file's summary to the new path", async () => {
    writeFileSync(join(root, "src", "archive.ts"), ARCHIVE);
    // prettier-ignore
    expect(await run("card", "upsert", ...repoArgs, "--repo-root", root, "--path", "src/archive.ts",
      "--tldr", "Settles and records closed accounts", "--role-primary", "domain")).toBe(0);
    writeFileSync(join(root, "src", "ledger.ts"), LEDGER);
    // prettier-ignore
    expect(await run("card", "upsert", ...repoArgs, "--repo-root", root, "--path", "src/ledger.ts",
      "--keep-model", "--carry-from", "src/archive.ts")).toBe(0);
    const db = openDb();
    try {
      const archive = db
        .prepare("SELECT tldr, model_status FROM file_card WHERE path = 'src/archive.ts'")
        .get() as { tldr: string | null; model_status: string };
      const ledger = db
        .prepare("SELECT tldr, model_status FROM file_card WHERE path = 'src/ledger.ts'")
        .get() as { tldr: string | null; model_status: string };
      expect(ledger).toEqual(archive);
      expect(ledger.tldr).toBe("Settles and records closed accounts");
    } finally {
      db.close();
    }
  });
});

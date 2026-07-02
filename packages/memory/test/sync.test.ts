/**
 * `memory sync` — round-trip Markdown export/import. Guards the
 * properties team-sync needs to be trustworthy:
 *
 *   - export → import → export is lossless for the fields we round-trip
 *   - frontmatter parser handles scalars, arrays, booleans, ISO dates
 *   - restricted records and drafts are excluded by default
 *   - --include-restricted / --include-drafts unlock them
 *   - malformed files are skipped with a reason, not crash
 *   - status from frontmatter is authoritative on import (PR is the gate)
 */
import BetterSqlite3 from "better-sqlite3";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { addLore, getLore, suggestLore } from "../src/core/lore.js";
import { addBoundary, findDependents, listBoundaries } from "../src/core/boundaries.js";
import { runMigrations } from "../src/db/migrations.js";
import {
  BOUNDARIES_FILE,
  exportToDir,
  findMemoryDirs,
  importFromDir,
  parseBoundaryLine,
  parseFrontmatter,
  renderLoreMarkdown,
} from "../src/cli/sync.js";
import type { Database } from "better-sqlite3";

function newInMemoryDb(): Database {
  const db = new BetterSqlite3(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

describe("cli/sync — frontmatter parser", () => {
  it("parses scalars, booleans, and ISO-shaped strings", () => {
    const text =
      "---\n" +
      "id: abc12345\n" +
      "title: Some title with no special chars\n" +
      "restricted: false\n" +
      "createdAt: 2026-02-10T09:31:00.000Z\n" +
      "---\n" +
      "\n" +
      "body line 1\n" +
      "body line 2\n";
    const r = parseFrontmatter(text);
    expect(r).not.toBeNull();
    expect(r!.frontmatter["id"]).toBe("abc12345");
    expect(r!.frontmatter["restricted"]).toBe(false);
    expect(r!.frontmatter["createdAt"]).toBe("2026-02-10T09:31:00.000Z");
    expect(r!.body).toBe("body line 1\nbody line 2\n");
  });

  it("parses string arrays under `key:` followed by `  - item`", () => {
    const text =
      "---\n" +
      "id: x\n" +
      "title: t\n" +
      "summary: s\n" +
      "status: active\n" +
      "repos:\n" +
      "  - auth-svc\n" +
      "  - payments-svc\n" +
      "tags:\n" +
      "  - security\n" +
      "---\n" +
      "body\n";
    const r = parseFrontmatter(text);
    expect(r!.frontmatter["repos"]).toEqual(["auth-svc", "payments-svc"]);
    expect(r!.frontmatter["tags"]).toEqual(["security"]);
  });

  it("returns null when the file does not start with a frontmatter fence", () => {
    expect(parseFrontmatter("just a body\n")).toBeNull();
  });

  it("returns null when the frontmatter never closes", () => {
    expect(parseFrontmatter("---\nid: x\ntitle: t\n")).toBeNull();
  });

  it("handles JSON-quoted strings (colons, special chars)", () => {
    const text =
      "---\n" +
      "id: x\n" +
      'title: "Use https://example.com: a colon test"\n' +
      "summary: s\n" +
      "status: active\n" +
      "---\n" +
      "body\n";
    const r = parseFrontmatter(text);
    expect(r!.frontmatter["title"]).toBe("Use https://example.com: a colon test");
  });
});

describe("cli/sync — renderLoreMarkdown", () => {
  it("round-trips: render → parse yields the same field values", () => {
    const db = newInMemoryDb();
    const lore = addLore(db, {
      title: "Use https://example.com: keep colons working",
      summary: "s with: colon",
      body: "Body line one.\nBody line two.",
      repos: ["auth-svc", "payments-svc"],
      tags: ["security"],
      source: "https://example.com/adrs/14",
      confidence: "high",
      reviewAfter: "2026-12-31",
      author: "alice@example.com",
      team: "Platform",
    });
    const full = getLore(db, lore.id)!;
    const md = renderLoreMarkdown(full);
    const parsed = parseFrontmatter(md);
    expect(parsed).not.toBeNull();
    expect(parsed!.frontmatter["id"]).toBe(full.id);
    expect(parsed!.frontmatter["title"]).toBe(full.title);
    expect(parsed!.frontmatter["status"]).toBe("active");
    expect(parsed!.frontmatter["confidence"]).toBe("high");
    expect(parsed!.frontmatter["restricted"]).toBe(false);
    expect(parsed!.frontmatter["repos"]).toEqual(["auth-svc", "payments-svc"]);
    expect(parsed!.frontmatter["tags"]).toEqual(["security"]);
    expect(parsed!.body.trim()).toBe(full.body);
  });
});

describe("cli/sync — export/import round-trip against the filesystem", () => {
  let db: Database;
  let dir: string;
  beforeEach(() => {
    db = newInMemoryDb();
    dir = mkdtempSync(join(tmpdir(), "lore-sync-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("exports active records to one .md per id, then imports them back losslessly", () => {
    const a = addLore(db, {
      title: "Argon2id default",
      summary: "Platform sec ruling.",
      body: "Body for argon record.",
      repos: ["auth-svc"],
      tags: ["security"],
      source: "https://example.com/adrs/14",
      confidence: "high",
    });
    const b = addLore(db, {
      title: "Migration style guide",
      summary: "Liquibase format.",
      body: "Body for migration record.",
      repos: ["billing-svc"],
      tags: ["db", "conventions"],
    });
    const exported = exportToDir(db, dir);
    expect(exported.written).toHaveLength(2);
    expect(exported.excluded.restricted).toBe(0);
    expect(exported.excluded.drafts).toBe(0);

    // Fresh DB; import. Both ids should round-trip.
    const db2 = newInMemoryDb();
    const result = importFromDir(db2, dir);
    expect(result.created).toBe(2);
    expect(result.updated).toBe(0);
    expect(result.skipped).toEqual([]);
    const ra = getLore(db2, a.id)!;
    const rb = getLore(db2, b.id)!;
    expect(ra.title).toBe(a.title);
    expect(ra.body).toBe("Body for argon record.");
    expect(ra.repos).toEqual(["auth-svc"]);
    expect(ra.tags).toEqual(["security"]);
    expect(ra.source).toBe("https://example.com/adrs/14");
    expect(ra.confidence).toBe("high");
    expect(rb.tags).toEqual(["conventions", "db"]);
  });

  it("excludes drafts and restricted by default; opt-ins surface them", () => {
    addLore(db, { title: "active", summary: "s", body: "B" });
    suggestLore(db, { title: "draft one", summary: "s", body: "B" });
    addLore(db, {
      title: "restricted one",
      summary: "s",
      body: "B",
      restricted: true,
    });
    const defaultExport = exportToDir(db, dir);
    expect(defaultExport.written).toHaveLength(1);
    expect(defaultExport.excluded.restricted).toBe(1);
    expect(defaultExport.excluded.drafts).toBe(1);
    expect(defaultExport.restrictedWritten).toBe(0);

    rmSync(dir, { recursive: true, force: true });
    const allOptins = exportToDir(db, dir, {
      includeDrafts: true,
      includeRestricted: true,
    });
    expect(allOptins.written).toHaveLength(3);
    expect(allOptins.restrictedWritten).toBe(1);
  });

  it("restricted records exported with --include-restricted are chmod'd 0600; others stay 0644", () => {
    const open = addLore(db, { title: "shareable", summary: "s", body: "B" });
    const locked = addLore(db, {
      title: "secret",
      summary: "s",
      body: "B",
      restricted: true,
    });
    const result = exportToDir(db, dir, { includeRestricted: true });
    expect(result.restrictedWritten).toBe(1);
    // Skip the assertion on Windows/WSL where chmod is a no-op.
    if (process.platform !== "win32") {
      const openMode = require("node:fs").statSync(join(dir, `${open.id}.md`)).mode & 0o777;
      const lockedMode = require("node:fs").statSync(join(dir, `${locked.id}.md`)).mode & 0o777;
      expect(openMode).toBe(0o644);
      expect(lockedMode).toBe(0o600);
    }
  });

  it("import second time updates rather than duplicates", () => {
    const a = addLore(db, {
      title: "v1",
      summary: "s",
      body: "B",
    });
    exportToDir(db, dir);

    // Edit the .md file in place.
    const path = join(dir, `${a.id}.md`);
    const text = readFileSync(path, "utf8");
    const edited = text.replace("title: v1", "title: v2 (edited)");
    writeFileSync(path, edited);

    const db2 = newInMemoryDb();
    // Insert the original first so the import path goes through UPDATE.
    addLore(db2, {
      title: "v1",
      summary: "s",
      body: "B",
    });
    // The local id won't match the export's id, so first import will CREATE.
    const first = importFromDir(db2, dir);
    expect(first.created).toBe(1);
    expect(first.updated).toBe(0);
    // Second import: same files, no changes → all rows should UPDATE.
    const second = importFromDir(db2, dir);
    expect(second.created).toBe(0);
    expect(second.updated).toBe(1);
    expect(getLore(db2, a.id)?.title).toBe("v2 (edited)");
  });

  it("skips files without frontmatter and reports a reason", () => {
    writeFileSync(join(dir, "rogue.md"), "no frontmatter here\n");
    const result = importFromDir(newInMemoryDb(), dir);
    expect(result.created).toBe(0);
    expect(result.skipped).toEqual([{ file: "rogue.md", reason: "no frontmatter" }]);
  });

  it("skips a restricted file by default and notes why; --include-restricted imports it", () => {
    addLore(db, {
      title: "Restricted note",
      summary: "s",
      body: "B",
      restricted: true,
    });
    exportToDir(db, dir, { includeRestricted: true });
    const db2 = newInMemoryDb();
    const def = importFromDir(db2, dir);
    expect(def.created).toBe(0);
    expect(def.skipped[0]?.reason).toContain("restricted");
    const db3 = newInMemoryDb();
    const opt = importFromDir(db3, dir, { includeRestricted: true });
    expect(opt.created).toBe(1);
  });

  it("respects status declared in frontmatter (PR is the gate)", () => {
    // Manually write a deprecated record's .md, import, expect deprecated.
    const id = "abcd2345";
    const md =
      "---\n" +
      `id: ${id}\n` +
      "title: Old policy\n" +
      "summary: deprecated by team vote\n" +
      "status: deprecated\n" +
      "confidence: medium\n" +
      "restricted: false\n" +
      "createdAt: 2026-01-01T00:00:00.000Z\n" +
      "updatedAt: 2026-01-02T00:00:00.000Z\n" +
      "---\n" +
      "\n" +
      "Body.\n";
    writeFileSync(join(dir, `${id}.md`), md);
    const result = importFromDir(db, dir);
    expect(result.created).toBe(1);
    expect(getLore(db, id)?.status).toBe("deprecated");
  });

  it("--clean removes stale <id>.md files in the target dir before writing", () => {
    addLore(db, { title: "current", summary: "s", body: "B" });
    // Place a stale lore-id-looking file in the dir; --clean should drop it.
    const stale = join(dir, "abcd2345.md");
    writeFileSync(stale, "---\nid: abcd2345\n---\nstale\n");
    const result = exportToDir(db, dir, { clean: true });
    expect(result.removed.map((p) => p.split("/").pop()).sort()).toContain("abcd2345.md");
    // The stale file is gone; only the current record's .md remains.
    const remaining = require("node:fs")
      .readdirSync(dir)
      .filter((f: string) => f.endsWith(".md"))
      .sort();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).not.toBe("abcd2345.md");
  });

  it("--clean does NOT remove hand-written .md files (only 8-char id pattern)", () => {
    addLore(db, { title: "current", summary: "s", body: "B" });
    writeFileSync(join(dir, "CONTRIBUTING.md"), "# How to contribute\n");
    writeFileSync(join(dir, "README.md"), "# Repo lore\n");
    const result = exportToDir(db, dir, { clean: true });
    expect(result.removed).toEqual([]);
    const names = readdirSync(dir).sort();
    expect(names).toContain("CONTRIBUTING.md");
    expect(names).toContain("README.md");
  });

  it("without --clean, stale <id>.md files survive across exports", () => {
    addLore(db, { title: "current", summary: "s", body: "B" });
    writeFileSync(join(dir, "abcd2345.md"), "---\nid: abcd2345\n---\nstale\n");
    const result = exportToDir(db, dir);
    expect(result.removed).toEqual([]);
    const names = readdirSync(dir);
    expect(names).toContain("abcd2345.md");
  });

  it("skips files with missing required fields and lists each reason", () => {
    writeFileSync(join(dir, "no-id.md"), "---\ntitle: t\nsummary: s\nstatus: active\n---\nbody\n");
    writeFileSync(
      join(dir, "bad-status.md"),
      "---\nid: abcd2345\ntitle: t\nsummary: s\nstatus: nonsense\n---\nbody\n",
    );
    const result = importFromDir(db, dir);
    expect(result.created).toBe(0);
    expect(result.skipped.map((s) => s.file).sort()).toEqual(["bad-status.md", "no-id.md"]);
  });

  it("rejects records whose id is not the 8-char [a-z2-9] shape", () => {
    // A typo or copy-paste mishap in the frontmatter must NOT become a
    // permanent ghost row. Each malformed id below should land in
    // `skipped`, not `created`.
    const cases = [
      { file: "ghost-prefix.md", id: "lor_abc12345" },
      { file: "ghost-space.md", id: "lor abc 123" },
      { file: "ghost-short.md", id: "abc" },
      { file: "ghost-upper.md", id: "ABCD2345" },
      { file: "ghost-banned-char.md", id: "abcd2340" }, // '0' is not in the alphabet
    ];
    for (const c of cases) {
      writeFileSync(
        join(dir, c.file),
        `---\nid: ${c.id}\ntitle: t\nsummary: s\nstatus: active\n---\nbody\n`,
      );
    }
    const result = importFromDir(db, dir);
    expect(result.created).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.skipped).toHaveLength(cases.length);
    for (const s of result.skipped) {
      expect(s.reason).toMatch(/invalid id/);
    }
  });

  it("rejects non-boolean restricted, non-enum confidence, non-id supersededBy, non-ISO timestamps", () => {
    writeFileSync(
      join(dir, "bad-restricted.md"),
      "---\nid: abcd2345\ntitle: t\nsummary: s\nstatus: active\nrestricted: maybe\n---\nb\n",
    );
    writeFileSync(
      join(dir, "bad-confidence.md"),
      "---\nid: bcde2345\ntitle: t\nsummary: s\nstatus: active\nconfidence: certain\n---\nb\n",
    );
    writeFileSync(
      join(dir, "bad-superseded.md"),
      "---\nid: cdef2345\ntitle: t\nsummary: s\nstatus: superseded\nsupersededBy: lor_999\n---\nb\n",
    );
    // "yesterday" is not parseable by Date.parse, so this is rejected.
    // Date-only strings ("2024-01-01") and full ISO timestamps both
    // parse cleanly and are accepted — that's deliberate, since the
    // CLI seeds reviewAfter as date-only and we round-trip those.
    writeFileSync(
      join(dir, "bad-timestamp.md"),
      "---\nid: defg2345\ntitle: t\nsummary: s\nstatus: active\nupdatedAt: yesterday\n---\nb\n",
    );
    const result = importFromDir(db, dir);
    expect(result.created).toBe(0);
    expect(result.skipped.map((s) => s.file).sort()).toEqual([
      "bad-confidence.md",
      "bad-restricted.md",
      "bad-superseded.md",
      "bad-timestamp.md",
    ]);
  });

  it("default import refuses to overwrite a strictly-newer local record; --force overrides", () => {
    // Establish a record, export it, then bump the local copy so the
    // local updatedAt is strictly newer than the on-disk file's.
    const a = addLore(db, { title: "v1", summary: "s", body: "B" });
    exportToDir(db, dir);
    // Force the local row forward by one second so updatedAt is strictly
    // greater than the file's recorded updatedAt.
    const future = new Date(Date.parse(a.updatedAt) + 1000).toISOString();
    db.prepare("UPDATE lore SET updated_at = ?, title = 'local-edit' WHERE id = ?").run(
      future,
      a.id,
    );

    const safe = importFromDir(db, dir);
    expect(safe.created).toBe(0);
    expect(safe.updated).toBe(0);
    expect(safe.skippedNewer).toBe(1);
    expect(getLore(db, a.id)?.title).toBe("local-edit");

    const forced = importFromDir(db, dir, { force: true });
    expect(forced.updated).toBe(1);
    expect(forced.skippedNewer).toBe(0);
    expect(getLore(db, a.id)?.title).toBe("v1");
  });

  it("--dry-run reports the plan without writing", () => {
    addLore(db, { title: "existing", summary: "s", body: "B" });
    exportToDir(db, dir);
    const fresh = newInMemoryDb();
    const planned = importFromDir(fresh, dir, { dryRun: true });
    expect(planned.dryRun).toBe(true);
    expect(planned.created).toBe(1);
    // Nothing was actually persisted.
    expect(fresh.prepare("SELECT COUNT(*) AS n FROM lore").get()).toEqual({ n: 0 });
  });

  /**
   * Regression: a pre-branch export (written before migration 009 added
   * `kind` to the frontmatter) re-imported over an equal timestamp used to
   * reset a backfilled kind to 'other' — silently dropping the record from
   * the product-context block, which filters by kind.
   */
  it("equal-timestamp import of a pre-kind file preserves a backfilled kind", () => {
    const a = addLore(db, { title: "ADR-14", summary: "s", body: "B", kind: "decision" });
    const full = getLore(db, a.id)!;
    // Hand-write the file a pre-009 binary would have exported: identical
    // updatedAt (so safe-import re-upserts idempotently), no `kind:` line.
    const md =
      "---\n" +
      `id: ${a.id}\n` +
      "title: ADR-14 (from disk)\n" +
      "summary: s\n" +
      "status: active\n" +
      `confidence: ${full.confidence}\n` +
      "restricted: false\n" +
      `createdAt: ${full.createdAt}\n` +
      `updatedAt: ${full.updatedAt}\n` +
      "---\n" +
      "\n" +
      "B\n";
    writeFileSync(join(dir, `${a.id}.md`), md);

    const result = importFromDir(db, dir);
    // Equal timestamps fall through and re-upsert (idempotent re-import)…
    expect(result.updated).toBe(1);
    expect(result.skippedNewer).toBe(0);
    const after = getLore(db, a.id)!;
    expect(after.title).toBe("ADR-14 (from disk)");
    // …but the backfilled kind survives.
    expect(after.kind).toBe("decision");
  });

  it("an import file that names a meaningful kind still overwrites the local kind", () => {
    const a = addLore(db, { title: "t", summary: "s", body: "B", kind: "decision" });
    const full = getLore(db, a.id)!;
    const md =
      "---\n" +
      `id: ${a.id}\n` +
      "title: t\n" +
      "summary: s\n" +
      "status: active\n" +
      "kind: gotcha\n" +
      "restricted: false\n" +
      `createdAt: ${full.createdAt}\n` +
      `updatedAt: ${full.updatedAt}\n` +
      "---\n" +
      "\n" +
      "B\n";
    writeFileSync(join(dir, `${a.id}.md`), md);

    const result = importFromDir(db, dir);
    expect(result.updated).toBe(1);
    expect(getLore(db, a.id)!.kind).toBe("gotcha");
  });
});

describe("findMemoryDirs — cross-repo discovery (`sync pull`)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "memory-pull-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // Build a fake workspace tree and seed .memory/ dirs in chosen
  // places. Each marker file is named with a valid lore-id pattern so
  // the heuristic accepts the dir.
  function seedLoreDir(path: string, ids: string[] = ["abcd2345"]): void {
    mkdirSync(path, { recursive: true });
    for (const id of ids) {
      writeFileSync(join(path, `${id}.md`), `---\nid: ${id}\n---\n`);
    }
  }

  it("discovers every .memory/ under the parent that contains <id>.md files", () => {
    seedLoreDir(join(root, "client-app", ".memory"));
    seedLoreDir(join(root, "backend-app", ".memory"));
    seedLoreDir(join(root, "infra", "terraform-mod", ".memory"));
    const found = findMemoryDirs(root);
    expect(found).toHaveLength(3);
    expect(found.map((p) => p.replace(root + "/", "")).sort()).toEqual([
      "backend-app/.memory",
      "client-app/.memory",
      "infra/terraform-mod/.memory",
    ]);
  });

  it("skips .memory/ dirs that contain no <id>.md files (avoid false positives)", () => {
    // Some unrelated tool happens to use the same name.
    mkdirSync(join(root, "junk", ".memory"), { recursive: true });
    writeFileSync(join(root, "junk", ".memory", "README"), "not lore");
    expect(findMemoryDirs(root)).toEqual([]);
  });

  it("does not descend into a discovered .memory/ itself", () => {
    seedLoreDir(join(root, "repo", ".memory"));
    // A nested directory inside the discovered one — should not be reported.
    mkdirSync(join(root, "repo", ".memory", "drafts", ".memory"), {
      recursive: true,
    });
    writeFileSync(join(root, "repo", ".memory", "drafts", ".memory", "abcd2345.md"), "---\n");
    const found = findMemoryDirs(root);
    expect(found).toEqual([join(root, "repo", ".memory")]);
  });

  it("skips heavy directories (node_modules, .git, dist, etc.)", () => {
    // Seed a real one to ensure walking still works.
    seedLoreDir(join(root, "repo", ".memory"));
    // And one buried inside skip-listed paths — should NOT be found.
    seedLoreDir(join(root, "repo", "node_modules", "pkg", ".memory"));
    seedLoreDir(join(root, "repo", "dist", ".memory"));
    seedLoreDir(join(root, "repo", ".git", "hooks", ".memory"));
    seedLoreDir(join(root, "repo", "vendor", ".memory"));
    const found = findMemoryDirs(root);
    expect(found).toEqual([join(root, "repo", ".memory")]);
  });

  it("returns sorted absolute paths so import order is stable", () => {
    seedLoreDir(join(root, "z-last", ".memory"));
    seedLoreDir(join(root, "a-first", ".memory"));
    seedLoreDir(join(root, "m-middle", ".memory"));
    const found = findMemoryDirs(root);
    expect(found).toEqual(found.slice().sort());
    expect(found[0]).toContain("a-first");
    expect(found[2]).toContain("z-last");
  });

  it("returns [] for an empty / non-existent / unreadable parent", () => {
    expect(findMemoryDirs(join(root, "no-such-dir"))).toEqual([]);
    // Empty dir → no .memory/ found
    expect(findMemoryDirs(root)).toEqual([]);
  });

  it("skips other hidden directories that aren't in the skip list", () => {
    // .vscode shouldn't be walked into (hidden), but our real walker
    // skips ALL dirs starting with `.` other than `.memory` itself.
    seedLoreDir(join(root, "repo", ".memory"));
    seedLoreDir(join(root, ".vscode-private", ".memory"));
    seedLoreDir(join(root, ".tmp", ".memory"));
    const found = findMemoryDirs(root);
    expect(found).toEqual([join(root, "repo", ".memory")]);
  });

  it("discovers a .memory/ that holds only boundaries.jsonl (no lore .md)", () => {
    const dir = join(root, "edges-only", ".memory");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, BOUNDARIES_FILE),
      JSON.stringify({
        id: "abcd2345",
        repo: "svc",
        contract: "c",
        role: "provides",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }) + "\n",
    );
    expect(findMemoryDirs(root)).toEqual([dir]);
  });
});

describe("cli/sync — boundary round-trip", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memory-bnd-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("parseBoundaryLine validates shape and skips junk", () => {
    expect(parseBoundaryLine("")).toBeNull();
    expect(parseBoundaryLine("not json")).toBeNull();
    expect(parseBoundaryLine(JSON.stringify({ repo: "r" }))).toBeNull();
    const ok = parseBoundaryLine(
      JSON.stringify({ repo: "r", contract: "c", role: "provides", status: "active" }),
    );
    expect(ok?.repo).toBe("r");
    expect(ok?.role).toBe("provides");
  });

  it("export writes boundaries.jsonl; import on another DB aggregates the edges", () => {
    const a = newInMemoryDb();
    addBoundary(a, { repo: "orders-svc", contract: "OrderSubmitted", role: "provides" });
    const out = join(dir, ".memory");
    const res = exportToDir(a, out);
    expect(res.boundariesWritten).toBe(1);
    const jsonl = readFileSync(join(out, BOUNDARIES_FILE), "utf8");
    expect(jsonl).toContain("order-submitted");

    const central = newInMemoryDb();
    addBoundary(central, { repo: "reporting-svc", contract: "order-submitted", role: "consumes" });
    const imp = importFromDir(central, out);
    expect(imp.boundariesCreated).toBe(1);
    const impact = findDependents(central, "order-submitted");
    expect(impact.providers.map((b) => b.repo)).toEqual(["orders-svc"]);
    expect(impact.consumers.map((b) => b.repo)).toEqual(["reporting-svc"]);
  });

  it("removes a stale boundaries.jsonl when no active edges remain", () => {
    const db = newInMemoryDb();
    addBoundary(db, { repo: "svc", contract: "c", role: "provides" });
    const out = join(dir, ".memory");
    exportToDir(db, out);
    expect(readdirSync(out)).toContain(BOUNDARIES_FILE);
    // Deprecate the only edge → next export should drop the artifact.
    const edges = listBoundaries(db);
    db.prepare("UPDATE boundaries SET status = 'deprecated' WHERE id = ?").run(edges[0]!.id);
    const res = exportToDir(db, out);
    expect(res.boundariesWritten).toBe(0);
    expect(readdirSync(out)).not.toContain(BOUNDARIES_FILE);
  });
});

/**
 * LESSONS (Gaffer backlog 59): a post-merge finding a person approved, served by path.
 *
 *  - suggestLore keeps a lesson (tag post-merge-finding) a draft even under auto-approve;
 *  - a draft, a rejected or a restricted lesson is never served; an approved one is served
 *    to a change in the same repo whose paths overlap its paths (prefix on whole segments
 *    either way, or a glob), and to no other change;
 *  - the scope packet's text-searched lore leaves lessons out, so a lesson whose words
 *    match an unrelated ticket's query still does not reach it;
 *  - `memory lessons --json` is the CLI the runner calls.
 */
import BetterSqlite3 from "better-sqlite3";
import type { Database } from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { LESSON_TAG, lessonsForPaths, lorePaths, pathsOverlap } from "../src/core/lessons.js";
import { approveLore, deleteLore, rejectLore, suggestLore } from "../src/core/lore.js";
import { cardsForScope } from "../src/core/scopePacket.js";
import { runMigrations } from "../src/db/migrations.js";
import { main } from "../src/cli/index.js";

function newDb(): Database {
  const db = new BetterSqlite3(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

const lesson = (db: Database, paths: string[], over: Record<string, unknown> = {}) =>
  suggestLore(
    db,
    {
      title: "Lesson from #12 (test gap): empty exports dropped the header row",
      summary: "Empty CSV exports lost their header row; test the empty case.",
      body: "From #12.",
      kind: "gotcha",
      repos: ["app"],
      tags: [LESSON_TAG, "from-ticket-12"],
      paths,
      ...over,
    },
    { autoApprove: true },
  );

describe("pathsOverlap", () => {
  it("matches whole path segments either way, and globs", () => {
    expect(pathsOverlap("src/export/csv.ts", "src/export/csv.ts")).toBe(true);
    expect(pathsOverlap("src/export/", "src/export/csv.ts")).toBe(true);
    expect(pathsOverlap("src/export", "src/export/csv.ts")).toBe(true);
    expect(pathsOverlap("src/export/csv.ts", "src/export")).toBe(true);
    expect(pathsOverlap("src/export", "src/exporter.ts")).toBe(false);
    expect(pathsOverlap("src/export/csv.ts", "src/import/csv.ts")).toBe(false);
    expect(pathsOverlap("src/**/*.csv.ts", "src/a/b/x.csv.ts")).toBe(true);
    expect(pathsOverlap("src/*.ts", "src/a/b.ts")).toBe(false);
    expect(pathsOverlap("src/export/*.ts", "src/export")).toBe(true);
    expect(pathsOverlap("./src//export/csv.ts", "/src/export/csv.ts")).toBe(true);
    expect(pathsOverlap("../x", "../x")).toBe(false);
  });
});

describe("lessons in memory", () => {
  let db: Database;
  beforeEach(() => {
    db = newDb();
  });

  it("a lesson stays a draft under auto-approve and is not served until a person approves it", () => {
    const l = lesson(db, ["src/export/csv.ts"]);
    expect(l.status).toBe("draft");
    expect(lorePaths(db, l.id)).toEqual(["src/export/csv.ts"]);
    expect(lessonsForPaths(db, { repo: "app", paths: ["src/export/csv.ts"] })).toEqual([]);
    approveLore(db, l.id);
    const hits = lessonsForPaths(db, { repo: "app", paths: ["src/export/csv.ts"] });
    expect(hits.map((h) => h.id)).toEqual([l.id]);
    expect(hits[0]).toMatchObject({
      title: "Lesson from #12 (test gap): empty exports dropped the header row",
      paths: ["src/export/csv.ts"],
      matched: ["src/export/csv.ts"],
      repo: "app",
      fromTicket: 12,
    });
  });

  it("serves only to the same repo and overlapping paths; never with no path", () => {
    const l = lesson(db, ["src/export/"]);
    approveLore(db, l.id);
    expect(lessonsForPaths(db, { repo: "app", paths: ["src/export/xlsx.ts"] })).toHaveLength(1);
    expect(lessonsForPaths(db, { repo: "app", paths: ["src/billing/invoice.ts"] })).toEqual([]);
    expect(lessonsForPaths(db, { repo: "other", paths: ["src/export/xlsx.ts"] })).toEqual([]);
    expect(lessonsForPaths(db, { repo: "app", paths: [] })).toEqual([]);
  });

  it("a rejected, restricted or deleted lesson is never served, and its paths go with it", () => {
    const rejected = lesson(db, ["src/a.ts"]);
    rejectLore(db, rejected.id, "not a lesson");
    const restricted = lesson(db, ["src/a.ts"], { restricted: true });
    approveLore(db, restricted.id);
    expect(lessonsForPaths(db, { repo: "app", paths: ["src/a.ts"] })).toEqual([]);
    const gone = lesson(db, ["src/a.ts"]);
    deleteLore(db, gone.id);
    expect(lorePaths(db, gone.id)).toEqual([]);
  });

  it("the scope packet's text-searched lore leaves lessons out", () => {
    const l = lesson(db, ["src/export/csv.ts"]);
    approveLore(db, l.id);
    const plain = suggestLore(
      db,
      {
        title: "Exports use the shared header helper",
        summary: "Empty exports and full ones call writeHeader.",
        body: "x",
        kind: "convention",
        repos: ["app"],
      },
      { autoApprove: true },
    );
    const packet = cardsForScope(db, {
      repoCanonical: "github.com/acme/app",
      repo: "app",
      query: "empty exports header row",
    });
    const ids = packet.lore.map((x) => x.id);
    expect(ids).toContain(plain.id);
    expect(ids).not.toContain(l.id);
  });
});

describe("memory lessons (CLI)", () => {
  it("prints the matching approved lessons as JSON, [] when none", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memory-lessons-"));
    const saved = process.env.MEMORY_DB;
    process.env.MEMORY_DB = join(dir, "lore.db");
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await main([
        "node",
        "memory",
        "suggest",
        "--title",
        "Lesson from #3: keep the header",
        "--summary",
        "Header row lost",
        "--body",
        "b",
        "--kind",
        "gotcha",
        "--repo",
        "app",
        "--tag",
        LESSON_TAG,
        "--path",
        "src/export/csv.ts",
      ]);
      const id = /suggested (\S+)/.exec(out.join(""))![1]!;
      out.length = 0;
      await main(["node", "memory", "lessons", "--repo", "app", "--paths", "src/export/csv.ts", "--json"]);
      expect(JSON.parse(out.join(""))).toEqual([]);
      await main(["node", "memory", "approve", id]);
      out.length = 0;
      await main(["node", "memory", "lessons", "--repo", "app", "--paths", "src/export", "--json"]);
      const hits = JSON.parse(out.join("")) as Array<{ id: string; title: string }>;
      expect(hits.map((h) => h.id)).toEqual([id]);
      out.length = 0;
      await main(["node", "memory", "lessons", "--repo", "app", "--paths", "src/other.ts", "--json"]);
      expect(JSON.parse(out.join(""))).toEqual([]);
    } finally {
      process.stdout.write = write;
      if (saved === undefined) delete process.env.MEMORY_DB;
      else process.env.MEMORY_DB = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

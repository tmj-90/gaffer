/**
 * CODE INDEX (migration 016): files -> top-level symbols -> imports -> tests.
 *
 * Pins:
 *   - the extractors: TS re-exports and aliases, default exports, CommonJS, ESM `.js`
 *     specifiers, Python relative / package imports
 *   - resolution: index.ts barrels (callers through a re-export), tsconfig paths, a
 *     workspace package name, Python packages and submodules
 *   - test links by import and by file name; a caller's tested flag
 *   - skips: node_modules, dist, *.generated.*, .gitattributes linguist-vendored
 *   - incremental refresh against a real git repo: only the changed files are re-read, a
 *     renamed file moves its importers' edges, a deleted file drops, an unchanged commit
 *     is a no-op; status missing / fresh / stale
 *   - the migration is additive and idempotent; the CLI build / neighbours / stats
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildCodeIndex,
  codeNeighbours,
  extractAliases,
  extractCodeFacts,
  getIndexBuild,
} from "../src/core/codeIndex.js";
import { repoKey } from "../src/core/fileCards.js";
import { MIGRATIONS, runMigrations } from "../src/db/migrations.js";
import { main } from "../src/cli/index.js";

function newDb(): Database {
  const db = new BetterSqlite3(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function write(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim();
}

/** A small mixed repo: TS app with a barrel, aliases and tests; a Python package. */
function seedRepo(root: string): void {
  write(
    root,
    "src/invoice.ts",
    [
      "import { round } from './util';",
      "export function calculateInvoice(lines: number[]): number {",
      "  return round(lines.reduce((a, b) => a + b, 0));",
      "}",
      "export const TAX = 0.2;",
      "export default function formatInvoice(n: number) { return `#${n}`; }",
      "function internal() {}",
      "",
    ].join("\n"),
  );
  write(root, "src/util.ts", "export function round(n: number) { return Math.round(n); }\n");
  write(
    root,
    "src/index.ts",
    "export { calculateInvoice, TAX as RATE } from './invoice';\nexport * from './util';\n",
  );
  write(
    root,
    "src/api.ts",
    "import { calculateInvoice } from './index';\nexport const api = calculateInvoice;\n",
  );
  write(
    root,
    "src/report.ts",
    "import { calculateInvoice } from './invoice.js';\nexport const r = calculateInvoice([1]);\n",
  );
  write(root, "src/main.ts", "import formatInvoice from './invoice';\nformatInvoice(1);\n");
  write(
    root,
    "src/alias.ts",
    "import { calculateInvoice as calc } from '@/invoice';\nexport const a = calc;\n",
  );
  write(root, "src/rate.ts", "import { RATE } from './index';\nexport const x = RATE;\n");
  write(
    root,
    "src/cjs.js",
    "const { calculateInvoice } = require('./invoice');\nmodule.exports = { calculateInvoice };\n",
  );
  write(
    root,
    "src/shared-user.ts",
    "import { shared } from '@acme/shared';\nexport const s = shared;\n",
  );
  write(
    root,
    "packages/shared/package.json",
    JSON.stringify({ name: "@acme/shared", version: "1.0.0" }),
  );
  write(root, "packages/shared/src/index.ts", "export const shared = 1;\n");
  write(
    root,
    "tsconfig.json",
    '{\n  // comments are allowed\n  "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } }\n}\n',
  );
  write(
    root,
    "test/invoice.test.ts",
    "import { calculateInvoice } from '../src/invoice';\ncalculateInvoice([]);\n",
  );
  write(root, "test/api.test.ts", "import { api } from '../src/api';\napi;\n");
  write(root, "src/util.test.ts", "it('rounds', () => {});\n");
  write(root, "pkg/__init__.py", "");
  write(root, "pkg/billing.py", "def calculate(x):\n    return x\n\nclass Ledger:\n    pass\n");
  write(
    root,
    "pkg/service.py",
    "from .billing import calculate\n\ndef run():\n    return calculate(1)\n",
  );
  write(root, "app.py", "from pkg.billing import calculate, Ledger\n");
  write(root, "other.py", "from pkg import billing\nimport os\n");
  write(root, "tests/test_billing.py", "from pkg.billing import calculate\n");
  // Noise the index must not read.
  write(root, "node_modules/dep/index.js", "export const dep = 1;\n");
  write(root, "dist/invoice.js", "export function calculateInvoice() {}\n");
  write(root, "src/schema.generated.ts", "export const gen = 1;\n");
  write(root, "src/legacy/old.ts", "import { calculateInvoice } from '../invoice';\n");
  write(root, ".gitattributes", "src/legacy/** linguist-vendored\n");
}

let root: string;
let db: Database;
const KEY = repoKey("/repos/acme");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "code-index-"));
  db = newDb();
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("extractors", () => {
  it("reads TS exports, re-exports with aliases, a default export and CommonJS", () => {
    const f = extractCodeFacts(
      "src/a.ts",
      [
        "import Foo, { a, b as c } from './x';",
        "import * as ns from '../y.js';",
        "export { calc, other as renamed } from './invoice';",
        "export * from './all';",
        "export default function main() {}",
        "export async function* gen() {}",
        "classify(1);",
        "const local = 2;",
        "export { local as LOCAL };",
        "const { r1 } = require('./req');",
      ].join("\n"),
    );
    const sym = Object.fromEntries(f.symbols.map((s) => [s.name, s.exportedAs]));
    expect(sym).toMatchObject({
      main: "default",
      gen: "gen",
      local: "LOCAL",
      calc: "calc",
      renamed: "renamed",
    });
    expect(sym).not.toHaveProperty("ify");
    const imp = f.imports.map((i) => `${i.kind} ${i.specifier} [${i.names.join(",")}] @${i.line}`);
    expect(imp).toEqual(
      expect.arrayContaining([
        "import ./x [a,b,default] @1",
        "import ../y.js [*] @2",
        "reexport ./invoice [calc,other as renamed] @3",
        "reexport ./all [*] @4",
        "require ./req [r1] @10",
      ]),
    );
  });

  it("reads Python defs, classes, constants and from / relative imports", () => {
    const f = extractCodeFacts(
      "pkg/x.py",
      "from .billing import (\n    calculate,\n    Total as T,\n)\nimport os, pkg.sub as ps\ndef run():\n    pass\ndef _hidden():\n    pass\nMAX_N = 3\n",
    );
    expect(f.symbols.map((s) => `${s.kind} ${s.name} ${s.exportedAs}`)).toEqual([
      "def run run",
      "def _hidden null",
      "const MAX_N MAX_N",
    ]);
    expect(f.imports.map((i) => `${i.specifier} [${i.names.join(",")}]`)).toEqual([
      ".billing [calculate,Total]",
      "os [*]",
      "pkg.sub [*]",
    ]);
  });

  it("reads workspace package names and tsconfig paths (comments and trailing commas allowed)", () => {
    expect(extractAliases("packages/a/package.json", '{"name":"@x/a"}')).toEqual([
      {
        sourcePath: "packages/a/package.json",
        alias: "@x/a",
        target: "packages/a",
        kind: "package",
      },
    ]);
    expect(
      extractAliases(
        "tsconfig.json",
        '{ /* c */ "compilerOptions": { "paths": { "@/*": ["./src/*"], }, } }',
      ),
    ).toEqual([{ sourcePath: "tsconfig.json", alias: "@/*", target: "src/*", kind: "tsconfig" }]);
  });
});

describe("build and neighbours", () => {
  beforeEach(() => {
    seedRepo(root);
  });

  it("indexes the sources, skips generated and vendored paths, and records coverage", () => {
    const r = buildCodeIndex(db, { repoKey: KEY, repo: "acme", repoRoot: root, commit: "c1" });
    expect(r.mode).toBe("full");
    const files = (
      db.prepare("SELECT path FROM code_index_file ORDER BY path").all() as Array<{ path: string }>
    ).map((x) => x.path);
    expect(files).not.toEqual(expect.arrayContaining(["node_modules/dep/index.js"]));
    expect(files.some((p) => p.startsWith("dist/") || p.startsWith("node_modules/"))).toBe(false);
    expect(files).not.toContain("src/schema.generated.ts");
    expect(files).not.toContain("src/legacy/old.ts");
    expect(files).toContain("src/invoice.ts");
    expect(files).toContain("pkg/billing.py");
    expect(r.stats.skippedGenerated).toBeGreaterThanOrEqual(2);
    expect(r.stats.testFiles).toBe(4);
    expect(r.stats.languages).toMatchObject({ ts: expect.any(Number), js: 1, py: 6 });
    expect(r.stats.refs).toBeGreaterThan(10);
    expect(getIndexBuild(db, KEY)?.commit).toBe("c1");
  });

  it("lists a changed symbol's callers through barrels, ESM .js, tsconfig and CommonJS, with tests", () => {
    buildCodeIndex(db, { repoKey: KEY, repo: "acme", repoRoot: root, commit: "c1" });
    const n = codeNeighbours(db, {
      repoKey: KEY,
      symbols: ["src/invoice.ts#calculateInvoice"],
      perItem: 20,
      commit: "c1",
    });
    expect(n.status).toBe("fresh");
    const it0 = n.items[0]!;
    expect(it0.exportedAs).toBe("calculateInvoice");
    const callers = Object.fromEntries(
      it0.callers.map((c) => [c.path, `${c.via}${c.through ? `:${c.through}` : ""}`]),
    );
    expect(callers).toEqual({
      "src/alias.ts": "name",
      "src/api.ts": "barrel:src/index.ts",
      "src/cjs.js": "name",
      "src/report.ts": "name",
    });
    // main.ts imports the default export, rate.ts another name through the barrel: not callers.
    expect(it0.callersTotal).toBe(4);
    // api.ts has a test that imports it; the others do not.
    expect(it0.callersTested).toBe(1);
    expect(it0.callers.find((c) => c.path === "src/api.ts")?.tested).toBe(true);
    expect(it0.tests.map((t) => `${t.path} ${t.via}`)).toEqual(["test/invoice.test.ts import"]);
  });

  it("follows a re-export alias, and a default export's importers", () => {
    buildCodeIndex(db, { repoKey: KEY, repo: "acme", repoRoot: root });
    const n = codeNeighbours(db, {
      repoKey: KEY,
      symbols: ["src/invoice.ts#TAX", "src/invoice.ts#formatInvoice", "src/invoice.ts#internal"],
    });
    expect(n.status).toBe("unknown");
    expect(n.items[0]!.callers.map((c) => c.path)).toEqual(["src/rate.ts"]);
    expect(n.items[1]!.exportedAs).toBe("default");
    expect(n.items[1]!.callers.map((c) => c.path)).toEqual(["src/main.ts"]);
    expect(n.items[2]!.note).toMatch(/not exported/);
  });

  it("answers a named path with every importer, and a bare symbol name by its definition", () => {
    buildCodeIndex(db, { repoKey: KEY, repo: "acme", repoRoot: root });
    const n = codeNeighbours(db, {
      repoKey: KEY,
      paths: ["src/invoice.ts", "src/util.ts", "README.md", "src/nope.ts"],
      symbols: ["calculateInvoice"],
      perItem: 3,
    });
    const [inv, util, readme, nope, bare] = n.items;
    // Direct importers only: the barrel itself, not every file that imports the barrel.
    // index.ts, report.ts, main.ts, alias.ts, cjs.js (the test file is listed as a test).
    expect(inv!.callersTotal).toBe(5);
    expect(inv!.callers).toHaveLength(3);
    expect(inv!.callers.map((c) => c.path)).toContain("src/index.ts");
    expect(util!.tests.map((t) => `${t.path} ${t.via}`)).toEqual(["src/util.test.ts name"]);
    expect(readme!.note).toMatch(/not a file the index reads/);
    expect(nope!.note).toMatch(/not in the index/);
    expect(bare!.path).toBe("src/invoice.ts");
    expect(bare!.callersTotal).toBe(4);
  });

  it("resolves a workspace package name and Python packages, submodules and relative imports", () => {
    buildCodeIndex(db, { repoKey: KEY, repo: "acme", repoRoot: root });
    const n = codeNeighbours(db, {
      repoKey: KEY,
      paths: ["packages/shared/src/index.ts", "pkg/billing.py"],
      symbols: ["pkg/billing.py#calculate", "pkg/billing.py#Ledger"],
    });
    expect(n.items[0]!.callers.map((c) => c.path)).toEqual(["src/shared-user.ts"]);
    expect(n.items[1]!.callers.map((c) => c.path)).toEqual([
      "app.py",
      "other.py",
      "pkg/service.py",
    ]);
    expect(n.items[1]!.tests.map((t) => t.path)).toEqual(["tests/test_billing.py"]);
    expect(n.items[2]!.callers.map((c) => `${c.path} ${c.via}`)).toEqual([
      "app.py name",
      "other.py module",
      "pkg/service.py name",
    ]);
    expect(n.items[2]!.tests.map((t) => t.path)).toEqual(["tests/test_billing.py"]);
    expect(n.items[3]!.callers.map((c) => c.path)).toEqual(["app.py", "other.py"]);
    expect(n.items[3]!.moduleTestsTotal).toBe(1);
  });

  it("says missing for a repo with no index, and stale against another commit", () => {
    expect(codeNeighbours(db, { repoKey: KEY, paths: ["src/invoice.ts"] })).toMatchObject({
      status: "missing",
      items: [],
    });
    buildCodeIndex(db, { repoKey: KEY, repo: "acme", repoRoot: root, commit: "c1" });
    expect(
      codeNeighbours(db, { repoKey: KEY, paths: ["src/invoice.ts"], commit: "c2" }).status,
    ).toBe("stale");
  });

  it("caps the walk and says so", () => {
    const r = buildCodeIndex(db, { repoKey: KEY, repo: "acme", repoRoot: root, maxFiles: 3 });
    expect(r.stats.files).toBe(3);
    expect(r.stats.capsHit).toEqual(["maxFiles"]);
    const b = buildCodeIndex(db, {
      repoKey: KEY,
      repo: "acme",
      repoRoot: root,
      maxBytesPerFile: 60,
    });
    expect(b.stats.capsHit).toEqual(["maxBytesPerFile"]);
    expect(b.stats.files).toBeGreaterThan(3);
  });
});

describe("incremental refresh (real git repo)", () => {
  it("re-reads only the changed files; a rename moves the edges and a delete drops the file", () => {
    seedRepo(root);
    git(root, "init", "-q", "-b", "main");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "one");
    const c1 = git(root, "rev-parse", "HEAD");
    const first = buildCodeIndex(db, { repoKey: KEY, repo: "acme", repoRoot: root, commit: c1 });
    expect(first.mode).toBe("full");

    // Rename report.ts -> summary.ts (content unchanged), change api.ts, delete util.test.ts.
    renameSync(join(root, "src/report.ts"), join(root, "src/summary.ts"));
    write(root, "src/api.ts", "import { TAX } from './invoice';\nexport const api = TAX;\n");
    unlinkSync(join(root, "src/util.test.ts"));
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "two");
    const c2 = git(root, "rev-parse", "HEAD");
    const spy = vi.fn((r: string, a: string, b: string) => {
      const out = execFileSync("git", ["-C", r, "diff", "--name-status", "-M", a, b], {
        encoding: "utf8",
      });
      const changed: string[] = [];
      const removed: string[] = [];
      for (const line of out.trim().split("\n")) {
        const f = line.split("\t");
        if (f[0]!.startsWith("R")) {
          removed.push(f[1]!);
          changed.push(f[2]!);
        } else if (f[0] === "D") removed.push(f[1]!);
        else changed.push(f[1]!);
      }
      return { changed, removed };
    });
    const second = buildCodeIndex(db, {
      repoKey: KEY,
      repo: "acme",
      repoRoot: root,
      commit: c2,
      changedPaths: spy,
    });
    expect(spy).toHaveBeenCalledWith(root, c1, c2);
    expect(second.mode).toBe("incremental");
    // summary.ts (renamed in) and api.ts (changed) are re-read; the rest keep their rows.
    expect(second.stats.extracted).toBe(2);
    expect(second.stats.removed).toBe(2);
    const n = codeNeighbours(db, {
      repoKey: KEY,
      symbols: ["src/invoice.ts#calculateInvoice"],
      perItem: 20,
      commit: c2,
    });
    expect(n.status).toBe("fresh");
    const callers = n.items[0]!.callers.map((c) => c.path);
    expect(callers).toContain("src/summary.ts");
    expect(callers).not.toContain("src/report.ts");
    expect(callers).not.toContain("src/api.ts");
    const util = codeNeighbours(db, { repoKey: KEY, paths: ["src/util.ts"] }).items[0]!;
    expect(util.tests).toEqual([]);

    // Same commit again: nothing to do.
    const third = buildCodeIndex(db, { repoKey: KEY, repo: "acme", repoRoot: root, commit: c2 });
    expect(third.mode).toBe("unchanged");
    expect(third.stats.extracted).toBe(0);
  });

  it("the default diff reader handles a real git rename and falls back to a walk without a known commit", () => {
    seedRepo(root);
    git(root, "init", "-q", "-b", "main");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "one");
    const c1 = git(root, "rev-parse", "HEAD");
    buildCodeIndex(db, { repoKey: KEY, repo: "acme", repoRoot: root, commit: c1 });
    renameSync(join(root, "src/report.ts"), join(root, "src/summary.ts"));
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "two");
    const c2 = git(root, "rev-parse", "HEAD");
    const r = buildCodeIndex(db, { repoKey: KEY, repo: "acme", repoRoot: root, commit: c2 });
    expect(r.mode).toBe("incremental");
    expect(r.stats.extracted).toBe(1);
    // A commit the repo does not have: the diff fails, so the tree is walked (hashes skip).
    const w = buildCodeIndex(db, {
      repoKey: KEY,
      repo: "acme",
      repoRoot: root,
      commit: "0".repeat(40),
    });
    expect(w.mode).toBe("full");
    expect(w.stats.extracted).toBe(0);
    const full = buildCodeIndex(db, {
      repoKey: KEY,
      repo: "acme",
      repoRoot: root,
      commit: c2,
      full: true,
    });
    expect(full.mode).toBe("full");
    expect(full.stats.extracted).toBe(0);
  });
});

describe("migration 016-code-index", () => {
  it("is additive and idempotent", () => {
    const d = new BetterSqlite3(":memory:");
    // Every migration before 016, then the code-index tables already present (a partial apply).
    for (const m of MIGRATIONS.filter((x) => x.id < "016")) m.up(d);
    d.exec("CREATE TABLE migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    for (const m of MIGRATIONS.filter((x) => x.id < "016"))
      d.prepare("INSERT INTO migrations VALUES (?, ?)").run(m.id, "t");
    MIGRATIONS.find((m) => m.id === "016-code-index")!.up(d);
    expect(runMigrations(d).applied).toEqual(["016-code-index"]);
    expect(runMigrations(d).applied).toEqual([]);
    const tables = (
      d
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'code_%' ORDER BY name",
        )
        .all() as Array<{
        name: string;
      }>
    ).map((t) => t.name);
    expect(tables).toEqual([
      "code_import",
      "code_index_alias",
      "code_index_build",
      "code_index_file",
      "code_ref",
      "code_symbol",
      "code_test_link",
    ]);
    d.close();
  });
});

describe("CLI: memory index", () => {
  let dir: string;
  let out = "";
  const prev: Record<string, string | undefined> = {};
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "code-index-cli-"));
    for (const k of ["MEMORY_DB", "MEMORY_AUDIT_OFF"]) prev[k] = process.env[k];
    process.env["MEMORY_DB"] = join(dir, "lore.db");
    process.env["MEMORY_AUDIT_OFF"] = "1";
    out = "";
    vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => {
      out += c.toString();
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
  const run = (...args: string[]) => main(["node", "memory", ...args]);

  it("builds, answers neighbours and reports stats as JSON", async () => {
    seedRepo(root);
    expect(
      await run(
        "index",
        "build",
        "--repo-root",
        root,
        "--canonical",
        "/repos/acme",
        "--repo",
        "acme",
        "--commit",
        "c1",
        "--json",
      ),
    ).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ repo: "acme", commit: "c1", mode: "full" });
    out = "";
    expect(
      await run(
        "index",
        "neighbours",
        "--canonical",
        "/repos/acme",
        "--symbols",
        "src/invoice.ts#calculateInvoice",
        "--commit",
        "c1",
        "--json",
      ),
    ).toBe(0);
    const n = JSON.parse(out);
    expect(n.status).toBe("fresh");
    expect(n.method).toBe("by import text (index)");
    expect(n.items[0].callersTotal).toBe(4);
    out = "";
    expect(await run("index", "stats", "--json")).toBe(0);
    expect(JSON.parse(out).repos[0]).toMatchObject({ repo: "acme", commit: "c1" });
    out = "";
    expect(await run("index", "neighbours", "--canonical", "/repos/other", "--paths", "a.ts")).toBe(
      0,
    );
    expect(out).toMatch(/code index: missing/);
    expect(await run("index", "build")).toBe(2);
    expect(await run("index", "bogus")).toBe(2);
  });
});

/**
 * CODE INDEX edge cases (the paths code-index.test.ts does not walk).
 *
 * Pins:
 *   - extractors: malformed brace lists, side-effect / dynamic / namespace re-export
 *     imports, CommonJS export shapes, duplicate declarations, unsupported languages
 *   - aliases: bad JSON, a package.json that is not a workspace package, tsconfig paths
 *     with no usable target or one that escapes the repo
 *   - resolution: exact and directory imports, an absolute and an escaping specifier,
 *     an exact tsconfig path, a tsconfig path with no match, a package subpath and a
 *     package with no entry, Python relative depth, `from . import x`, star imports and
 *     source-root / unique-suffix module lookups
 *   - storage: a corrupt build record or import row, a self import, a re-export of a
 *     missing module, test links by mirrored directory
 *   - build: a missing checkout, symlinks, .gitattributes patterns, the incremental
 *     paths for a vanished, oversized, generated, hidden, newly vendored or config file,
 *     the maxFiles cap on an incremental build, and the git diff reader's statuses
 *   - query: barrel cycles, repeated imports, tests through a barrel, every "no answer"
 *     note, a symbol defined in more than MAX_DEFINITIONS modules
 *   - CLI: text renderings of build / neighbours / stats, the empty index, bad flags
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildCodeIndex,
  codeIndexStats,
  codeNeighbours,
  extractAliases,
  extractCodeFacts,
  getIndexBuild,
  gitChangedPaths,
  gitHead,
  indexLang,
  listIndexBuilds,
  Resolver,
  type IndexAlias,
} from "../src/core/codeIndex.js";
import { repoKey } from "../src/core/fileCards.js";
import { runMigrations } from "../src/db/migrations.js";
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

const KEY = repoKey("/repos/edges");
let root: string;
let db: Database;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "code-index-edges-"));
  db = newDb();
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const build = (extra: Partial<Parameters<typeof buildCodeIndex>[1]> = {}) =>
  buildCodeIndex(db, { repoKey: KEY, repo: "edges", repoRoot: root, commit: "c1", ...extra });

describe("extractors: edge shapes", () => {
  it("skips empty, non-identifier and badly aliased entries in a brace list", () => {
    const f = extractCodeFacts(
      "src/a.ts",
      "export { a, , 1bad, b as 2c, /* note */ type T, default as D } from './x';\n",
    );
    expect(f.imports).toEqual([
      { specifier: "./x", kind: "reexport", names: ["a", "b", "T", "default as D"], line: 1 },
    ]);
    // `b as 2c` keeps the source name (the alias is not an identifier).
    expect(f.symbols.map((s) => s.name)).toEqual(["a", "b", "T", "D"]);
  });

  it("reads side-effect, dynamic and namespace re-export imports, and both require shapes", () => {
    const f = extractCodeFacts(
      "src/a.js",
      [
        "import './polyfill';",
        "export * as helpers from './helpers';",
        "const lazy = () => import('./lazy');",
        "const { a, b: renamed } = require('./obj');",
        "require('./side');",
      ].join("\n"),
    );
    expect(f.imports.map((i) => `${i.kind} ${i.specifier} [${i.names.join(",")}]`)).toEqual([
      "import ./polyfill []",
      "import ./helpers [*]",
      "require ./obj [a,b]",
      "require ./side [*]",
      "dynamic ./lazy [*]",
    ]);
    expect(f.symbols).toEqual([
      { name: "lazy", kind: "const", line: 3, exportedAs: null },
      { name: "helpers", kind: "reexport", line: 2, exportedAs: "helpers" },
    ]);
  });

  it("marks local declarations exported by a local list, CommonJS assignments and module.exports", () => {
    const f = extractCodeFacts(
      "src/c.js",
      [
        "function a() {}",
        "function b() {}",
        "function c() {}",
        "function d() {}",
        "export { a, b as bee, ghost };",
        "exports.c = c;",
        "module.exports.fresh = 1;",
        "module.exports = { d, e: 1, 'quoted': 2 };",
        "module.exports = d;",
        "module.exports = unknownThing;",
      ].join("\n"),
    );
    const sym = Object.fromEntries(f.symbols.map((s) => [s.name, `${s.kind}:${s.exportedAs}`]));
    expect(sym).toEqual({
      a: "function:a",
      b: "function:bee",
      c: "function:c",
      d: "function:d",
      ghost: "export:ghost",
      fresh: "export:fresh",
      e: "export:e",
    });
  });

  it("keeps the first of duplicate declarations, and takes a later export name for a local one", () => {
    const f = extractCodeFacts(
      "src/d.ts",
      [
        "export function over(x: string): void;",
        "export function over(x: unknown) {}",
        "function later() {}",
        "export { later } from './elsewhere';",
        "export default someName;",
        "export default 42;",
        "export default async () => 1;",
      ].join("\n"),
    );
    expect(f.symbols.filter((s) => s.name === "over")).toHaveLength(1);
    expect(f.symbols.find((s) => s.name === "later")).toMatchObject({
      kind: "function",
      exportedAs: "later",
    });
    expect(f.symbols.filter((s) => s.name === "default")).toEqual([
      { name: "default", kind: "default", line: 5, exportedAs: "default" },
    ]);
  });

  it("names a declared local by `export default name`", () => {
    const f = extractCodeFacts("src/e.ts", "const handler = 1;\nexport default handler;\n");
    expect(f.symbols).toEqual([{ name: "handler", kind: "const", line: 1, exportedAs: "default" }]);
  });

  it("keeps the first Python def and constant of a repeated name", () => {
    const f = extractCodeFacts(
      "m.py",
      "def run():\n    pass\ndef run():\n    pass\nLIMIT = 1\nLIMIT = 2\nclass LIMIT:\n    pass\n",
    );
    expect(f.symbols.map((s) => `${s.kind} ${s.name} @${s.line}`)).toEqual([
      "def run @1",
      "class LIMIT @7",
    ]);
  });

  it("reads nothing from declaration files and unsupported languages", () => {
    expect(indexLang("src/types.d.ts")).toBeNull();
    expect(indexLang("src/types.d.mts")).toBeNull();
    expect(indexLang("lib/x.rb")).toBeNull();
    expect(extractCodeFacts("src/types.d.ts", "export interface X {}\n")).toEqual({
      symbols: [],
      imports: [],
    });
    expect(extractCodeFacts("lib/x.rb", "require 'y'\n")).toEqual({ symbols: [], imports: [] });
  });
});

describe("extractAliases: malformed and non-workspace configs", () => {
  it("yields nothing for bad JSON or a non-object document", () => {
    expect(extractAliases("package.json", "{ not json")).toEqual([]);
    expect(extractAliases("package.json", "null")).toEqual([]);
    expect(extractAliases("package.json", "42")).toEqual([]);
  });

  it("yields nothing for a package.json with no usable name", () => {
    expect(extractAliases("a/package.json", '{"version":"1.0.0"}')).toEqual([]);
    expect(extractAliases("a/package.json", '{"name":7}')).toEqual([]);
    expect(extractAliases("a/package.json", '{"name":"not a package name"}')).toEqual([]);
  });

  it("skips tsconfig paths with no string target or a target outside the repo", () => {
    expect(extractAliases("tsconfig.json", "{}")).toEqual([]);
    expect(extractAliases("tsconfig.base.json", '{"compilerOptions":{}}')).toEqual([]);
    expect(
      extractAliases(
        "app/jsconfig.json",
        JSON.stringify({
          compilerOptions: {
            baseUrl: "src",
            paths: {
              "#notarray": "lib/*",
              "#empty": [],
              "#numbers": [1, 2],
              "#escape": ["../../../outside/*"],
              "#ok": [3, "lib/*"],
            },
          },
        }),
      ),
    ).toEqual([
      { sourcePath: "app/jsconfig.json", alias: "#ok", target: "app/src/lib/*", kind: "tsconfig" },
    ]);
  });

  it("ignores a JSON file that is neither a package.json nor a tsconfig", () => {
    expect(extractAliases("config/settings.json", '{"name":"x"}')).toEqual([]);
  });
});

describe("Resolver: specifier shapes", () => {
  const paths = new Set([
    "index.ts",
    "src/a.ts",
    "src/explicit.ts",
    "src/esm.mts",
    "src/dir/index.tsx",
    "src/config.ts",
    "packages/ui/lib/button.ts",
    "packages/empty/README.md",
  ]);
  const aliases: IndexAlias[] = [
    { sourcePath: "tsconfig.json", alias: "~config", target: "src/config.ts", kind: "tsconfig" },
    { sourcePath: "tsconfig.json", alias: "@lib/*", target: "src/*", kind: "tsconfig" },
    {
      sourcePath: "packages/ui/package.json",
      alias: "@acme/ui",
      target: "packages/ui",
      kind: "package",
    },
    {
      sourcePath: "packages/empty/package.json",
      alias: "@acme/empty",
      target: "packages/empty",
      kind: "package",
    },
  ];
  const r = new Resolver(paths, aliases);

  it("resolves an explicit extension, an .mjs to .mts, a directory index and the repo root", () => {
    expect(r.resolveJs("src/a.ts", "./explicit.ts")).toEqual({
      to: "src/explicit.ts",
      how: "relative",
    });
    expect(r.resolveJs("src/a.ts", "./esm.mjs")).toEqual({ to: "src/esm.mts", how: "relative" });
    expect(r.resolveJs("src/a.ts", "./dir/")).toEqual({ to: "src/dir/index.tsx", how: "relative" });
    expect(r.resolveJs("src/a.ts", "..")).toEqual({ to: "index.ts", how: "relative" });
    expect(r.resolveJs("src/a.ts", "./missing")).toEqual({ to: null, how: "unresolved" });
  });

  it("reads an absolute specifier from the repo root and refuses one that escapes it", () => {
    expect(r.resolveJs("src/dir/index.tsx", "/src/a")).toEqual({ to: "src/a.ts", how: "relative" });
    expect(r.resolveJs("src/a.ts", "../../outside")).toEqual({ to: null, how: "unresolved" });
  });

  it("resolves an exact tsconfig path; a pattern with no file falls through to external", () => {
    expect(r.resolveJs("src/a.ts", "~config")).toEqual({ to: "src/config.ts", how: "alias" });
    expect(r.resolveJs("src/a.ts", "~configx")).toEqual({ to: null, how: "external" });
    expect(r.resolveJs("src/a.ts", "@lib/nothing")).toEqual({ to: null, how: "external" });
  });

  it("resolves a package subpath; a workspace package with no entry is unresolved, others external", () => {
    expect(r.resolveJs("src/a.ts", "@acme/ui/lib/button")).toEqual({
      to: "packages/ui/lib/button.ts",
      how: "alias",
    });
    expect(r.resolveJs("src/a.ts", "@acme/ui")).toEqual({ to: null, how: "unresolved" });
    expect(r.resolveJs("src/a.ts", "@acme/empty")).toEqual({ to: null, how: "unresolved" });
    // A name that starts like a workspace package but is not one.
    expect(r.resolveJs("src/a.ts", "@acme/uikit")).toEqual({ to: null, how: "external" });
    expect(r.resolveJs("src/a.ts", "react")).toEqual({ to: null, how: "external" });
  });

  const py = new Resolver(
    new Set([
      "__init__.py",
      "top.py",
      "src/core/engine.py",
      "pkg/__init__.py",
      "pkg/a.py",
      "pkg/sub/__init__.py",
      "pkg/sub/deep.py",
      "one/x/shared/mod.py",
      "two/y/shared/mod.py",
      "far/away/unique/leaf.py",
    ]),
    [],
  );
  const imp = (specifier: string, names: string[], kind = "from") => ({
    specifier,
    kind,
    names,
    line: 1,
  });

  it("walks Python relative imports by dot depth and refuses one deeper than the package", () => {
    expect(py.resolvePy("pkg/sub/deep.py", imp("..a", ["f"]))).toEqual({
      edges: [{ to: "pkg/a.py", names: ["f"] }],
      how: "relative",
    });
    expect(py.resolvePy("pkg/sub/deep.py", imp("....", ["x"]))).toEqual({
      edges: [],
      how: "unresolved",
    });
    expect(py.resolvePy("pkg/a.py", imp(".", ["sub"]))).toEqual({
      edges: [{ to: "pkg/sub/__init__.py", names: ["*"] }],
      how: "relative",
    });
    // `from .. import top` from a top-level package reaches the repo-root __init__.py.
    expect(py.resolvePy("pkg/a.py", imp("..", ["top", "thing"]))).toEqual({
      edges: [
        { to: "top.py", names: ["*"] },
        { to: "__init__.py", names: ["thing"] },
      ],
      how: "relative",
    });
    expect(py.resolvePy("pkg/a.py", imp(".missing", ["x"]))).toEqual({
      edges: [],
      how: "unresolved",
    });
  });

  it("keeps a star import as a whole-module edge and finds modules under a source root or by unique suffix", () => {
    expect(py.resolvePy("top.py", imp("pkg.a", ["*"]))).toEqual({
      edges: [{ to: "pkg/a.py", names: ["*"] }],
      how: "alias",
    });
    expect(py.resolvePy("top.py", imp("core.engine", ["*"], "import_module"))).toEqual({
      edges: [{ to: "src/core/engine.py", names: ["*"] }],
      how: "alias",
    });
    expect(py.resolvePy("top.py", imp("unique.leaf", ["*"], "import_module"))).toEqual({
      edges: [{ to: "far/away/unique/leaf.py", names: ["*"] }],
      how: "alias",
    });
    // Two modules end in `shared.mod`: no unique answer.
    expect(py.resolvePy("top.py", imp("shared.mod", ["*"], "import_module"))).toEqual({
      edges: [],
      how: "external",
    });
    expect(py.resolvePy("top.py", imp("requests", ["get"]))).toEqual({
      edges: [],
      how: "external",
    });
  });
});

describe("storage: corrupt rows and derived edges", () => {
  it("treats a build record with unreadable stats as no build", () => {
    write(root, "a.ts", "export const a = 1;\n");
    build();
    db.prepare("UPDATE code_index_build SET stats = 'not json' WHERE repo_key = ?").run(KEY);
    expect(getIndexBuild(db, KEY)).toBeNull();
    expect(listIndexBuilds(db)).toEqual([]);
    expect(codeIndexStats(db, KEY)).toEqual([]);
    expect(codeNeighbours(db, { repoKey: KEY, paths: ["a.ts"] }).status).toBe("missing");
  });

  it("reports a build missing capsHit as uncapped", () => {
    write(root, "a.ts", "export const a = 1;\n");
    build();
    const row = db.prepare("SELECT stats FROM code_index_build").get() as { stats: string };
    const stats = JSON.parse(row.stats) as Record<string, unknown>;
    delete stats["capsHit"];
    db.prepare("UPDATE code_index_build SET stats = ?").run(JSON.stringify(stats));
    expect(codeNeighbours(db, { repoKey: KEY, paths: ["a.ts"] }).build?.capsHit).toEqual([]);
  });

  it("counts unresolved and external imports, drops a self import and a re-export of a missing module", () => {
    write(root, "src/self.ts", "import { x } from './self';\nexport const x = 1;\n");
    write(root, "src/barrel.ts", "export { gone } from './gone';\nexport * from './also-gone';\n");
    write(root, "src/dep.ts", "import React from 'react';\n");
    write(root, "pkg/__init__.py", "");
    write(root, "pkg/m.py", "from .missing import y\nimport numpy\nfrom pkg import m\n");
    const r = build();
    expect(r.stats.refs).toBe(0);
    // ./gone, ./also-gone, .missing are unresolved; react, numpy are dependencies.
    expect(r.stats.unresolved).toBe(3);
    expect(r.stats.external).toBe(2);
    const n = codeNeighbours(db, { repoKey: KEY, symbols: ["gone"] });
    expect(n.items).toEqual([
      expect.objectContaining({ path: null, note: "no exported symbol of that name in the index" }),
    ]);
  });

  it("survives a stored import or ref whose names are not a JSON array", () => {
    write(root, "src/a.ts", "export const a = 1;\n");
    write(root, "src/b.ts", "import { a } from './a';\n");
    build();
    db.prepare("UPDATE code_import SET names = 'oops' WHERE from_path = 'src/b.ts'").run();
    // A rebuild reads the stored raw imports again (no file is re-read: the hashes match).
    const r = build({ full: true });
    expect(r.stats.extracted).toBe(0);
    expect(r.stats.refs).toBe(1);
    // Names unreadable → no names: a path query still lists the importer.
    expect(codeNeighbours(db, { repoKey: KEY, paths: ["src/a.ts"] }).items[0]?.callersTotal).toBe(
      1,
    );
    db.prepare("UPDATE code_ref SET names = '{\"a\":1}'").run();
    expect(
      codeNeighbours(db, { repoKey: KEY, symbols: ["src/a.ts#a"] }).items[0]?.callersTotal,
    ).toBe(0);
    db.prepare("UPDATE code_ref SET names = 'still not json'").run();
    expect(codeNeighbours(db, { repoKey: KEY, paths: ["src/a.ts"] }).items[0]?.callersTotal).toBe(
      1,
    );
  });

  it("links a test by name to the module in its mirrored directory when the stem is ambiguous", () => {
    write(root, "src/api/client.ts", "export const c = 1;\n");
    write(root, "src/db/client.ts", "export const c = 2;\n");
    write(root, "lib/util.ts", "export const u = 1;\n");
    write(root, "app/util.ts", "export const u = 2;\n");
    write(root, "test/api/client.test.ts", "// by name\n");
    write(root, "test/util.test.ts", "// ambiguous, no mirror\n");
    build();
    const n = codeNeighbours(db, {
      repoKey: KEY,
      paths: ["src/api/client.ts", "src/db/client.ts", "lib/util.ts", "app/util.ts"],
    });
    expect(n.items.map((i) => [i.path, i.tests.map((t) => t.path)])).toEqual([
      ["src/api/client.ts", ["test/api/client.test.ts"]],
      ["src/db/client.ts", []],
      ["lib/util.ts", []],
      ["app/util.ts", []],
    ]);
  });
});

describe("build: walk and .gitattributes", () => {
  it("records an empty full build for a checkout that does not exist", () => {
    const r = buildCodeIndex(db, {
      repoKey: KEY,
      repo: "edges",
      repoRoot: join(root, "nope"),
      commit: null,
    });
    expect(r).toMatchObject({ mode: "full", commit: null });
    expect(r.stats.files).toBe(0);
    expect(codeNeighbours(db, { repoKey: KEY, paths: ["x.ts"], commit: "c1" }).status).toBe(
      "unknown",
    );
  });

  it("skips symlinks, and honours .gitattributes globs, negations and comments", () => {
    write(root, "src/real.ts", "export const r = 1;\n");
    symlinkSync(join(root, "src/real.ts"), join(root, "src/link.ts"));
    write(root, "gen/a.ts", "export const g = 1;\n");
    write(root, "gen/keep.ts", "export const k = 1;\n");
    write(root, "deep/x/y/out.ts", "export const o = 1;\n");
    write(root, "src/q1.ts", "export const q = 1;\n");
    write(root, "src/q22.ts", "export const q = 2;\n");
    write(root, "lib/one.ts", "export const one = 1;\n");
    write(root, "lib/v.ts", "export const v = 1;\n");
    write(
      root,
      ".gitattributes",
      [
        "# a comment",
        "!negated linguist-generated",
        "single-field-line",
        "/gen/ linguist-generated",
        "gen/keep.ts -linguist-generated",
        "deep/**/out.ts linguist-generated=true",
        "src/q?.ts linguist-vendored",
        "lib/** linguist-generated",
        "lib/v.ts linguist-generated=false",
        "*.ts text eol=lf",
      ].join("\n"),
    );
    const r = build();
    const files = (
      db.prepare("SELECT path FROM code_index_file ORDER BY path").all() as Array<{ path: string }>
    ).map((x) => x.path);
    expect(files).toEqual(["gen/keep.ts", "lib/v.ts", "src/q22.ts", "src/real.ts"]);
    expect(r.stats.skippedGenerated).toBe(4);
  });

  it("drops a file a full rebuild no longer finds", () => {
    write(root, "a.ts", "export const a = 1;\n");
    write(root, "b.ts", "export const b = 1;\n");
    build();
    unlinkSync(join(root, "b.ts"));
    const r = build({ full: true });
    expect(r.stats).toMatchObject({ files: 1, removed: 1, extracted: 0 });
  });
});

describe("build: incremental edge cases (injected diff)", () => {
  const diffOf =
    (changed: string[], removed: string[] = []) =>
    () => ({ changed, removed });

  it("handles a vanished, oversized, generated, hidden, non-code and escaping changed path", () => {
    write(root, "src/a.ts", "export const a = 1;\n");
    write(root, "src/b.ts", "export const b = 1;\n");
    write(root, "src/big.ts", "export const big = 1;\n");
    build({ maxBytesPerFile: 1000 });
    unlinkSync(join(root, "src/b.ts"));
    write(root, "src/big.ts", `export const big = "${"x".repeat(2000)}";\n`);
    write(root, "src/new.generated.ts", "export const g = 1;\n");
    write(root, ".hidden/x.ts", "export const h = 1;\n");
    write(root, "README.md", "# readme\n");
    const r = build({
      commit: "c2",
      maxBytesPerFile: 1000,
      changedPaths: diffOf([
        "src/b.ts",
        "src/big.ts",
        "src/new.generated.ts",
        ".hidden/x.ts",
        "README.md",
        "/abs.ts",
        "src/a.ts",
      ]),
    });
    expect(r.mode).toBe("incremental");
    expect(r.stats).toMatchObject({
      files: 1,
      removed: 2,
      extracted: 0,
      skippedGenerated: 1,
      capsHit: ["maxBytesPerFile"],
    });
  });

  it("drops a stored file that a new .gitattributes marks vendored", () => {
    write(root, "src/a.ts", "export const a = 1;\n");
    write(root, "vendor-ish/v.ts", "export const v = 1;\n");
    build();
    write(root, ".gitattributes", "vendor-ish/** linguist-vendored\n");
    const r = build({ commit: "c2", changedPaths: diffOf([".gitattributes", "vendor-ish/v.ts"]) });
    expect(r.stats).toMatchObject({ files: 1, removed: 1, skippedGenerated: 1 });
  });

  it("re-reads changed and removed alias configs, and ignores one under a skipped directory", () => {
    write(root, "src/use.ts", "import { s } from '@acme/shared';\nimport { t } from '@t/x';\n");
    write(root, "packages/shared/package.json", '{"name":"@acme/shared"}');
    write(root, "packages/shared/src/index.ts", "export const s = 1;\n");
    write(root, "src/x.ts", "export const t = 1;\n");
    write(root, "tsconfig.json", '{"compilerOptions":{"paths":{"@t/*":["src/*"]}}}');
    expect(build().stats.refs).toBe(2);
    // The workspace package is renamed, the tsconfig is deleted, and a package.json lands in
    // node_modules (never an alias).
    write(root, "packages/shared/package.json", '{"name":"@acme/renamed"}');
    unlinkSync(join(root, "tsconfig.json"));
    write(root, "node_modules/@acme/shared/package.json", '{"name":"@acme/shared"}');
    const r = build({
      commit: "c2",
      changedPaths: diffOf(
        ["packages/shared/package.json", "node_modules/@acme/shared/package.json"],
        ["tsconfig.json", "src/never-indexed.ts"],
      ),
    });
    expect(r.stats).toMatchObject({ refs: 0, unresolved: 0, external: 2, removed: 0 });
    expect(db.prepare("SELECT alias FROM code_index_alias").all()).toEqual([
      { alias: "@acme/renamed" },
    ]);
  });

  it("stops adding new files at maxFiles on an incremental build, keeping the stored ones", () => {
    write(root, "a.ts", "export const a = 1;\n");
    write(root, "b.ts", "export const b = 1;\n");
    build();
    write(root, "c.ts", "export const c = 1;\n");
    write(root, "a.ts", "export const a = 2;\n");
    const r = build({ commit: "c2", maxFiles: 2, changedPaths: diffOf(["c.ts", "a.ts"]) });
    expect(r.stats).toMatchObject({ files: 2, extracted: 1, capsHit: ["maxFiles"] });
    // A capped build is never the base of an incremental one: the next build walks.
    const next = build({ commit: "c3", changedPaths: () => ({ changed: [], removed: [] }) });
    expect(next.mode).toBe("full");
    expect(next.stats.files).toBe(3);
  });

  it("walks the tree when the diff cannot be read", () => {
    write(root, "a.ts", "export const a = 1;\n");
    build();
    write(root, "b.ts", "export const b = 1;\n");
    const r = build({ commit: "c2", changedPaths: () => null });
    expect(r.mode).toBe("full");
    expect(r.stats.files).toBe(2);
  });
});

describe("git helpers", () => {
  it("parses deletes, renames and modifications; returns null outside a repo", () => {
    write(root, "a.ts", "export const a = 1;\n");
    write(root, "b.ts", "export const b = 'a fairly long line so the rename is detected';\n");
    write(root, "c.ts", "export const c = 1;\n");
    git(root, "init", "-q", "-b", "main");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "one");
    const c1 = git(root, "rev-parse", "HEAD");
    expect(gitHead(root)).toBe(c1);
    unlinkSync(join(root, "a.ts"));
    git(root, "mv", "b.ts", "moved.ts");
    write(root, "c.ts", "export const c = 2;\n");
    write(root, "d.ts", "export const d = 1;\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "two");
    const c2 = git(root, "rev-parse", "HEAD");
    const d = gitChangedPaths(root, c1, c2);
    expect(d).not.toBeNull();
    expect(d!.removed.sort()).toEqual(["a.ts", "b.ts"]);
    expect(d!.changed.sort()).toEqual(["c.ts", "d.ts", "moved.ts"]);
    const outside = mkdtempSync(join(tmpdir(), "code-index-nogit-"));
    try {
      expect(gitHead(outside)).toBeNull();
      expect(gitChangedPaths(outside, c1, c2)).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("query: barrels, duplicates and notes", () => {
  it("follows a barrel cycle once, counts a repeated importer once, and lists a test through a barrel", () => {
    write(root, "src/m.ts", "export function f() {}\nexport * from './barrel';\n");
    write(root, "src/barrel.ts", "export * from './m';\nexport { f as g } from './m';\n");
    write(root, "src/outer.ts", "export * from './barrel';\n");
    write(
      root,
      "src/use.ts",
      "import { g } from './barrel';\nimport { f } from './outer';\nimport { f as again } from './outer';\n",
    );
    write(root, "src/zed.ts", "import { f } from './m';\n");
    write(root, "test/use-it.test.ts", "import { f } from '../src/barrel';\n");
    build();
    const item = codeNeighbours(db, { repoKey: KEY, symbols: ["src/m.ts#f"], perItem: 10 })
      .items[0]!;
    expect(item.callers.map((c) => `${c.path} ${c.via} ${c.through ?? "-"}`)).toEqual([
      "src/use.ts barrel src/barrel.ts",
      "src/zed.ts name -",
    ]);
    expect(item.tests).toEqual([
      { path: "test/use-it.test.ts", via: "barrel", through: "src/barrel.ts" },
    ]);
  });

  it("gives a note for each query with no answer", () => {
    write(root, "src/a.ts", "function hidden() {}\nexport const shown = 1;\n");
    write(root, "src/anon.ts", "export default 1;\n");
    write(root, "src/plain.ts", "const x = 1;\n");
    write(root, "src/user.ts", "import d from './plain';\n");
    write(
      root,
      "src/fwd.js",
      "const { shown } = require('./a');\nmodule.exports = { shown, onlyHere };\n",
    );
    build();
    const n = codeNeighbours(db, {
      repoKey: KEY,
      paths: ["", "./src/a.ts", "src/a.ts", "src/gone.ts", "README.md"],
      symbols: [
        " ",
        "src/a.ts#",
        "src/missing.ts#x",
        "src/a.ts#hidden",
        "src/a.ts#nothing",
        "src/plain.ts#default",
        "onlyHere",
      ],
    });
    expect(n.items.map((i) => `${i.query} -> ${i.note}`)).toEqual([
      "src/a.ts -> null",
      "src/gone.ts -> not in the index (skipped, or not in the tree at the build commit)",
      "README.md -> not a file the index reads (TypeScript, JavaScript and Python only)",
      "src/missing.ts#x -> module not in the index",
      "src/a.ts#hidden -> not exported (no other module can import it by name)",
      "src/a.ts#nothing -> no top-level symbol of that name in the index",
      "src/plain.ts#default -> null",
      "onlyHere -> null",
    ]);
    // `#default` with no recorded default export still answers by the default import.
    expect(n.items[6]).toMatchObject({ exportedAs: "default", callersTotal: 1 });
    // A name only an export list passes on is answered at that list.
    expect(n.items[7]).toMatchObject({ path: "src/fwd.js", exportedAs: "onlyHere" });
  });

  it("lists the first definitions of a name exported by many modules, and says how many", () => {
    for (const p of ["a", "b", "c", "d"]) write(root, `src/${p}.ts`, "export const dup = 1;\n");
    build();
    const n = codeNeighbours(db, { repoKey: KEY, symbols: ["dup"] });
    expect(n.items.map((i) => i.path)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(n.items[0]!.note).toBe("4 modules export this name; the first 3 are listed");
  });

  it("returns a repo's stats by key, and nothing for an unknown key", () => {
    write(root, "a.ts", "export const a = 1;\n");
    build();
    expect(codeIndexStats(db, KEY).map((r) => r.repo)).toEqual(["edges"]);
    expect(codeIndexStats(db, repoKey("/repos/nope"))).toEqual([]);
    expect(codeIndexStats(db)).toHaveLength(1);
  });
});

describe("CLI: memory index (text output and bad input)", () => {
  let dir: string;
  let out = "";
  let err = "";
  const prev: Record<string, string | undefined> = {};
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "code-index-edges-cli-"));
    for (const k of ["MEMORY_DB", "MEMORY_AUDIT_OFF"]) prev[k] = process.env[k];
    process.env["MEMORY_DB"] = join(dir, "lore.db");
    process.env["MEMORY_AUDIT_OFF"] = "1";
    out = "";
    err = "";
    vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => {
      out += c.toString();
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array) => {
      err += c.toString();
      return true;
    });
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

  it("says there is no index yet on an empty database, as text and as JSON", async () => {
    expect(await run("index", "stats")).toBe(0);
    expect(out).toBe("No code index yet (run `memory index build --repo-root <abs>`).\n");
    out = "";
    expect(await run("index", "stats", "--json")).toBe(0);
    expect(JSON.parse(out)).toEqual({ repos: [] });
    out = "";
    expect(await run("index", "neighbors", "--canonical", "/repos/none", "--json")).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ status: "missing", items: [], build: null });
  });

  it("rejects a relative root, a bad number and a neighbours call with no repo", async () => {
    expect(await run("index", "build", "--repo-root", "relative/dir")).toBe(2);
    expect(err).toMatch(/requires --repo-root <absolute-path>/);
    expect(await run("index", "build", "--repo-root", root, "--max-files", "0")).toBe(2);
    expect(err).toMatch(/--max-files must be a positive integer/);
    expect(await run("index", "build", "--repo-root", root, "--max-bytes-per-file", "1.5")).toBe(2);
    expect(await run("index", "neighbours")).toBe(2);
    expect(err).toMatch(/requires --repo-root <abs> or --canonical <c>/);
    expect(await run("index", "neighbours", "--canonical", "/x", "--per-item", "nope")).toBe(2);
    expect(await run("index")).toBe(2);
  });

  it("builds from a non-git checkout as text, then renders neighbours and stats as text", async () => {
    write(root, "src/m.ts", "export function f() {}\n");
    write(root, "src/barrel.ts", "export { f } from './m';\n");
    write(root, "src/use.ts", "import { f } from './barrel';\n");
    write(root, "src/direct.ts", "import { f } from './m';\n");
    write(root, "test/direct.test.ts", "import '../src/direct';\n");
    write(root, "test/m.test.ts", "import { f } from '../src/m';\n");
    // No --canonical and no git remote: the realpath is the canonical; no git: no commit.
    expect(await run("index", "build", "--repo-root", root, "--max-files", "50")).toBe(0);
    expect(out).toMatch(/^CODE INDEX for '[^']+' \(full\) at an unknown commit, built /);
    expect(out).toMatch(/files: {4}6 \(ts 6\), 2 test files/);
    expect(out).not.toMatch(/caps hit/);
    out = "";
    expect(
      await run(
        "index",
        "neighbours",
        "--repo-root",
        root,
        "--symbols",
        "src/m.ts#f",
        "--symbols",
        "src/m.ts#nope",
        "--paths",
        "src/gone.ts",
      ),
    ).toBe(0);
    expect(out.split("\n")).toEqual([
      "code index: unknown (built at ?, " +
        out.split("\n")[0]!.split("built at ?, ")[1]!.split(")")[0]! +
        "); by import text (index), a lower bound",
      "  src/gone.ts: not in the index (skipped, or not in the tree at the build commit)",
      "  f (src/m.ts): 2 importing files (1 with a test), 1 test",
      "    caller src/direct.ts:1",
      "    caller src/use.ts:1 through src/barrel.ts (no test imports it)",
      "    test   test/m.test.ts (import)",
      "  nope (src/m.ts): no top-level symbol of that name in the index",
      "",
    ]);
    out = "";
    expect(await run("index", "stats", "--repo-root", root)).toBe(0);
    expect(out).toMatch(/CODE INDEX for .* \(full\)/);
    out = "";
    expect(await run("index", "stats", "--canonical", "/repos/elsewhere")).toBe(0);
    expect(out).toMatch(/No code index yet/);
  });

  it("names the cap and the partial count in text output", async () => {
    write(root, "a.ts", "export const a = 1;\n");
    write(root, "b.ts", "import { a } from './a';\n");
    expect(
      await run(
        "index",
        "build",
        "--repo-root",
        root,
        "--canonical",
        "/repos/capped",
        "--commit",
        "abcdef0123456789",
        "--max-files",
        "1",
      ),
    ).toBe(0);
    expect(out).toMatch(/at abcdef012345, built/);
    expect(out).toMatch(/caps hit: maxFiles/);
    out = "";
    expect(
      await run(
        "index",
        "neighbours",
        "--canonical",
        "/repos/capped",
        "--paths",
        "a.ts",
        "--commit",
        "abcdef0123456789",
      ),
    ).toBe(0);
    expect(out).toMatch(/^code index: fresh \(built at abcdef012345, /);
    expect(out).toMatch(/partial: the build hit its maxFiles cap/);
    expect(out).toMatch(/ {2}a\.ts: 0 importing files \(0 with a test\), 0 tests/);
  });

  it("takes the canonical from the checkout's git remote", async () => {
    write(root, "a.ts", "export const a = 1;\n");
    git(root, "init", "-q", "-b", "main");
    git(root, "remote", "add", "origin", "https://example.com/acme/widgets.git");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "one");
    expect(await run("index", "build", "--repo-root", root, "--json")).toBe(0);
    const rec = JSON.parse(out);
    expect(rec.repo).toBe("widgets");
    expect(rec.commit).toBe(git(root, "rev-parse", "HEAD"));
    out = "";
    expect(
      await run("index", "stats", "--canonical", "https://example.com/acme/widgets.git", "--json"),
    ).toBe(0);
    expect(JSON.parse(out).repos).toHaveLength(1);
  });
});

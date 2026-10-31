/**
 * GATE INTEGRITY classifier (services/testIntegrity.ts): the one implementation the
 * runner's integrity GATE row and the server-side `test-modified` risk annotation share.
 *
 *  1. test paths per stack (and the additive GAFFER_TEST_PATH_RE);
 *  2. every skip/focus marker class, on ADDED lines only, not in comments;
 *  3. deleted / renamed test files and test-runner config from name-status;
 *  4. gate scripts changed or removed in package.json, plus any change (an ADDED
 *     pre/post hook included) in the scripts a gate script reaches; a brand-new gate
 *     script is fine;
 *  5. gate command resolution against the base commit's package.json;
 *  6. collectTestIntegrity against a real git repo (delete, rename, skip, script).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  addedSkipMarkers,
  analyzeTestIntegrity,
  changedGateScripts,
  collectTestIntegrity,
  extraTestPathRe,
  gateScriptNamesOf,
  hasIntegrityFindings,
  hiddenIndexPaths,
  integrityItems,
  isTestPath,
  parseNameStatusZ,
  parseScriptInvocation,
  resolveGateCommand,
  scriptRefs,
  summarizeIntegrity,
  type IntegrityGit,
} from "../src/services/testIntegrity.js";

/** A one-file patch adding `lines` to `path`. */
function patchAdding(path: string, lines: string[], startLine = 1): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${startLine},0 +${startLine},${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
    "",
  ].join("\n");
}

describe("isTestPath", () => {
  it.each([
    "src/a.test.ts",
    "src/a.spec.tsx",
    "web/b.test.mjs",
    "pkg/x_test.go",
    "tests/test_api.py",
    "app/test_models.py",
    "app/models_test.py",
    "app/tests.py", // Django's default test module (unittest's `test*.py` glob)
    "pkg/tests.py",
    "testsuite.py",
    "spec/user_spec.rb",
    "src/test/java/FooTest.java",
    "src/FooTests.cs",
    "tests/UnitTest.php",
    "test/thing_test.exs",
    "runner/test/dod.test.sh",
    "__tests__/x.js",
    "test/fixtures/data.json",
    "e2e/login.ts",
  ])("treats %s as a test path", (p) => {
    expect(isTestPath(p)).toBe(true);
  });

  it.each(["src/a.ts", "src/testing-utils.ts", "README.md", "src/contest.py", "latest/x.ts"])(
    "does not treat %s as a test path",
    (p) => {
      expect(isTestPath(p)).toBe(false);
    },
  );

  it("an operator's extra pattern only widens the set; a malformed one is ignored", () => {
    const extra = extraTestPathRe("^checks/");
    expect(isTestPath("checks/run.ts", extra)).toBe(true);
    expect(isTestPath("src/a.test.ts", extra)).toBe(true);
    expect(extraTestPathRe("([")).toBeNull();
    expect(extraTestPathRe("")).toBeNull();
  });
});

describe("addedSkipMarkers: every marker class", () => {
  it.each([
    ["src/a.test.ts", "  it.skip('adds', () => {", "it.skip"],
    ["src/a.test.ts", "describe.only('suite', () => {", "describe.only"],
    ["src/a.test.ts", "test.todo('later')", "test.todo"],
    ["src/a.test.ts", "it.skipIf(process.env.CI)('x', () => {})", "it.skipIf"],
    ["e2e/a.spec.ts", "test.fixme('flaky', async () => {})", "test.fixme"],
    ["src/a.test.js", "xit('adds', () => {", "xit"],
    ["src/a.test.js", "xdescribe('suite', () => {", "xdescribe"],
    ["src/a.test.js", "fit('only this', () => {", "fit"],
    ["tests/test_x.py", "@pytest.mark.skip(reason='later')", "@pytest.mark.skip"],
    ["tests/test_x.py", "@pytest.mark.skipif(True, reason='x')", "@pytest.mark.skipif"],
    ["tests/test_x.py", "@pytest.mark.xfail", "@pytest.mark.xfail"],
    ["tests/test_x.py", "    pytest.skip('nope')", "pytest.skip()"],
    ["tests/test_x.py", "@unittest.skip('later')", "@unittest.skip"],
    ["tests/test_x.py", "        self.skipTest('later')", "skipTest()"],
    ["app/tests.py", "@pytest.mark.skip(reason='later')", "@pytest.mark.skip"],
    ["app/tests.py", "    @unittest.skip('later')", "@unittest.skip"],
    ["pkg/x_test.go", '\tt.Skip("flaky")', "t.Skip"],
    ["pkg/x_test.go", '\tt.Skipf("%s", why)', "t.Skipf"],
    ["src/lib.rs", "#[ignore]", "#[ignore]"],
    ["tests/it.rs", '#[ignore = "slow"]', "#[ignore]"],
    ["src/test/java/FooTest.java", "  @Disabled", "@Disabled"],
    ["src/test/kotlin/FooTest.kt", "  @Ignore", "@Ignore"],
    ["tests/FooTests.cs", '[Fact(Skip = "later")]', "Skip"],
    ["spec/user_spec.rb", "  xit 'works' do", "xit"],
    ["spec/user_spec.rb", "  pending 'later'", "pending"],
    ["tests/UnitTest.php", "$this->markTestSkipped('later');", "markTestSkipped"],
    ["test/thing_test.exs", "  @tag :skip", "@tag :skip"],
    // Behind a modifier (vitest / jest).
    ["src/a.test.ts", "it.concurrent.skip('x', async () => {})", "it.concurrent.skip"],
    ["src/a.test.ts", "describe.sequential.only('s', () => {", "describe.sequential.only"],
    ["src/a.test.ts", "it.runIf(false)('x', () => {})", "it.runIf"],
    // node:test options and runtime skips (node --test is a first-class stack).
    ["test/a.test.js", 'test("a", { skip: true }, () => {', "{ skip: … } option"],
    ["test/a.test.js", "test('a', { todo: 'later' }, () => {", "{ todo: … } option"],
    ["test/a.test.js", 'describe("s", { skip: !process.env.DB }, () => {', "{ skip: … } option"],
    ["test/a.test.js", "it('a', { only: true }, () => {", "{ only: … } option"],
    ["test/a.test.js", "  skip: true,", "{ skip: … } option"],
    ["test/a.test.js", 'test("a", (t) => { t.skip("later"); });', "t.skip()"],
    ["test/a.test.js", "  t.todo();", "t.todo()"],
    ["test/a.test.js", "    this.skip();", "this.skip()"],
    ["src/a.test.ts", "it('x', (ctx) => { ctx.skip(); })", "ctx.skip()"],
    // Code after a comment is still code.
    ["test/a.test.js", '/**/ test.skip("a", () => {});', "test.skip"],
    ["test/a.test.js", '/* note */ it.only("a", () => {});', "it.only"],
    ["test/a.test.js", ' * docs */ test.skip("a", () => {});', "test.skip"],
    ["test/a.test.js", 'const u = "http://x"; test.skip("a", () => {});', "test.skip"],
    ["test/a.test.js", 'const r = /[/*]/; test.skip("a", () => {});', "test.skip"],
    ["tests/test_x.py", "x = '#'; pytest.skip('nope')", "pytest.skip()"],
  ])("%s: %s → %s", (path, line, marker) => {
    const found = addedSkipMarkers(patchAdding(path, [line], 7));
    expect(found).toEqual([{ path, marker, line: 7 }]);
  });

  // Other spellings of the same markers: bracket access, a chained `.skip` on its own
  // line, destructuring, module-level pytest marks, raised skips, a Go build constraint
  // that drops the whole test file.
  it.each([
    ["test/a.test.js", 'test["skip"]("a", () => {});', "test.skip"],
    ["test/a.test.js", "it['only']('a', () => {});", "it.only"],
    ["test/a.test.js", "describe.concurrent[`skip`]('s', () => {", "describe.concurrent.skip"],
    ["test/a.test.js", "  .skip('a', () => {", ".skip (chained)"],
    ["test/a.test.js", "  ?.only('a', () => {", ".only (chained)"],
    ["test/a.test.js", "const { skip } = test;", "{ skip } = test"],
    ["test/a.test.js", "const { only: o } = it;", "{ only } = it"],
    ["tests/test_x.py", "pytestmark = pytest.mark.skip(reason='later')", "pytest.mark.skip"],
    ["tests/test_x.py", "pytestmark = [pytest.mark.xfail]", "pytest.mark.xfail"],
    ["tests/test_x.py", "@mark.skip", "pytest.mark.skip"],
    ["tests/test_x.py", "skip_all = unittest.skip('later')", "unittest.skip"],
    ["tests/test_x.py", "    raise unittest.SkipTest('later')", "SkipTest"],
    ["tests/test_x.py", "    raise SkipTest('later')", "SkipTest"],
    ["tests/test_x.py", "np = pytest.importorskip('not_installed')", "pytest.importorskip()"],
    ["tests/test_x.py", "__test__ = False", "__test__ = False"],
    ["pkg/x_test.go", "//go:build ignore", "go build constraint"],
    ["pkg/x_test.go", "// +build ignore", "go build constraint"],
  ])("another spelling — %s: %s → %s", (path, line, marker) => {
    const found = addedSkipMarkers(patchAdding(path, [line], 7));
    expect(found).toEqual([{ path, marker, line: 7 }]);
  });

  it("the new spellings still ignore comments, app code and look-alikes", () => {
    expect(
      addedSkipMarkers(
        patchAdding("tests/test_x.py", [
          "# pytestmark = pytest.mark.skip",
          "remark.skip = 1",
          "x = SkipTestsConfig()",
        ]),
      ),
    ).toEqual([]);
    expect(
      addedSkipMarkers(
        patchAdding("test/a.test.js", [
          "// test['skip']('a')",
          "const { skip } = options;",
          "rows.skip(2)",
          "const o = { only: 1 };",
        ]),
      ),
    ).toEqual([]);
    // A build constraint in app code is not a test marker.
    expect(addedSkipMarkers(patchAdding("pkg/x.go", ["//go:build linux"]))).toEqual([]);
  });

  it("ignores REMOVED lines (deleting a .skip re-enables a test)", () => {
    const patch = [
      "diff --git a/src/a.test.ts b/src/a.test.ts",
      "--- a/src/a.test.ts",
      "+++ b/src/a.test.ts",
      "@@ -3 +3 @@",
      "-it.skip('adds', () => {",
      "+it('adds', () => {",
      "",
    ].join("\n");
    expect(addedSkipMarkers(patch)).toEqual([]);
  });

  it("ignores comments, non-test files and look-alikes", () => {
    expect(addedSkipMarkers(patchAdding("src/a.test.ts", ["// it.skip('x')"]))).toEqual([]);
    expect(addedSkipMarkers(patchAdding("tests/test_x.py", ["# @pytest.mark.skip"]))).toEqual([]);
    // A marker inside a comment, wherever the comment sits on the line, skips nothing.
    expect(
      addedSkipMarkers(
        patchAdding("src/a.test.ts", [
          "/* it.skip('x') */",
          " * use test.skip sparingly",
          "it('a', () => {}); // TODO: it.only while debugging",
          "x(); /* test.skip */ y();",
          "x = 1 # pytest.skip()",
        ]),
      ),
    ).toEqual([]);
    expect(addedSkipMarkers(patchAdding("tests/test_x.py", ["x = 1  # pytest.skip()"]))).toEqual(
      [],
    );
    // Look-alikes: a query's numeric skip, a falsy option, another object's .skip().
    expect(
      addedSkipMarkers(
        patchAdding("src/a.test.ts", [
          "db.find({ skip: 10, take: 5 })",
          "test('a', { skip: false }, () => {})",
          "stream.skip(3)",
          "cursor.t.skip(1)",
        ]),
      ),
    ).toEqual([]);
    // Not a test file: a `.skip` in app code is not a test marker.
    expect(addedSkipMarkers(patchAdding("src/app.ts", ["list.skip(2)", "it.only()"]))).toEqual([]);
    // `transmit(` / `submit(` are not `xit(` / `fit(`.
    expect(
      addedSkipMarkers(patchAdding("src/a.test.ts", ["transmit(x)", "submit(y)", "obj.fit(z)"])),
    ).toEqual([]);
  });

  it("tracks line numbers across hunks and files, and stops at a deleted file", () => {
    const patch = [
      "diff --git a/src/a.test.ts b/src/a.test.ts",
      "--- a/src/a.test.ts",
      "+++ b/src/a.test.ts",
      "@@ -1,2 +1,3 @@",
      " import x",
      "+it.only('a', () => {})",
      " more",
      "@@ -20 +21 @@",
      "+xit('b', () => {})",
      "diff --git a/src/gone.test.ts b/src/gone.test.ts",
      "--- a/src/gone.test.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-it('c')",
      "",
    ].join("\n");
    expect(addedSkipMarkers(patch)).toEqual([
      { path: "src/a.test.ts", marker: "it.only", line: 2 },
      { path: "src/a.test.ts", marker: "xit", line: 21 },
    ]);
  });
});

describe("name-status: deletes, renames, config", () => {
  it("parses -z output, flags deleted/renamed tests and touched test config", () => {
    const ns = parseNameStatusZ(
      [
        "M",
        "src/a.ts",
        "D",
        "src/old.test.ts",
        "R087",
        "test/b.test.ts",
        "test/b.ts",
        "R100",
        "src/c.ts",
        "src/d.ts",
        "M",
        "vitest.config.ts",
        "A",
        "jest.config.js",
        "D",
        "tests/conftest.py",
        "",
      ].join("\0"),
    );
    expect(ns).toHaveLength(7);
    const f = analyzeTestIntegrity({ nameStatus: ns, patch: "" });
    expect(f.deleted).toEqual(["src/old.test.ts", "tests/conftest.py"]);
    expect(f.renamed).toEqual([{ from: "test/b.test.ts", to: "test/b.ts" }]);
    // An ADDED config is not flagged (a greenfield scaffold adds every config).
    expect(f.configs).toEqual([
      { path: "vitest.config.ts", change: "modified" },
      { path: "tests/conftest.py", change: "deleted" },
    ]);
    expect(hasIntegrityFindings(f)).toBe(true);
    expect(summarizeIntegrity(f)).toContain(
      "deleted 2 test files (src/old.test.ts, tests/conftest.py)",
    );
    expect(integrityItems(f)).toContain("renamed test file test/b.test.ts → test/b.ts");
  });

  it("flags a deleted Django app/tests.py (unittest's default test*.py glob)", () => {
    const f = analyzeTestIntegrity({
      nameStatus: [
        { status: "M", path: "app/models.py" },
        { status: "D", path: "app/tests.py" },
      ],
      patch: "",
    });
    expect(f.deleted).toEqual(["app/tests.py"]);
    expect(summarizeIntegrity(f)).toContain("deleted 1 test file (app/tests.py)");
  });

  it("flags a package-manager rc file on ADD, as well as modify, delete and rename", () => {
    const f = analyzeTestIntegrity({
      nameStatus: [
        { status: "A", path: ".npmrc" },
        { status: "A", path: "packages/web/.npmrc" },
        { status: "M", path: ".yarnrc.yml" },
        { status: "D", path: ".yarnrc" },
        { status: "R100", from: "notes.txt", path: "bunfig.toml" },
        { status: "A", path: "src/npmrc.md" }, // not an rc name
        { status: "A", path: "vitest.config.ts" }, // added test config stays unflagged
      ],
      patch: "",
    });
    expect(f.configs).toEqual([
      { path: ".npmrc", change: "added" },
      { path: "packages/web/.npmrc", change: "added" },
      { path: ".yarnrc.yml", change: "modified" },
      { path: ".yarnrc", change: "deleted" },
      { path: "bunfig.toml", change: "added" },
    ]);
    expect(hasIntegrityFindings(f)).toBe(true);
    expect(summarizeIntegrity(f)).toContain(
      "touched package-manager config (.npmrc added, packages/web/.npmrc added, .yarnrc.yml modified, +2 more)",
    );
    expect(integrityItems(f)).toContain("added package-manager config .npmrc");
  });

  it("a clean change has no findings and a reassuring summary", () => {
    const f = analyzeTestIntegrity({
      nameStatus: [
        { status: "M", path: "src/a.ts" },
        { status: "A", path: "src/a.test.ts" },
      ],
      patch: patchAdding("src/a.test.ts", ["it('adds', () => {})"]),
    });
    expect(hasIntegrityFindings(f)).toBe(false);
    expect(summarizeIntegrity(f)).toMatch(/no test files deleted/);
  });

  it("an incomplete scan is itself a finding (fail toward a human)", () => {
    const f = analyzeTestIntegrity({ nameStatus: [], patch: "", incomplete: ["git failed"] });
    expect(hasIntegrityFindings(f)).toBe(true);
  });
});

describe("changedGateScripts", () => {
  const base = JSON.stringify({ scripts: { test: "vitest run", lint: "eslint .", build: "tsc" } });

  it("flags a changed and a removed gate script, not an unrelated or added one", () => {
    const head = JSON.stringify({
      scripts: { test: "vitest run src/safe", build: "tsc -b", "test:new": "x" },
    });
    expect(changedGateScripts("package.json", base, head)).toEqual([
      { file: "package.json", script: "test", change: "changed" },
      { file: "package.json", script: "lint", change: "removed" },
    ]);
  });

  it("covers scripts the gate commands name, and treats a new package.json as nothing to weaken", () => {
    const b = JSON.stringify({ scripts: { "verify-fast": "x" } });
    const h = JSON.stringify({ scripts: { "verify-fast": "true" } });
    expect(changedGateScripts("p/package.json", b, h)).toHaveLength(1); // verify* by convention
    const b2 = JSON.stringify({ scripts: { gate: "vitest" } });
    const h2 = JSON.stringify({ scripts: { gate: "true" } });
    expect(changedGateScripts("package.json", b2, h2)).toEqual([]);
    expect(changedGateScripts("package.json", b2, h2, ["gate"])).toHaveLength(1);
    expect(changedGateScripts("package.json", null, h2)).toEqual([]);
  });

  it("flags an ADDED pre/post hook of a gate script (npm runs it around the gate)", () => {
    const b = JSON.stringify({ scripts: { test: "node --test" } });
    const h = JSON.stringify({
      scripts: {
        pretest: "mv test/a.test.js .stash/",
        test: "node --test",
        posttest: "mv .stash/a.test.js test/",
      },
    });
    expect(changedGateScripts("package.json", b, h)).toEqual([
      { file: "package.json", script: "pretest", change: "added" },
      { file: "package.json", script: "posttest", change: "added" },
    ]);
  });

  it("flags a change anywhere in the closure of scripts the gate reaches", () => {
    const b = JSON.stringify({
      scripts: { test: "npm run unit", unit: "node --test", other: "x" },
    });
    expect(
      changedGateScripts(
        "package.json",
        b,
        JSON.stringify({ scripts: { test: "npm run unit", unit: "node -e 0", other: "y" } }),
      ),
    ).toEqual([{ file: "package.json", script: "unit", change: "changed" }]);
    // run-s / npm-run-all words and globs, pnpm shorthand, an added hook on a reached script
    const b2 = JSON.stringify({
      scripts: {
        check: "run-s lint:* types",
        "lint:js": "eslint .",
        types: "tsc",
        verify: "pnpm build",
        build: "tsc -b",
      },
    });
    const h2 = JSON.stringify({
      scripts: {
        check: "run-s lint:* types",
        "lint:js": "true",
        "lint:extra": "echo",
        types: "tsc",
        pretypes: "rm -rf src",
        verify: "pnpm build",
        build: "true",
      },
    });
    expect(
      changedGateScripts("package.json", b2, h2)
        .map((c) => `${c.script}:${c.change}`)
        .sort(),
    ).toEqual(["build:changed", "lint:extra:added", "lint:js:changed", "pretypes:added"]);
    // a removed reached script, and a script the registered command reaches via run-p
    const b3 = JSON.stringify({ scripts: { gate: "npm run a", a: "vitest" } });
    expect(
      changedGateScripts("package.json", b3, JSON.stringify({ scripts: { gate: "npm run a" } }), [
        "gate",
      ]),
    ).toEqual([{ file: "package.json", script: "a", change: "removed" }]);
    expect(gateScriptNamesOf(["run-p 'unit:*' e2e", "concurrently npm:x"]).sort()).toEqual([
      "e2e",
      "unit:*",
      "x",
    ]);
    const b4 = JSON.stringify({ scripts: { "unit:a": "vitest a" } });
    const h4 = JSON.stringify({ scripts: { "unit:a": "true" } });
    expect(changedGateScripts("package.json", b4, h4, ["unit:*"])).toHaveLength(1);
  });

  it("scriptRefs reads the script calls in a body", () => {
    const u = ["a", "b", "test", "lint:x", "lint:y", "c"];
    expect(scriptRefs("npm run -s a && pnpm b; npm t", u).sort()).toEqual(["a", "b", "test"]);
    expect(scriptRefs("npm-run-all --parallel 'lint:*' c", u).sort()).toEqual([
      "c",
      "lint:x",
      "lint:y",
    ]);
    expect(scriptRefs("eslint . && tsc", u)).toEqual([]);
    expect(scriptRefs("pnpm install && yarn c", u)).toEqual(["c"]);
  });

  it("an unparseable package.json is reported, never silently passed", () => {
    expect(changedGateScripts("package.json", base, "{not json")).toEqual([
      { file: "package.json", script: "(unparseable package.json)", change: "changed" },
    ]);
  });
});

describe("gate command resolution against the base commit", () => {
  it("parses package-manager script invocations, and leaves anything else alone", () => {
    expect(parseScriptInvocation("npm test")).toEqual({ pm: "npm", script: "test", args: [] });
    expect(parseScriptInvocation("npm run lint -- --max-warnings=0")).toEqual({
      pm: "npm",
      script: "lint",
      args: ["--max-warnings=0"],
    });
    expect(parseScriptInvocation("pnpm test")?.script).toBe("test");
    expect(parseScriptInvocation("pnpm run typecheck")?.script).toBe("typecheck");
    expect(parseScriptInvocation("yarn lint")?.script).toBe("lint");
    expect(parseScriptInvocation("bun run test")?.script).toBe("test");
    for (const c of [
      "pnpm -r test",
      "pnpm install",
      "bun test",
      "npm test && npm run lint",
      "pytest -q",
      "make test",
      "npm run $X",
      "",
    ]) {
      expect(parseScriptInvocation(c), c).toBeNull();
    }
    expect(
      gateScriptNamesOf(["pnpm run verify:fast", "npm test && npm run lint:ci"]).sort(),
    ).toEqual(["lint:ci", "test", "verify:fast"]);
  });

  const basePkg = JSON.stringify({
    scripts: { pretest: "node gen.js", test: "vitest run", lint: "eslint ." },
  });

  it("unchanged script → runs as registered, source base", () => {
    const r = resolveGateCommand("pnpm test", basePkg, basePkg, "0123456789abcdef");
    expect(r).toMatchObject({ command: "pnpm test", source: "base" });
    expect(r.note).toContain("0123456789ab");
  });

  it("changed script → the BASE body runs (with its pre hook), source base-pinned", () => {
    const head = JSON.stringify({ scripts: { test: "echo ok", lint: "eslint ." } });
    const r = resolveGateCommand("npm test -- --reporter=dot", basePkg, head, "abc");
    expect(r.source).toBe("base-pinned");
    expect(r.command).toBe(
      'PATH="$PWD/node_modules/.bin:$PATH"; ( node gen.js ) && ( vitest run --reporter=dot )',
    );
    expect(r.note).toMatch(/changed script "test"/);
  });

  it("removed script or deleted package.json → the base body runs", () => {
    const head = JSON.stringify({ scripts: {} });
    expect(resolveGateCommand("npm run lint", basePkg, head, "abc")).toMatchObject({
      source: "base-pinned",
      command: 'PATH="$PWD/node_modules/.bin:$PATH"; ( eslint . )',
    });
    expect(resolveGateCommand("npm run lint", basePkg, null, "abc").source).toBe("base-pinned");
  });

  it("a script new in the delivery runs from head; a non-script command runs as registered", () => {
    const head = JSON.stringify({ scripts: { typecheck: "tsc --noEmit" } });
    expect(resolveGateCommand("pnpm run typecheck", basePkg, head, "abc").source).toBe("head");
    expect(resolveGateCommand("pytest -q", basePkg, head, "abc")).toMatchObject({
      source: "registered",
      command: "pytest -q",
    });
    expect(resolveGateCommand("pnpm test", "{bad", head, "abc").source).toBe("unresolved");
  });

  it("an ADDED pre/post hook pins the gate to base (the delivery's hooks never run)", () => {
    const b = JSON.stringify({ scripts: { test: "node --test" } });
    const h = JSON.stringify({
      scripts: {
        pretest: "mv test/a.test.js .stash/",
        test: "node --test",
        posttest: "mv .stash/a.test.js test/",
      },
    });
    const r = resolveGateCommand("npm test", b, h, "abc");
    expect(r.source).toBe("base-pinned");
    expect(r.command).toBe('PATH="$PWD/node_modules/.bin:$PATH"; ( node --test )');
    expect(r.note).toContain('added script "pretest"');
    // a changed base hook: the BASE hook runs
    const b2 = JSON.stringify({ scripts: { pretest: "node gen.js", test: "vitest run" } });
    const h2 = JSON.stringify({ scripts: { pretest: "rm -rf test", test: "vitest run" } });
    expect(resolveGateCommand("pnpm test", b2, h2, "abc").command).toBe(
      'PATH="$PWD/node_modules/.bin:$PATH"; ( node gen.js ) && ( vitest run )',
    );
  });

  it("a changed script reached through a simple chain is pinned by inlining the base chain", () => {
    const b = JSON.stringify({
      scripts: { test: "npm run unit -- --x", unit: "node --test", preunit: "node gen.js" },
    });
    const h = JSON.stringify({
      scripts: { test: "npm run unit -- --x", unit: "node -e 0", preunit: "node gen.js" },
    });
    const r = resolveGateCommand("npm test -- y", b, h, "abc");
    expect(r.source).toBe("base-pinned");
    expect(r.command).toBe(
      'PATH="$PWD/node_modules/.bin:$PATH"; ( ( node gen.js ) && ( node --test --x y ) )',
    );
    expect(r.note).toContain('changed script "unit"');
    expect(r.note).not.toContain("still ran");
  });

  it("a changed script behind a compound body is named in the note (the scan flags it)", () => {
    const b = JSON.stringify({
      scripts: { test: "run-s unit e2e", unit: "node --test", e2e: "x" },
    });
    const h = JSON.stringify({ scripts: { test: "run-s unit e2e", unit: "node -e 0", e2e: "x" } });
    const r = resolveGateCommand("npm test", b, h, "abc");
    expect(r.source).toBe("base-pinned");
    expect(r.command).toBe('PATH="$PWD/node_modules/.bin:$PATH"; ( run-s unit e2e )');
    expect(r.note).toMatch(/unit still ran as the delivery has it/);
  });

  it("quotes extra arguments that need it", () => {
    const head = JSON.stringify({ scripts: { test: "x" } });
    const r = resolveGateCommand("npm test -- a,b", basePkg, head, "abc");
    expect(r.command).toContain("( vitest run a,b )");
  });
});

describe("hiddenIndexPaths", () => {
  it("names skip-worktree and assume-unchanged entries from `git ls-files -v -z`", () => {
    const out = [
      "H src/a.js",
      "S test/a.test.js",
      "h test/b.test.js",
      "H test/c.test.js",
      "s x y.js",
      "",
    ].join("\0");
    expect(hiddenIndexPaths(out)).toEqual(["test/a.test.js", "test/b.test.js", "x y.js"]);
    expect(hiddenIndexPaths("H a\0H b\0")).toEqual([]);
    expect(hiddenIndexPaths("")).toEqual([]);
  });

  it("matches what git reports for a real index", () => {
    const d = mkdtempSync(join(tmpdir(), "gi-"));
    try {
      const g = (args: string[]) =>
        execFileSync("git", ["-C", d, ...args], {
          encoding: "utf8",
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "t",
            GIT_AUTHOR_EMAIL: "t@t",
            GIT_COMMITTER_NAME: "t",
            GIT_COMMITTER_EMAIL: "t@t",
          },
        });
      g(["init", "-q", "-b", "main"]);
      for (const f of ["a.test.js", "b.test.js", "c.js"]) writeFileSync(join(d, f), "x\n");
      g(["add", "-A"]);
      g(["commit", "-qm", "base"]);
      g(["update-index", "--skip-worktree", "a.test.js"]);
      g(["update-index", "--assume-unchanged", "b.test.js"]);
      expect(hiddenIndexPaths(g(["ls-files", "-v", "-z"]))).toEqual(["a.test.js", "b.test.js"]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("collectTestIntegrity against a real git repo", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  const sh = (args: string[]): string =>
    execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });
  const git: IntegrityGit = (args, opts) => {
    const r = spawnSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      maxBuffer: opts?.maxBuffer ?? 1024 * 1024,
    });
    return { status: r.status, stdout: r.stdout ?? "" };
  };

  it("finds a deleted test, a renamed test, an added it.skip and a rewritten test script", () => {
    dir = mkdtempSync(join(tmpdir(), "gi-"));
    sh(["init", "-q", "-b", "main"]);
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    writeFileSync(join(dir, "src/a.ts"), "export const a = 1;\n");
    writeFileSync(join(dir, "src/a.test.ts"), "it('a', () => {});\n");
    writeFileSync(join(dir, "src/b.test.ts"), "it('b1', () => {});\nit('b2', () => {});\n");
    writeFileSync(join(dir, "src/c.test.ts"), "it('c', () => { expect(1).toBe(1); });\n");
    sh(["add", "-A"]);
    sh(["commit", "-qm", "base"]);
    const base = sh(["rev-parse", "HEAD"]).trim();
    sh(["checkout", "-qb", "feat"]);
    unlinkSync(join(dir, "src/a.test.ts"));
    writeFileSync(join(dir, "src/b.test.ts"), "it('b1', () => {});\nit.skip('b2', () => {});\n");
    renameSync(join(dir, "src/c.test.ts"), join(dir, "src/c-check.ts"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "echo ok" } }));
    sh(["add", "-A"]);
    sh(["commit", "-qm", "weaken"]);

    const f = collectTestIntegrity(git, base, "feat");
    expect(f.deleted).toEqual(["src/a.test.ts"]);
    expect(f.renamed).toEqual([{ from: "src/c.test.ts", to: "src/c-check.ts" }]);
    expect(f.markers).toEqual([{ path: "src/b.test.ts", marker: "it.skip", line: 2 }]);
    expect(f.scripts).toEqual([{ file: "package.json", script: "test", change: "changed" }]);
    expect(f.incomplete).toEqual([]);

    // An unknown range is an incomplete scan, not a clean one.
    const bad = collectTestIntegrity(git, "nope", "feat");
    expect(bad.incomplete).toHaveLength(1);
    expect(hasIntegrityFindings(bad)).toBe(true);
  });

  it("finds a deleted Django tests.py, a skip inside another, and an added .npmrc", () => {
    dir = mkdtempSync(join(tmpdir(), "gi-"));
    sh(["init", "-q", "-b", "main"]);
    mkdirSync(join(dir, "shop"));
    mkdirSync(join(dir, "blog"));
    const t =
      "from django.test import TestCase\n\nclass T(TestCase):\n    def test_a(self):\n        self.assertTrue(True)\n";
    writeFileSync(join(dir, "shop/tests.py"), t);
    writeFileSync(join(dir, "blog/tests.py"), t);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    sh(["add", "-A"]);
    sh(["commit", "-qm", "base"]);
    const base = sh(["rev-parse", "HEAD"]).trim();
    sh(["checkout", "-qb", "feat"]);
    unlinkSync(join(dir, "shop/tests.py"));
    writeFileSync(
      join(dir, "blog/tests.py"),
      t.replace("    def test_a", "    @pytest.mark.skip(reason='later')\n    def test_a"),
    );
    writeFileSync(join(dir, ".npmrc"), "script-shell=/bin/true\n");
    sh(["add", "-A"]);
    sh(["commit", "-qm", "weaken"]);
    const f = collectTestIntegrity(git, base, "feat");
    expect(f.deleted).toEqual(["shop/tests.py"]);
    expect(f.markers).toEqual([{ path: "blog/tests.py", marker: "@pytest.mark.skip", line: 4 }]);
    expect(f.configs).toEqual([{ path: ".npmrc", change: "added" }]);
  });

  it("a .gitattributes that marks the tests binary or -diff cannot hide a skip", () => {
    dir = mkdtempSync(join(tmpdir(), "gi-"));
    sh(["init", "-q", "-b", "main"]);
    mkdirSync(join(dir, "test"));
    writeFileSync(join(dir, "test/a.test.js"), 'test("a", () => {});\n');
    writeFileSync(join(dir, "test/b.test.js"), 'test("b", () => {});\n');
    sh(["add", "-A"]);
    sh(["commit", "-qm", "base"]);
    const base = sh(["rev-parse", "HEAD"]).trim();
    sh(["checkout", "-qb", "feat"]);
    writeFileSync(join(dir, ".gitattributes"), "test/a.test.js -diff\n*.js binary\n");
    writeFileSync(join(dir, "test/a.test.js"), 'test.skip("a", () => {});\n');
    writeFileSync(join(dir, "test/b.test.js"), 'it.only("b", () => {});\n');
    sh(["add", "-A"]);
    sh(["commit", "-qm", "hide them"]);
    const f = collectTestIntegrity(git, base, "feat");
    expect(f.markers.map((m) => `${m.marker}@${m.path}:${m.line}`)).toEqual([
      "test.skip@test/a.test.js:1",
      "it.only@test/b.test.js:1",
    ]);
  });

  it("finds node:test option skips, runtime skips and a skip behind a comment", () => {
    dir = mkdtempSync(join(tmpdir(), "gi-"));
    sh(["init", "-q", "-b", "main"]);
    mkdirSync(join(dir, "test"));
    const body = (n: string) => `test("${n}", () => { assert.ok(true); });\n`;
    writeFileSync(join(dir, "test/a.test.js"), body("a") + body("b") + body("c") + body("d"));
    sh(["add", "-A"]);
    sh(["commit", "-qm", "base"]);
    const base = sh(["rev-parse", "HEAD"]).trim();
    sh(["checkout", "-qb", "feat"]);
    writeFileSync(
      join(dir, "test/a.test.js"),
      'test("a", { skip: true }, () => { assert.ok(true); });\n' +
        'test("b", (t) => { t.skip(); assert.ok(true); });\n' +
        '/**/ test.skip("c", () => { assert.ok(true); });\n' +
        'it.concurrent.skip("d", () => { assert.ok(true); });\n',
    );
    sh(["commit", "-qam", "skip them"]);
    const f = collectTestIntegrity(git, base, "feat");
    expect(f.markers.map((m) => `${m.marker}@${m.line}`)).toEqual([
      "{ skip: … } option@1",
      "t.skip()@2",
      "test.skip@3",
      "it.concurrent.skip@4",
    ]);
  });
});

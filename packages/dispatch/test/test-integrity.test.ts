/**
 * GATE INTEGRITY classifier (services/testIntegrity.ts): the one implementation the
 * runner's integrity GATE row and the server-side `test-modified` risk annotation share.
 *
 *  1. test paths per stack (and the additive GAFFER_TEST_PATH_RE);
 *  2. every skip/focus marker class, on ADDED lines only, not in comments;
 *  3. deleted / renamed test files and test-runner config from name-status;
 *  4. gate scripts changed or removed in package.json (added ones are fine);
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
  integrityItems,
  isTestPath,
  parseNameStatusZ,
  parseScriptInvocation,
  resolveGateCommand,
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
  ])("%s: %s → %s", (path, line, marker) => {
    const found = addedSkipMarkers(patchAdding(path, [line], 7));
    expect(found).toEqual([{ path, marker, line: 7 }]);
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

  it("quotes extra arguments that need it", () => {
    const head = JSON.stringify({ scripts: { test: "x" } });
    const r = resolveGateCommand("npm test -- a,b", basePkg, head, "abc");
    expect(r.command).toContain("( vitest run a,b )");
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
});

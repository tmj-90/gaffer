// REVIEW PACKET: reading test counts out of runner output and out of the agent's
// words, and flagging only a real disagreement between the two.

import { describe, expect, it } from "vitest";

import {
  compareTestClaims,
  parseRunnerTally,
  parseTestClaims,
  parseTestClaimsFrom,
} from "../src/util/testTally.js";

const ESC = String.fromCharCode(27);

describe("parseRunnerTally: the usual runner summaries", () => {
  it("vitest (summed across packages, ANSI stripped, Test Files ignored)", () => {
    const t = parseRunnerTally(
      [
        " Test Files  3 passed (3)",
        `      Tests  ${ESC}[32m40 passed${ESC}[39m (40)`,
        " Test Files  1 failed | 1 passed (2)",
        "      Tests  1 failed | 1 passed | 2 skipped (4)",
      ].join("\n"),
    );
    expect(t).toMatchObject({ framework: "vitest", passed: 41, failed: 1, skipped: 2, total: 44 });
    expect(t!.lines).toHaveLength(2);
  });

  it("jest", () => {
    expect(
      parseRunnerTally("Tests:       1 failed, 2 skipped, 41 passed, 44 total\nSnapshots: 0 total"),
    ).toMatchObject({ framework: "jest", passed: 41, failed: 1, skipped: 2, total: 44 });
  });

  it("pytest (with and without the ===== frame)", () => {
    expect(
      parseRunnerTally("========= 1 failed, 41 passed, 2 skipped in 0.12s ========="),
    ).toMatchObject({
      framework: "pytest",
      passed: 41,
      failed: 1,
      skipped: 2,
    });
    expect(parseRunnerTally("12 passed in 0.03s")).toMatchObject({ passed: 12, failed: 0 });
  });

  it("go test -v (top-level --- lines and the runner's tally line)", () => {
    const raw = [
      "=== RUN   TestA",
      "--- PASS: TestA (0.00s)",
      "    --- PASS: TestA/sub (0.00s)",
      "--- FAIL: TestB (0.01s)",
      "--- SKIP: TestC (0.00s)",
      "FAIL",
    ].join("\n");
    expect(parseRunnerTally(raw)).toMatchObject({
      framework: "go",
      passed: 1,
      failed: 1,
      skipped: 1,
      total: 3,
    });
    expect(parseRunnerTally("gotest-tally: pass=12 fail=0 skip=1")).toMatchObject({
      framework: "go",
      passed: 12,
      skipped: 1,
    });
  });

  it("cargo (one line per test binary, summed)", () => {
    expect(
      parseRunnerTally(
        [
          "test result: ok. 10 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.01s",
          "test result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out",
        ].join("\n"),
      ),
    ).toMatchObject({ framework: "cargo", passed: 12, failed: 1, skipped: 1, total: 14 });
  });

  it("node --test (tap and spec reporters; one group per run)", () => {
    const tap = [
      "# tests 3",
      "# suites 0",
      "# pass 2",
      "# fail 1",
      "# cancelled 0",
      "# skipped 0",
      "# todo 0",
      "# duration_ms 4.2",
    ];
    expect(parseRunnerTally(tap.join("\n"))).toMatchObject({
      framework: "node:test",
      passed: 2,
      failed: 1,
      total: 3,
    });
    const twoRuns = [...tap, "ℹ tests 5", "ℹ pass 5", "ℹ fail 0"].join("\n");
    expect(parseRunnerTally(twoRuns)).toMatchObject({ passed: 7, failed: 1, total: 8 });
  });

  it("no summary ⇒ null (never zero)", () => {
    expect(parseRunnerTally("all good\nDone in 3s")).toBeNull();
    expect(parseRunnerTally("")).toBeNull();
  });
});

describe("parseTestClaims: what the agent said", () => {
  it("reads counted and bare claims", () => {
    expect(parseTestClaims("Implemented clearDone; all 42 tests pass.")).toEqual([
      { passed: 42, all: true, excerpt: "Implemented clearDone; all 42 tests pass." },
    ]);
    expect(parseTestClaims("12/12 tests passing")[0]).toMatchObject({ passed: 12, all: true });
    expect(parseTestClaims("42 tests passing")[0]).toMatchObject({ passed: 42, all: false });
    expect(parseTestClaims("All tests pass.")[0]).toMatchObject({ passed: null, all: true });
    // A pasted runner line is still the agent's word.
    expect(parseTestClaims("Tests  9 passed (9)")[0]).toMatchObject({ passed: 9, all: true });
  });

  it("ignores counts that are not a pass claim", () => {
    expect(parseTestClaims("Added 3 new tests for the edge cases.")).toEqual([]);
    expect(parseTestClaims("Smallest-change note: modified src/a.ts")).toEqual([]);
  });

  it("reads only claims about the whole suite", () => {
    // Part of the suite: new, unit, added, partial, one file's.
    expect(parseTestClaims("30 unit tests passed")).toEqual([]);
    expect(parseTestClaims("Added 3 new tests pass")).toEqual([]);
    expect(parseTestClaims("Added 3 tests pass")).toEqual([]);
    expect(parseTestClaims("1 of 2 tests passing before the fix")).toEqual([]);
    expect(parseTestClaims("test/lock.test.ts: 3 tests pass")).toEqual([]);
    expect(parseTestClaims("all unit tests pass")).toEqual([]);
    // A file's count still reads when it says "all".
    expect(parseTestClaims("all 42 tests pass, incl. test/lock.test.ts")[0]).toMatchObject({
      passed: 42,
      all: true,
    });
  });

  it("in a criterion's row, only an explicit 'all' speaks for the suite", () => {
    const ac = { acScoped: true };
    expect(parseTestClaims("3 tests pass", ac)).toEqual([]);
    expect(parseTestClaims("3/3 tests pass", ac)).toEqual([]);
    expect(parseTestClaims("Tests  3 passed (3)", ac)).toEqual([]);
    expect(parseTestClaims("All 42 tests pass.", ac)[0]).toMatchObject({ passed: 42, all: true });
    expect(parseTestClaims("All tests pass.", ac)[0]).toMatchObject({ passed: null, all: true });
  });

  it("merges claims across rows, each read in its own scope", () => {
    const c = parseTestClaimsFrom([
      { text: "3 tests pass", acScoped: true },
      { text: "42 tests pass" },
      { text: "All tests pass." },
    ]);
    expect(c.map((x) => x.passed)).toEqual([42]);
  });

  it("a counted claim wins over a bare 'all pass'", () => {
    const c = parseTestClaims("All tests pass.\n42 tests passing");
    expect(c).toHaveLength(1);
    expect(c[0]!.passed).toBe(42);
  });
});

describe("compareTestClaims", () => {
  const tally = { framework: "vitest", passed: 40, failed: 0, skipped: 0, total: 40, lines: [] };

  it("flags a claimed count the runner did not see", () => {
    const d = compareTestClaims(parseTestClaims("all 42 tests pass"), tally);
    expect(d).toHaveLength(1);
    expect(d[0]!.message).toBe("The summary says 42, the runner saw 40.");
  });

  it("says nothing when the counts agree, or when there is no runner count", () => {
    expect(compareTestClaims(parseTestClaims("all 40 tests pass"), tally)).toEqual([]);
    expect(compareTestClaims(parseTestClaims("all 42 tests pass"), null)).toEqual([]);
  });

  it("a matching count beside 'all tests pass' does not hide the runner's failure", () => {
    // The gate passed (the test script's exit code), but the runner printed a failure.
    const failing = { ...tally, passed: 40, failed: 1 };
    const want = "The summary says all tests pass, the runner saw 40 passing and 1 failing.";
    for (const claims of [
      parseTestClaims("All tests pass.\n40 tests passing"),
      parseTestClaimsFrom([{ text: "All tests pass." }, { text: "40 tests pass" }]),
      parseTestClaimsFrom([{ text: "All tests pass.", acScoped: true }, { text: "40 tests pass" }]),
    ]) {
      expect(compareTestClaims(claims, failing).map((d) => d.message)).toEqual([want]);
    }
    // With no failure, the same words agree with the runner.
    expect(compareTestClaims(parseTestClaims("All tests pass.\n40 tests passing"), tally)).toEqual(
      [],
    );
  });

  it("flags 'all pass' against a runner failure or a failed test gate", () => {
    const failing = { ...tally, passed: 39, failed: 1 };
    expect(compareTestClaims(parseTestClaims("All tests pass."), failing)[0]!.message).toBe(
      "The summary says all tests pass, the runner saw 39 passing and 1 failing.",
    );
    expect(
      compareTestClaims(parseTestClaims("All tests pass."), null, { testsGateFailed: true })[0]!
        .message,
    ).toBe("The summary says all tests pass, the runner saw the test gate fail.");
  });
});

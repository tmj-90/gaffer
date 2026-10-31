import { describe, expect, it } from "vitest";

import { executedCount, summarizeGates } from "../src/runtime/dod/dodSummary.js";

// The DoD verdict-tally text-processors (strangler port of dod.sh's
// gaffer_dod_summary_line / gaffer_dod_executed_count). A "results file" is
// TAB-separated `GATE\t<gate>\t<repo>\t<status>\t<rc>\t<note>` rows; every other
// line (the framed ---DOD-OUTPUT--- transcript) is ignored, exactly like the awk
// `$1=="GATE"` guard. The bash↔ts byte-identity is separately pinned by
// runner/test/dod-distill-parity.test.sh; this proves the pure functions' shape.
const doc = (lines: string[]): string => lines.join("\n") + "\n";
const MIXED = doc([
  "GATE\ttests\tapp-web\tPASS\t0\tnpm test",
  "GATE\ttypecheck\tapp-web\tFAIL\t2\texited 2: tsc",
  "---DOD-OUTPUT typecheck@app-web---",
  "src/x.ts:3:1 error",
  "---END-DOD-OUTPUT---",
  "GATE\tlint\tapp-web\tSKIP\t0\tno command configured",
  "GATE\ttests\tapp-api\tFAIL\t1\texited 1: pytest",
]);

describe("summarizeGates", () => {
  it("tallies pass/skip/fail and lists the FAILs as gate@repo (no trailing newline)", () => {
    expect(summarizeGates(MIXED)).toBe(
      "4 gate(s): 1 pass, 1 skip, 2 fail (failed: typecheck@app-web, tests@app-api)",
    );
  });
  it("omits the (failed: …) clause when nothing failed", () => {
    expect(summarizeGates(doc(["GATE\ttests\tr\tPASS\t0\tt", "GATE\tlint\tr\tSKIP\t0\t-"]))).toBe(
      "2 gate(s): 1 pass, 1 skip, 0 fail",
    );
  });
  it("ignores non-GATE lines (framed transcript, noise)", () => {
    expect(
      summarizeGates(doc(["noise", "---DOD-OUTPUT x@y---", "body", "---END-DOD-OUTPUT---"])),
    ).toBe("0 gate(s): 0 pass, 0 skip, 0 fail");
  });
  it("empty input → zero tally", () => {
    expect(summarizeGates("")).toBe("0 gate(s): 0 pass, 0 skip, 0 fail");
  });
});

describe("executedCount", () => {
  it("counts only PASS/FAIL rows (SKIP excluded)", () => {
    expect(executedCount(MIXED)).toBe(3);
  });
  it("all-skip → 0 (the vacuous-pass guard signal)", () => {
    expect(executedCount(doc(["GATE\ttests\tr\tSKIP\t0\t-", "GATE\tlint\tr\tSKIP\t0\t-"]))).toBe(0);
  });
  it("empty input → 0", () => {
    expect(executedCount("")).toBe(0);
  });
});

// GATE INTEGRITY: the `integrity` row is advisory. A FLAG is counted and named (never
// as a fail, never as a skip), and no integrity row counts as an EXECUTED gate — a
// delivery whose only non-skip row is integrity PASS still verified nothing.
describe("gate integrity rows", () => {
  const WITH_FLAG = doc([
    "GATE\ttests\tr\tPASS\t0\tnpm test\tbase",
    "GATE\tlint\tr\tSKIP\t0\tno command configured",
    "GATE\tintegrity\tr\tFLAG\t0\tdeleted 1 test file (a.test.ts)\tbase abc vs worktree",
  ]);
  it("summarizeGates counts and names a FLAG", () => {
    expect(summarizeGates(WITH_FLAG)).toBe(
      "3 gate(s): 1 pass, 1 skip, 0 fail, 1 flag (flagged: integrity@r)",
    );
  });
  it("executedCount ignores the integrity row whatever its status", () => {
    expect(executedCount(WITH_FLAG)).toBe(1);
    expect(
      executedCount(doc(["GATE\ttests\tr\tSKIP\t0\t-", "GATE\tintegrity\tr\tPASS\t0\tclean"])),
    ).toBe(0);
  });
});

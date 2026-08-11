import { describe, expect, it } from "vitest";

import { checkMinimalism } from "../src/runtime/minimalism/minimalism.js";

// Pure minimalism post-condition (strangler port of gaffer_check_minimalism).
// The bash↔ts byte-identity of token/code/reason is pinned by
// runner/test/minimalism-parity.test.sh; this proves the decision's shape.
describe("checkMinimalism", () => {
  it("ok: note present + within caps", () => {
    expect(checkMinimalism({ files: 3, lines: 120, note: "Refactored auth for clarity" })).toEqual({
      verdict: "ok",
      code: 0,
      reason: "minimal: 3 files / 120 lines within caps; smallest-change note present",
    });
  });

  it("missing_note: empty/whitespace note fails when enforcing (code 1)", () => {
    expect(checkMinimalism({ files: 1, lines: 1, note: "   \t\n " })).toEqual({
      verdict: "missing_note",
      code: 1,
      reason: "missing smallest-change note (required for every completed delivery)",
    });
  });

  it("missing_note downgrades to code 2 when enforce=false", () => {
    expect(checkMinimalism({ files: 1, lines: 1, note: "", enforce: false }).code).toBe(2);
  });

  it("oversized_diff: over a cap → code 2, em-dash reason (never fails)", () => {
    expect(checkMinimalism({ files: 20, lines: 900, note: "big sweep", changed: "" })).toEqual({
      verdict: "oversized_diff",
      code: 2,
      reason: "oversized_diff: 20 files / 900 lines (caps: 12 files / 400 lines) — suggest a split",
    });
  });

  it("a cap of 0 disables that dimension", () => {
    expect(
      checkMinimalism({ files: 99, lines: 99999, note: "n", maxFiles: 0, maxLines: 0 }).verdict,
    ).toBe("ok");
  });

  it("unverified_note: note references no changed file → code 2 with 80-char excerpt", () => {
    const note = "x".repeat(120);
    const v = checkMinimalism({ files: 2, lines: 50, note, changed: "src/z.ts" });
    expect(v.verdict).toBe("unverified_note");
    expect(v.code).toBe(2);
    expect(v.reason).toBe(
      `smallest-change note references no changed file (possible boilerplate): "${"x".repeat(80)}"`,
    );
  });

  it("verified by basename or stem (>=4 chars) → not flagged", () => {
    expect(
      checkMinimalism({
        files: 2,
        lines: 50,
        note: "tweaked reset.ts",
        changed: "src/auth/reset.ts",
      }).verdict,
    ).toBe("ok");
    expect(
      checkMinimalism({
        files: 2,
        lines: 50,
        note: "the account handler",
        changed: "src/account.tsx",
      }).verdict,
    ).toBe("ok");
  });

  it("no changed list → relevance check skipped", () => {
    expect(checkMinimalism({ files: 2, lines: 50, note: "anything", changed: "" }).verdict).toBe(
      "ok",
    );
  });
});

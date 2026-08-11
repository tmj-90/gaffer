import { describe, expect, it } from "vitest";

import { diffStats } from "../src/runtime/minimalism/diffStats.js";

// Pure numstat parser (strangler port of gaffer_diff_stats' awk). The bash↔ts
// byte-identity is pinned by runner/test/minimalism-parity.test.sh; this proves
// the shape. Output is "<files> <lines>" (lines = added + deleted).
describe("diffStats", () => {
  it("empty numstat → 0 files, 0 lines (no phantom record)", () => {
    expect(diffStats("")).toBe("0 0");
  });
  it("one text file counts added + deleted", () => {
    expect(diffStats("12\t3\tsrc/a.ts")).toBe("1 15");
  });
  it("binary files ('-') count toward files but not lines", () => {
    expect(diffStats("12\t3\tsrc/a.ts\n-\t-\tlogo.png\n5\t0\tREADME.md")).toBe("3 20");
  });
  it("a trailing newline is not an extra file (awk RS semantics)", () => {
    expect(diffStats("1\t1\ta\n2\t2\tb\n")).toBe("2 6");
  });
  it("paths with spaces don't inflate the count (only the first two fields matter)", () => {
    expect(diffStats("4\t2\tmy dir/file name.ts")).toBe("1 6");
  });
});

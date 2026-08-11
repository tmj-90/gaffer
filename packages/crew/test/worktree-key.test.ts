import { describe, expect, it } from "vitest";

import { worktreeKey } from "../src/runtime/worktree/worktreeKey.js";

// Pure worktree-leaf derivation (strangler port of tick.sh's WT_ROWS loop).
// The bash↔ts byte-identity is separately pinned by
// runner/test/worktree-key-parity.test.sh; this proves the function's shape,
// including the byte-oriented multibyte collapse that matches `tr -c … '-'`.
describe("worktreeKey", () => {
  it("passes a clean id through unchanged", () => {
    expect(worktreeKey("fixture-repo-id", "fixture-app", 0)).toBe("fixture-repo-id");
  });
  it("falls back to the name when the id is empty", () => {
    expect(worktreeKey("", "My Repo Name!", 1)).toBe("My-Repo-Name");
  });
  it("replaces filesystem-unsafe chars with '-' and collapses/trims runs", () => {
    expect(worktreeKey("weird/id:with*chars", "x", 2)).toBe("weird-id-with-chars");
    expect(worktreeKey("---leading-and-trailing---", "y", 3)).toBe("leading-and-trailing");
  });
  it("collapses each multibyte char's BYTES to a single '-' (tr byte semantics)", () => {
    // "café-ünïcode": é/ü/ï are 2 bytes each → "--" per char → collapsed to "-".
    expect(worktreeKey("café-ünïcode", "z", 4)).toBe("caf-n-code");
  });
  it("keeps dots (they are in the allowed set)", () => {
    expect(worktreeKey("....", "only-dots", 6)).toBe("....");
  });
  it("falls back to repo<index> when id and name are both empty", () => {
    expect(worktreeKey("", "", 5)).toBe("repo5");
  });
  it("falls back to repo<index> when the key sanitizes to empty", () => {
    expect(worktreeKey("@@@###", "", 8)).toBe("repo8");
  });
});

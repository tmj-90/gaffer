/**
 * Lore id generator. Small but load-bearing: ids are the round-trip key
 * for sync, the FTS-free record handle, and are validated by a regex in
 * several places. Pin the shape and alphabet.
 */
import { describe, expect, it } from "vitest";

import { newLoreId } from "../src/core/ids.js";

describe("newLoreId", () => {
  it("is 8 chars from the Crockford-ish lowercase alphabet [a-z2-9]", () => {
    for (let i = 0; i < 200; i++) {
      expect(newLoreId()).toMatch(/^[a-z2-9]{8}$/);
    }
  });

  it("never contains the ambiguous chars 0/1/i/l/o", () => {
    for (let i = 0; i < 200; i++) {
      expect(newLoreId()).not.toMatch(/[01ilo]/);
    }
  });

  it("is effectively collision-free across a large batch", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) seen.add(newLoreId());
    // Allow for the astronomically unlikely dupe, but it should be ~0.
    expect(seen.size).toBeGreaterThan(4995);
  });
});

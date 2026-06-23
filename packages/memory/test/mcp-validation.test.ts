/**
 * MCP input-length guards for suggest_lore. The zod max-cap path used
 * to mask the real cause ("body is undefined") and agents dropped the
 * suggestion silently. These tests pin the contract on `checkLength`:
 * structured shape, boundary behaviour, suggested_cut size.
 */
import { describe, expect, it } from "vitest";

import { auditMessageForTooLong, checkLength, LENGTH_CAPS } from "../src/mcp/validation.js";

function repeat(ch: string, n: number): string {
  return ch.repeat(n);
}

describe("checkLength — title", () => {
  it("returns null when at the boundary (length === max)", () => {
    expect(checkLength("title", repeat("a", LENGTH_CAPS.title))).toBeNull();
  });

  it("returns null when well under the cap", () => {
    expect(checkLength("title", "short title")).toBeNull();
  });

  it("returns null on empty string (zod min(1) is the empty-string gate)", () => {
    expect(checkLength("title", "")).toBeNull();
  });

  it("returns the structured shape when over by one", () => {
    const value = repeat("a", LENGTH_CAPS.title + 1);
    const err = checkLength("title", value);
    expect(err).not.toBeNull();
    expect(err).toEqual({
      error: "title_too_long",
      provided: LENGTH_CAPS.title + 1,
      max: LENGTH_CAPS.title,
      suggested_cut: repeat("a", LENGTH_CAPS.title - 1) + "…",
      hint: expect.stringMatching(/shorter title/i),
    });
  });

  it("suggested_cut is exactly max chars and ends with the ellipsis", () => {
    const value = repeat("a", 999);
    const err = checkLength("title", value)!;
    expect(err.suggested_cut.length).toBe(LENGTH_CAPS.title);
    expect(err.suggested_cut.endsWith("…")).toBe(true);
    // The single character is U+2026, not three dots.
    expect(err.suggested_cut.at(-1)).toBe("…");
    expect(err.suggested_cut.at(-1)).not.toBe(".");
  });
});

describe("checkLength — summary", () => {
  it("returns null when at the boundary (length === max)", () => {
    expect(checkLength("summary", repeat("a", LENGTH_CAPS.summary))).toBeNull();
  });

  it("returns the structured shape when over the cap", () => {
    const value = repeat("a", LENGTH_CAPS.summary + 12);
    const err = checkLength("summary", value);
    expect(err).toEqual({
      error: "summary_too_long",
      provided: LENGTH_CAPS.summary + 12,
      max: LENGTH_CAPS.summary,
      suggested_cut: repeat("a", LENGTH_CAPS.summary - 1) + "…",
      hint: expect.stringMatching(/body has no length limit/i),
    });
  });

  it("suggested_cut is exactly max chars and ends with the ellipsis", () => {
    const value = repeat("x", LENGTH_CAPS.summary * 2);
    const err = checkLength("summary", value)!;
    expect(err.suggested_cut.length).toBe(LENGTH_CAPS.summary);
    expect(err.suggested_cut.endsWith("…")).toBe(true);
  });

  it("hint points the agent at the right next action (body is uncapped)", () => {
    const err = checkLength("summary", repeat("a", 1500))!;
    expect(err.hint.toLowerCase()).toContain("body has no length limit");
  });
});

describe("auditMessageForTooLong", () => {
  it("produces a greppable single-line shape: '<field>_too_long: <n> > <max>'", () => {
    const tErr = checkLength("title", repeat("a", 250))!;
    expect(auditMessageForTooLong(tErr)).toBe("title_too_long: 250 > 200");
    const sErr = checkLength("summary", repeat("a", 1234))!;
    expect(auditMessageForTooLong(sErr)).toBe("summary_too_long: 1234 > 800");
  });
});

describe("LENGTH_CAPS — contract", () => {
  it("title cap is 200 and summary cap is 800 (changing these is a public API change)", () => {
    expect(LENGTH_CAPS.title).toBe(200);
    expect(LENGTH_CAPS.summary).toBe(800);
  });

  it("body is intentionally absent — body has no length cap (asymmetry preserved)", () => {
    expect("body" in LENGTH_CAPS).toBe(false);
  });
});

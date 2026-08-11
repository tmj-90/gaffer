import { describe, expect, it } from "vitest";

import {
  DEFAULT_FORBIDDEN_PATHS,
  isForbiddenPath,
  parseFragments,
} from "../src/runtime/hygiene/forbiddenPath.js";

// Pure delivery-hygiene forbidden-path policy (strangler port of hygiene.sh).
// The bash↔ts byte-identity is separately pinned by
// runner/test/hygiene-forbidden-parity.test.sh; this proves the predicate's shape.
const DEF = parseFragments(DEFAULT_FORBIDDEN_PATHS);

describe("parseFragments", () => {
  it("splits the default policy on whitespace, dropping empties", () => {
    expect(DEF).toEqual([
      "node_modules",
      ".crew/",
      "*.events.jsonl",
      ".claude/",
      "CLAUDE.factory.md",
      ".mcp.json",
      "mcp-runtime.",
    ]);
  });
});

describe("isForbiddenPath (default policy)", () => {
  it("flags substring fragments anywhere in the path", () => {
    expect(isForbiddenPath("node_modules/x/y.js", DEF)).toBe(true);
    expect(isForbiddenPath("app/.crew/state", DEF)).toBe(true);
    expect(isForbiddenPath("deep/.mcp.json", DEF)).toBe(true);
    expect(isForbiddenPath("CLAUDE.factory.md", DEF)).toBe(true);
  });
  it("flags a *-leading fragment as a whole-path glob (suffix)", () => {
    expect(isForbiddenPath("logs/run.events.jsonl", DEF)).toBe(true);
    expect(isForbiddenPath("x.events.jsonl", DEF)).toBe(true);
    // Anchored: a trailing extra char is NOT the suffix.
    expect(isForbiddenPath("src/events.jsonlx", DEF)).toBe(false);
  });
  it("does NOT flag a legit source dir that only shares a prefix (FINDING B-H2)", () => {
    // "mcp-runtime." (trailing dot) matches "mcp-runtime.123.json" but not "mcp-runtime/".
    expect(isForbiddenPath("mcp-runtime.123.json", DEF)).toBe(true);
    expect(isForbiddenPath("src/mcp-runtime/index.ts", DEF)).toBe(false);
  });
  it("leaves ordinary source paths alone", () => {
    expect(isForbiddenPath("src/index.ts", DEF)).toBe(false);
    expect(isForbiddenPath("README.md", DEF)).toBe(false);
  });
});

describe("isForbiddenPath (custom policies)", () => {
  it("treats ONLY *-leading fragments as globs (?, [ranges], [!negation])", () => {
    // Matching the bash: `case $frag in '*'*)` glob, else literal substring. So the
    // glob features only fire when the fragment itself starts with '*'.
    // `case`-glob is a FULL-path match, so `*dist?/` requires the path to END at
    // the slash (verified against the bash oracle in hygiene-forbidden-parity).
    const frags = parseFragments("*dist?/ *build[0-9]/ *.[!0-9]");
    expect(isForbiddenPath("a/dist1/", frags)).toBe(true); // any + dist + 1 char + / (ends there)
    expect(isForbiddenPath("a/dist1/x", frags)).toBe(false); // trailing content → not a full match
    expect(isForbiddenPath("a/dist/", frags)).toBe(false); // ? needs exactly one char
    expect(isForbiddenPath("x/build3/", frags)).toBe(true); // *build[0-9]/
    expect(isForbiddenPath("x/buildX/", frags)).toBe(false);
    expect(isForbiddenPath("a.b", frags)).toBe(true); // *.[!0-9] → ends in a non-digit
    expect(isForbiddenPath("a.9", frags)).toBe(false);
  });
  it("treats a non-*-leading fragment as a LITERAL substring, not a glob", () => {
    const sub = parseFragments("dist?/");
    expect(isForbiddenPath("dist1/x", sub)).toBe(false); // no literal "dist?/" present
    expect(isForbiddenPath("my/dist?/thing", sub)).toBe(true); // literal "dist?/" substring
  });
});

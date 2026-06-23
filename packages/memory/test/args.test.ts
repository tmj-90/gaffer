/**
 * The tiny CLI flag parser. Every command depends on it, so its edge
 * cases (repeated flags → array, `--flag=value`, bare booleans, `--`
 * value boundaries) are worth pinning directly.
 */
import { describe, expect, it } from "vitest";

import { getBool, getString, getStringArray, parseArgs } from "../src/cli/args.js";

describe("parseArgs", () => {
  it("separates positionals from flags", () => {
    const r = parseArgs(["show", "abc12345", "--repo", "svc"]);
    expect(r.positionals).toEqual(["show", "abc12345"]);
    expect(r.flags["repo"]).toBe("svc");
  });

  it("supports --flag=value form", () => {
    const r = parseArgs(["--limit=20", "--repo=payments-svc"]);
    expect(r.flags["limit"]).toBe("20");
    expect(r.flags["repo"]).toBe("payments-svc");
  });

  it("treats a flag with no following value as boolean true", () => {
    const r = parseArgs(["--dry-run", "--force"]);
    expect(r.flags["dry-run"]).toBe(true);
    expect(r.flags["force"]).toBe(true);
  });

  it("a flag followed by another flag is boolean, not consuming the next flag", () => {
    const r = parseArgs(["--prefix", "--repo", "svc"]);
    expect(r.flags["prefix"]).toBe(true);
    expect(r.flags["repo"]).toBe("svc");
  });

  it("collects a repeated flag into an array", () => {
    const r = parseArgs(["--tag", "a", "--tag", "b", "--tag", "c"]);
    expect(r.flags["tag"]).toEqual(["a", "b", "c"]);
  });

  it("handles an empty argv", () => {
    const r = parseArgs([]);
    expect(r.positionals).toEqual([]);
    expect(r.flags).toEqual({});
  });

  it("keeps positionals that appear after flags", () => {
    const r = parseArgs(["--repo", "svc", "extra", "words"]);
    expect(r.positionals).toEqual(["extra", "words"]);
  });
});

describe("getString", () => {
  it("returns the value, or the last value when repeated", () => {
    expect(getString({ x: "one" }, "x")).toBe("one");
    expect(getString({ x: ["one", "two"] }, "x")).toBe("two");
  });
  it("returns undefined for a missing flag or a bare boolean", () => {
    expect(getString({}, "x")).toBeUndefined();
    expect(getString({ x: true }, "x")).toBeUndefined();
  });
});

describe("getStringArray", () => {
  it("normalises single / repeated / missing into an array", () => {
    expect(getStringArray({ tag: "a" }, "tag")).toEqual(["a"]);
    expect(getStringArray({ tag: ["a", "b"] }, "tag")).toEqual(["a", "b"]);
    expect(getStringArray({}, "tag")).toEqual([]);
    expect(getStringArray({ tag: true }, "tag")).toEqual([]);
  });
  it("returns a fresh array (caller can mutate without aliasing flags)", () => {
    const flags = { tag: ["a", "b"] };
    const out = getStringArray(flags, "tag");
    out.push("c");
    expect(flags.tag).toEqual(["a", "b"]);
  });
});

describe("getBool", () => {
  it("is true for boolean-true and the literal string 'true'", () => {
    expect(getBool({ f: true }, "f")).toBe(true);
    expect(getBool({ f: "true" }, "f")).toBe(true);
  });
  it("is false for missing, other strings, or arrays", () => {
    expect(getBool({}, "f")).toBe(false);
    expect(getBool({ f: "false" }, "f")).toBe(false);
    expect(getBool({ f: "yes" }, "f")).toBe(false);
  });
});

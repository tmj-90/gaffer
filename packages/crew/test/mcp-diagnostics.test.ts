/**
 * Defensive-startup diagnostics: the `crew-mcp` bin must turn a
 * CrewError thrown during startup into an actionable, multi-line message
 * (not a raw stack), because MCP clients surface only "server failed to start".
 *
 * `diagnoseStartupError` is the pure mapping behind that message; these tests
 * pin each known startup code to concrete remediation guidance and assert the
 * unknown-code fallback degrades gracefully.
 */
import { describe, expect, it } from "vitest";

import { diagnoseStartupError } from "../src/mcp/diagnostics.js";
import { CrewError } from "../src/util/errors.js";

describe("diagnoseStartupError", () => {
  it("always leads with the machine-readable code and message", () => {
    const out = diagnoseStartupError(new CrewError("INVALID_CONFIG", "boom"));
    expect(out).toContain("reason (INVALID_CONFIG): boom");
  });

  it("coaches CONFIG_NOT_FOUND towards -c / CREW_CONFIG / init", () => {
    const out = diagnoseStartupError(new CrewError("CONFIG_NOT_FOUND", "no file"));
    expect(out).toContain("crew-mcp -c");
    expect(out).toContain("CREW_CONFIG");
    expect(out).toContain("crew init");
  });

  it("coaches INVALID_CONFIG towards fixing validation issues + doctor", () => {
    const out = diagnoseStartupError(new CrewError("INVALID_CONFIG", "bad yaml"));
    expect(out).toContain("validation issues");
    expect(out).toContain("crew doctor");
  });

  it("coaches DISPATCH_UNAVAILABLE towards building the dispatch package", () => {
    const out = diagnoseStartupError(new CrewError("DISPATCH_UNAVAILABLE", "no dist"));
    expect(out).toContain("dispatch build");
  });

  it("falls back to `crew doctor` for an unknown startup code", () => {
    const out = diagnoseStartupError(new CrewError("SOMETHING_NEW", "?"));
    expect(out).toContain("reason (SOMETHING_NEW): ?");
    expect(out).toContain("crew doctor");
  });

  it("renders as multiple bulleted lines, never a single blob", () => {
    const out = diagnoseStartupError(new CrewError("CONFIG_NOT_FOUND", "x"));
    const lines = out.split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.slice(1).every((l) => l.trimStart().startsWith("•"))).toBe(true);
  });
});

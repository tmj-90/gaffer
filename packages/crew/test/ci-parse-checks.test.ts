import { describe, expect, it } from "vitest";

import { parseChecks } from "../src/runtime/ci/parseChecks.js";

// Pure CI check-status verdict (strangler port of gaffer_parse_checks). The
// bash↔ts byte-identity is pinned by runner/test/ci-gate-parse-parity.test.sh;
// this proves the shape. Rows are `<name>\t<status>\t<conclusion>\t<url>`.
const row = (...c: string[]): string => c.join("\t");

describe("parseChecks", () => {
  it("empty input → unknown", () => {
    expect(parseChecks("")).toBe("unknown");
  });
  it("all success → pass", () => {
    expect(
      parseChecks(
        [row("build", "completed", "success", "u1"), row("t", "completed", "success", "u2")].join(
          "\n",
        ),
      ),
    ).toBe("pass");
  });
  it("a failing conclusion → fail:<name>|<url> (first match wins)", () => {
    expect(
      parseChecks(
        [
          row("build", "completed", "success", "u1"),
          row("test", "completed", "failure", "u2"),
        ].join("\n"),
      ),
    ).toBe("fail:test|u2");
  });
  it("an error in the status column also trips red", () => {
    expect(parseChecks(row("lint", "error", "", "uz"))).toBe("fail:lint|uz");
  });
  it("fail takes precedence over pending regardless of order", () => {
    expect(
      parseChecks(
        [row("a", "pending", "", "u1"), row("b", "completed", "failure", "u2")].join("\n"),
      ),
    ).toBe("fail:b|u2");
  });
  it("pending / queued / in_progress / waiting → pending", () => {
    expect(parseChecks(row("b", "in_progress", "", "u"))).toBe("pending");
    expect(parseChecks(row("b", "", "queued", "u"))).toBe("pending");
    expect(parseChecks(row("b", "waiting", "", "u"))).toBe("pending");
  });
  it("empty name → 'unknown'; missing url → ''", () => {
    expect(parseChecks(row("", "failure", "", "u"))).toBe("fail:unknown|u");
    expect(parseChecks(row("build", "completed", "failure"))).toBe("fail:build|");
  });
  it("status casing is folded (awk tolower)", () => {
    expect(parseChecks(row("build", "FAILURE", "", "u"))).toBe("fail:build|u");
  });
});

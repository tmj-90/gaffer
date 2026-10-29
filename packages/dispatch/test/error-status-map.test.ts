import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { statusForCode } from "../src/api/http.js";
import { DISPATCH_ERROR_CODES } from "../src/util/errors.js";

/**
 * Backstop for the type check: every code a DispatchError is thrown with in src/ is
 * declared, and none of them silently maps to a 500 (only the genuine server-side
 * failures do). The scan is whitespace-tolerant on purpose — most of the codes that
 * used to 500 put the string on the line after `new DispatchError(`.
 */

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const SERVER_SIDE = new Set(["INTERNAL_ERROR", "UNSAFE_BIND", "IO_ERROR"]);

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "web" ? [] : tsFiles(p);
    return p.endsWith(".ts") ? [p] : [];
  });
}

function thrownCodes(): Set<string> {
  const codes = new Set<string>();
  for (const file of tsFiles(SRC)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/DispatchError\(\s*"([A-Z_]+)"/g)) codes.add(m[1] as string);
    // The ternary form: DispatchError(\n  cond ? "A" : "B", …)
    for (const m of text.matchAll(/DispatchError\(\s*[^"()]+\?\s*"([A-Z_]+)"\s*:\s*"([A-Z_]+)"/g)) {
      codes.add(m[1] as string);
      codes.add(m[2] as string);
    }
  }
  return codes;
}

describe("DispatchError codes → HTTP status", () => {
  it("the scan finds the codes that used to fall through to 500", () => {
    const codes = thrownCodes();
    for (const c of ["TEST_CONTRACT_LEAK", "BINDING_REQUIRED", "CONTRACT_MISMATCH"]) {
      expect(codes.has(c)).toBe(true);
    }
  });

  it("every thrown code is declared in DISPATCH_ERROR_CODES", () => {
    const declared = new Set<string>(DISPATCH_ERROR_CODES);
    expect([...thrownCodes()].filter((c) => !declared.has(c))).toEqual([]);
  });

  it("no domain refusal maps to 500", () => {
    const fiveHundreds = DISPATCH_ERROR_CODES.filter(
      (c) => !SERVER_SIDE.has(c) && statusForCode(c) >= 500 && c !== "NOT_CONFIGURED",
    );
    expect(fiveHundreds).toEqual([]);
    expect(statusForCode("NOT_CONFIGURED")).toBe(503);
    expect(statusForCode("TEST_CONTRACT_LEAK")).toBe(422);
    expect(statusForCode("BINDING_REQUIRED")).toBe(422);
    expect(statusForCode("CONTRACT_MISMATCH")).toBe(409);
    expect(statusForCode("FACTORY_RUNNER_OWNED")).toBe(409);
    expect(statusForCode("SOMETHING_UNKNOWN")).toBe(500);
  });
});

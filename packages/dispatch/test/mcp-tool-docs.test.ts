import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MCP_TOOLS_END, MCP_TOOLS_START, spliceMcpToolTable } from "../src/mcp/toolDocs.js";
import { toolSchemas } from "../src/mcp/tools.js";
import { DISPATCH_ERROR_CODES } from "../src/util/errors.js";

/**
 * The MCP docs used to drift from the code: the README said "18 agent-facing
 * tools" (there are 23) and docs/03 documented tools that never existed with an
 * error model the server does not use. The README table is now generated; these
 * tests fail the moment it, or docs/03's error codes, fall out of step.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const README = read("../README.md");
const PLAN = read("../docs/03-mcp-tools.md");

function readmeSection(): string {
  return README.slice(README.indexOf(MCP_TOOLS_START), README.indexOf(MCP_TOOLS_END));
}

describe("MCP tool docs match the code", () => {
  it("the README table is what scripts/mcp-tools-doc.mjs would write", () => {
    expect(spliceMcpToolTable(README)).toBe(README);
  });

  it("every registered tool is in the README table, and nothing else is", () => {
    const named = [...readmeSection().matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]);
    expect(named.sort()).toEqual(Object.keys(toolSchemas).sort());
    expect(README).not.toMatch(/exposes \d+ agent-facing tools/);
  });

  it("docs/03 is marked as the historical plan; its tool headings are real or covered by that", () => {
    const real = new Set(Object.keys(toolSchemas));
    const headings = [...PLAN.matchAll(/^### ([a-z_]+)\s*$/gm)].map((m) => m[1] as string);
    const ghosts = headings.filter((h) => !real.has(h));
    expect(ghosts.length === 0 || /Historical design plan/.test(PLAN)).toBe(true);
  });

  it("docs/03's error model uses the real shape and real codes", () => {
    const section = PLAN.slice(PLAN.indexOf("## Error model"));
    expect(section).not.toContain("recoverable");
    expect(section).toContain('"details"');
    const codes = [...section.matchAll(/^([A-Z][A-Z_]+)$/gm)].map((m) => m[1] as string);
    expect(codes.length).toBeGreaterThan(5);
    const declared = new Set<string>(DISPATCH_ERROR_CODES);
    expect(codes.filter((c) => !declared.has(c))).toEqual([]);
    for (const m of section.matchAll(/"code": "([A-Z_]+)"/g)) {
      expect(declared.has(m[1] as string)).toBe(true);
    }
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { VERSION } from "../src/version.js";

/**
 * The MCP handshake and CLI `--version` must report the published version, not a
 * hand-maintained literal that silently drifts. These tests pin VERSION to the
 * single source of truth (package.json) and prove the server constructor uses it.
 */
describe("version single-source-of-truth", () => {
  it("VERSION equals package.json#version", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
      version: string;
    };
    expect(VERSION).toBe(pkg.version);
    expect(VERSION).not.toBe("0.0.0"); // the fallback should never be the real value
  });

  it("has no hardcoded version literal left in the MCP server source", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "..", "src", "mcp", "server.ts"), "utf8");
    // The McpServer must be constructed with the imported VERSION, never a
    // string literal — guards against re-introducing the drift this fix closed.
    expect(src).toMatch(/version:\s*VERSION/);
    expect(src).not.toMatch(/version:\s*["']\d+\.\d+\.\d+["']/);
  });
});

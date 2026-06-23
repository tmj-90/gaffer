/**
 * resolveUnderstandingSink — the WRITE-sink resolver for the onboard flush.
 *
 * Asserts the priority order that makes a fresh install populate memory on first
 * onboard WITHOUT an MCP server:
 *   - MEMORY_CLI_BIN + MEMORY_DB in the env  → CliMemoryClient (preferred);
 *   - memory.cli.command + MEMORY_DB (env)   → CliMemoryClient;
 *   - no CLI channel + mcp.command null            → null (flush no-ops);
 *   - memory.enabled false                      → null.
 */
import { describe, expect, it } from "vitest";

import { resolveUnderstandingSink } from "../src/memory/factory.js";
import { CliMemoryClient } from "../src/memory/cliClient.js";
import { testConfig } from "./helpers.js";

describe("resolveUnderstandingSink", () => {
  it("prefers the env-driven CLI bridge (no MCP server) even with mcp.command null", async () => {
    const config = testConfig();
    expect(config.memory.mcp.command).toBeNull();

    const sink = await resolveUnderstandingSink(config, undefined, {
      MEMORY_CLI_BIN: "/bin/lg.js",
      MEMORY_DB: "/db.sqlite",
    });
    expect(sink).toBeInstanceOf(CliMemoryClient);
  });

  it("uses memory.cli.command + MEMORY_DB (env) when no MEMORY_CLI_BIN is set", async () => {
    const base = testConfig();
    const config = {
      ...base,
      memory: { ...base.memory, cli: { command: "/configured/lg.js" } },
    };

    const sink = await resolveUnderstandingSink(config, undefined, { MEMORY_DB: "/db.sqlite" });
    expect(sink).toBeInstanceOf(CliMemoryClient);
  });

  it("returns null when no CLI channel and no MCP server are configured", async () => {
    const sink = await resolveUnderstandingSink(testConfig(), undefined, {});
    expect(sink).toBeNull();
  });

  it("returns null when memory is disabled, regardless of env", async () => {
    const base = testConfig();
    const config = { ...base, memory: { ...base.memory, enabled: false } };
    const sink = await resolveUnderstandingSink(config, undefined, {
      MEMORY_CLI_BIN: "/bin/lg.js",
      MEMORY_DB: "/db.sqlite",
    });
    expect(sink).toBeNull();
  });
});

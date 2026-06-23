#!/usr/bin/env node
import { CrewError } from "../util/errors.js";
import { diagnoseStartupError } from "./diagnostics.js";
import { runStdioServer } from "./server.js";

/**
 * `crew-mcp` entrypoint: serve the factory tools over stdio. Config is
 * resolved from `-c`/`--config` or `CREW_CONFIG`, falling back to the
 * default `crew.yaml` lookup.
 *
 * Startup failures (missing/invalid config, an unreachable Dispatch) must NOT
 * surface to the MCP client as a raw stack — the client typically shows only
 * "server failed to start". We catch `CrewError` and write an actionable,
 * multi-line diagnostic to stderr (which clients surface on launch failure),
 * then exit cleanly. Only genuinely unexpected (non-CrewError) throws are
 * re-raised, since those are programming errors worth a stack trace.
 */
async function main(): Promise<void> {
  try {
    await runStdioServer();
  } catch (err) {
    if (err instanceof CrewError) {
      process.stderr.write(`crew-mcp: could not start.\n${diagnoseStartupError(err)}\n`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

void main();

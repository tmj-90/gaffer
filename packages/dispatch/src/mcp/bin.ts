#!/usr/bin/env node
import { runStdioServer } from "./server.js";

runStdioServer().catch((err: unknown) => {
  // stdout is the MCP transport — diagnostics must go to stderr only.
  process.stderr.write(`dispatch-mcp failed to start: ${String(err)}\n`);
  process.exitCode = 1;
});

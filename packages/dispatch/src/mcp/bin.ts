#!/usr/bin/env node
import { enableCompileCache } from "../util/compileCache.js";

// Turn on the compile cache before the server's modules load (see compileCache.ts).
enableCompileCache();
const { runStdioServer } = await import("./server.js");

runStdioServer().catch((err: unknown) => {
  // stdout is the MCP transport — diagnostics must go to stderr only.
  process.stderr.write(`dispatch-mcp failed to start: ${String(err)}\n`);
  process.exitCode = 1;
});

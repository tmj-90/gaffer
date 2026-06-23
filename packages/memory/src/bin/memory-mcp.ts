#!/usr/bin/env node
import { runMcpServer } from "../mcp/server.js";

runMcpServer().catch((err) => {
  process.stderr.write(
    `memory-mcp: fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});

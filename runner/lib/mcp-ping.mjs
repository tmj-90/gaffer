#!/usr/bin/env node
// Live stdio handshake with one of the factory's MCP servers: connect, list the tools,
// print them, close. Used by demo.sh ("the two MCP servers are real") and preflight.sh.
//
//   node runner/lib/mcp-ping.mjs <server-bin.js> <ENV_KEY> <ENV_VALUE> [--names]
//     prints the tool count, or with --names "<n> tools — a, b, c"
//
// Both scripts used to WRITE a ping script into packages/memory (so that the bare
// `@modelcontextprotocol/sdk` import resolved from there) and delete it afterwards:
// a write inside the checkout, left behind whenever the run was interrupted. This
// file is committed and resolves the SDK from packages/memory (or $MEMORY_DIR)
// explicitly, so nothing is written anywhere.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const memoryDir = process.env.MEMORY_DIR || path.resolve(HERE, "..", "..", "packages", "memory");
const req = createRequire(path.join(memoryDir, "package.json"));
const { Client } = req("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = req("@modelcontextprotocol/sdk/client/stdio.js");

const [bin, key, value, mode] = process.argv.slice(2);
if (!bin || !key) {
  console.error("usage: mcp-ping.mjs <server-bin.js> <ENV_KEY> <ENV_VALUE> [--names]");
  process.exit(2);
}
const client = new Client({ name: "gaffer-ping", version: "0" }, { capabilities: {} });
await client.connect(
  new StdioClientTransport({
    command: "node",
    args: [bin],
    env: { ...process.env, [key]: value ?? "" },
  }),
);
const tools = (await client.listTools()).tools.map((t) => t.name);
console.log(
  mode === "--names" ? `${tools.length} tools — ${tools.join(", ")}` : String(tools.length),
);
await client.close();

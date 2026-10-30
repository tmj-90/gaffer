#!/usr/bin/env node
// MCP tool reference generator — the README's tool table, derived from the code.
//
// packages/dispatch/src/mcp/toolDocs.ts renders every registered tool (its
// arguments + the lead sentence of its coaching description); this script splices
// that table between the <!-- mcp-tools:start/end --> markers in
// packages/dispatch/README.md, and fails (--check) when the committed table no
// longer matches the code — the same discipline as docs/openapi.json.
//
//   node scripts/mcp-tools-doc.mjs           # rewrite the README section
//   node scripts/mcp-tools-doc.mjs --check   # exit 1 if it is stale
//
// Requires packages/dispatch to be built (reads dist/mcp/toolDocs.js).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS_JS = path.join(ROOT, "packages", "dispatch", "dist", "mcp", "toolDocs.js");
const README = path.join(ROOT, "packages", "dispatch", "README.md");

if (!existsSync(DOCS_JS)) {
  console.error(
    `mcp-tools-doc: ${path.relative(ROOT, DOCS_JS)} not found — build packages/dispatch first (pnpm -C packages/dispatch build)`,
  );
  process.exit(2);
}
const { spliceMcpToolTable } = await import(pathToFileURL(DOCS_JS).href);
const current = readFileSync(README, "utf8");
const next = spliceMcpToolTable(current);

if (process.argv.includes("--check")) {
  if (next !== current) {
    console.error(
      "packages/dispatch/README.md MCP tool table is stale — regenerate with: node scripts/mcp-tools-doc.mjs",
    );
    process.exit(1);
  }
  console.log("packages/dispatch/README.md MCP tool table is up to date");
} else {
  writeFileSync(README, next);
  console.log("wrote the MCP tool table in packages/dispatch/README.md");
}

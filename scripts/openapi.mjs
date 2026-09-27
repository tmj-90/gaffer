#!/usr/bin/env node
// OpenAPI reference generator — the REST contract, derived from the code.
//
// packages/dispatch/src/api/openapi/spec.ts lists every endpoint the router
// serves and points each request body / query at the zod schema the route parses
// with; buildOpenApiDocument() renders that as OpenAPI 3.1. This script writes the
// document to docs/openapi.json and fails CI (--check) when the committed file no
// longer matches the code — the same discipline as docs/CONFIG.md.
//
//   node scripts/openapi.mjs           # write docs/openapi.json
//   node scripts/openapi.mjs --check   # exit 1 if docs/openapi.json is stale
//
// Requires packages/dispatch to be built (reads dist/api/openapi/spec.js). The
// running dashboard serves the same document at GET /api/openapi.json.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SPEC_JS = path.join(ROOT, "packages", "dispatch", "dist", "api", "openapi", "spec.js");
const OUT = path.join(ROOT, "docs", "openapi.json");

if (!existsSync(SPEC_JS)) {
  console.error(
    `openapi: ${path.relative(ROOT, SPEC_JS)} not found — build packages/dispatch first (pnpm -C packages/dispatch build)`,
  );
  process.exit(2);
}
const { buildOpenApiDocument, ENDPOINTS } = await import(pathToFileURL(SPEC_JS).href);
const text = JSON.stringify(buildOpenApiDocument(), null, 2) + "\n";

if (process.argv.includes("--check")) {
  const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (current !== text) {
    console.error(`openapi: ${path.relative(ROOT, OUT)} is stale — run: node scripts/openapi.mjs`);
    process.exit(1);
  }
  console.log(`${path.relative(ROOT, OUT)} is up to date (${ENDPOINTS.length} endpoints)`);
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${path.relative(ROOT, OUT)} (${ENDPOINTS.length} endpoints)`);
}

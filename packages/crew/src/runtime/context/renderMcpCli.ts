#!/usr/bin/env node
// =====================================================================
// Node entrypoint for the tick.sh `.mcp.json` runtime render
// (P1b context assembly, docs/tick-sh-runtime-migration.md).
// ---------------------------------------------------------------------
// This is the LIVE render seam: tick.sh (delivery + bootstrap) invokes
// this CLI to render its per-tick runtime .mcp.json, replacing the bash
// sed substitution chain. It routes the render through the golden-tested
// typed renderer (renderMcpRuntimeConfig, ./mcpConfig.ts) so the unit /
// golden test IS the live behaviour — closing the divergence that let a
// bash-only render path ship an unsubstituted ${GAFFER_RECALL_TICKET}.
//
// Dependency surface is kept as tiny as select-skills.mjs: this imports
// ONLY ./mcpConfig.js (which imports only ../../util/errors.js) — NOT the
// crew CLI, dispatch, or zod — so startup stays fast and side-effect-free.
//
// CONTRACT (env for values, argv for the two file paths):
//   node renderMcpCli.js --template <path> --out <path>
// Values are read from env (raw, un-escaped strings) so a claim token or
// a path containing sed/replace specials is never exposed on the process
// argv (ps / /proc/<pid>/cmdline) and never re-interpreted as a pattern:
//   GAFFER_MCP_DISPATCH_DB     → dispatchDb
//   GAFFER_MCP_MEMORY_DB       → memoryDb
//   GAFFER_MCP_DISPATCH_BIN    → dispatchMcpBin
//   GAFFER_MCP_MEMORY_BIN      → memoryMcpBin
//   GAFFER_MCP_CLAIM_TOKEN     → claimToken       (may legitimately be "")
//   GAFFER_MCP_TICKET_REPOS    → ticketRepos      (may legitimately be "")
//   GAFFER_MCP_RECALL_TICKET   → recallTicket     (may legitimately be "")
//
// BYTE-IDENTITY: renderMcpRuntimeConfig returns the rendered template
// verbatim (it does not strip or add a trailing newline), and this writes
// it with writeFileSync (no console.log — that would append a byte). The
// output is therefore byte-identical to the prior bash sed render for the
// same inputs (proven by runner/test/mcp-render-parity.test.sh).
//
// FAIL-CLOSED: a CrewError from the renderer (leftover placeholder, invalid
// JSON, missing dispatch/memory server) is printed to stderr and exits 1,
// so a broken MCP config never reaches a live agent launch — a strict
// improvement over the bash sed, which never validated its output.
// =====================================================================

import { readFileSync, writeFileSync } from "node:fs";

import { CrewError } from "../../util/errors.js";
import { renderMcpRuntimeConfig } from "./mcpConfig.js";

/** Parse the two --flag <value> path args; unknown flags are ignored. */
function parsePathArgs(argv: string[]): { template: string; out: string } {
  let template = "";
  let out = "";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--template") {
      template = argv[(i += 1)] ?? "";
    } else if (arg === "--out") {
      out = argv[(i += 1)] ?? "";
    }
  }
  return { template, out };
}

function main(): void {
  const { template, out } = parsePathArgs(process.argv.slice(2));
  if (!template || !out) {
    process.stderr.write("render-mcp: usage: renderMcpCli.js --template <path> --out <path>\n");
    process.exit(2);
  }

  const env = process.env;
  const templateText = readFileSync(template, "utf8");
  const rendered = renderMcpRuntimeConfig(templateText, {
    dispatchDb: env.GAFFER_MCP_DISPATCH_DB ?? "",
    memoryDb: env.GAFFER_MCP_MEMORY_DB ?? "",
    dispatchMcpBin: env.GAFFER_MCP_DISPATCH_BIN ?? "",
    memoryMcpBin: env.GAFFER_MCP_MEMORY_BIN ?? "",
    claimToken: env.GAFFER_MCP_CLAIM_TOKEN ?? "",
    ticketRepos: env.GAFFER_MCP_TICKET_REPOS ?? "",
    recallTicket: env.GAFFER_MCP_RECALL_TICKET ?? "",
  });

  // writeFileSync — NOT console.log / stdout + "\n": the render must land
  // byte-identical, so no extra trailing newline may be introduced.
  writeFileSync(out, rendered);
}

try {
  main();
} catch (err) {
  if (err instanceof CrewError) {
    process.stderr.write(`render-mcp: ${err.code}: ${err.message}\n`);
  } else {
    process.stderr.write(`render-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  process.exit(1);
}

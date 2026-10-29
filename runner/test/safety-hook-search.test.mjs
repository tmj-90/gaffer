#!/usr/bin/env node
// Search-tool boundary: Grep / Glob / LS read the filesystem like Read does (Claude
// Code runs ripgrep with --hidden), so the hook checks their search root and glob,
// rewrites an allowed Grep to exclude secret files, and refuses tools it does not
// know instead of waving them through.
// Run: node test/safety-hook-search.test.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { runHook, scratchDir, suite, tool } from "./lib/hook-harness.mjs";

const t = suite("safety-hook-search");
const ROOT = scratchDir("gaffer-search-root-");
const HOME = scratchDir("gaffer-search-home-");
const DATA = scratchDir("gaffer-search-data-");
for (const d of [ROOT, HOME, DATA]) t.cleanup(d);
mkdirSync(`${ROOT}/src`, { recursive: true });
writeFileSync(`${DATA}/dashboard-token`, "tok\n");
writeFileSync(`${DATA}/mcp-runtime.123.json`, "{}\n");
const env = { HOME, GAFFER_DATA: DATA, GAFFER_WRITE_ROOTS: ROOT, GAFFER_READ_ROOTS: "" };
const opts = { env, cwd: ROOT };
// Fallback: no roots configured (reads are not root-restricted) — the home and
// factory-state guards must still hold.
const fallback = {
  env: { HOME, GAFFER_DATA: DATA, GAFFER_WRITE_ROOTS: "", GAFFER_READ_ROOTS: "" },
  cwd: ROOT,
};

const grep = (input) => tool("Grep", { pattern: "x", ...input });

// Secret files / out-of-root trees through Grep → DENY.
t.deny("Grep over the dashboard-token file", grep({ path: `${DATA}/dashboard-token` }), opts);
t.deny(
  "Grep over the mcp-runtime claim-token file",
  grep({ path: `${DATA}/mcp-runtime.123.json` }),
  opts,
);
t.deny("Grep over $GAFFER_DATA (outside roots)", grep({ path: DATA }), opts);
t.deny("Grep over HOME (outside roots)", grep({ path: HOME }), opts);
t.deny("Grep over ~ (tilde → HOME)", grep({ path: "~" }), opts);
t.deny(
  "Grep glob .env* (content mode)",
  grep({ path: "src", glob: ".env*", output_mode: "content" }),
  opts,
);
t.deny("Grep glob **/.env", grep({ glob: "**/.env" }), opts);
t.deny("Grep glob *.pem", grep({ glob: "*.pem" }), opts);
t.deny("Grep glob brace {.env,x}", grep({ glob: "{.env,x.ts}" }), opts);
t.deny("Grep under fallback over $GAFFER_DATA", grep({ path: DATA }), fallback);
t.deny("Grep under fallback over HOME", grep({ path: HOME }), fallback);
t.deny("Grep under fallback over /", grep({ path: "/" }), fallback);

// Glob / LS.
t.deny("Glob **/.env*", tool("Glob", { pattern: "**/.env*" }), opts);
t.deny("Glob absolute pattern outside roots", tool("Glob", { pattern: "/etc/**/*.conf" }), opts);
t.deny("Glob ../ pattern climbing out of the root", tool("Glob", { pattern: "../**/*.ts" }), opts);
t.deny("Glob path HOME", tool("Glob", { pattern: "**/*", path: HOME }), opts);
t.deny("Glob ~/ pattern", tool("Glob", { pattern: "~/.config/**" }), fallback);
t.deny("LS of HOME", tool("LS", { path: HOME }), opts);

// Unknown tools reaching the hook fail closed; known non-file tools pass.
t.deny("unknown tool", tool("Frobnicate", {}), opts);
t.deny("WebFetch routed to the hook", tool("WebFetch", { url: "https://x" }), opts);
t.allow("TodoWrite", tool("TodoWrite", { todos: [] }), opts);
t.allow("dispatch MCP tool", tool("mcp__dispatch__get_ticket", { id: 1 }), opts);
t.allow("memory MCP tool", tool("mcp__memory__search", { q: "x" }), opts);

// Legitimate searches stay allowed — the content `pattern` is never a path.
t.allow("Grep pattern 'token' over src", grep({ pattern: "token", path: "src" }), opts);
t.allow(
  "Grep pattern 'secret|credentials' (content regex)",
  grep({ pattern: "secret|credentials" }),
  opts,
);
t.allow("Grep with a code glob", grep({ glob: "*.{ts,tsx}" }), opts);
t.allow("Glob src/**/*.ts", tool("Glob", { pattern: "src/**/*.ts" }), opts);
t.allow("Grep with no path under fallback", grep({}), fallback);

// An allowed Grep is rewritten so ripgrep skips secret files inside the tree.
{
  const res = runHook(grep({ path: "src", glob: "*.ts" }), opts);
  let out = null;
  try {
    out = JSON.parse(res.stdout);
  } catch {
    /* asserted below */
  }
  const glob = out?.hookSpecificOutput?.updatedInput?.glob ?? "";
  t.assert("Grep allow exits 0", res.status === 0);
  t.assert(
    "Grep allow emits a PreToolUse decision",
    out?.hookSpecificOutput?.hookEventName === "PreToolUse",
  );
  t.assert("updatedInput keeps the agent's own glob first", glob.startsWith("*.ts "));
  t.assert(
    "updatedInput keeps the pattern/path",
    out?.hookSpecificOutput?.updatedInput?.path === "src",
  );
  for (const ex of [
    "!**/.env",
    "!**/.env.*",
    "!**/dashboard-token*",
    "!**/mcp-runtime*.json",
    "!**/*.pem",
  ]) {
    t.assert(`updatedInput excludes ${ex}`, glob.split(" ").includes(ex));
  }
}

t.done();

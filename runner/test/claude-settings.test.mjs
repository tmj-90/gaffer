#!/usr/bin/env node
// The agent settings template (runner/claude/settings.json) is the ROUTING contract
// for the safety hook: a tool with no PreToolUse matcher never reaches the hook at
// all. Grep and Glob were allowed but unmatched, so they read nested `.env` files and
// the factory's token files with no check. This pins:
//   • every file-touching tool the template allows has a PreToolUse matcher;
//   • every safety-hook entry fails closed (onFailure: block) with a timeout;
//   • the Read deny rules are recursive/absolute, not cwd-root-only `./` forms (Claude
//     Code turns them into ripgrep excludes for Grep/Glob), and never `~/**`;
//   • spawns without project settings (onboard-analyze) carry the same Read rules.
// Run: node test/claude-settings.test.mjs
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { secretReadDenyRules } from "../lib/agent-home.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = resolve(HERE, "..");
const settings = JSON.parse(readFileSync(resolve(RUNNER, "claude", "settings.json"), "utf8"));

let passed = 0;
const failures = [];
const check = (label, ok) => (ok ? (passed += 1) : failures.push(label));

const FILE_TOOLS = ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "Read", "Grep", "Glob"];
const matchers = (settings.hooks?.PreToolUse ?? []).filter((m) =>
  (m.hooks ?? []).some((h) => String(h.command).includes("${RUNNER_DIR}/safety-hook.mjs")),
);
const routed = (name) => matchers.some((m) => new RegExp(`^(?:${m.matcher})$`).test(name));
const allowed = settings.permissions?.allow ?? [];

for (const name of FILE_TOOLS) {
  check(`file tool ${name} has a safety-hook PreToolUse matcher`, routed(name));
}
for (const name of allowed) {
  if (FILE_TOOLS.includes(name)) {
    check(`allowed file tool ${name} is routed to the hook`, routed(name));
  }
}

// Claude Code's default for a hook that times out, crashes or exits other than 0/2 is
// to report it and RUN the tool: every safety-hook entry must fail closed instead,
// with a bounded timeout (a pathological command must not outlast the hook).
for (const m of matchers) {
  for (const h of m.hooks ?? []) {
    if (!String(h.command).includes("${RUNNER_DIR}/safety-hook.mjs")) continue;
    check(`safety-hook entry for ${m.matcher} sets onFailure: block`, h.onFailure === "block");
    check(
      `safety-hook entry for ${m.matcher} sets an explicit timeout (seconds)`,
      Number.isInteger(h.timeout) && h.timeout > 0 && h.timeout <= 120,
    );
  }
}

const deny = settings.permissions?.deny ?? [];
for (const rule of deny) {
  check(`deny rule is not cwd-root-only: ${rule}`, !/^Read\(\.\//.test(rule));
  check(`deny rule does not blanket-deny HOME: ${rule}`, rule !== "Read(~/**)");
}
for (const need of [
  "Read(**/.env)",
  "Read(**/.env.local)",
  "Read(**/*.env)",
  "Read(**/*.pem)",
  "Read(**/*.key)",
  "Read(**/dashboard-token*)",
  "Read(**/mcp-runtime*.json)",
  "Read(//**/dashboard-token*)",
  "Read(//**/mcp-runtime*.json)",
]) {
  check(`deny list carries ${need}`, deny.includes(need));
}

// onboard-analyze runs in RUNNER_DIR with no rendered settings: it must pass the
// template's Read rules through --disallowedTools.
const readRules = deny.filter((r) => r.startsWith("Read("));
check(
  "secretReadDenyRules() returns every Read deny rule of the template",
  JSON.stringify(secretReadDenyRules()) === JSON.stringify(readRules),
);
const onboard = readFileSync(resolve(RUNNER, "lib", "onboard-analyze.mjs"), "utf8");
check(
  "onboard-analyze passes secretReadDenyRules() via --disallowedTools",
  /"--disallowedTools",[\s\S]{0,200}\.\.\.secretReadDenyRules\(\)/.test(onboard),
);

if (failures.length) {
  console.error(`FAIL claude-settings — ${failures.length} failed, ${passed} passed`);
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`PASS claude-settings — ${passed} checks passed`);

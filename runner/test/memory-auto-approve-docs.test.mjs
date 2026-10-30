#!/usr/bin/env node
// What MEMORY_AUTO_APPROVE covers in the factory must read the same everywhere it is
// described, and match the config the agent actually gets. runner/.mcp.json pins
// MEMORY_AUTO_APPROVE=0 on the agent-mounted memory server, so an agent's suggest_lore
// is always a draft there; the flag only covers the runner's own memory writes. The
// memory package README used to promise "a fully hands-off factory … suggest_lore
// lands active immediately" after that pin landed. This pins the config and the text
// of the three docs that describe it, so a change to either side shows up here.
// Run: node test/memory-auto-approve-docs.test.mjs
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const read = (f) => readFileSync(resolve(ROOT, f), "utf8");

let passed = 0;
const failures = [];
const check = (label, ok) => (ok ? (passed += 1) : failures.push(label));

// The config side: the agent-mounted memory server is pinned to drafts.
const mcp = JSON.parse(read("runner/.mcp.json"));
check(
  "runner/.mcp.json pins MEMORY_AUTO_APPROVE=0 on the memory server",
  mcp?.mcpServers?.memory?.env?.MEMORY_AUTO_APPROVE === "0",
);

// packages/memory/README.md — the "Autonomous mode" section.
const readme = read("packages/memory/README.md");
const a = readme.indexOf("## Autonomous mode");
const section = a < 0 ? "" : readme.slice(a, readme.indexOf("\n## ", a + 1));
const flat = section.replace(/\s+/g, " ");
check("README has an Autonomous mode section", section.length > 0);
check(
  "README does not promise a hands-off factory for agent lore",
  !/hands-off factory/i.test(flat),
);
check(
  "README scopes 'suggest_lore lands active' to standalone memory-mcp",
  /Standalone memory-mcp\*\*[^.]*suggest_lore`? lands `?active/i.test(flat),
);
check(
  "README: in the factory, agent MCP suggestions always stay a draft",
  /In the Gaffer factory/.test(flat) && /suggests over MCP \*\*always stays a draft\*\*/.test(flat),
);
check(
  "README names the pin and where it lives",
  flat.includes("`MEMORY_AUTO_APPROVE=0`") && flat.includes("`runner/.mcp.json`"),
);
for (const w of ["distiller", "onboarding induction lore", "`memory suggest`"]) {
  check(`README: the flag covers the runner's own writes — ${w}`, flat.includes(w));
}

// docs/FEATURES.md and SECURITY.md say the same thing.
const featLine =
  read("docs/FEATURES.md")
    .split("\n")
    .find((l) => l.startsWith("| `MEMORY_AUTO_APPROVE`")) ?? "";
check(
  "FEATURES.md: agent MCP lore always stays a draft",
  /suggests over MCP always stays a draft/.test(featLine),
);
const secLine =
  read("SECURITY.md")
    .split("\n")
    .find((l) => l.includes("**The opt-in autonomy flags remove protections by design.**")) ?? "";
check(
  "SECURITY.md: agent MCP lore stays a draft, the runner pins MEMORY_AUTO_APPROVE=0",
  /stays a draft even then/.test(secLine) && secLine.includes("`MEMORY_AUTO_APPROVE=0`"),
);

if (failures.length) {
  console.error(`FAIL memory-auto-approve-docs — ${failures.length} failed, ${passed} passed`);
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`PASS memory-auto-approve-docs — ${passed} checks passed`);

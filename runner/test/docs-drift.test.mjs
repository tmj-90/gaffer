#!/usr/bin/env node
// =====================================================================
// Docs that state a COUNT or a DEFAULT must match the code they describe. These
// drifted (the gap analysis found 118 / ~70 skills, "7 views" with 11 in the nav, a
// shipped spec plan still "in progress", and CONFIG.md listing the agent-approve and
// memory-auto-approve flags as on by default). Each is pinned here against its source:
//   D1 every skill count in README / ARCHITECTURE / runner/README = the runner/skills dirs
//   D2 the dashboard view count in ARCHITECTURE = the NAV entries in app.js
//   D3 docs/spec-driven-development.md does not say "in progress" (it shipped)
//   D4 CONFIG.md and the settings help say DISPATCH_ALLOW_AGENT_APPROVE and
//      MEMORY_AUTO_APPROVE are off by default (the supervised mode's fill)
// Run: node runner/test/docs-drift.test.mjs
// =====================================================================
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (f) => readFileSync(resolve(ROOT, f), "utf8");
let pass = 0;
const fails = [];
function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fails.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("== D1: skill counts ==");
const skillsDir = resolve(ROOT, "runner/skills");
const skills = readdirSync(skillsDir).filter((d) =>
  statSync(resolve(skillsDir, d)).isDirectory(),
).length;
check(`the library has skills (${skills})`, skills > 0);
for (const f of ["README.md", "ARCHITECTURE.md", "runner/README.md"]) {
  const text = read(f);
  const stated = [...text.matchAll(/(?:~\s*)?\*{0,2}(\d+)\*{0,2}[- ]skills?\b/gi)].map((m) => m[0]);
  check(`${f} states the skill count`, stated.length > 0, "no count found");
  for (const s of stated) {
    const n = Number(s.match(/\d+/)[0]);
    check(`${f}: "${s}" is ${skills}`, n === skills && !s.startsWith("~"), `stated ${s}`);
  }
}

console.log("== D2: dashboard view count ==");
const app = read("packages/dispatch/src/api/web/app.js");
const navBlock = app.slice(
  app.indexOf("const NAV = ["),
  app.indexOf("];", app.indexOf("const NAV = [")),
);
const views = (navBlock.match(/\{\s*id:\s*"/g) || []).length;
check(`the nav has views (${views})`, views > 0);
const arch = read("ARCHITECTURE.md");
const vm = arch.match(/web dashboard \((\d+) views\)/);
check("ARCHITECTURE.md states the view count", !!vm);
check(
  `ARCHITECTURE.md: ${vm?.[1]} views is ${views}`,
  vm && Number(vm[1]) === views,
  `stated ${vm?.[1]}`,
);

console.log("== D3: the spec-driven plan is not 'in progress' ==");
const spec = read("docs/spec-driven-development.md");
check("no 'in progress' in the spec-driven doc", !/in progress/i.test(spec));
check("it says it shipped", /\bshipped\b/i.test(spec.split("\n").slice(0, 5).join("\n")));

console.log("== D4: the two autonomy flags are off by default in the docs ==");
const config = read("docs/CONFIG.md");
for (const k of ["DISPATCH_ALLOW_AGENT_APPROVE", "MEMORY_AUTO_APPROVE"]) {
  const row = config.split("\n").find((l) => l.startsWith(`| \`${k}\` |`)) || "";
  const dflt = row.split("|")[2] || "";
  check(`CONFIG.md: ${k} defaults to 0`, /^\s*`0`/.test(dflt), dflt.trim());
  check(`CONFIG.md: ${k}'s notes say off by default`, /off by default/i.test(row));
}
const settings = read("packages/dispatch/src/api/settings.ts");
for (const k of ["DISPATCH_ALLOW_AGENT_APPROVE", "MEMORY_AUTO_APPROVE"]) {
  const at = settings.indexOf(`key: "${k}"`);
  const block = settings.slice(at, settings.indexOf("},", at));
  check(`settings help for ${k} says off by default`, /Off by default/.test(block));
}
// The fill the docs report is the one the config applies when GAFFER_MODE is unset.
const cfg = read("runner/factory.config.sh");
const arm = cfg.slice(
  cfg.indexOf("  *)   # supervised (default)"),
  cfg.indexOf("esac", cfg.indexOf("  *)   # supervised (default)")),
);
for (const k of ["DISPATCH_ALLOW_AGENT_APPROVE", "MEMORY_AUTO_APPROVE"])
  check(`factory.config.sh's supervised arm sets ${k}:=0`, arm.includes(`: "\${${k}:=0}"`));

console.log();
if (fails.length === 0) {
  console.log(`docs-drift: all ${pass} passed`);
  process.exit(0);
}
console.log(`docs-drift: ${fails.length} FAILED (of ${pass + fails.length})`);
for (const f of fails) console.log(`  - ${f}`);
process.exit(1);

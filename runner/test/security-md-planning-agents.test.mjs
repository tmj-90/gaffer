#!/usr/bin/env node
// SECURITY.md's planning-agent containment must describe what the code actually does.
// It used to say decompose / spec-author / onboard-analyze all run "hook-less in the
// factory's OWN source dir (RUNNER_DIR)", after decompose and spec-author had moved to
// a throwaway agent home with the hook settings rendered. This pins each agent's spawn
// cwd in the source, the matchers makeAgentHome really renders, and the doc text that
// describes both — so a later change to either side shows up here.
// Run: node test/security-md-planning-agents.test.mjs
import { readFileSync, rmSync } from "node:fs";
import { gafferMkdtemp } from "./lib/tmpdir.mjs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = resolve(HERE, "..");
const DATA = gafferMkdtemp(resolve(tmpdir(), "security-md-"));
process.env.GAFFER_DATA = DATA;
delete process.env.CLAUDE_SETTINGS;
const { makeAgentHome } = await import(resolve(RUNNER, "lib", "agent-home.mjs"));

let passed = 0;
const failures = [];
const check = (label, ok) => (ok ? (passed += 1) : failures.push(label));

const doc = readFileSync(resolve(RUNNER, "..", "SECURITY.md"), "utf8");
const section = doc.slice(
  doc.indexOf("**Planning agents run read-only.**"),
  doc.indexOf("## Honest residual"),
);
const homeLine = section.split("\n").find((l) => l.includes("`decompose` and `spec-author`")) ?? "";
const onboardLine = section.split("\n").find((l) => l.includes("`onboard-analyze`")) ?? "";
const src = (f) => readFileSync(resolve(RUNNER, f), "utf8");

// decompose + spec-author: agent home in the code, agent home in the doc.
for (const f of ["bin/decompose.mjs", "bin/spec-author.mjs"]) {
  check(
    `${f} spawns with cwd: home.dir from makeAgentHome`,
    /makeAgentHome\(/.test(src(f)) && /cwd: home\.dir/.test(src(f)),
  );
}
check(
  "doc: decompose/spec-author run in a throwaway agent home",
  /throwaway agent home/.test(homeLine),
);
check("doc: the agent home lives under GAFFER_DATA", homeLine.includes("<GAFFER_DATA>/"));
check("doc: GAFFER_WRITE_ROOTS is the home", /GAFFER_WRITE_ROOTS.{0,20}is the home/.test(homeLine));
check(
  "doc: does not say decompose/spec-author run in RUNNER_DIR",
  !homeLine.includes("RUNNER_DIR"),
);

// The matchers makeAgentHome really renders are the ones the doc lists.
const home = makeAgentHome("security-md-");
const rendered = JSON.parse(readFileSync(resolve(home.dir, ".claude", "settings.json"), "utf8"));
home.remove();
const tools = rendered.hooks.PreToolUse.flatMap((m) => m.matcher.split("|"));
check(
  "rendered settings route Grep and Glob to the hook",
  tools.includes("Grep") && tools.includes("Glob"),
);
for (const t of tools) check(`doc names the rendered matcher ${t}`, homeLine.includes(t));

// onboard-analyze: still RUNNER_DIR + no project settings, in the code and the doc.
// (The synthesis turn's cwd defaults to RUNNER_DIR; only the text-only card turns,
// which get no tools at all, swap it for an empty scratch dir.)
check(
  "onboard-analyze spawns with cwd: RUNNER_DIR",
  /\bcwd(?::| =) RUNNER_DIR\b/.test(src("lib/onboard-analyze.mjs")),
);
check(
  "doc: onboard-analyze runs in RUNNER_DIR, hook-less",
  onboardLine.includes("RUNNER_DIR") && /hook-less/.test(onboardLine),
);
check(
  "doc: onboard-analyze gets the Read deny rules via --disallowedTools (and the code does it)",
  /--disallowedTools/.test(onboardLine) &&
    /\.\.\.secretReadDenyRules\(\)/.test(src("lib/onboard-analyze.mjs")),
);

rmSync(DATA, { recursive: true, force: true });
if (failures.length) {
  console.error(`FAIL security-md-planning-agents — ${failures.length} failed, ${passed} passed`);
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`PASS security-md-planning-agents — ${passed} checks passed`);

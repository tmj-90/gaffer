#!/usr/bin/env node
// =====================================================================
// B7 — headless planning turns can SEE the factory's skills.
// ---------------------------------------------------------------------
// decompose.mjs / spec-author.mjs used to spawn `claude -p` with cwd = RUNNER_DIR,
// which has no .claude/skills, so the plan-build / spec-author skill each prompt
// names was invisible unless the operator had run `gaffer skills install --user`.
// lib/agent-home.mjs builds a throwaway agent home (skills symlink + resolved
// project settings) and both helpers now spawn from it. Run: node test/agent-home.test.mjs
// =====================================================================
import { existsSync, lstatSync, readFileSync, readlinkSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_DIR = resolve(HERE, "..");
const { makeAgentHome } = await import(resolve(RUNNER_DIR, "lib", "agent-home.mjs"));

let passed = 0;
const failures = [];
const ok = (l) => {
  passed += 1;
  console.log(`  ok   ${l}`);
};
const fail = (l) => {
  failures.push(l);
  console.log(`  FAIL ${l}`);
};
const assert = (l, c) => (c ? ok(l) : fail(l));

const DATA = mkdtempSync(resolve(tmpdir(), "agent-home-test-"));
process.env.GAFFER_DATA = DATA;
delete process.env.SKILLS_DIR;
delete process.env.CLAUDE_SETTINGS;

console.log("== makeAgentHome: skills symlink + resolved settings, under GAFFER_DATA ==");
{
  const home = makeAgentHome("decompose-");
  assert("home dir created under GAFFER_DATA", home.dir.startsWith(DATA) && existsSync(home.dir));
  const link = resolve(home.dir, ".claude", "skills");
  assert(".claude/skills is a symlink", existsSync(link) && lstatSync(link).isSymbolicLink());
  assert(
    "…pointing at the factory's skills dir (plan-build + spec-author resolve)",
    readlinkSync(link) === resolve(RUNNER_DIR, "skills") &&
      existsSync(resolve(link, "plan-build", "SKILL.md")) &&
      existsSync(resolve(link, "spec-author", "SKILL.md")),
  );
  const settings = resolve(home.dir, ".claude", "settings.json");
  assert(
    "settings.json mirrored with ${RUNNER_DIR} resolved",
    existsSync(settings) &&
      !readFileSync(settings, "utf8").includes("${RUNNER_DIR}") &&
      readFileSync(settings, "utf8").includes(RUNNER_DIR),
  );
  home.remove();
  assert("remove() deletes the home", !existsSync(home.dir));
  home.remove();
  ok("remove() is idempotent");
}

console.log("== decompose.mjs + spec-author.mjs spawn from the agent home, not RUNNER_DIR ==");
for (const f of ["decompose.mjs", "spec-author.mjs"]) {
  const src = readFileSync(resolve(RUNNER_DIR, "bin", f), "utf8");
  assert(
    `${f} imports makeAgentHome`,
    /import \{ makeAgentHome \} from "\.\.\/lib\/agent-home\.mjs"/.test(src),
  );
  assert(`${f} spawns with cwd: home.dir`, /cwd: home\.dir/.test(src));
  assert(`${f} no longer spawns the agent with cwd: RUNNER_DIR`, !/cwd: RUNNER_DIR/.test(src));
  assert(
    `${f} keeps the unconditional write/exec denylist`,
    src.includes('"--disallowedTools", "Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"'),
  );
  assert(
    `${f} removes the home after the turn (finally)`,
    /finally \{\s*home\.remove\(\);/.test(src),
  );
}

rmSync(DATA, { recursive: true, force: true });
console.log();
if (failures.length === 0) {
  console.log(`PASS — ${passed} checks passed`);
  process.exit(0);
}
console.log(`FAILED — ${failures.length} of ${passed + failures.length}`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(1);

#!/usr/bin/env node
// =====================================================================
// SKILL LIBRARY LINT — the quality gate every SKILL.md must pass.
// ---------------------------------------------------------------------
// A skill is forwarded to an agent through progressive disclosure: only its
// name + one-line description are in context until the agent opens it. So the
// description must be a real trigger sentence, the body must be a procedure the
// agent can follow, and every tool / skill it names must exist — a skill that
// names a tool that does not exist (`attach_delivery_evidence`, found live) or
// a section the merge does not accept silently wastes the agent's work.
//
// Checks, per skill:
//   1. frontmatter: name == directory, safe slug, one-line description with
//      trigger phrasing ("Use when/to/as/on …" or "Invoke …"), stack list,
//      area in the known set (the selector's buckets).
//   2. body: an H1, >= 2 H2 sections, a numbered procedure, >= 220 words.
//   3. every backticked MCP-tool-shaped token exists in the dispatch or memory
//      MCP tool list (derived from the source), and every "`x` skill"
//      cross-reference names a real skill directory.
//   4. no two skills share a name or description; no leftover placeholder text.
//   5. every role profile's core skills exist (select-skills.mjs).
// Run: node test/skills-lint.test.mjs
// =====================================================================
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_DIR = resolve(HERE, "..");
const ROOT = resolve(RUNNER_DIR, "..");
const SKILLS_DIR = process.env.SKILLS_DIR || resolve(RUNNER_DIR, "skills");
const { ROLE_PROFILES } = await import(resolve(RUNNER_DIR, "bin", "select-skills.mjs"));
// The per-skill checks live in lib/skill-lint.mjs so `gaffer skills add` (bin/skill-add.mjs)
// accepts exactly what this gate accepts.
const { lintSkill, realToolNames } = await import(resolve(RUNNER_DIR, "lib", "skill-lint.mjs"));

let passed = 0;
const failures = [];
const ok = () => {
  passed += 1;
};
const fail = (l) => {
  failures.push(l);
};
const assert = (l, c) => (c ? ok(l) : fail(l));

const TOOLS = realToolNames(ROOT);
assert("the MCP tool sources are readable", TOOLS !== null);

const dirs = readdirSync(SKILLS_DIR)
  .filter((d) => {
    try {
      return statSync(join(SKILLS_DIR, d)).isDirectory();
    } catch {
      return false;
    }
  })
  .sort();
assert("library has skills", dirs.length > 0);

const seenNames = new Map();
const seenDescs = new Map();
for (const dir of dirs) {
  const file = join(SKILLS_DIR, dir, "SKILL.md");
  const tag = `skills/${dir}`;
  if (!existsSync(file)) {
    fail(`${tag}: no SKILL.md`);
    continue;
  }
  const res = lintSkill({
    text: readFileSync(file, "utf8"),
    dirName: dir,
    skillNames: dirs,
    toolNames: TOOLS,
  });
  for (const c of res.checks) assert(c.label, c.ok);
  if (!res.name) continue;

  // 4. no duplicates across the library
  if (seenNames.has(res.name)) fail(`${tag}: duplicate name (also ${seenNames.get(res.name)})`);
  else seenNames.set(res.name, tag);
  const dkey = res.description.toLowerCase().slice(0, 120);
  if (seenDescs.has(dkey))
    fail(`${tag}: duplicate description opening (also ${seenDescs.get(dkey)})`);
  else seenDescs.set(dkey, tag);
}

// 5. role profiles
for (const [role, p] of Object.entries(ROLE_PROFILES)) {
  for (const n of p.core) assert(`role ${role}: core skill ${n} exists`, dirs.includes(n));
}

// 6. the skill counts the READMEs state match the library (only for the real
// library — a SKILLS_DIR override is a fixture). The runner README said 31 while
// 118 shipped.
if (!process.env.SKILLS_DIR) {
  for (const [doc, re] of [
    [join(RUNNER_DIR, "README.md"), /ships \*\*(\d+) skills\*\*/],
    [join(ROOT, "README.md"), /the safety hook, (\d+) skills/],
  ]) {
    const m = existsSync(doc) ? readFileSync(doc, "utf8").match(re) : null;
    assert(
      `${doc.slice(ROOT.length + 1)} states the skill count (${m ? m[1] : "none found"}) = ${dirs.length}`,
      m !== null && Number(m[1]) === dirs.length,
    );
  }
}

console.log(
  `skills-lint: ${dirs.length} skills, ${passed} checks passed, ${failures.length} failed`,
);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(failures.length === 0 ? 0 : 1);

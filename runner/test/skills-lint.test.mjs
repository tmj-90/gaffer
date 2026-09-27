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
const { parseFrontmatter, ROLE_PROFILES } = await import(
  resolve(RUNNER_DIR, "bin", "select-skills.mjs")
);

let passed = 0;
const failures = [];
const ok = () => {
  passed += 1;
};
const fail = (l) => {
  failures.push(l);
};
const assert = (l, c) => (c ? ok(l) : fail(l));

// The selector's area buckets — see docs/skill-selection-and-stacks.md.
const KNOWN_AREAS = new Set([
  "quality",
  "testing",
  "review",
  "workflow",
  "security",
  "language",
  "frontend",
  "mobile",
  "backend",
  "data",
  "refactor",
  "docs",
  "marketing",
  "product",
  "planning",
  "devops",
  "infra",
  "meta",
  "security-ops",
]);

/** Real MCP tool names, read from the servers' source so the list cannot drift. */
function realToolNames() {
  const names = new Set();
  const dispatch = readFileSync(resolve(ROOT, "packages/dispatch/src/mcp/tools.ts"), "utf8");
  for (const m of dispatch.matchAll(/^ {2}([a-z_]+): \{$/gm)) names.add(m[1]);
  const memDir = resolve(ROOT, "packages/memory/src/mcp/tools");
  for (const f of readdirSync(memDir)) {
    const src = readFileSync(join(memDir, f), "utf8");
    for (const m of src.matchAll(/"([a-z]+_[a-z_]+)"/g)) names.add(m[1]);
  }
  return names;
}
const TOOLS = realToolNames();
// Tokens that LOOK like a tool call (verb_noun) and must therefore be real tools.
const TOOL_VERBS =
  /^(create|add|mark|claim|get|heartbeat|record|submit|release|request|set|freeze|search|suggest|update|advance|list|attach|declare|report|find|cards|delete|remove|approve|reject|move|run)_[a-z_]+$/;
// Backticked snake_case that is NOT a tool: field names, statuses, evidence types
// (`run_command`, `claim_token`, `test_output`, `changed_surfaces`…). A token that
// matches TOOL_VERBS but ends in a FIELD suffix is a field, not a call.
const FIELD_SUFFIX =
  /_(command|token|id|at|url|name|type|ready|deps|vars|surfaces?|log|only|required|review|testing|merge|output|report|summary|contract|node|indexes|branch|tested|level|count|status|key|path|mode|flag|limit|window|size|by|to|from)$/;
const looksLikeToolCall = (tok) => TOOL_VERBS.test(tok) && !FIELD_SUFFIX.test(tok);

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
  const text = readFileSync(file, "utf8");
  const fmMatch = /^---\s*\n([\s\S]*?)\n---\s*\n/.exec(text);
  if (!fmMatch) {
    fail(`${tag}: no frontmatter block`);
    continue;
  }
  const fm = parseFrontmatter(text, "");
  const body = text.slice(fmMatch[0].length);

  // 1. frontmatter
  assert(`${tag}: name matches directory`, fm.name === dir);
  assert(`${tag}: name is a safe slug`, /^[a-z0-9][a-z0-9._-]*$/.test(fm.name));
  const descLine = fmMatch[1].split("\n").find((l) => l.startsWith("description:")) || "";
  assert(
    `${tag}: description is a single frontmatter line`,
    descLine.length > 0 && !/^\s*[|>-]?\s*$/.test(descLine.slice(12)),
  );
  assert(
    `${tag}: description is 60–1500 chars`,
    fm.description.length >= 60 && fm.description.length <= 1500,
  );
  assert(
    `${tag}: description has trigger phrasing (Use when/to/as/on… or Invoke…)`,
    /\b(Use (when|to|as|on|for|right|after|before|at|during|whenever|in|instead)|Invoke|Reference for)\b/.test(
      fm.description,
    ),
  );
  assert(`${tag}: stack is a list`, Array.isArray(fm.stack));
  assert(`${tag}: area "${fm.area}" is a known bucket`, KNOWN_AREAS.has(fm.area));
  if (seenNames.has(fm.name)) fail(`${tag}: duplicate name (also ${seenNames.get(fm.name)})`);
  else seenNames.set(fm.name, tag);
  const dkey = fm.description.toLowerCase().slice(0, 120);
  if (seenDescs.has(dkey))
    fail(`${tag}: duplicate description opening (also ${seenDescs.get(dkey)})`);
  else seenDescs.set(dkey, tag);

  // 2. body shape
  assert(`${tag}: has an H1 title`, /^# .+/m.test(body));
  const h2s = [...body.matchAll(/^## .+/gm)].length;
  assert(`${tag}: has >= 2 H2 sections`, h2s >= 2);
  const bullets = [...body.matchAll(/^\s*[-*] /gm)].length;
  assert(
    `${tag}: has a numbered procedure or a checklist (>= 3 bullets)`,
    /^\s*(1\.|- \[ \]|\d+\))\s/m.test(body) || bullets >= 3,
  );
  const words = body.split(/\s+/).filter(Boolean).length;
  assert(`${tag}: body >= 220 words (${words})`, words >= 220);
  // Placeholder text: a skill may legitimately SAY "no lorem ipsum"; flag only a block
  // of actual filler (the classic opening) left in the body.
  assert(`${tag}: no leftover filler text`, !/lorem ipsum dolor/i.test(body));

  // 3. tool + skill references
  for (const m of body.matchAll(/`([a-z]+_[a-z_]+)`/g)) {
    const tok = m[1];
    if (looksLikeToolCall(tok)) assert(`${tag}: \`${tok}\` is a real MCP tool`, TOOLS.has(tok));
  }
  for (const m of body.matchAll(/`([a-z0-9-]+)` skill/g)) {
    assert(`${tag}: cross-ref \`${m[1]}\` skill exists`, dirs.includes(m[1]));
  }
  for (const m of body.matchAll(/\bthe ([a-z0-9]+(?:-[a-z0-9]+)+) skill\b/g)) {
    if (!dirs.includes(m[1])) fail(`${tag}: refers to "the ${m[1]} skill" which does not exist`);
  }
}

// 5. role profiles
for (const [role, p] of Object.entries(ROLE_PROFILES)) {
  for (const n of p.core) assert(`role ${role}: core skill ${n} exists`, dirs.includes(n));
}

console.log(
  `skills-lint: ${dirs.length} skills, ${passed} checks passed, ${failures.length} failed`,
);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(failures.length === 0 ? 0 : 1);

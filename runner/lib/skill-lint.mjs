// =====================================================================
// SKILL.md CONTRACT — the per-skill checks every library skill must pass.
// ---------------------------------------------------------------------
// One implementation, two callers:
//   - test/skills-lint.test.mjs runs it over the whole library (plus the cross-skill
//     checks: duplicate names / descriptions, role-profile core skills);
//   - bin/skill-add.mjs runs it on an EXTERNAL skill BEFORE installing it, so
//     `gaffer skills add` accepts exactly what the lint gate accepts. It used to check
//     only name / description / stack, so a skill with no area (= always eligible, on
//     every delivery for every stack), a 10-char description, no procedure and a fake
//     MCP tool was installed — and then broke `pnpm test:runner`.
// Zero deps; pure apart from reading the MCP tool sources in realToolNames().
// =====================================================================
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseFrontmatter } from "../bin/select-skills.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, "..", "..");

/** The selector's area buckets — see docs/skill-selection-and-stacks.md. */
export const KNOWN_AREAS = new Set([
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

/**
 * Real MCP tool names, read from the servers' source so the list cannot drift. Returns
 * null when the sources cannot be read (the caller decides how to fail).
 */
export function realToolNames(root = DEFAULT_ROOT) {
  try {
    const names = new Set();
    const dispatch = readFileSync(resolve(root, "packages/dispatch/src/mcp/tools.ts"), "utf8");
    for (const m of dispatch.matchAll(/^ {2}([a-z_]+): \{$/gm)) names.add(m[1]);
    const memDir = resolve(root, "packages/memory/src/mcp/tools");
    for (const f of readdirSync(memDir)) {
      const src = readFileSync(join(memDir, f), "utf8");
      for (const m of src.matchAll(/"([a-z]+_[a-z_]+)"/g)) names.add(m[1]);
    }
    return names.size > 0 ? names : null;
  } catch {
    return null;
  }
}

// Tokens that LOOK like a tool call (verb_noun) and must therefore be real tools.
const TOOL_VERBS =
  /^(create|add|mark|claim|get|heartbeat|record|submit|release|request|set|freeze|search|suggest|update|advance|list|attach|declare|report|find|cards|delete|remove|approve|reject|move|run)_[a-z_]+$/;
// Backticked snake_case that is NOT a tool: field names, statuses, evidence types
// (`run_command`, `claim_token`, `test_output`, `changed_surfaces`…). A token that
// matches TOOL_VERBS but ends in a FIELD suffix is a field, not a call.
const FIELD_SUFFIX =
  /_(command|token|id|at|url|name|type|ready|deps|vars|surfaces?|log|only|required|review|testing|merge|output|report|summary|contract|node|indexes|branch|tested|level|count|status|key|path|mode|flag|limit|window|size|by|to|from)$/;
export const looksLikeToolCall = (tok) => TOOL_VERBS.test(tok) && !FIELD_SUFFIX.test(tok);

/**
 * Lint one SKILL.md. Returns `{ name, description, checks }` where `checks` is a list of
 * `{ label, ok }` (every check, so the library test can count passes) — use
 * {@link lintErrors} for just the failures.
 *   text          — the SKILL.md content
 *   dirName       — the directory it lives in; null skips the name == directory check
 *                   (an external source's dir name is not its install name)
 *   skillNames    — the skill names a cross-reference may point at
 *   toolNames     — the real MCP tool names (realToolNames()); null fails every
 *                   tool-shaped token closed ("cannot verify")
 */
export function lintSkill({ text, dirName = null, skillNames = [], toolNames = null, tag = "" }) {
  const checks = [];
  const t = tag || `skills/${dirName ?? "?"}`;
  const check = (label, ok) => checks.push({ label: `${t}: ${label}`, ok: Boolean(ok) });
  const fmMatch = /^---\s*\n([\s\S]*?)\n---\s*\n/.exec(text);
  if (!fmMatch) {
    check("has a frontmatter block (--- … ---)", false);
    return { name: "", description: "", checks };
  }
  const fm = parseFrontmatter(text, "");
  const body = text.slice(fmMatch[0].length);
  const known = new Set(skillNames);

  // 1. frontmatter
  if (dirName !== null) check("name matches directory", fm.name === dirName);
  check("name is a safe slug", /^[a-z0-9][a-z0-9._-]*$/.test(fm.name) && !fm.name.includes(".."));
  const descLine = fmMatch[1].split("\n").find((l) => l.startsWith("description:")) || "";
  check(
    "description is a single frontmatter line",
    descLine.length > 0 && !/^\s*[|>-]?\s*$/.test(descLine.slice(12)),
  );
  check(
    "description is 60–1500 chars",
    fm.description.length >= 60 && fm.description.length <= 1500,
  );
  check(
    "description has trigger phrasing (Use when/to/as/on… or Invoke…)",
    /\b(Use (when|to|as|on|for|right|after|before|at|during|whenever|in|instead)|Invoke|Reference for)\b/.test(
      fm.description,
    ),
  );
  check("stack is a list", Array.isArray(fm.stack));
  check(`area "${fm.area}" is a known bucket`, KNOWN_AREAS.has(fm.area));

  // 2. body shape
  check("has an H1 title", /^# .+/m.test(body));
  const h2s = [...body.matchAll(/^## .+/gm)].length;
  check("has >= 2 H2 sections", h2s >= 2);
  const bullets = [...body.matchAll(/^\s*[-*] /gm)].length;
  check(
    "has a numbered procedure or a checklist (>= 3 bullets)",
    /^\s*(1\.|- \[ \]|\d+\))\s/m.test(body) || bullets >= 3,
  );
  const words = body.split(/\s+/).filter(Boolean).length;
  check(`body >= 220 words (${words})`, words >= 220);
  // Placeholder text: a skill may legitimately SAY "no lorem ipsum"; flag only a block
  // of actual filler (the classic opening) left in the body.
  check("no leftover filler text", !/lorem ipsum dolor/i.test(body));

  // 3. tool + skill references
  for (const m of body.matchAll(/`([a-z]+_[a-z_]+)`/g)) {
    const tok = m[1];
    if (!looksLikeToolCall(tok)) continue;
    if (toolNames === null)
      check(`\`${tok}\` is a real MCP tool (cannot verify: MCP tool sources unreadable)`, false);
    else check(`\`${tok}\` is a real MCP tool`, toolNames.has(tok));
  }
  for (const m of body.matchAll(/`([a-z0-9-]+)` skill/g)) {
    check(`cross-ref \`${m[1]}\` skill exists`, known.has(m[1]));
  }
  for (const m of body.matchAll(/\bthe ([a-z0-9]+(?:-[a-z0-9]+)+) skill\b/g)) {
    if (!known.has(m[1])) check(`refers to "the ${m[1]} skill" which exists`, false);
  }
  return { name: fm.name, description: fm.description, checks };
}

/** The failed checks of a {@link lintSkill} result, as "check failed: <label>" reasons. */
export function lintErrors(result) {
  return result.checks.filter((c) => !c.ok).map((c) => `check failed: ${c.label}`);
}

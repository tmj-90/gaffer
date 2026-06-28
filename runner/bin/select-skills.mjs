#!/usr/bin/env node
// Gaffer factory — stack/area skill selector.
//
// Selects skills from the factory's live SKILL.md library by *stack* (language /
// runtime) and *area* (domain pack: frontend, backend, security, language, …).
// Mirrors the Crew registry's matching semantics so local selection and
// registry selection agree: an empty constraint on either side means "no
// constraint"; otherwise the sets must intersect (stack) or be equal (area).
//
// Zero runtime dependencies — parses the simple SKILL.md frontmatter by hand so
// the factory never needs an install to recommend skills.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Default to the sibling `skills/` directory of this repo. */
export const DEFAULT_SKILLS_DIR = resolve(HERE, "..", "skills");

/**
 * Parse a SKILL.md frontmatter block into a tagged skill descriptor.
 * Recognised keys: name, description, stack (inline list), area (scalar).
 * Unknown keys are ignored; missing stack/area default to "no constraint".
 */
export function parseFrontmatter(text, fallbackName = "") {
  const match = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/.exec(text);
  const skill = { name: fallbackName, description: "", stack: [], area: "" };
  if (!match) return skill;
  for (const rawLine of match[1].split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    switch (key) {
      case "name":
        skill.name = stripQuotes(value) || fallbackName;
        break;
      case "description":
        skill.description = stripQuotes(value);
        break;
      case "stack":
        skill.stack = parseInlineList(value);
        break;
      case "area":
        skill.area = stripQuotes(value);
        break;
      default:
        break;
    }
  }
  return skill;
}

function stripQuotes(value) {
  return value.replace(/^['"]|['"]$/g, "").trim();
}

/** Parse an inline YAML list `[a, b]` (or a bare scalar) into a string array. */
function parseInlineList(value) {
  const inner = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  return inner
    .split(",")
    .map((item) => stripQuotes(item))
    .filter((item) => item.length > 0);
}

/**
 * Expand a compound stack label into the token set the registry matches on. A label
 * like "typescript-react-native-expo" expands to its parts plus the whole
 * ("typescript-react-native-expo", "typescript", "react", "native", "expo") so a skill
 * tagged with either the broad or the specific stack still matches. Mirrors the Crew
 * context packet's `ticketStacks` expansion EXACTLY so the runner CLI path (tick.sh,
 * which passes the raw repo stack label) and the registry path agree. De-duped, order
 * preserved (whole label first).
 */
export function expandStacks(stacks = []) {
  const out = new Set();
  for (const raw of stacks) {
    const normalised = String(raw ?? "")
      .toLowerCase()
      .trim();
    if (!normalised) continue;
    out.add(normalised);
    for (const part of normalised.split(/[-/]+/).filter(Boolean)) out.add(part);
  }
  return [...out];
}

/** Load every tagged skill from a SKILL.md library directory. */
export function loadSkills(skillsDir = DEFAULT_SKILLS_DIR) {
  let entries;
  try {
    entries = readdirSync(skillsDir);
  } catch {
    return [];
  }
  const skills = [];
  for (const entry of entries.sort()) {
    const skillFile = join(skillsDir, entry, "SKILL.md");
    let text;
    try {
      if (!statSync(skillFile).isFile()) continue;
      text = readFileSync(skillFile, "utf8");
    } catch {
      continue;
    }
    skills.push(parseFrontmatter(text, entry));
  }
  return skills;
}

/**
 * A skill matches when its stack is unconstrained or intersects the wanted
 * stack(s), AND its area constraint is satisfied.
 *
 * `area` is an OPT-IN constraint. The two modes are:
 *
 *   - Explicit area query (`area` non-empty): every skill that carries an
 *     `area:` must match it (and area-less skills still pass). This is the
 *     narrow "give me the X pack" path — e.g. `area: security` excludes
 *     `typescript-conventions` (area: language) even on a node stack.
 *   - Stack-only query (`area` empty, how tick.sh calls this): an AREA-ONLY
 *     skill (`stack:[]` + non-empty `area:`) is NOT auto-included — it would
 *     otherwise leak marketing/product/meta packs onto every backend ticket.
 *     A STACK-TAGGED skill still routes by its stack regardless of its area
 *     label, so `frontend-design`/`landing-page-generator` still fire for a
 *     matching web/react stack. Fully-unconstrained skills (`stack:[] area:''`)
 *     still match everything (workflow/quality helpers).
 */
export function skillMatches(skill, { stacks = [], area = "" } = {}) {
  const hasStackTag = skill.stack.length > 0;
  const stackOk =
    !hasStackTag || stacks.length === 0 || skill.stack.some((s) => stacks.includes(s));
  let areaOk;
  if (area) {
    // Explicit area: area-tagged skills must match it exactly; area-less pass.
    areaOk = !skill.area || skill.area === area;
  } else {
    // Stack-only query: an area-only skill is opt-in (excluded); a stack-tagged
    // skill routes by stack (its area label does not block it).
    areaOk = !skill.area || hasStackTag;
  }
  return stackOk && areaOk;
}

/**
 * Select skills from the library by stack + area. Compound stack labels (e.g.
 * "typescript-react") are expanded to their parts before matching so the runner CLI
 * path agrees with the Crew registry (see {@link expandStacks}).
 */
export function selectSkills({ skillsDir = DEFAULT_SKILLS_DIR, stacks = [], area = "" } = {}) {
  const expanded = expandStacks(stacks);
  return loadSkills(skillsDir).filter((skill) => skillMatches(skill, { stacks: expanded, area }));
}

/** Distinct area packs present in the library, sorted. */
export function listAreas(skillsDir = DEFAULT_SKILLS_DIR) {
  const areas = new Set();
  for (const skill of loadSkills(skillsDir)) {
    if (skill.area) areas.add(skill.area);
  }
  return [...areas].sort();
}

function parseArgs(argv) {
  const opts = {
    stacks: [],
    area: "",
    skillsDir: DEFAULT_SKILLS_DIR,
    json: false,
    listAreas: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[(i += 1)];
    switch (arg) {
      case "--stack":
        opts.stacks.push(...parseInlineList(next() ?? ""));
        break;
      case "--area":
        opts.area = next() ?? "";
        break;
      case "--skills-dir":
        opts.skillsDir = resolve(next() ?? DEFAULT_SKILLS_DIR);
        break;
      case "--json":
        opts.json = true;
        break;
      case "--list-areas":
        opts.listAreas = true;
        break;
      default:
        break;
    }
  }
  return opts;
}

// CLI: print selected skill names (comma-separated) or JSON. Used by tick.sh to
// inject stack/area-recommended skills into the delivery prompt.
if (import.meta.url === `file://${process.argv[1]}`) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.listAreas) {
    process.stdout.write(listAreas(opts.skillsDir).join("\n") + "\n");
  } else {
    const selected = selectSkills(opts);
    if (opts.json) {
      process.stdout.write(
        JSON.stringify({ ok: true, count: selected.length, skills: selected }) + "\n",
      );
    } else {
      process.stdout.write(selected.map((s) => s.name).join(", ") + "\n");
    }
  }
}

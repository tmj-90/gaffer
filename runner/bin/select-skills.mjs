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
 * Cross-cutting areas whose skills apply to EVERY delivery regardless of stack
 * or domain — the delivery mechanics: run tests (`testing`), lint/minimalism
 * (`quality`), self/submit review (`review`), branch + record evidence
 * (`workflow`), and security review (`security`, defense-in-depth on every
 * delivery — policy). These are always eligible (subject to stack). Only DOMAIN
 * areas (marketing/product/docs/devops/infra/data/meta/…) are opt-in.
 */
const UNIVERSAL_AREAS = new Set(["quality", "testing", "review", "workflow", "security"]);

/**
 * DOMAIN areas that are relevant to ANY code delivery — mounted regardless of the repo's
 * stack label. This is a deliberate BROAD-INCLUSION (denylist) model: the previous
 * allowlist gated language/frontend/mobile packs on the stack string, which silently
 * EXCLUDED `java-conventions` from a Java-backend ticket and `mobile-ui`/`brand` from a
 * mobile app when the stack was mis-registered. Progressive disclosure means Claude Code
 * only loads a skill's name+description (~one line) until the agent invokes it, so an
 * unused mounted skill is nearly free — whereas a wrongly-EXCLUDED skill is invisible and
 * costly. So every plausibly-relevant pack is mounted and the agent chooses. Off-domain
 * packs (marketing / product / planning / devops / infra / meta / security-ops) are NOT
 * here — they stay opt-in (stack-tagged or an explicit --area) so a feature ticket isn't
 * handed a slide-deck, SEO, or Terraform skill. See {@link skillMatches}.
 */
const DELIVERY_AREAS = new Set([
  "language",
  "frontend",
  "mobile",
  "backend",
  "data",
  "refactor",
  "docs",
]);

/**
 * A skill matches when it is in an always-eligible area (UNIVERSAL or DELIVERY), OR its
 * stack intersects the wanted stack(s) AND its area constraint is satisfied.
 *
 * Area handling:
 *   - No `area:`, a UNIVERSAL area, or a DELIVERY area → always eligible, regardless of
 *     stack. The core delivery flow plus every code-relevant pack (language conventions,
 *     frontend/mobile/backend, refactor, docs) fires on every delivery so the agent is
 *     never missing a skill it needs for the files in front of it.
 *   - OFF-DOMAIN area (marketing/product/planning/devops/infra/meta/security-ops) +
 *     explicit `area` query → must equal the requested area.
 *   - OFF-DOMAIN area + stack-only query → opt-in: included only if ALSO stack-tagged, so
 *     these packs don't leak onto a normal feature delivery.
 */
export function skillMatches(skill, { stacks = [], area = "" } = {}) {
  const alwaysEligible =
    !skill.area || UNIVERSAL_AREAS.has(skill.area) || DELIVERY_AREAS.has(skill.area);
  const hasStackTag = skill.stack.length > 0;
  const stackOk =
    alwaysEligible ||
    !hasStackTag ||
    stacks.length === 0 ||
    skill.stack.some((s) => stacks.includes(s));
  let areaOk;
  if (alwaysEligible) {
    // No area, a cross-cutting universal area, or a code-delivery area — every delivery.
    areaOk = true;
  } else if (area) {
    // Explicit area query: an off-domain skill must match the requested area.
    areaOk = skill.area === area;
  } else {
    // Stack-only query: an off-domain skill is opt-in unless stack-tagged.
    areaOk = hasStackTag;
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

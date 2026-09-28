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
 * stack label. This is a deliberate BROAD-INCLUSION (denylist) model for the
 * task-shaped packs: an unused mounted skill costs one description line under
 * progressive disclosure, whereas a wrongly-EXCLUDED skill is invisible. Off-domain
 * packs (marketing / product / planning / devops / infra / meta / security-ops) are NOT
 * here — they stay opt-in (an explicit --area, or the ticket text calling for them) so a
 * feature ticket isn't handed a slide-deck, SEO, or Terraform skill. See {@link skillMatches}.
 */
const DELIVERY_AREAS = new Set(["backend", "data", "refactor", "docs"]);

/**
 * STACK-PACK areas: the language conventions packs and the web / mobile surface packs.
 * These follow the repo's STACK, not the broad-inclusion rule — a Node service must not
 * be handed `csharp-conventions`, `swift-conventions` or `mobile-ui` (a wrong-language
 * conventions pack actively misleads: its casing, layout and tooling rules contradict
 * the files in front of the agent, and 20+ irrelevant packs dilute the one that fits).
 * The mis-registration concern that motivated broad inclusion is kept as FAIL-OPEN:
 * when the stack label is EMPTY or carries no token the library recognises (nothing a
 * language pack or a surface list names), every stack pack is mounted, exactly as
 * before. The ticket text still pulls a pack in by name ("port the Kotlin client").
 */
const STACK_PACK_AREAS = new Set(["language", "frontend", "mobile"]);

/** Stack tokens that mark a web / mobile SURFACE, used to add the design-bar packs. */
const WEB_STACKS = new Set([
  "react",
  "web",
  "next",
  "nextjs",
  "vue",
  "svelte",
  "angular",
  "html",
  "css",
]);
const MOBILE_STACKS = new Set([
  "react-native",
  "native",
  "expo",
  "ios",
  "android",
  "swift",
  "kotlin",
]);

/**
 * Stack tokens the library RECOGNISES: every tag a language pack carries plus the web /
 * mobile surface tokens. A stack made only of tokens outside this set (or an empty
 * stack) is UNKNOWN, and the stack packs fail open for it. The static seed keeps
 * `skillMatches` usable without a loaded library; {@link knownStackTokens} unions in the
 * library's own tags so a new language pack extends the set without editing this file.
 */
const KNOWN_STACK_TOKENS = new Set([
  ...WEB_STACKS,
  ...MOBILE_STACKS,
  "typescript",
  "javascript",
  "node",
  "python",
  "go",
  "java",
  "jvm",
  "csharp",
  "dotnet",
  "aspnet",
  "ruby",
  "rails",
  "rust",
  "bash",
  "shell",
  "sh",
  "zsh",
  "macos",
]);

/**
 * PER-PATH STACK ROUTING. A mixed repo carries one compound label (`csharp-typescript-react`)
 * and every agent used to get every ecosystem's packs. When the files a job touches are
 * known — the reviewer's diff, the paths a ticket names — the stack is NARROWED to the
 * ecosystems those files belong to, so a .NET-only change is reviewed with the C# pack and
 * not the React design bar. Tokens group into ECOSYSTEMS; a repo token survives narrowing
 * when its ecosystem is touched (so `node`-tagged packs still ride a `.ts` change).
 */
const ECOSYSTEMS = Object.freeze({
  js: [
    "typescript",
    "javascript",
    "node",
    "react",
    "next",
    "nextjs",
    "vue",
    "svelte",
    "angular",
    "web",
    "html",
    "css",
    "react-native",
    "native",
    "expo",
  ],
  dotnet: ["csharp", "dotnet", "aspnet"],
  python: ["python"],
  go: ["go"],
  rust: ["rust"],
  jvm: ["java", "kotlin", "jvm", "android"],
  swift: ["swift", "ios", "macos"],
  ruby: ["ruby", "rails"],
  shell: ["bash", "shell", "sh", "zsh"],
});
const TOKEN_ECOSYSTEM = new Map(
  Object.entries(ECOSYSTEMS).flatMap(([eco, tokens]) => tokens.map((t) => [t, eco])),
);

/** File path → the stack tokens it implies (extension and a few manifest names). */
const PATH_STACK_RULES = [
  [/\.(cs|csproj|fsproj|vbproj|sln|slnx|razor|cshtml)$/i, ["csharp"]],
  [/\.(tsx)$/i, ["typescript", "react", "web"]],
  [/\.(jsx)$/i, ["javascript", "react", "web"]],
  [/\.(ts|mts|cts)$/i, ["typescript"]],
  [/\.(js|mjs|cjs)$/i, ["javascript"]],
  [/\.vue$/i, ["vue", "web", "typescript"]],
  [/\.svelte$/i, ["svelte", "web", "typescript"]],
  [/\.(html|htm|css|scss|sass|less)$/i, ["web"]],
  [/\.py$/i, ["python"]],
  [/\.go$/i, ["go"]],
  [/\.rs$/i, ["rust"]],
  [/\.java$/i, ["java"]],
  [/\.(kt|kts)$/i, ["kotlin"]],
  [/\.swift$/i, ["swift"]],
  [/\.rb$|(^|\/)(Gemfile|Rakefile)$/i, ["ruby"]],
  [/\.(sh|bash|zsh)$/i, ["bash"]],
];

/** Stack tokens implied by a list of file paths (empty when nothing is recognised). */
export function stacksFromPaths(paths = []) {
  const out = new Set();
  for (const raw of paths) {
    const path = String(raw ?? "").trim();
    if (!path) continue;
    for (const [re, tokens] of PATH_STACK_RULES) {
      if (re.test(path)) {
        for (const t of tokens) out.add(t);
        break;
      }
    }
  }
  return out;
}

/**
 * Narrow a repo's (expanded) stack tokens to the ecosystems the given paths touch.
 *   - no path implies a stack (docs, config, unknown extensions) → the repo stack, unchanged;
 *   - otherwise every repo token whose ecosystem is touched survives, and the path-implied
 *     tokens are added (so a `.tsx` change on a `csharp-typescript-react` repo keeps
 *     `typescript`/`react` and drops `csharp`; a `.cs` change keeps `csharp` only);
 *   - a repo whose tokens name none of the touched ecosystems (mis-registered or unknown)
 *     gets the path tokens ADDED to its own — never fewer packs than before.
 */
export function narrowStacks(stacks = [], paths = []) {
  const expanded = expandStacks(stacks);
  const implied = stacksFromPaths(paths);
  if (implied.size === 0) return expanded;
  const touched = new Set([...implied].map((t) => TOKEN_ECOSYSTEM.get(t)).filter(Boolean));
  const kept = expanded.filter((t) => touched.has(TOKEN_ECOSYSTEM.get(t)));
  const base = kept.length > 0 ? kept : expanded;
  const out = [...base];
  for (const t of implied) if (!out.includes(t)) out.push(t);
  return out;
}

/** The recognised stack tokens for a loaded library (static seed ∪ language-pack tags). */
export function knownStackTokens(library = []) {
  const out = new Set(KNOWN_STACK_TOKENS);
  for (const skill of library) {
    if (skill.area === "language") for (const t of skill.stack) out.add(t);
  }
  return out;
}

/** True when the (expanded) stack names at least one token the library recognises. */
export function stackIsKnown(stacks = [], library = []) {
  const known = knownStackTokens(library);
  return stacks.some((t) => known.has(t));
}

/**
 * Does a STACK-PACK skill (language / frontend / mobile) fit the stack? Fail-open when
 * the stack is unknown; otherwise a language pack needs a tag match, a frontend pack a
 * web surface token (or a tag match), a mobile pack a mobile surface token (or a tag
 * match).
 */
export function stackPackFits(skill, stacks = [], { stackKnown } = {}) {
  const known = stackKnown ?? stackIsKnown(stacks);
  if (!known) return true;
  const tagged = skill.stack.some((t) => stacks.includes(t));
  if (skill.area === "language") return tagged;
  if (skill.area === "frontend") return tagged || stacks.some((t) => WEB_STACKS.has(t));
  if (skill.area === "mobile") return tagged || stacks.some((t) => MOBILE_STACKS.has(t));
  return tagged;
}

/**
 * A skill matches when it is in an always-eligible area (UNIVERSAL or DELIVERY), OR it is
 * a STACK PACK that fits the stack (fail-open on an unknown stack), OR its stack
 * intersects the wanted stack(s) AND its area constraint is satisfied.
 *
 * Area handling:
 *   - No `area:`, a UNIVERSAL area, or a DELIVERY area → always eligible, regardless of
 *     stack. The core delivery flow plus every task-shaped pack (backend, data, refactor,
 *     docs) fires on every delivery so the agent is never missing a skill it needs for
 *     the files in front of it.
 *   - STACK-PACK area (language / frontend / mobile) → {@link stackPackFits}; an explicit
 *     `area` query equal to the pack's area mounts it regardless (the runner derives
 *     `frontend` from a web stack label).
 *   - OFF-DOMAIN area (marketing/product/planning/devops/infra/meta/security-ops) +
 *     explicit `area` query → must equal the requested area.
 *   - OFF-DOMAIN area + stack-only query → opt-in: included only if ALSO stack-tagged, so
 *     these packs don't leak onto a normal feature delivery.
 */
/**
 * ROLE PROCEDURES: the skill that IS another agent's job. They live in universal areas
 * (review / testing / workflow / product / planning) so the role profiles can mount them
 * as core, but the DELIVERY selection never hands the builder the reviewer's, tester's,
 * intake's or planner's procedure — a builder that opens `review-ticket` reviews itself.
 */
const ROLE_ONLY_SKILLS = new Set([
  "review-ticket",
  "adversarial-reviewer",
  "black-box-test",
  "clarify",
  "plan-build",
  "spec-author",
  "product-owner",
]);

export function skillMatches(skill, { stacks = [], area = "", stackKnown } = {}) {
  // A role procedure is reachable only through its role profile or an explicit --area.
  if (ROLE_ONLY_SKILLS.has(skill.name) && !(area && skill.area === area)) return false;
  const known = stackKnown ?? stackIsKnown(stacks);
  const hasStackTag = skill.stack.length > 0;
  const tagged = skill.stack.some((s) => stacks.includes(s));
  const alwaysEligible =
    !skill.area || UNIVERSAL_AREAS.has(skill.area) || DELIVERY_AREAS.has(skill.area);
  if (alwaysEligible) {
    // A stack tag on an always-on skill is its author's applicability statement (e.g.
    // `frontend-testing` is React/web only): honoured once the stack is known.
    return !hasStackTag || !known || tagged || (Boolean(area) && skill.area === area);
  }
  if (STACK_PACK_AREAS.has(skill.area)) {
    if (area && skill.area === area) return true;
    return stackPackFits(skill, stacks, { stackKnown: known });
  }
  const stackOk = !hasStackTag || stacks.length === 0 || tagged;
  let areaOk;
  if (area) {
    // Explicit area query: an off-domain skill must match the requested area.
    areaOk = skill.area === area;
  } else {
    // Stack-only query: an off-domain skill is opt-in unless stack-tagged.
    areaOk = hasStackTag;
  }
  return stackOk && areaOk;
}

/** Words too generic to signal relevance on their own. */
const STOP_WORDS = new Set(
  (
    "a an and are as at be by for from has have in into is it its of on or that the this to " +
    "with you your when use using used skill skills agent code file files repo project add adds " +
    "create new make build build-time run runs write writes write-up guide how what which where " +
    "will can should must never always every any all not no yes one two via per into over under " +
    "after before while after before then than these those they them their there here about " +
    "more most less least also only just each both such very much many some most other same"
  ).split(/\s+/),
);

/** Lower-cased, de-hyphenated, stop-word-free tokens (≥ 3 chars) of a text. */
export function relevanceTokens(text = "") {
  const out = new Set();
  for (const raw of String(text)
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)) {
    const t = raw.replace(/^[.+#]+|[.+#]+$/g, "");
    if (t.length >= 3 && !STOP_WORDS.has(t) && !/^\d+$/.test(t)) out.add(t);
  }
  return out;
}

/**
 * TEXT RELEVANCE (additive, opt-in via `text`): an OFF-DOMAIN skill — one that the
 * stack/area rules keep opt-in (marketing / product / planning / devops / infra /
 * meta / security-ops) — is ALSO mounted when the ticket text plainly calls for it:
 * its name (as a phrase, e.g. "terraform patterns" / "seo audit") or its name's
 * distinctive parts appear in the text, or at least two distinctive words of its
 * description do. Before this, ~25 packs were unreachable from any runner path
 * (no runner path ever set `--area devops|marketing|…`), so a ticket that said
 * "add a Terraform module for the S3 bucket" got no Terraform skill. Always-eligible
 * skills are unaffected; with no text the selection is byte-identical to before.
 */
export function textMatches(skill, text = "") {
  if (!text) return false;
  const words = relevanceTokens(text);
  if (words.size === 0) return false;
  const nameParts = [...relevanceTokens(skill.name.replace(/[-_]/g, " "))];
  if (nameParts.length > 0 && nameParts.every((p) => words.has(p))) return true;
  const phrase = skill.name.replace(/[-_]/g, " ").toLowerCase();
  if (phrase.length >= 5 && String(text).toLowerCase().includes(phrase)) return true;
  // A LANGUAGE pack is pulled in when the text names its language ("port the Kotlin
  // client", "the Rust worker"): its stack tags are the language's names. Only tags
  // that are unambiguous language names count (not `node`, `shell`, a platform name).
  if (
    skill.area === "language" &&
    skill.stack.some((t) => t.length >= 4 && !LANGUAGE_TAGS_TOO_GENERIC.has(t) && words.has(t))
  )
    return true;
  // Two shared description words pull in an OFF-DOMAIN pack only. A stack pack or an
  // always-on pack is decided by the stack rules above; ordinary ticket words ("test",
  // "module", "login") would otherwise drag `typescript-conventions` onto a Python
  // ticket through its description.
  if (STACK_PACK_AREAS.has(skill.area) || ROLE_ONLY_SKILLS.has(skill.name)) return false;
  if (!skill.area || UNIVERSAL_AREAS.has(skill.area) || DELIVERY_AREAS.has(skill.area))
    return false;
  const descHits = [...relevanceTokens(skill.description)].filter((t) => words.has(t));
  return descHits.length >= 2;
}

/** Language-pack stack tags that also occur in ordinary ticket text — never a text pull. */
const LANGUAGE_TAGS_TOO_GENERIC = new Set(["node", "shell", "macos", "android", "rails"]);

/**
 * Select skills from the library by stack + area (+ optional ticket text). Compound
 * stack labels (e.g. "typescript-react") are expanded to their parts before matching
 * so the runner CLI path agrees with the Crew registry (see {@link expandStacks}).
 * `text` (the ticket title + description) additionally pulls in off-domain packs the
 * text plainly calls for — see {@link textMatches}.
 */
export function selectSkills({
  skillsDir = DEFAULT_SKILLS_DIR,
  stacks = [],
  area = "",
  text = "",
} = {}) {
  const expanded = expandStacks(stacks);
  const library = loadSkills(skillsDir);
  const stackKnown = stackIsKnown(expanded, library);
  return library.filter(
    (skill) =>
      skillMatches(skill, { stacks: expanded, area, stackKnown }) || textMatches(skill, text),
  );
}

/**
 * ROLE PROFILES — what each factory AGENT ROLE is handed. Skill selection used to be
 * delivery-shaped only: the delivery agent got the stack/area/text selection plus the
 * universal mechanics, while every other agent got a hard-coded list (the reviewer:
 * five skills, never the stack's conventions pack or a security lens — even though
 * review-ticket step 5 tells it to "review Java like Java" from a pack that was not
 * mounted) or the whole library. A profile names the role's CORE (always mounted),
 * its LENS areas (whole areas mounted regardless of stack) and whether the stack's
 * language / surface packs and the text-relevant packs are added. Names that do not
 * exist in the library are dropped silently, so a trimmed library is safe.
 *
 * The delivery profile reproduces today's selection byte-for-byte (core = the
 * universal mechanics set skills-mount.sh also unions in; selection = skillMatches ||
 * textMatches), so tick.sh's prompt is unchanged.
 */
export const ROLE_PROFILES = Object.freeze({
  delivery: {
    core: [
      "run-tests",
      "run-lint",
      "run-coverage",
      "minimalism",
      "self-review",
      "submit-review",
      "record-evidence",
      "create-branch",
      "prepare-digest-delta",
      "plan-change",
    ],
    lensAreas: [],
    languagePacks: true,
    surfacePacks: true,
    textPacks: true,
    deliverySelection: true,
  },
  review: {
    // The reviewer judges; it never builds. It gets the review procedure, the review
    // LENSES (security / performance / accessibility / test quality / API design), the
    // quality bar it holds the diff to, and the conventions pack of the diff's stack.
    core: [
      "review-ticket",
      "adversarial-reviewer",
      "submit-review",
      "record-evidence",
      "engineering-craft",
      "minimalism",
    ],
    lensAreas: ["review", "security"],
    languagePacks: true,
    surfacePacks: true,
    textPacks: false,
    deliverySelection: false,
  },
  clarify: {
    // Intake: turn a vague draft into deliverable ACs; raise decisions. Product-shaping
    // skills help it write good criteria; it never codes.
    core: ["clarify", "record-evidence", "user-story", "prd"],
    lensAreas: ["security"],
    languagePacks: true,
    surfacePacks: false,
    textPacks: false,
    deliverySelection: false,
  },
  test: {
    // The independent tester writes tests from the contract — never from the diff.
    core: [
      "black-box-test",
      "run-tests",
      "add-integration-test",
      "e2e-browser-test",
      "contract-test",
      "test-fixtures-and-factories",
      "record-evidence",
    ],
    lensAreas: ["testing"],
    languagePacks: true,
    surfacePacks: false,
    textPacks: false,
    deliverySelection: false,
  },
  plan: {
    // Decomposition: a brief → an epic of tickets. Planning + product-shaping packs, the
    // stack's conventions (so tickets are phrased in the repo's terms) and the design
    // packs it may need to size UI / data work.
    core: [
      "plan-build",
      "spec-author",
      "user-story",
      "rice",
      "prd",
      "product-discovery",
      "database-schema-designer",
      "api-design-reviewer",
      "design-system",
      "write-adr",
    ],
    lensAreas: ["planning"],
    languagePacks: true,
    surfacePacks: true,
    textPacks: true,
    deliverySelection: false,
  },
  spec: {
    core: ["spec-author", "prd", "user-story", "product-discovery", "write-adr"],
    lensAreas: ["planning"],
    languagePacks: false,
    surfacePacks: false,
    textPacks: false,
    deliverySelection: false,
  },
  product: {
    core: ["product-owner", "prd", "rice", "user-story", "product-discovery", "brand", "page-cro"],
    lensAreas: ["product"],
    languagePacks: false,
    surfacePacks: false,
    textPacks: true,
    deliverySelection: false,
  },
  merge: {
    core: ["resolve-merge-conflict", "run-tests", "run-lint", "record-evidence", "minimalism"],
    lensAreas: [],
    languagePacks: true,
    surfacePacks: false,
    textPacks: false,
    deliverySelection: false,
  },
  bootstrap: {
    core: [
      "create-branch",
      "record-evidence",
      "minimalism",
      "run-tests",
      "run-lint",
      "ci-cd-pipeline",
      "docker-development",
      "shell-scripting",
    ],
    lensAreas: ["quality"],
    languagePacks: true,
    surfacePacks: true,
    textPacks: true,
    deliverySelection: true,
  },
});

export const ROLE_NAMES = Object.freeze(Object.keys(ROLE_PROFILES));

/**
 * Select the skills for an agent ROLE. Returns the ordered, de-duplicated list of
 * skill descriptors: core first, then lens areas, then the stack's packs, then the
 * text-relevant packs. Unknown role → the delivery profile (never an empty mount).
 */
export function selectForRole(
  role,
  { skillsDir = DEFAULT_SKILLS_DIR, stacks = [], area = "", text = "" } = {},
) {
  const profile = ROLE_PROFILES[role] ?? ROLE_PROFILES.delivery;
  const library = loadSkills(skillsDir);
  const byName = new Map(library.map((s) => [s.name, s]));
  const expanded = expandStacks(stacks);
  const stackKnown = stackIsKnown(expanded, library);
  const out = [];
  const seen = new Set();
  const push = (skill) => {
    if (!skill || seen.has(skill.name)) return;
    seen.add(skill.name);
    out.push(skill);
  };
  for (const name of profile.core) push(byName.get(name));
  for (const skill of library) {
    // A whole LENS area, minus the lenses whose own stack tag rules the stack out
    // (`accessibility-review` is a web/mobile lens; a known backend stack skips it).
    if (
      profile.lensAreas.includes(skill.area) &&
      (skill.stack.length === 0 || !stackKnown || skill.stack.some((t) => expanded.includes(t)))
    )
      push(skill);
  }
  if (profile.languagePacks) {
    // The stack's LANGUAGE pack(s): stack-tagged language skills whose tags intersect —
    // every language pack when the stack is unknown (fail-open, see STACK_PACK_AREAS).
    for (const skill of library) {
      if (skill.area === "language" && stackPackFits(skill, expanded, { stackKnown })) push(skill);
    }
  }
  if (profile.surfacePacks) {
    // The stack's SURFACE packs: the frontend / mobile design bar when the stack is one
    // (or unknown — fail-open).
    for (const skill of library) {
      if (
        (skill.area === "frontend" || skill.area === "mobile") &&
        stackPackFits(skill, expanded, { stackKnown })
      )
        push(skill);
    }
  }
  if (profile.deliverySelection) {
    for (const skill of library) {
      if (skillMatches(skill, { stacks: expanded, area, stackKnown })) push(skill);
    }
  }
  if (profile.textPacks && text) {
    for (const skill of library) {
      if (textMatches(skill, text)) push(skill);
    }
  }
  return out;
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
    text: "",
    skillsDir: DEFAULT_SKILLS_DIR,
    json: false,
    listAreas: false,
    role: "",
    paths: [],
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
      case "--text":
        opts.text = next() ?? "";
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
      case "--role":
        opts.role = (next() ?? "").trim();
        break;
      // PER-PATH ROUTING: the files this job touches (the reviewer's diff, the paths a
      // ticket names). The stack is narrowed to their ecosystems before selection.
      case "--path":
        opts.paths.push(...parseInlineList(next() ?? ""));
        break;
      case "--paths-file": {
        const file = next() ?? "";
        try {
          opts.paths.push(
            ...readFileSync(file, "utf8")
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean),
          );
        } catch {
          /* unreadable → no narrowing */
        }
        break;
      }
      default:
        break;
    }
  }
  return opts;
}

// CLI: print selected skill names (comma-separated) or JSON. Used by tick.sh to
// inject stack/area-recommended skills into the delivery prompt, and — with --role —
// by every other agent spawn site (review, clarify, test, plan, spec, product, merge,
// bootstrap) to mount the role's skill set instead of a hard-coded list.
if (import.meta.url === `file://${process.argv[1]}`) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.listAreas) {
    process.stdout.write(listAreas(opts.skillsDir).join("\n") + "\n");
  } else {
    if (opts.paths.length > 0) {
      opts.stacks = narrowStacks(opts.stacks, opts.paths);
      // An explicit surface area derived from the FULL repo label (tick.sh maps a web
      // stack to --area frontend) must not re-mount the design bar the narrowing dropped:
      // keep it only while the narrowed stack still carries that surface.
      if (opts.area === "frontend" && !opts.stacks.some((t) => WEB_STACKS.has(t))) opts.area = "";
      if (opts.area === "mobile" && !opts.stacks.some((t) => MOBILE_STACKS.has(t))) opts.area = "";
    }
    const selected = opts.role ? selectForRole(opts.role, opts) : selectSkills(opts);
    if (opts.json) {
      process.stdout.write(
        JSON.stringify({
          ok: true,
          count: selected.length,
          stacks: opts.stacks,
          skills: selected,
        }) + "\n",
      );
    } else {
      process.stdout.write(selected.map((s) => s.name).join(", ") + "\n");
    }
  }
}

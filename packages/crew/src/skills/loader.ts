import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";
import { ZodError } from "zod";

import { invalidConfig } from "../util/errors.js";
import { builtinSkills } from "./builtins.js";
import { SkillRegistry } from "./registry.js";
import { skillFileSchema, skillSchema, type Skill } from "./schema.js";

export interface LoadSkillsOptions {
  /** Factory root directory; a `skills/` subdir is loaded if present. */
  factoryDir?: string;
  /** Include v1 built-in skills (default true). */
  includeBuiltins?: boolean;
  /**
   * The factory's SKILL.md library (`runner/skills/<name>/SKILL.md` — the skills the
   * live agents are actually mounted). Defaults to {@link defaultSkillMdDir}; pass
   * `false` to skip it (tests that want built-ins only).
   */
  skillMdDir?: string | false;
}

/** Parse one YAML skill file into one or more validated skills. */
export function parseSkillFile(yamlText: string, source = "<string>"): Skill[] {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (cause) {
    throw invalidConfig(
      `Could not parse skill YAML in ${source}: ${cause instanceof Error ? cause.message : String(cause)}`,
      {
        source,
      },
    );
  }
  try {
    const parsed = skillFileSchema.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (err) {
    if (err instanceof ZodError) {
      const detail = err.issues
        .map((i) => `  - ${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
        .join("\n");
      throw invalidConfig(`Invalid skill definition (${source}):\n${detail}`, {
        source,
        issues: err.issues,
      });
    }
    throw err;
  }
}

/** Load every `*.yaml`/`*.yml` skill file from a directory (non-recursive). */
export function loadSkillsFromDir(dir: string): Skill[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const skills: Skill[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (!/\.(ya?ml)$/i.test(entry)) continue;
    const path = join(dir, entry);
    if (!statSync(path).isFile()) continue;
    skills.push(...parseSkillFile(readFileSync(path, "utf8"), path));
  }
  return skills;
}

// ── The SKILL.md library (B30) ───────────────────────────────────────────────
// The registry used to load only the 14 descriptive built-ins and never read the
// `runner/skills/*/SKILL.md` library the live agents are mounted — so the runner's
// `fg skills --stack X` fallback (tick.sh) returned generic placeholders and never a
// real skill. The library is now a first-class source: each SKILL.md's frontmatter
// (`name` / `description` / `stack` / `area`) becomes a registry skill whose id is the
// directory name, whose `applies_to.stacks` are the frontmatter stack tags and whose
// `applies_to.capabilities` carry the area bucket; its numbered "## Steps" become the
// steps. Parsing is deliberately tolerant — a malformed SKILL.md is skipped, never a
// crash (the runner's lint gate, test/skills-lint.test.mjs, is where quality is enforced).

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Where the SKILL.md library lives: the runner's `SKILLS_DIR` (exported into every
 * crew run it spawns), else the in-repo `runner/skills` next to this package.
 */
export function defaultSkillMdDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = (env.SKILLS_DIR ?? "").trim();
  if (fromEnv !== "") return fromEnv;
  // packages/crew/{src,dist}/skills → ../../../../runner/skills
  return resolve(HERE, "..", "..", "..", "..", "runner", "skills");
}

function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter((v) => v !== "");
  if (typeof value === "string") {
    const inner = value.trim().replace(/^\[|\]$/g, "");
    return inner
      .split(",")
      .map((v) => v.trim().replace(/^['"]|['"]$/g, ""))
      .filter((v) => v !== "");
  }
  return [];
}

/**
 * The numbered items of the `## Steps` section (first line of each item, markdown
 * emphasis stripped). Falls back to the description so the schema's "at least one
 * step" invariant holds for a skill whose body is prose only.
 */
export function skillMdSteps(body: string, fallback: string): string[] {
  const section = /^##\s+Steps\s*$([\s\S]*?)(?=^##\s|\s*$(?![\s\S]))/m.exec(body);
  const text = section ? section[1]! : body;
  const steps: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*\d+\.\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const step = m[1]!.replace(/\*\*/g, "").trim();
    if (step) steps.push(step);
  }
  if (steps.length > 0) return steps;
  const fb = fallback.trim();
  return [fb !== "" ? fb : "follow the procedure in SKILL.md"];
}

/**
 * Parse one SKILL.md into a registry skill. Returns null when the text has no
 * frontmatter block, or the frontmatter is not a YAML map — tolerant by design.
 */
export function parseSkillMd(text: string, dirName: string): Skill | null {
  const match = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/.exec(text);
  if (!match) return null;
  let fm: unknown;
  try {
    fm = parseYaml(match[1]!);
  } catch {
    return null;
  }
  if (fm === null || typeof fm !== "object" || Array.isArray(fm)) return null;
  const f = fm as Record<string, unknown>;
  const name = typeof f.name === "string" && f.name.trim() !== "" ? f.name.trim() : dirName;
  const description = typeof f.description === "string" ? f.description.trim() : "";
  const area = typeof f.area === "string" ? f.area.trim() : "";
  const body = text.slice(match[0].length);
  const parsed = skillSchema.safeParse({
    id: dirName,
    version: 1,
    name,
    applies_to: { stacks: asStringList(f.stack), capabilities: area ? [area] : [] },
    steps: skillMdSteps(body, description),
    evidence: [],
    description,
    area,
  });
  return parsed.success ? parsed.data : null;
}

/** Load every `<dir>/<name>/SKILL.md` in the library, sorted by directory name. */
export function loadSkillMdLibrary(dir: string): Skill[] {
  let entries: string[];
  try {
    if (!statSync(dir).isDirectory()) return [];
    entries = readdirSync(dir).sort();
  } catch {
    return [];
  }
  const skills: Skill[] = [];
  for (const entry of entries) {
    const file = join(dir, entry, "SKILL.md");
    let text: string;
    try {
      if (!statSync(file).isFile()) continue;
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const skill = parseSkillMd(text, entry);
    if (skill) skills.push(skill);
  }
  return skills;
}

/**
 * Build a {@link SkillRegistry} from the v1 built-ins, the factory's SKILL.md
 * library (the skills the live agents actually run with), plus any `skills/` YAML in
 * the factory dir. Later sources override earlier ones by id (last write wins): a
 * library SKILL.md replaces the descriptive built-in of the same name, and a
 * human-authored YAML file overrides both.
 */
export function loadSkillRegistry(opts: LoadSkillsOptions = {}): SkillRegistry {
  const registry = new SkillRegistry();
  if (opts.includeBuiltins ?? true) {
    for (const skill of builtinSkills()) registry.add(skill);
  }
  if (opts.skillMdDir !== false) {
    for (const skill of loadSkillMdLibrary(opts.skillMdDir ?? defaultSkillMdDir())) {
      registry.add(skill);
    }
  }
  if (opts.factoryDir) {
    const dir = resolve(opts.factoryDir, "skills");
    for (const skill of loadSkillsFromDir(dir)) registry.add(skill);
  }
  return registry;
}

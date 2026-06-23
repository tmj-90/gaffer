import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { parse as parseYaml } from "yaml";
import { ZodError } from "zod";

import { invalidConfig } from "../util/errors.js";
import { builtinSkills } from "./builtins.js";
import { SkillRegistry } from "./registry.js";
import { skillFileSchema, type Skill } from "./schema.js";

export interface LoadSkillsOptions {
  /** Factory root directory; a `skills/` subdir is loaded if present. */
  factoryDir?: string;
  /** Include v1 built-in skills (default true). */
  includeBuiltins?: boolean;
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

/**
 * Build a {@link SkillRegistry} from the v1 built-ins plus any `skills/` YAML in
 * the factory dir. Human-authored files override built-ins by id (last write
 * wins in the registry).
 */
export function loadSkillRegistry(opts: LoadSkillsOptions = {}): SkillRegistry {
  const registry = new SkillRegistry();
  if (opts.includeBuiltins ?? true) {
    for (const skill of builtinSkills()) registry.add(skill);
  }
  if (opts.factoryDir) {
    const dir = resolve(opts.factoryDir, "skills");
    for (const skill of loadSkillsFromDir(dir)) registry.add(skill);
  }
  return registry;
}

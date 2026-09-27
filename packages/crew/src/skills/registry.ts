import { CrewError } from "../util/errors.js";
import type { Skill } from "./schema.js";

export interface SkillSelectQuery {
  stacks?: string[];
  capabilities?: string[];
}

/**
 * In-memory registry of loaded skills. A skill is selectable for a query when:
 *  - its `applies_to.stacks` is empty (stack-agnostic) OR intersects the query
 *    stacks, AND
 *  - its `applies_to.capabilities` is empty OR intersects the query capabilities.
 * An empty query field is treated as "no constraint" on that dimension.
 */
export class SkillRegistry {
  private readonly byId = new Map<string, Skill>();

  constructor(skills: readonly Skill[] = []) {
    for (const skill of skills) this.add(skill);
  }

  /** Add a skill. Last-write-wins per id so human files can override built-ins. */
  add(skill: Skill): void {
    this.byId.set(skill.id, skill);
  }

  list(): Skill[] {
    return [...this.byId.values()];
  }

  find(id: string): Skill | undefined {
    return this.byId.get(id);
  }

  get(id: string): Skill {
    const skill = this.byId.get(id);
    if (!skill) throw new CrewError("SKILL_NOT_FOUND", `Skill not found: ${id}`, { id });
    return skill;
  }

  /** Skills applicable to the given stacks + capabilities (see class doc). */
  select(query: SkillSelectQuery): Skill[] {
    const wantStacks = query.stacks ?? [];
    const wantCaps = query.capabilities ?? [];
    return this.list().filter((skill) => {
      const stackOk = matches(skill.applies_to.stacks, wantStacks);
      const capOk = matches(skill.applies_to.capabilities, wantCaps);
      return stackOk && capOk;
    });
  }
}

/**
 * A skill dimension matches when the skill declares no constraint (empty), or
 * the query supplies no constraint (empty), or the two sets intersect.
 */
function matches(declared: readonly string[], wanted: readonly string[]): boolean {
  if (declared.length === 0 || wanted.length === 0) return true;
  return declared.some((d) => wanted.includes(d));
}

/**
 * Expand compound stack labels into the token set skills are tagged with. A repo's
 * stack label like "typescript-react-native-expo" expands to the whole plus its parts
 * ("typescript-react-native-expo", "typescript", "react", "native", "expo") so a skill
 * tagged with either the broad or the specific stack matches. Mirrors the runner's
 * `select-skills.mjs expandStacks` and the context packet's `ticketStacks` EXACTLY, so
 * `fg skills --stack <label>` (tick.sh's fallback selector) agrees with both. Lower-cased,
 * de-duplicated, order preserved (whole label first).
 */
export function expandStackLabels(labels: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of labels) {
    const normalised = String(raw ?? "")
      .toLowerCase()
      .trim();
    if (!normalised) continue;
    out.add(normalised);
    for (const part of normalised.split(/[-/]+/).filter(Boolean)) out.add(part);
  }
  return [...out];
}

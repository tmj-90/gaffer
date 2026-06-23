import { z } from "zod";

/**
 * Skill shape from 04-loops-hooks-skills.md. Skills are *descriptive* versioned
 * procedures in v1 — load/select/list only, no execution engine. Validated at
 * the boundary (built-in templates + any `skills/` YAML in the factory dir).
 */
export const skillSchema = z.object({
  id: z.string().min(1, "skill.id is required"),
  version: z.number().int().positive().default(1),
  name: z.string().min(1, "skill.name is required"),
  applies_to: z
    .object({
      stacks: z.array(z.string()).default([]),
      capabilities: z.array(z.string()).default([]),
    })
    .default({}),
  steps: z.array(z.string().min(1)).min(1, "a skill needs at least one step"),
  evidence: z.array(z.string()).default([]),
});

export type Skill = z.infer<typeof skillSchema>;

/** A file may contain a single skill or a list of skills. */
export const skillFileSchema = z.union([skillSchema, z.array(skillSchema)]);

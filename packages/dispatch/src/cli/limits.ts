import type { Command } from "commander";

/**
 * The ranges and limits the domain schemas enforce on what a person types, in words.
 * One source for two places (exploratory findings cli-wg/F-15 and F-25): the help
 * text of the options they apply to, and the message of a validation failure, which
 * used to be raw zod text ("Expected number, received nan").
 */
export const RULES = {
  priority: "a whole number between 0 and 1000",
  budget: "a number greater than 0 (US dollars)",
  title: "1 to 300 characters on one line",
  criterion: "1 to 2000 characters on one line",
  description: "at most 20000 characters",
} as const;

/**
 * Per command (its path below the program), the schema field → the rule that field
 * is held to. Only commands whose option maps one-to-one onto a schema field are
 * listed; anything else falls back to the flag (when one matches) and the issue's
 * own message.
 */
const FIELD_RULES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "ticket create": {
    title: RULES.title,
    description: RULES.description,
    priority: RULES.priority,
    delivery_budget_usd: RULES.budget,
  },
  "ticket edit": { title: RULES.title, description: RULES.description, priority: RULES.priority },
  "ticket budget": { delivery_budget_usd: RULES.budget },
  "ac add": { text: RULES.criterion },
  "ac edit": { text: RULES.criterion },
};

/** Schema field → the option attribute names that set it, where they differ. */
const FIELD_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  delivery_budget_usd: ["budget", "usd"],
  policy_pack: ["policy"],
  risk_level: ["risk"],
  verification_method: ["verify"],
  check_command: ["check"],
  spec_clause_id: ["clause"],
  display_name: ["name"],
  max_risk: ["maxRisk"],
  shirt_number: ["number"],
};

const camel = (s: string): string => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** The flag a person typed for a schema field on this command (e.g. `--budget`), if any. */
export function flagForField(cmd: Command | undefined, field: string): string | undefined {
  if (!cmd) return undefined;
  const names = FIELD_OPTIONS[field] ?? [camel(field)];
  const opt = cmd.options.find((o) => names.includes(o.attributeName()));
  return opt ? (opt.long ?? opt.short) : undefined;
}

/** The plain-words rule for a field on this command, if it has one. */
export function ruleForField(commandPath: string, field: string): string | undefined {
  return FIELD_RULES[commandPath]?.[field];
}

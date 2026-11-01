/**
 * Exploratory finding cli-wg/F-25: `ticket create` and `ac add` help did not state the
 * ranges they enforce, so a person found them only through raw zod messages. The help
 * now states them, from the same words a validation failure uses (src/cli/limits.ts).
 */
import type { Command } from "commander";
import { describe, expect, it } from "vitest";

import { RULES } from "../src/cli/limits.js";
import { buildProgram } from "../src/cli/program.js";

const program = buildProgram({ name: "dispatch" });
const sub = (path: string): Command =>
  path.split(" ").reduce<Command>((c, n) => c.commands.find((x) => x.name() === n)!, program);
/** Help with the column wrapping undone, so a phrase is matched across a line break. */
const help = (path: string): string => sub(path).helpInformation().replace(/\s+/g, " ");

describe("cli-wg F-25: help states the ranges and limits", () => {
  it("ticket create: priority 0-1000, budget > 0, title 300 chars", () => {
    const h = help("ticket create");
    expect(h).toContain("--priority <n> priority: a whole number between 0 and 1000");
    expect(h).toContain("a number greater than 0 (US dollars)");
    expect(h).toContain("-t, --title <title> ticket title: 1 to 300 characters on one line");
  });

  it("ticket edit and ticket budget state theirs", () => {
    expect(help("ticket edit")).toContain(RULES.priority);
    expect(help("ticket edit")).toContain(RULES.title);
    expect(help("ticket budget")).toContain(RULES.budget);
  });

  it("ac add / ac edit: criterion 2000 chars", () => {
    expect(help("ac add")).toContain(
      "-t, --text <text> the criterion: 1 to 2000 characters on one line",
    );
    expect(help("ac edit")).toContain(RULES.criterion);
  });

  it("the words match what the schemas enforce", () => {
    expect(RULES.priority).toBe("a whole number between 0 and 1000");
    expect(RULES.title).toMatch(/300 characters/);
    expect(RULES.criterion).toMatch(/2000 characters/);
  });
});

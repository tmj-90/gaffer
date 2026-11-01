/**
 * Exploratory findings cli-wg/F-14, F-23, F-24 and fresh-user/F-22:
 *  - a usage error (unknown command or option, missing argument or required option)
 *    exited 1 like a NOT_FOUND, so a script could not tell a typo from a refusal; the
 *    `gaffer` front door promises "an unknown command or option exits 2";
 *  - `wg help <unknown>` printed the root usage, exit 1, without saying it was unknown;
 *  - every Usage line said `dispatch`, not `gaffer wg`;
 *  - help showed internal tracker codes, did not mark required options and mixed the
 *    runner's bookkeeping commands in with a person's.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Command } from "commander";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import {
  RUNNER_INTERNAL_COMMANDS,
  RUNNER_INTERNAL_HEADING,
  allCommands,
  buildProgram,
  commandPath,
} from "../src/cli/program.js";

import { CLI_BUILT, oneLineError, runBin } from "./helpers/cliBin.js";

let dir: string;
let db: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "wg-usage-"));
  db = join(dir, "d.sqlite");
  Dispatch.open(db).db.close();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(!CLI_BUILT)("cli-wg F-14 / F-24: usage errors exit 2, refusals exit 1", () => {
  it.each([
    [["ticket", "list", "--nope"], /unknown option '--nope'/],
    [["ticket", "create"], /required option '-t, --title <title>' not specified/],
    [["ticket", "show"], /missing required argument 'ref'/],
    [["bogus"], /unknown command 'bogus'/],
    [["ticket", "bogus"], /unknown command 'bogus'/],
    [["help", "bogus"], /unknown command 'bogus'/],
    [["ticket", "help", "bogus"], /unknown command 'bogus'/],
    [["help", "ticket", "bogus"], /unknown command 'bogus'/],
    [["ticket"], /a command is missing/],
  ])("%j exits 2 and names the problem", (args, re) => {
    const r = runBin(db, args as string[]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(re);
    expect(r.stdout).toBe("");
  });

  it("a runtime refusal (NOT_FOUND) still exits 1 with the JSON error", () => {
    const r = runBin(db, ["ticket", "show", "999"]);
    expect(r.status).toBe(1);
    expect(oneLineError(r.stderr).code).toBe("NOT_FOUND");
  });

  it("help <command> [subcommand] prints that command's help and exits 0", () => {
    for (const args of [
      ["help", "ticket", "create"],
      ["ticket", "help", "create"],
      ["ticket", "create", "--help"],
    ]) {
      const r = runBin(db, args);
      expect(r.status, args.join(" ")).toBe(0);
      expect(r.stdout).toMatch(/^Usage: dispatch ticket create \[options\]/);
    }
    const root = runBin(db, ["help"]);
    expect(root.status).toBe(0);
    expect(root.stdout).toMatch(/^Usage: dispatch \[options\] \[command\]/);
  });
});

describe.skipIf(!CLI_BUILT)("fresh-user F-22 / cli-wg F-23: help names `gaffer wg`", () => {
  it("Usage lines use the invoked name", () => {
    const env = { DISPATCH_CLI_NAME: "gaffer wg" };
    const r = runBin(db, ["ticket", "create", "--help"], { env });
    expect(r.stdout).toMatch(/^Usage: gaffer wg ticket create \[options\]/);
    const bad = runBin(db, ["ticket", "create"], { env });
    expect(bad.stderr).toContain("Usage: gaffer wg ticket create");
    const root = runBin(db, ["--help"], { env });
    expect(root.stdout).toMatch(/^Usage: gaffer wg \[options\] \[command\]/);
    expect(root.stdout).not.toMatch(/Usage: dispatch/);
  });
});

/** Every command's full help text, rendered in-process. */
function helpTexts(program: Command): Array<[string, string]> {
  return allCommands(program).map((c) => [commandPath(c) || "(root)", c.helpInformation()]);
}

describe("cli-wg F-23: help content", () => {
  const program = buildProgram({ name: "dispatch" });

  it("shows no internal tracker codes", () => {
    const codes =
      /\b(?:WG|BBT|TRACK|EP|FG|SDD|H)-\d+[a-z]?\b|\bFG-|RUNNER-OWNED|PER-REPOSITORY LANDING|I3 lint|DELIVERY-DOSSIER|GRADUATED-AUTONOMY|TESTER REPLAY:|REQUIRED CI:|GATE INTEGRITY:|PAUSE-ON-CAP|MACHINE-CHECKABLE:/;
    const hits = helpTexts(program)
      .filter(([, text]) => codes.test(text))
      .map(([path, text]) => `${path}: ${text.match(codes)![0]}`);
    expect(hits).toEqual([]);
  });

  it("marks every required option (required)", () => {
    const unmarked: string[] = [];
    for (const cmd of allCommands(program)) {
      const text = cmd.helpInformation();
      for (const o of cmd.options.filter((o) => o.mandatory)) {
        const line = text.split("\n").find((l) => l.trimStart().startsWith(o.flags));
        // The description may wrap: look from the flag's line to the next option.
        const from = text.indexOf(line ?? o.flags);
        const rest = text.slice(from, from + 600);
        const block = rest.split(/\n {2}-/)[0] ?? "";
        if (!block.includes("(required)")) unmarked.push(`${commandPath(cmd)} ${o.flags}`);
      }
    }
    expect(unmarked).toEqual([]);
    const create = program.commands
      .find((c) => c.name() === "ticket")!
      .commands.find((c) => c.name() === "create")!;
    expect(create.helpInformation()).toMatch(/-t, --title <title>[^-]*\(required\)/);
  });

  it("groups the runner's own commands under their own heading", () => {
    const root = program.helpInformation();
    expect(root).toContain(RUNNER_INTERNAL_HEADING);
    const [people, internal] = root.split(RUNNER_INTERNAL_HEADING);
    for (const name of ["runner-release", "heartbeat", "claim-ticket", "attach-evidence"]) {
      expect(internal).toMatch(new RegExp(`^  ${name}\\b`, "m"));
      expect(people).not.toMatch(new RegExp(`^  ${name}\\b`, "m"));
    }
    for (const name of ["ticket", "review", "human-claim", "block", "decisions"]) {
      expect(people).toMatch(new RegExp(`^  ${name}\\b`, "m"));
    }
    const ticket = program.commands.find((c) => c.name() === "ticket")!.helpInformation();
    expect(ticket.split(RUNNER_INTERNAL_HEADING)[1]).toMatch(/^ {2}paused-clear\b/m);
  });

  it("every listed runner-internal command exists (a rename cannot drop one silently)", () => {
    const missing: string[] = [];
    for (const [parent, names] of Object.entries(RUNNER_INTERNAL_COMMANDS)) {
      const cmd = allCommands(program).find((c) => commandPath(c) === parent);
      for (const n of names) {
        if (!cmd?.commands.some((c) => c.name() === n)) missing.push(`${parent} ${n}`.trim());
      }
    }
    expect(missing).toEqual([]);
  });

  it("the root help states the output, error and exit-code rules", () => {
    const root = program.helpInformation() + "\n" + rootAfter(program);
    expect(root).toMatch(/Exit codes: 0 done; 1 refused or failed/);
    expect(root).toMatch(/2 a usage error/);
  });
});

/** The text commander prints after the root help (addHelpText("after")). */
function rootAfter(program: Command): string {
  let out = "";
  program.configureOutput({ writeOut: (s) => (out += s) });
  program.outputHelp();
  return out;
}

/**
 * Exploratory finding cli-wg/F-21: only stats, doctor, human-queue and the events
 * commands took `--json` (they print text by default); every other command always
 * prints JSON and refused `--json` ("unknown option '--json'"), so a script could not
 * pass it uniformly. The rule now: JSON is the default everywhere except those text
 * commands, and every command accepts `--json` (a no-op where JSON is the default).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import { allCommands, buildProgram, commandPath } from "../src/cli/program.js";

import { CLI_BUILT, runBin } from "./helpers/cliBin.js";

let dir: string;
let db: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "wg-json-"));
  db = join(dir, "d.sqlite");
  const wg = Dispatch.open(db);
  wg.createTicket({ title: "t" }, { type: "human", id: "test" });
  wg.db.close();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("cli-wg F-21: --json is accepted by every command", () => {
  const program = buildProgram({ name: "dispatch" });

  it("every leaf command has a --json option", () => {
    const leaves = allCommands(program).filter((c) => c.commands.length === 0);
    const without = leaves
      .filter((c) => !c.options.some((o) => o.long === "--json"))
      .map((c) => commandPath(c));
    expect(without).toEqual([]);
  });

  it("the root help says so", () => {
    let out = "";
    program.configureOutput({ writeOut: (s) => (out += s) });
    program.outputHelp();
    expect(out.replace(/\s+/g, " ")).toMatch(/Every command accepts --json/);
  });
});

describe.skipIf(!CLI_BUILT)("cli-wg F-21: end to end", () => {
  it("`ticket show 1 --json` prints the same JSON as without it", () => {
    const a = runBin(db, ["ticket", "show", "1", "--json"]);
    expect(a.status).toBe(0);
    const b = runBin(db, ["ticket", "show", "1"]);
    expect(JSON.parse(a.stdout)).toEqual(JSON.parse(b.stdout));
  });

  it("stats keeps text by default and JSON with --json", () => {
    expect(() => JSON.parse(runBin(db, ["stats"]).stdout)).toThrow();
    expect(JSON.parse(runBin(db, ["stats", "--json"]).stdout)).toHaveProperty("ticketsByStatus");
  });
});

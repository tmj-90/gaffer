import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import { parseSpecClauses, type Actor } from "../src/domain/types.js";

import { runCli } from "./helpers/cli.js";

/**
 * Exploratory finding cli-wg/F-16: validation the rest of the CLI has was missing in
 * four places. An empty decision (title and question "") was stored and showed as an
 * empty "[Decision] — why:" in the human queue; `agent register -n ""` stored an empty
 * display name; `ac add --clause does-not-exist` recorded provenance pointing at no
 * spec clause; `ticket record-landing --via bogus` was not refused as an unknown --via.
 */
const human: Actor = { type: "human", id: "tom" };

function count(db: string, sql: string): number {
  const wg = Dispatch.open(db);
  try {
    return (wg.db.prepare(sql).get() as { n: number }).n;
  } finally {
    wg.db.close();
  }
}

describe("cli-wg F-16: validation gaps", () => {
  let dir: string;
  let db: string;
  let clauseId: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wg-gaps-"));
    db = join(dir, "d.sqlite");
    const wg = Dispatch.open(db);
    wg.createTicket({ title: "t" }, human);
    const spec = wg.createSpec(
      { title: "s", brief: "b", clauses: [{ kind: "requirement", text: "it works" }] },
      human,
    );
    clauseId = parseSpecClauses(spec.clauses_json)[0]!.clause_id;
    wg.db.close();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("an empty or blank decision title or question is refused", () => {
    for (const [title, question] of [
      ["", ""],
      ["  ", "why?"],
      ["Pick a db", " "],
    ]) {
      const r = runCli(db, ["decision", "--title", title!, "--question", question!]);
      expect(r.error, JSON.stringify([title, question])).toBeDefined();
    }
    expect(count(db, "SELECT COUNT(*) AS n FROM decisions")).toBe(0);
    expect(
      runCli(db, ["decision", "--title", "Pick a db", "--question", "pg or sqlite?"]).error,
    ).toBeUndefined();
  });

  it("agent register refuses an empty display name (omitting -n is still fine)", () => {
    expect(runCli(db, ["agent", "register", "-n", ""]).error).toBeDefined();
    expect(runCli(db, ["agent", "register", "-n", "   "]).error).toBeDefined();
    expect(count(db, "SELECT COUNT(*) AS n FROM agents")).toBe(0);
    expect(runCli(db, ["agent", "register"]).error).toBeUndefined();
    expect(runCli(db, ["agent", "register", "-n", "Bez"]).error).toBeUndefined();
  });

  it("ac add --clause must name an existing spec clause", () => {
    const bad = runCli(db, ["ac", "add", "1", "-t", "prov", "--clause", "does-not-exist:at-all"]);
    expect(bad.error).toBeDefined();
    expect(String((bad.error as Error).message)).toMatch(/spec clause/);
    expect(count(db, "SELECT COUNT(*) AS n FROM acceptance_criteria")).toBe(0);
    expect(
      runCli(db, ["ac", "add", "1", "-t", "prov", "--clause", clauseId]).error,
    ).toBeUndefined();
  });

  it("record-landing --via is checked against its enum before anything runs", () => {
    const r = runCli(db, [
      "ticket",
      "record-landing",
      "1",
      "--repo",
      "svc",
      "--commit",
      "a".repeat(40),
      "--via",
      "bogus",
    ]);
    expect(r.error).toBeDefined();
    expect(JSON.stringify(r.error)).toMatch(/git-verified/);
  });
});

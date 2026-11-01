/**
 * Exploratory finding cli-wg/F-09: an explicit `--db` (which `runner/gaffer wg` always
 * passes) or DISPATCH_DB kept the old open-or-create behaviour, so a mistyped
 * GAFFER_DATA or --db silently created a new, empty board, answered `[]` with exit 0,
 * and the next `ticket create` wrote into it. Only `init` creates a database now;
 * every other command refuses a missing file with exit 2 and creates nothing.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CLI_BUILT, oneLineError, runBin } from "./helpers/cliBin.js";

const GAFFER = resolve(__dirname, "..", "..", "..", "runner", "gaffer");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wg-explicit-db-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(!CLI_BUILT)("cli-wg F-09: an explicit --db never conjures an empty board", () => {
  it("a missing --db is refused with exit 2, the setup hint, and no file", () => {
    const db = join(dir, "nope.sqlite");
    for (const args of [
      ["ticket", "list"],
      ["ticket", "create", "-t", "x"],
      ["doctor"],
      ["stats"],
    ]) {
      const r = runBin(db, args);
      expect(r.status, args.join(" ")).toBe(2);
      const e = oneLineError(r.stderr);
      expect(e.code).toBe("DB_NOT_FOUND");
      expect(e.message).toContain(`no database at ${db}`);
      expect(e.message).toContain("runner/gaffer setup");
      expect(e.message).toContain("wg init");
      expect(r.stdout).toBe("");
      expect(existsSync(db), args.join(" ")).toBe(false);
    }
  });

  it("DISPATCH_DB pointing at a missing file is refused the same way", () => {
    const db = join(dir, "env.sqlite");
    const r = runBin(null, ["ticket", "list"], { env: { DISPATCH_DB: db } });
    expect(r.status).toBe(2);
    expect(oneLineError(r.stderr).code).toBe("DB_NOT_FOUND");
    expect(existsSync(db)).toBe(false);
  });

  it("init still creates it (and its directory), and every command then opens it", () => {
    const db = join(dir, "sub", "d.sqlite");
    expect(runBin(db, ["init"]).status).toBe(0);
    expect(existsSync(db)).toBe(true);
    const r = runBin(db, ["ticket", "list"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([]);
  });

  it("`gaffer wg` with a mistyped GAFFER_DATA creates no stray board", () => {
    const data = join(dir, "emptydata");
    mkdirSync(data);
    const r = spawnSync("bash", [GAFFER, "wg", "ticket", "list"], {
      encoding: "utf8",
      env: { ...process.env, GAFFER_DATA: data, DISPATCH_DB: "" },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("runner/gaffer setup");
    expect(readdirSync(data)).toEqual([]);
  });
});

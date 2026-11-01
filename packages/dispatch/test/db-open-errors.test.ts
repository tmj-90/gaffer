/**
 * A database file Dispatch cannot read gets the same actionable DatabaseOpenError
 * guidance whatever is wrong with it (exploratory finding api-robustness/F16): a
 * directory at the DB path already did, but a corrupt file (garbage bytes) surfaced
 * as a bare "SqliteError: file is not a database" from the first pragma.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import { DatabaseOpenError, openDatabase } from "../src/db/connection.js";

const API_BIN = resolve(__dirname, "..", "dist", "api", "bin.js");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wg-db-open-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function corruptFile(): string {
  const p = join(dir, "dispatch.db");
  writeFileSync(p, Buffer.from("this is not a sqlite database, just some bytes\n".repeat(200)));
  return p;
}

describe("opening an unreadable Dispatch database", () => {
  it("a directory at the DB path is a DatabaseOpenError (unchanged)", () => {
    const p = join(dir, "is-a-dir.db");
    mkdirSync(p);
    expect(() => openDatabase(p)).toThrow(DatabaseOpenError);
  });

  it("a corrupt file is a DatabaseOpenError with the same guidance, not a bare SqliteError", () => {
    const p = corruptFile();
    let err: unknown;
    try {
      openDatabase(p);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DatabaseOpenError);
    const msg = (err as Error).message;
    expect(msg).toContain(`could not open the Dispatch database at ${p}`);
    expect(msg).toMatch(/reason: file is not a database/);
    expect(msg).toMatch(/If the file is corrupt, restore a backup/);
    expect(() => Dispatch.open(p)).toThrow(DatabaseOpenError);
  });

  it("the dashboard server started on a corrupt file prints the guidance, not a stack", () => {
    expect(existsSync(API_BIN), "build packages/dispatch first").toBe(true);
    const p = corruptFile();
    const r = spawnSync(process.execPath, [API_BIN, "--port", "0"], {
      env: {
        PATH: process.env["PATH"],
        HOME: dir,
        GAFFER_DATA: dir,
        DISPATCH_DB: p,
        DISPATCH_API_TOKEN: "db-open-test-token-0123456789abcdef",
        DISPATCH_AUDIT_OFF: "1",
      },
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("could not open the Dispatch database");
    expect(r.stderr).toMatch(/If the file is corrupt, restore a backup/);
    expect(r.stderr).not.toMatch(/^SqliteError/m);
    expect(r.stderr).not.toMatch(/\n\s+at /);
  });
});

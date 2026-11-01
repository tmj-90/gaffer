/**
 * Exploratory findings cli-wg/F-07 and cli-runner/F-13: the CLI printed raw Node /
 * SQLite stack traces (with internal file paths) for a bad `--role`, a missing input
 * file, an unwritable `--out`, a database write-locked by another process and a file
 * that is not a database, where every other failure is a one-line
 * `{"ok":false,"code",…}` on stderr. One error boundary now turns each of them into
 * that line; the REST side of the lock case is a 503 DB_BUSY, not a bare 500.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleError } from "../src/api/http.js";
import { Dispatch } from "../src/core.js";

import { CLI_BUILT, oneLineError, runBin } from "./helpers/cliBin.js";

const require = createRequire(import.meta.url);

/** No `    at …` frames, no `node:fs:…` source excerpts, no SqliteError banner. */
function expectNoStack(stderr: string): void {
  expect(stderr).not.toMatch(/\n\s+at /);
  expect(stderr).not.toMatch(/^node:/m);
  expect(stderr).not.toMatch(/^SqliteError/m);
  expect(stderr).not.toMatch(/file:\/\/\//);
}

let dir: string;
let db: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wg-err-boundary-"));
  db = join(dir, "d.sqlite");
  const wg = Dispatch.open(db);
  wg.createTicket({ title: "t" }, { type: "human", id: "test" });
  wg.registerRepository({ name: "r", default_branch: "main" }, { type: "human", id: "test" });
  wg.db.close();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(!CLI_BUILT)("cli-wg F-07: every failure is the one-line JSON error", () => {
  it("a bad --role is refused before the DB constraint, naming the roles", () => {
    const r = runBin(db, ["repo", "link", "1", "r", "--role", "bogus"]);
    expectNoStack(r.stderr);
    expect(r.status).toBe(1);
    const e = oneLineError(r.stderr);
    expect(e).toMatchObject({ ok: false, code: "VALIDATION_ERROR" });
    expect(e.message).toMatch(/--role must be one of: primary, secondary/);
  });

  it("--role lists its values in help", () => {
    const r = runBin(db, ["repo", "link", "--help"]);
    expect(r.stdout).toMatch(/primary \| secondary/);
  });

  it.each(["epic create", "spec create", "import"])(
    "a missing input file is FILE_NOT_FOUND (%s)",
    (cmd) => {
      const missing = join(dir, "no", "such.json");
      const r = runBin(db, [...cmd.split(" "), missing]);
      expectNoStack(r.stderr);
      expect(r.status).toBe(1);
      const e = oneLineError(r.stderr);
      expect(e.code).toBe("FILE_NOT_FOUND");
      expect(e.message).toContain(missing);
    },
  );

  it("an unwritable --out is WRITE_FAILED and writes nothing", () => {
    const out = join(dir, "no", "such", "dir", "b.json");
    const r = runBin(db, ["export", "--out", out]);
    expectNoStack(r.stderr);
    expect(r.status).toBe(1);
    const e = oneLineError(r.stderr);
    expect(e.code).toBe("WRITE_FAILED");
    expect(e.message).toContain(out);
    expect(r.stdout).toBe("");
  });

  it("a file that is not a database gets the open-failure guidance", () => {
    const garbage = join(dir, "garbage.sqlite");
    writeFileSync(garbage, "not a database\n".repeat(400));
    const r = runBin(garbage, ["ticket", "list"]);
    expectNoStack(r.stderr);
    expect(r.status).toBe(1);
    const e = oneLineError(r.stderr);
    expect(e.code).toBe("DISPATCH_DB_OPEN_FAILED");
    expect(e.message).toMatch(/If the file is corrupt, restore a backup/);
  });

  describe("a database write-locked by another process", () => {
    let holder: ChildProcess | undefined;
    afterEach(() => {
      holder?.kill("SIGKILL");
      holder = undefined;
    });

    it("is DB_BUSY with 'another process holds the database; retry'", async () => {
      const sqlite = require.resolve("better-sqlite3");
      holder = spawn(
        process.execPath,
        [
          "-e",
          `const D=require(${JSON.stringify(sqlite)});const db=new D(${JSON.stringify(db)});` +
            `db.exec("BEGIN IMMEDIATE");db.exec("UPDATE tickets SET title=title");` +
            `process.stdout.write("locked\\n");setTimeout(()=>{},60000);`,
        ],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      await new Promise<void>((resolve, reject) => {
        holder!.stdout!.on("data", (b: Buffer) => {
          if (String(b).includes("locked")) resolve();
        });
        holder!.on("exit", (c) => reject(new Error(`lock holder exited ${c}`)));
      });
      const r = runBin(db, ["ticket", "create", "-t", "x"]);
      expectNoStack(r.stderr);
      expect(r.status).toBe(1);
      const e = oneLineError(r.stderr);
      expect(e.code).toBe("DB_BUSY");
      expect(e.message).toContain("another process holds the database; retry");
      expect(existsSync(db)).toBe(true);
    }, 30_000);
  });
});

describe("REST: a busy database is a 503 DB_BUSY, not a bare 500", () => {
  it("handleError maps SQLITE_BUSY to 503 with the same code", () => {
    let status = 0;
    let body = "";
    const res = {
      headersSent: false,
      setHeader: () => undefined,
      writeHead: (s: number) => {
        status = s;
      },
      end: (b: string) => {
        body = b;
      },
    } as unknown as ServerResponse;
    const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    handleError(res, busy);
    expect(status).toBe(503);
    const parsed = JSON.parse(body) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe("DB_BUSY");
    expect(parsed.error.message).toContain("another process holds the database; retry");
  });
});

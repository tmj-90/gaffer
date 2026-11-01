/**
 * Exploratory findings cli-wg/F-07 and cli-runner/F-13: the CLI printed raw Node /
 * SQLite stack traces (with internal file paths) for a bad `--role`, a missing input
 * file, an unwritable `--out`, a database write-locked by another process and a file
 * that is not a database, where every other failure is a one-line
 * `{"ok":false,"code",…}` on stderr. One error boundary now turns each of them into
 * that line; the REST side of the lock case is a 503 DB_BUSY, not a bare 500.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CommanderError } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleError } from "../src/api/http.js";
import { describeCliFailure } from "../src/cli/errors.js";
import { Dispatch } from "../src/core.js";

import { CLI_BIN, CLI_BUILT, oneLineError, runBin } from "./helpers/cliBin.js";

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

describe.skipIf(!CLI_BUILT)(
  "cli-wg F-07: every failure is the one-line JSON error",
  { timeout: 60_000 },
  () => {
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

    it("a reader that closes the pipe early (`| head`) gets no EPIPE stack", () => {
      // Enough output to outlast the pipe buffer, so the CLI is still writing when the
      // reader has gone.
      const wg = Dispatch.open(db);
      for (let i = 0; i < 200; i++) {
        wg.createTicket(
          { title: `t${i}`, description: "x".repeat(2000) },
          { type: "human", id: "test" },
        );
      }
      wg.db.close();
      for (const args of ["export", "ticket list"]) {
        const r = spawnSync(
          "bash",
          [
            "-c",
            'set -o pipefail; "$0" "$1" --db "$2" $3 | head -c 1 >/dev/null',
            process.execPath,
            CLI_BIN,
            db,
            args,
          ],
          { encoding: "utf8", timeout: 60_000 },
        );
        expectNoStack(r.stderr);
        expect(r.stderr, args).not.toMatch(/EPIPE/);
        expect(r.status, `${args}: ${r.stderr}`).toBe(0);
      }
    });

    // Root ignores file permissions, so this runs wherever the tests are not root (CI).
    it.skipIf(process.getuid?.() === 0)(
      "a read-only database file is the open-failure guidance, not INTERNAL_ERROR",
      () => {
        chmodSync(db, 0o444);
        try {
          const r = runBin(db, ["ticket", "list"]);
          expectNoStack(r.stderr);
          expect(r.status).toBe(1);
          const e = oneLineError(r.stderr);
          expect(e.code).toBe("DISPATCH_DB_OPEN_FAILED");
          expect(e.message).toMatch(/read-only/);
        } finally {
          chmodSync(db, 0o644);
        }
      },
    );

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
  },
);

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

describe("the boundary's fallback for an unexpected error", () => {
  afterEach(() => {
    delete process.env["DISPATCH_DEBUG"];
  });

  it("is INTERNAL_ERROR with its message and no stack", () => {
    const f = describeCliFailure(new Error("boom"));
    expect(f.exitCode).toBe(1);
    expect(f.body).toEqual({
      ok: false,
      code: "INTERNAL_ERROR",
      message: "Unexpected error: boom",
    });
  });

  it("adds the stack under details only with DISPATCH_DEBUG=1", () => {
    process.env["DISPATCH_DEBUG"] = "1";
    const f = describeCliFailure(new Error("boom"));
    expect(f.body?.code).toBe("INTERNAL_ERROR");
    expect(String(f.body?.details?.["stack"])).toMatch(/Error: boom\n\s+at /);
  });

  it("a usage error exits 2, help and --version exit 0", () => {
    expect(describeCliFailure(new CommanderError(1, "commander.unknownOption", "x")).exitCode).toBe(
      2,
    );
    expect(describeCliFailure(new CommanderError(0, "commander.helpDisplayed", "x")).exitCode).toBe(
      0,
    );
    expect(describeCliFailure(new CommanderError(0, "commander.version", "x")).exitCode).toBe(0);
  });
});

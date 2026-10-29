import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { open } from "../src/cli/shared.js";
import { DispatchError } from "../src/util/errors.js";
import { assertCliDbExists, isImplicitDbPath } from "../src/util/paths.js";

/**
 * The CLI refuses to CREATE a database at the implicit `./.dispatch/dispatch.sqlite`
 * fallback (no --db, no DISPATCH_DB) for anything but `init`. The quickstart's
 * reviewer snippet lacked --db: run from the repo root it answered NOT_FOUND from a
 * brand-new empty database and left `.dispatch/` behind in the cwd.
 */
describe("implicit database path", () => {
  let dir: string;
  const originalDb = process.env.DISPATCH_DB;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dispatch-implicit-db-"));
    delete process.env.DISPATCH_DB;
    vi.spyOn(process, "cwd").mockReturnValue(dir);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (originalDb === undefined) delete process.env.DISPATCH_DB;
    else process.env.DISPATCH_DB = originalDb;
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a non-init command and creates nothing", () => {
    expect(isImplicitDbPath(undefined)).toBe(true);
    let err: unknown;
    try {
      open({});
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DispatchError);
    expect((err as DispatchError).code).toBe("DB_NOT_FOUND");
    expect((err as DispatchError).message).toContain("runner/gaffer wg");
    expect(existsSync(join(dir, ".dispatch"))).toBe(false);
  });

  it("init (create: true) still creates it, and later commands then open it", () => {
    open({}, { create: true }).db.close();
    expect(existsSync(join(dir, ".dispatch", "dispatch.sqlite"))).toBe(true);
    expect(() => assertCliDbExists(undefined)).not.toThrow();
    open({}).db.close();
  });

  it("an explicit --db or DISPATCH_DB keeps open-or-create", () => {
    const explicit = join(dir, "explicit.sqlite");
    expect(isImplicitDbPath(explicit)).toBe(false);
    open({ db: explicit }).db.close();
    expect(existsSync(explicit)).toBe(true);
    process.env.DISPATCH_DB = join(dir, "env.sqlite");
    expect(isImplicitDbPath(undefined)).toBe(false);
    open({}).db.close();
    expect(existsSync(join(dir, "env.sqlite"))).toBe(true);
  });
});

// End to end through the built bin (the exact quickstart failure): skipped when
// dist/ is absent; CI builds before it tests.
const CLI = resolve(__dirname, "..", "dist", "cli", "index.js");
describe.skipIf(!existsSync(CLI))("dispatch CLI binary", () => {
  it("`ticket show 1` with no --db exits non-zero and leaves no .dispatch/ behind", () => {
    const cwd = mkdtempSync(join(tmpdir(), "dispatch-cli-cwd-"));
    try {
      const env = { ...process.env };
      delete env.DISPATCH_DB;
      const r = spawnSync(process.execPath, [CLI, "ticket", "show", "1"], {
        cwd,
        env,
        encoding: "utf8",
      });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("DB_NOT_FOUND");
      expect(existsSync(join(cwd, ".dispatch"))).toBe(false);
      const init = spawnSync(process.execPath, [CLI, "init"], { cwd, env, encoding: "utf8" });
      expect(init.status).toBe(0);
      expect(existsSync(join(cwd, ".dispatch", "dispatch.sqlite"))).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

/**
 * Exploratory finding testspeed/TS-2: every `wg` call, `--version` included, loaded
 * the whole program (about 230 modules: the services, better-sqlite3 and zod with its
 * 60-odd locales) before commander looked at argv. The runner spawns `wg` dozens of
 * times per tick. The command tree is now built from light modules only; what an
 * action needs loads in a preAction hook (src/cli/runtime.ts).
 *
 * A module hook records every module the built CLI resolves, so these tests pin
 * which invocations load the action modules and which do not.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isVersionRequest } from "../src/cli/stdio.js";
import { Dispatch } from "../src/core.js";
import { VERSION } from "../src/version.js";

import { CLI_BIN, CLI_BUILT } from "./helpers/cliBin.js";

let dir: string;
let db: string;
let hook: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "wg-lazy-"));
  db = join(dir, "d.sqlite");
  Dispatch.open(db).db.close();
  hook = join(dir, "record.mjs");
  writeFileSync(
    hook,
    [
      'import { registerHooks } from "node:module";',
      'import { writeFileSync } from "node:fs";',
      "const seen = [];",
      "registerHooks({ resolve(s, c, next) { const r = next(s, c); seen.push(r.url); return r; } });",
      'process.on("exit", () => writeFileSync(process.env.WG_LAZY_OUT, seen.join("\\n")));',
    ].join("\n"),
  );
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Run the built CLI and return its exit code and the module URLs it resolved. */
function modulesFor(args: string[]): { status: number | null; modules: string[] } {
  const out = join(dir, "modules.txt");
  writeFileSync(out, "");
  const r = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(hook).href, CLI_BIN, "--db", db, ...args],
    { encoding: "utf8", env: { ...process.env, WG_LAZY_OUT: out }, timeout: 60_000 },
  );
  return { status: r.status, modules: readFileSync(out, "utf8").split("\n").filter(Boolean) };
}

const HEAVY = [/\/zod\//, /better-sqlite3/, /\/dist\/core\.js$/, /\/dist\/db\//, /\/services\//];
const heavyIn = (modules: string[]): string[] =>
  modules.filter((m) => HEAVY.some((re) => re.test(m)));

describe.skipIf(!CLI_BUILT)(
  "testspeed/TS-2: the CLI loads what an action needs only for an action",
  () => {
    it.each([["--version"], ["-v"], ["--db", "other.sqlite", "--version"], ["--db=x", "-v"]])(
      "%s prints the version without loading commander (TS-4)",
      (...args) => {
        const r = spawnSync(process.execPath, [CLI_BIN, ...args], { encoding: "utf8" });
        expect(r.status).toBe(0);
        expect(r.stdout).toBe(`${VERSION}\n`);
        expect(r.stderr).toBe("");
        expect(modulesFor(args).modules.filter((m) => !m.startsWith("node:"))).toEqual([
          expect.stringMatching(/\/dist\/cli\/index\.js$/),
          expect.stringMatching(/\/dist\/util\/compileCache\.js$/),
          expect.stringMatching(/\/dist\/cli\/stdio\.js$/),
          expect.stringMatching(/\/dist\/version\.js$/),
        ]);
      },
    );

    it.each([
      [["-v", "ticket", "list"], 0],
      [["--db", "--version"], 2],
      [["--help"], 0],
      [["help", "ticket", "create"], 0],
      [["ticket", "list", "--help"], 0],
      [["ticket"], 2],
      [["bogus"], 2],
      [["ticket", "list", "--nope"], 2],
    ])("%j loads no database, service or zod module (exit %i)", (args, code) => {
      const { status, modules } = modulesFor(args);
      expect(status).toBe(code);
      expect(modules.some((m) => m.includes("commander"))).toBe(true);
      expect(heavyIn(modules)).toEqual([]);
    });

    it("an action loads them, before it runs", () => {
      const { status, modules } = modulesFor(["ticket", "list"]);
      expect(status).toBe(0);
      expect(modules.some((m) => /\/dist\/core\.js$/.test(m))).toBe(true);
      expect(modules.some((m) => /\/zod\//.test(m))).toBe(true);
      // The REST body schemas are for `decisions resolve` alone.
      expect(modules.some((m) => /\/dist\/api\/schemas\.js$/.test(m))).toBe(false);
    });

    it("decisions resolve loads the REST body schema it validates with", () => {
      const { status, modules } = modulesFor(["decisions", "resolve", "nope0000", "--answer", "x"]);
      expect(status).toBe(1);
      expect(modules.some((m) => /\/dist\/api\/schemas\.js$/.test(m))).toBe(true);
    });
  },
);

describe("testspeed/TS-4: isVersionRequest", () => {
  it("is the version option alone, after any root --db", () => {
    for (const args of [["--version"], ["-v"], ["--db", "x", "-v"], ["--db=x", "--version"]]) {
      expect(isVersionRequest(args)).toBe(true);
    }
  });
  it("leaves everything else to commander", () => {
    for (const args of [
      [],
      ["-V"],
      ["--db", "--version"],
      ["-v", "ticket"],
      ["--version", "bogus"],
      ["ticket", "-v"],
      ["--json", "-v"],
      ["-hv"],
    ]) {
      expect(isVersionRequest(args)).toBe(false);
    }
  });
});

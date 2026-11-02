/**
 * Review finding testspeed-review/R-1: the CLI, API and MCP entries turned on Node's
 * compile cache in its default place, `<os.tmpdir()>/node-compile-cache`. Node runs
 * the bytecode it finds there once the recorded source hash matches, so whoever can
 * write that directory chooses the code a later `wg` runs: a strict-mode agent may
 * write the temp dirs (lib/sandbox.sh grants $TMPDIR and /tmp), and the runner's own
 * `wg` calls carry the runner's whole environment. The cache now lives next to the
 * code it caches (the package's own `node_modules/.cache`), which is exactly as
 * writable as `dist/` itself; `NODE_COMPILE_CACHE` still overrides it.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { compileCacheDir } from "../src/util/compileCache.js";

import { CLI_BIN, CLI_BUILT } from "./helpers/cliBin.js";

const PKG = resolve(__dirname, "..");
const DEFAULT_DIR = join(PKG, "node_modules", ".cache", "node-compile-cache");
const dir = mkdtempSync(join(tmpdir(), "wg-compile-cache-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(args: string[], env: Record<string, string | undefined>) {
  const e: Record<string, string | undefined> = { ...process.env, ...env };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete e[k];
  return spawnSync(process.execPath, [CLI_BIN, ...args], {
    encoding: "utf8",
    env: e,
    timeout: 60_000,
  });
}

describe("testspeed-review/R-1: where the compile cache lives", () => {
  it("defaults to the package's own node_modules/.cache, not the temp dir", () => {
    expect(compileCacheDir({})).toBe(DEFAULT_DIR);
    expect(compileCacheDir({ NODE_COMPILE_CACHE: "  " })).toBe(DEFAULT_DIR);
  });

  it("NODE_COMPILE_CACHE overrides it", () => {
    expect(compileCacheDir({ NODE_COMPILE_CACHE: "/srv/cache" })).toBe("/srv/cache");
  });
});

describe.skipIf(!CLI_BUILT)("testspeed-review/R-1: the built CLI and its cache", () => {
  it("writes nothing under TMPDIR and caches next to the package", () => {
    const tmp = join(dir, "tmp");
    mkdirSync(tmp);
    const r = run(["--help"], { TMPDIR: tmp, NODE_COMPILE_CACHE: undefined });
    expect(r.status).toBe(0);
    expect(existsSync(join(tmp, "node-compile-cache"))).toBe(false);
    expect(readdirSync(DEFAULT_DIR).length).toBeGreaterThan(0);
  });

  it("uses NODE_COMPILE_CACHE when it is set", () => {
    const cc = join(dir, "explicit");
    const r = run(["--help"], { NODE_COMPILE_CACHE: cc });
    expect(r.status).toBe(0);
    expect(readdirSync(cc).length).toBeGreaterThan(0);
  });

  it("NODE_DISABLE_COMPILE_CACHE=1 writes no cache", () => {
    const cc = join(dir, "disabled");
    const r = run(["--help"], { NODE_COMPILE_CACHE: cc, NODE_DISABLE_COMPILE_CACHE: "1" });
    expect(r.status).toBe(0);
    expect(existsSync(cc)).toBe(false);
  });

  it("a cache dir that cannot be created costs only the speedup", () => {
    const file = join(dir, "a-file");
    writeFileSync(file, "");
    for (const args of [["--version"], ["--help"]]) {
      const r = run(args, { NODE_COMPILE_CACHE: join(file, "cache") });
      expect(r.status, args.join(" ")).toBe(0);
      expect(r.stderr).toBe("");
    }
    // An action still reaches its own answer: no database there.
    const r = run(["--db", join(dir, "no.sqlite"), "ticket", "list"], {
      NODE_COMPILE_CACHE: join(file, "cache"),
    });
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stderr.trim())).toMatchObject({ code: "DB_NOT_FOUND" });
  });
});

/**
 * Review finding testspeed-review/R-2: the CLI's error contract is one JSON line on
 * stderr, never a stack. The lazy CLI loads its action modules, and the heavy half of
 * its error boundary, with dynamic imports; when one of them cannot load (a partial
 * or corrupted install, a module the build left out) the boundary itself failed to
 * import, and the process died on an unhandled rejection with a raw stack. A broken
 * program module did the same. Both are now the one INTERNAL_ERROR line, exit 1
 * (with the stack under `details` when DISPATCH_DEBUG=1), and `--help` still works
 * when only the action modules are broken.
 */
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CLI_BUILT } from "./helpers/cliBin.js";

const PKG = resolve(__dirname, "..");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A copy of the built package whose `broken` dist module fails to load. */
function brokenInstall(broken: string, how: "syntax" | "missing"): string {
  const root = mkdtempSync(join(tmpdir(), "wg-broken-"));
  dirs.push(root);
  const pkg = join(root, "dispatch");
  mkdirSync(pkg);
  cpSync(join(PKG, "dist"), join(pkg, "dist"), {
    recursive: true,
    filter: (src) => !/\.(map|d\.ts)$/.test(src) && !src.includes(`${join("dist", "api", "web")}`),
  });
  cpSync(join(PKG, "package.json"), join(pkg, "package.json"));
  symlinkSync(join(PKG, "node_modules"), join(pkg, "node_modules"), "dir");
  const file = join(pkg, "dist", broken);
  if (how === "syntax") appendFileSync(file, "\nthis is not javascript(\n");
  else writeFileSync(file, 'export * from "./no-such-module.js";\n');
  return join(pkg, "dist", "cli", "index.js");
}

function run(cli: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(
    process.execPath,
    [cli, "--db", join(tmpdir(), "wg-broken-none.sqlite"), ...args],
    {
      encoding: "utf8",
      env: { ...process.env, ...env, NODE_DISABLE_COMPILE_CACHE: "1" },
      timeout: 60_000,
    },
  );
}

function oneJsonLine(stderr: string): {
  ok: boolean;
  code: string;
  message: string;
  details?: { stack?: string };
} {
  const lines = stderr.split("\n").filter((l) => l.trim() !== "");
  expect(lines, stderr).toHaveLength(1);
  return JSON.parse(lines[0]!) as {
    ok: boolean;
    code: string;
    message: string;
    details?: { stack?: string };
  };
}

describe.skipIf(!CLI_BUILT)(
  "testspeed-review/R-2: a module that cannot load is one error line",
  () => {
    it.each([
      ["db/connection.js", "syntax"],
      ["db/connection.js", "missing"],
      ["core.js", "syntax"],
      ["util/zod3Compat.js", "syntax"],
      ["cli/errors.js", "syntax"],
    ] as const)("an action with %s broken (%s)", (broken, how) => {
      const cli = brokenInstall(broken, how);
      const r = run(cli, ["ticket", "list"]);
      expect(r.status).toBe(1);
      expect(r.stdout).toBe("");
      const body = oneJsonLine(r.stderr);
      expect(body).toMatchObject({ ok: false, code: "INTERNAL_ERROR" });
      expect(body.message).toMatch(/^Unexpected error: /);
      expect(body.details).toBeUndefined();

      const debug = oneJsonLine(run(cli, ["ticket", "list"], { DISPATCH_DEBUG: "1" }).stderr);
      expect(debug.details?.stack).toEqual(expect.any(String));

      // Help is built from the light modules alone.
      const help = run(cli, ["--help"]);
      expect(help.status).toBe(0);
      expect(help.stderr).toBe("");
    });

    it.each(["cli/program.js", "cli/helpers.js"])("the program itself with %s broken", (broken) => {
      const cli = brokenInstall(broken, "syntax");
      for (const args of [["ticket", "list"], ["--help"]]) {
        const r = run(cli, args);
        expect(r.status, args.join(" ")).toBe(1);
        expect(oneJsonLine(r.stderr)).toMatchObject({ ok: false, code: "INTERNAL_ERROR" });
      }
    });
  },
);

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newClaimToken } from "../src/util/id.js";

/**
 * A claim token used to be bare base64url, which starts with "-" one time in 64. The
 * CLI then read it as an option: `heartbeat -vXXX` and `submit N --token -vXXX` printed
 * the version and exited 0, so the runner's submit and release did nothing and the
 * ticket stayed `claimed` (seen as a rare CI failure in waste-controls and
 * pause-on-cap). Tokens now carry a prefix, and root options parse only before the
 * subcommand.
 */
const CLI = resolve(__dirname, "../dist/cli/index.js");

describe("claim tokens never look like CLI options", () => {
  it("every minted token starts with the ct_ prefix, never with '-'", () => {
    for (let i = 0; i < 2000; i++) {
      const t = newClaimToken();
      expect(t.startsWith("ct_")).toBe(true);
      expect(t.length).toBeGreaterThan(30);
    }
  });

  describe("a '-v…' value after the subcommand is not the root --version flag", () => {
    let dir: string;
    let db: string;
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [CLI, "--db", db, ...args], { encoding: "utf8" });

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "dispatch-dash-token-"));
      db = join(dir, "d.sqlite");
      expect(run("init").status).toBe(0);
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("heartbeat -- -vXXX is refused as an invalid claim, not answered with the version", () => {
      const r = run("heartbeat", "--", "-vAbCdEfGh");
      expect(r.stdout).not.toMatch(/^\d+\.\d+\.\d+\s*$/);
      expect(r.status).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).toContain("CLAIM_INVALID");
    });

    it("submit N --token -vXXX is refused, not answered with the version", () => {
      const r = run("submit", "1", "--token", "-vAbCdEfGh", "--reason", "x");
      expect(r.stdout).not.toMatch(/^\d+\.\d+\.\d+\s*$/);
      expect(r.status).not.toBe(0);
    });

    it("the root -v still prints the version before a subcommand", () => {
      const r = spawnSync(process.execPath, [CLI, "-v"], { encoding: "utf8" });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    });
  });
});

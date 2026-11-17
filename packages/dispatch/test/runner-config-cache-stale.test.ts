/**
 * Review of external review 21, item 3: the runner's config read is asynchronous now, so
 * a settings save can land WHILE a read runs. The read was cached under the file's bytes
 * as they were when it STARTED, though the config it ran read the file when it got to
 * it. A save in between (A, then B) left B's values cached under A's bytes, and once the
 * file was A again (a person switched back) the dashboard applied B's values for A: the
 * approve floor and auto merge could run on values the file no longer holds, from a
 * cache hit, with no read at all.
 *
 * The rule pinned here: a read whose file changed while it ran is never cached (it is
 * returned, and the caller's refresh sees the file changed and reads again).
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearRunnerConfigCache,
  readRunnerConfigAsync,
  setRunnerConfigCommandsForTest,
} from "../src/api/runnerConfig.js";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rc-cache-stale-"));
  clearRunnerConfigCache();
});
afterEach(() => {
  setRunnerConfigCommandsForTest(null);
  clearRunnerConfigCache();
  rmSync(dir, { recursive: true, force: true });
});

function script(name: string, body: string): string {
  const f = join(dir, name);
  writeFileSync(f, `#!/bin/sh\n${body}\n`);
  chmodSync(f, 0o755);
  return f;
}

const settings = (mode: string) =>
  writeFileSync(join(dir, "settings.json"), `${JSON.stringify({ GAFFER_MODE: mode })}\n`);

/** The mode the read reported (the stub's report is the file it read). */
function modeOf(r: Awaited<ReturnType<typeof readRunnerConfigAsync>>): string | null {
  if (!r.ok) return null;
  return (r.report as unknown as { GAFFER_MODE?: string }).GAFFER_MODE ?? null;
}

describe("a config read whose file changed while it ran is not cached", () => {
  it("A, a read starts, B is saved before the config reads the file, A again: A's values", async () => {
    // The records stub reads the file after a pause (a config sourcing before it gets to
    // settings.json); the report stub echoes what the records stub printed.
    const records = script("records.sh", 'sleep 0.4\ncat "$GAFFER_DATA/settings.json"');
    const show = script("show.sh", "cat");
    setRunnerConfigCommandsForTest({ records: [records], show: [show] });
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", GAFFER_DATA: dir };

    settings("supervised");
    const first = readRunnerConfigAsync(env);
    await new Promise((r) => setTimeout(r, 100));
    settings("autonomous"); // saved while the first read runs
    expect(modeOf(await first)).toBe("autonomous"); // what that read saw

    settings("supervised"); // switched back: the same bytes the first read started under
    const again = await readRunnerConfigAsync(env);
    expect(modeOf(again)).toBe("supervised");
  }, 20_000);

  it("a read whose file did not change is still cached (one read for the same bytes)", async () => {
    const count = join(dir, "count");
    const records = script("records.sh", `echo x >> "${count}"\ncat "$GAFFER_DATA/settings.json"`);
    const show = script("show.sh", "cat");
    setRunnerConfigCommandsForTest({ records: [records], show: [show] });
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", GAFFER_DATA: dir };
    settings("supervised");
    expect(modeOf(await readRunnerConfigAsync(env))).toBe("supervised");
    expect(modeOf(await readRunnerConfigAsync(env))).toBe("supervised");
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(count, "utf8").trim().split("\n")).toHaveLength(1);
  }, 20_000);
});

describe("a read that did not run to an exit is not cached", () => {
  it("a config process killed by a signal once does not answer every later load", async () => {
    const mark = join(dir, "ran-once");
    // First run: killed by a signal (a transient failure: memory, a stray kill). Later
    // runs: the file as read.
    const records = script(
      "records.sh",
      `if [ ! -e "${mark}" ]; then : > "${mark}"; kill -9 $$; fi\ncat "$GAFFER_DATA/settings.json"`,
    );
    const show = script("show.sh", "cat");
    setRunnerConfigCommandsForTest({ records: [records], show: [show] });
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", GAFFER_DATA: dir };
    settings("supervised");
    expect((await readRunnerConfigAsync(env)).ok).toBe(false);
    expect(modeOf(await readRunnerConfigAsync(env))).toBe("supervised");
  }, 20_000);

  it("a config that stops on a value it refuses is cached (the same file stops it again)", async () => {
    const count = join(dir, "count");
    const records = script(
      "records.sh",
      `echo x >> "${count}"\necho "stop: bad value" >&2\nexit 1`,
    );
    setRunnerConfigCommandsForTest({ records: [records], show: [script("show.sh", "cat")] });
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", GAFFER_DATA: dir };
    settings("supervised");
    expect((await readRunnerConfigAsync(env)).ok).toBe(false);
    expect((await readRunnerConfigAsync(env)).ok).toBe(false);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(count, "utf8").trim().split("\n")).toHaveLength(1);
  }, 20_000);
});

/**
 * The tool-backed scan oracles reach production behind `loops.oracles` (off by default).
 *
 * Regression: IdleLoopDeps.oracles was read by the type-quality, security and
 * tech-debt loops, but no production caller ever set it, so ~650 lines of tested
 * oracle code could never run. Now the shared idle tick (and `crew maintain`)
 * build the set from config:
 *   - off by default → no oracles, every loop keeps its heuristic path;
 *   - on → tsc / semgrep only, resolved from PATH, NEVER the repo's own
 *     node_modules/.bin (the repo controls that file);
 *   - an idle tick with a stub `tsc` on PATH records the oracle path.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { systemCommandRunner } from "../src/adapters/commandRunner.js";
import { parseConfig } from "../src/config/loader.js";
import type { CrewConfig } from "../src/config/schema.js";
import { FakeDispatchClient } from "../src/dispatch/fakeClient.js";
import { EventLog } from "../src/events/eventLog.js";
import { runIdleTick } from "../src/loops/idleTick.js";
import { buildOracleSet } from "../src/loops/oracles/build.js";
import { RepoRegistry } from "../src/registry/repoRegistry.js";
import { systemClock } from "../src/util/clock.js";

function config(oracles: string, repoPath?: string): CrewConfig {
  const repos = repoPath ? `repos:\n  - id: app\n    name: app\n    path: ${repoPath}\n` : "";
  return parseConfig(`factory:
  name: t
${repos}loops:
  idle_type_quality:
    enabled: true
${oracles}`);
}

describe("buildOracleSet", () => {
  it("is off by default — no oracles, so the loops stay heuristic", () => {
    expect(buildOracleSet(systemCommandRunner, config(""))).toBeUndefined();
  });

  it("offers only tsc and semgrep when enabled", () => {
    const set = buildOracleSet(systemCommandRunner, config("  oracles:\n    enabled: true\n"));
    expect(Object.keys(set ?? {}).sort()).toEqual(["security", "tsc"]);
    const tscOnly = buildOracleSet(
      systemCommandRunner,
      config("  oracles:\n    enabled: true\n    tools: [tsc]\n"),
    );
    expect(Object.keys(tscOnly ?? {})).toEqual(["tsc"]);
  });

  it("rejects eslint / knip (they load repo JS config)", () => {
    expect(() => config("  oracles:\n    enabled: true\n    tools: [eslint]\n")).toThrow();
  });
});

describe("an idle tick with loops.oracles on", () => {
  let tmp: string;
  let repoDir: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gaffer-oracle-wiring-"));
    repoDir = join(tmp, "app");
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(join(repoDir, "src", "a.ts"), "export const n: number = 1;\n");
    // A stub tsc on PATH that reports one diagnostic.
    const bin = join(tmp, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "tsc"),
      "#!/bin/sh\necho \"src/a.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.\"\nexit 2\n",
    );
    chmodSync(join(bin, "tsc"), 0o755);
    // A repo-local tsc that must NEVER run (the repo controls node_modules/.bin).
    const localBin = join(repoDir, "node_modules", ".bin");
    mkdirSync(localBin, { recursive: true });
    writeFileSync(join(localBin, "tsc"), `#!/bin/sh\ntouch "${join(tmp, "REPO_LOCAL_RAN")}"\n`);
    chmodSync(join(localBin, "tsc"), 0o755);
    savedPath = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${savedPath ?? ""}`;
  });
  afterEach(() => {
    process.env.PATH = savedPath;
    rmSync(tmp, { recursive: true, force: true });
  });

  async function tick(oracles: string) {
    const events = new EventLog(systemClock);
    const cfg = config(oracles, repoDir);
    await runIdleTick({
      config: cfg,
      repoRegistry: RepoRegistry.fromConfig(cfg, tmp),
      dispatch: new FakeDispatchClient(),
      runner: systemCommandRunner,
      events,
      clock: systemClock,
      resolveMemory: async () => null,
    });
    return events.events
      .filter((e) => e.type === "type_quality_scanned")
      .map((e) => (e.payload as { path: string }).path);
  }

  it("records the oracle path via the PATH tsc, never the repo-local one", async () => {
    const scanned = await tick("  oracles:\n    enabled: true\n    tools: [tsc]\n");
    expect(scanned).toEqual(["oracle"]);
    expect(existsSync(join(tmp, "REPO_LOCAL_RAN"))).toBe(false);
  });

  it("with the flag off the same tick stays heuristic", async () => {
    const scanned = await tick("");
    expect(scanned).toEqual(["heuristic"]);
  });
});

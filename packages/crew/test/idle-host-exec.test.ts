/**
 * Idle loops' repo commands are bounded, and refused on the host under strict
 * containment.
 *
 * Regression: systemCommandRunner.run (coverage_command, audit_command, the gh
 * ingest calls) used execSync with no timeout and the 1 MiB default buffer, so a
 * hung suite held the tick until the outer tick timeout and a big report was cut
 * into a failed parse. And with GAFFER_STRICT_REQUIRE on (autonomy mode), the
 * coverage loop still ran the repo's own test suite bare on the host while the
 * agent run and the DoD gates fail closed without a sandbox.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  defaultRunTimeoutMs,
  FakeCommandRunner,
  systemCommandRunner,
  type CommandResult,
} from "../src/adapters/commandRunner.js";
import { crewConfigSchema } from "../src/config/schema.js";
import { FakeDispatchClient } from "../src/dispatch/fakeClient.js";
import { EventLog } from "../src/events/eventLog.js";
import { idleHostExecRefused, runIdleCoverageLoop } from "../src/loops/idleLoop.js";
import { RepoRegistry } from "../src/registry/repoRegistry.js";
import { TestClock } from "../src/util/clock.js";

describe("systemCommandRunner.run is bounded", () => {
  const cwd = mkdtempSync(join(tmpdir(), "gaffer-run-bounds-"));

  it("kills an overrunning command (and its process group) at timeoutMs", () => {
    const started = Date.now();
    const res = systemCommandRunner.run("(sleep 999 &); sleep 999", cwd, { timeoutMs: 200 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).not.toBe(0);
  });

  it("flags output past maxBuffer as truncated instead of returning a cut parse", () => {
    const res = systemCommandRunner.run(
      "head -c 300000 /dev/zero | tr '\\0' a; echo; echo 'All files | 90'",
      cwd,
      { maxBuffer: 100_000 },
    );
    expect(res.truncated).toBe(true);
    expect(res.exitCode).not.toBe(0);
    expect(res.stdout.length).toBeLessThanOrEqual(100_000);
  });

  it("keeps the old contract for normal commands", () => {
    expect(systemCommandRunner.run("echo hi; echo err >&2", cwd)).toEqual({
      stdout: "hi\n",
      exitCode: 0,
    });
    const failed = systemCommandRunner.run("echo out; echo err >&2; exit 3", cwd);
    expect(failed).toEqual({ stdout: "out\nerr\n", exitCode: 3 });
    // Output well past the old 1 MiB execSync default is returned whole.
    const big = systemCommandRunner.run("head -c 2000000 /dev/zero | tr '\\0' a", cwd);
    expect(big.stdout.length).toBe(2_000_000);
    expect(big.exitCode).toBe(0);
  });

  it("defaults the cap to GAFFER_DOD_TIMEOUT seconds, else 900s", () => {
    expect(defaultRunTimeoutMs({ GAFFER_DOD_TIMEOUT: "60" })).toBe(60_000);
    expect(defaultRunTimeoutMs({})).toBe(900_000);
    expect(defaultRunTimeoutMs({ GAFFER_DOD_TIMEOUT: "junk" })).toBe(900_000);
  });
});

describe("the coverage loop", () => {
  function deps(result: CommandResult, env: NodeJS.ProcessEnv = {}) {
    const config = crewConfigSchema.parse({
      factory: { name: "t" },
      repos: [{ id: "demo", name: "demo", path: "/tmp", coverage_command: "pnpm coverage" }],
    });
    config.loops.idle_coverage.enabled = true;
    const runner = new FakeCommandRunner(result);
    const wg = new FakeDispatchClient();
    return {
      d: {
        config,
        repoRegistry: RepoRegistry.fromConfig(config, "/tmp"),
        dispatch: wg,
        runner,
        events: new EventLog(new TestClock()),
        clock: new TestClock(),
        env,
      },
      runner,
      wg,
    };
  }

  it("never parses a timed-out run as a finding", () => {
    const { d, wg } = deps({ stdout: "All files | 10 |", exitCode: 1, timedOut: true });
    const outcome = runIdleCoverageLoop(d);
    expect(outcome.status).toBe("no_findings");
    expect(d.events.types()).toContain("coverage_scan_failed");
    expect(wg.events.filter((e) => e.type === "draft_ticket.created")).toHaveLength(0);
  });

  it("refuses to run the repo's coverage_command on the host under GAFFER_STRICT_REQUIRE", () => {
    const { d, runner } = deps(
      { stdout: "TOTAL 100 40 60%", exitCode: 0 },
      {
        GAFFER_STRICT_REQUIRE: "1",
      },
    );
    const outcome = runIdleCoverageLoop(d);
    expect(runner.calls).toHaveLength(0);
    expect(outcome.status).toBe("no_findings");
    expect(d.events.types()).toContain("coverage_scan_refused");
  });

  it("runs it under strict mode only when GAFFER_IDLE_HOST_EXEC=1 opts in", () => {
    const { d, runner } = deps(
      { stdout: "TOTAL 100 40 60%", exitCode: 0 },
      {
        GAFFER_STRICT_REQUIRE: "1",
        GAFFER_IDLE_HOST_EXEC: "1",
      },
    );
    runIdleCoverageLoop(d);
    expect(runner.calls).toHaveLength(1);
  });

  it("is unchanged without strict mode", () => {
    expect(idleHostExecRefused({})).toBe(false);
    expect(idleHostExecRefused({ GAFFER_STRICT_REQUIRE: "0" })).toBe(false);
    expect(idleHostExecRefused({ GAFFER_STRICT_REQUIRE: "true" })).toBe(true);
  });
});

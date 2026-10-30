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
import { mkdtempSync, writeFileSync } from "node:fs";
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
import { runIdleDependencyLoop } from "../src/loops/idleDependencies.js";
import { coverageGap, idleHostExecRefused, runIdleCoverageLoop } from "../src/loops/idleLoop.js";
import { buildOracleSet } from "../src/loops/oracles/build.js";
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

describe("the coverage loop files only real gaps (the target decides)", () => {
  function deps(result: CommandResult, target = 80) {
    const config = crewConfigSchema.parse({
      factory: { name: "t" },
      repos: [{ id: "demo", name: "demo", path: "/tmp", coverage_command: "pnpm coverage" }],
    });
    config.loops.idle_coverage.enabled = true;
    config.loops.idle_coverage.minimum_gap_threshold = target;
    const wg = new FakeDispatchClient();
    return {
      d: {
        config,
        repoRegistry: RepoRegistry.fromConfig(config, "/tmp"),
        dispatch: wg,
        runner: new FakeCommandRunner(result),
        events: new EventLog(new TestClock()),
        clock: new TestClock(),
        env: {},
      },
      drafts: () => wg.events.filter((e) => e.type === "draft_ticket.created"),
    };
  }

  it("files nothing for a repo at 100% (it used to draft 'Coverage gap' by 0 points)", () => {
    const { d, drafts } = deps({ stdout: "All files | 100 | 100 |", exitCode: 0 });
    expect(runIdleCoverageLoop(d).status).toBe("no_findings");
    expect(drafts()).toHaveLength(0);
    expect(d.events.types()).toContain("coverage_within_target");
  });

  it("files nothing when the command fails (non-zero exit), even with a parsable total", () => {
    const { d, drafts } = deps({ stdout: "All files | 12 |", exitCode: 1 });
    expect(runIdleCoverageLoop(d).status).toBe("no_findings");
    expect(drafts()).toHaveLength(0);
    expect(d.events.types()).toContain("coverage_scan_failed");
  });

  it("files nothing when the output carries no recognisable total", () => {
    const { d, drafts } = deps({ stdout: "ran 3 suites, no report", exitCode: 0 });
    expect(runIdleCoverageLoop(d).status).toBe("no_findings");
    expect(drafts()).toHaveLength(0);
  });

  it("files a draft for a total below the target, with a true evidence line", () => {
    const { d, drafts } = deps({ stdout: "TOTAL 100 40 60%", exitCode: 0 }, 80);
    expect(runIdleCoverageLoop(d).status).toBe("draft_created");
    expect(drafts()).toHaveLength(1);
    expect(JSON.stringify(drafts()[0])).toContain("is 60% (below the 80% target by 20 points)");
  });

  it("coverageGap: the decision table", () => {
    expect(coverageGap({ exitCode: 0 }, { total: 79 }, 80)).toEqual({ file: true });
    expect(coverageGap({ exitCode: 0 }, { total: 80 }, 80)).toMatchObject({ file: false });
    expect(coverageGap({ exitCode: 2 }, { total: 10 }, 80)).toMatchObject({
      reason: "command_failed",
    });
    expect(coverageGap({ exitCode: 0 }, { total: null }, 80)).toMatchObject({
      reason: "unparseable",
    });
  });
});

describe("strict containment covers every idle host command, not only coverage", () => {
  function depDeps(env: NodeJS.ProcessEnv) {
    const root = mkdtempSync(join(tmpdir(), "gaffer-dep-strict-"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { "left-pad": "*" } }),
    );
    const config = crewConfigSchema.parse({
      factory: { name: "t" },
      repos: [{ id: "demo", name: "demo", path: root }],
    });
    config.loops.idle_dependencies.enabled = true;
    config.loops.idle_dependencies.audit_command = "touch audit-ran";
    const runner = new FakeCommandRunner({ stdout: "{}", exitCode: 0 });
    return {
      d: {
        config,
        repoRegistry: RepoRegistry.fromConfig(config, root),
        dispatch: new FakeDispatchClient(),
        runner,
        events: new EventLog(new TestClock()),
        clock: new TestClock(),
        env,
      },
      runner,
    };
  }

  it("refuses idle_dependencies.audit_command on the host under GAFFER_STRICT_REQUIRE", () => {
    const { d, runner } = depDeps({ GAFFER_STRICT_REQUIRE: "1" });
    const outcome = runIdleDependencyLoop(d);
    expect(runner.calls).toHaveLength(0);
    expect(d.events.types()).toContain("dependency_audit_refused");
    // The package.json range scan needs no exec, so it still finds the '*' range.
    expect(outcome.status).toBe("draft_created");
  });

  it("runs the audit command under strict mode only with GAFFER_IDLE_HOST_EXEC=1", () => {
    const { d, runner } = depDeps({ GAFFER_STRICT_REQUIRE: "1", GAFFER_IDLE_HOST_EXEC: "1" });
    runIdleDependencyLoop(d);
    expect(runner.calls).toHaveLength(1);
  });

  it("builds no tool oracles (tsc / semgrep on the host) under GAFFER_STRICT_REQUIRE", () => {
    const config = crewConfigSchema.parse({ factory: { name: "t" } });
    config.loops.oracles.enabled = true;
    const runner = new FakeCommandRunner({ stdout: "", exitCode: 0 });
    const events = new EventLog(new TestClock());
    expect(buildOracleSet(runner, config, { env: { GAFFER_STRICT_REQUIRE: "1" }, events })).toBe(
      undefined,
    );
    expect(events.types()).toContain("oracles_refused");
    expect(
      buildOracleSet(runner, config, {
        env: { GAFFER_STRICT_REQUIRE: "1", GAFFER_IDLE_HOST_EXEC: "1" },
      }),
    ).toBeDefined();
    expect(buildOracleSet(runner, config, { env: {} })).toBeDefined();
  });
});

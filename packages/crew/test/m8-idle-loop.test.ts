import { describe, expect, it } from "vitest";

import { runIdleCoverageLoop, parseCoverage } from "../src/loops/idleLoop.js";
import { FakeCommandRunner } from "../src/adapters/commandRunner.js";
import { EventLog } from "../src/events/eventLog.js";
import { FakeDispatchClient } from "../src/dispatch/fakeClient.js";
import { TestClock } from "../src/util/clock.js";
import { RepoRegistry } from "../src/index.js";
import { testConfig } from "./helpers.js";

const COVERAGE_OUTPUT = `
Name                       Stmts   Miss  Cover
----------------------------------------------
src/auth/login.py            120     30    75%
src/auth/reset.py             80     60    25%
src/util/format.py            40      0   100%
----------------------------------------------
TOTAL                        240     90    63%
`;

function idleDeps(wg: FakeDispatchClient, runner: FakeCommandRunner) {
  const config = testConfig();
  return {
    config,
    repoRegistry: RepoRegistry.fromConfig(config, "/tmp"),
    dispatch: wg,
    runner,
    events: new EventLog(new TestClock()),
    clock: new TestClock(),
  };
}

describe("parseCoverage", () => {
  it("extracts the total and lowest-covered files", () => {
    const parsed = parseCoverage(COVERAGE_OUTPUT);
    expect(parsed.total).toBe(63);
    expect(parsed.lowFiles[0]).toEqual({ file: "src/auth/reset.py", coverage: 25 });
    expect(parsed.lowFiles).not.toContainEqual({ file: "src/util/format.py", coverage: 100 });
  });

  it("handles istanbul-style 'All files' output", () => {
    expect(parseCoverage("All files | 42.5 |").total).toBe(42.5);
  });
});

describe("idle coverage loop", () => {
  it("creates a draft ticket referencing the repo and evidence, not code changes", () => {
    const wg = new FakeDispatchClient();
    const runner = new FakeCommandRunner({ stdout: COVERAGE_OUTPUT, exitCode: 0 });
    const d = idleDeps(wg, runner);

    const outcome = runIdleCoverageLoop(d);

    expect(outcome.status).toBe("draft_created");
    if (outcome.status !== "draft_created") throw new Error("unreachable");
    expect(outcome.drafts).toHaveLength(1);
    expect(outcome.drafts[0]!.repoName).toBe("web-app");
    expect(outcome.drafts[0]!.finding.totalCoverage).toBe(63);

    // The created ticket is a DRAFT, references the repo, and carries evidence.
    const ticket = wg.getTicket(outcome.drafts[0]!.ticketId);
    expect(ticket.ticket.status).toBe("draft");
    expect(ticket.repositories[0]!.name).toBe("web-app");
    expect(ticket.ticket.description).toMatch(/coverage/i);
    expect(ticket.ticket.description).toMatch(/no code was changed/i);

    // No evidence on real tickets, no branch — observation only.
    expect(wg.evidence).toHaveLength(0);

    // Event log records the idle ticket creation.
    expect(d.events.types()).toContain("idle_ticket_created");
    expect(d.events.types()).toContain("coverage_scanned");
  });

  it("skips when ready tickets exist (does not create idle work)", () => {
    const wg = new FakeDispatchClient();
    wg.seedTicket({ title: "ready work", status: "ready" });
    const runner = new FakeCommandRunner({ stdout: COVERAGE_OUTPUT, exitCode: 0 });
    const d = idleDeps(wg, runner);

    const outcome = runIdleCoverageLoop(d);
    expect(outcome.status).toBe("skipped_tickets_ready");
    expect(runner.calls).toHaveLength(0);
  });

  it("runs the coverage command in the resolved repo directory", () => {
    const wg = new FakeDispatchClient();
    const runner = new FakeCommandRunner({ stdout: COVERAGE_OUTPUT, exitCode: 0 });
    const d = idleDeps(wg, runner);
    runIdleCoverageLoop(d);
    expect(runner.calls[0]!.command).toBe("pnpm test -- --coverage");
    expect(runner.calls[0]!.cwd).toContain("test-web-app");
  });

  it("reports no_repos when no configured repo has a coverage command", () => {
    const config = testConfig({
      repos: [{ ...testConfig().repos[0]!, coverage_command: null }],
    });
    const wg = new FakeDispatchClient();
    const outcome = runIdleCoverageLoop({
      config,
      repoRegistry: RepoRegistry.fromConfig(config, "/tmp"),
      dispatch: wg,
      runner: new FakeCommandRunner({ stdout: "", exitCode: 0 }),
      events: new EventLog(new TestClock()),
      clock: new TestClock(),
    });
    expect(outcome.status).toBe("no_repos");
  });
});

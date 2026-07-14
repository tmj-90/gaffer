import { describe, expect, it } from "vitest";

import {
  checkPostConditions,
  isLintEvidence,
  isTestEvidence,
  summarisePostConditionFailures,
  type DeliveryFacts,
} from "../src/safety/postconditions.js";
import { defaultSafetyPolicy } from "../src/safety/policySchema.js";
import { runImplementationLoop } from "../src/loops/implementationLoop.js";
import { DryRunGitAdapter } from "../src/adapters/gitAdapter.js";
import { EventLog } from "../src/events/eventLog.js";
import { MockAgentRuntime } from "../src/runtime/agentRuntime.js";
import { NullMemoryClient } from "../src/memory/client.js";
import { FakeDispatchClient } from "../src/dispatch/fakeClient.js";
import { TestClock } from "../src/util/clock.js";
import { RepoRegistry } from "../src/index.js";
import { testConfig } from "./helpers.js";

const GIT = defaultSafetyPolicy().git;
const ALL_REQUIRED = {
  branchPrefix: true,
  testEvidence: true,
  acEvidence: true,
  lintClean: true,
} as const;

function facts(overrides: Partial<DeliveryFacts> = {}): DeliveryFacts {
  return {
    branch: `${GIT.require_branch_prefix}ticket-7-add-reset`,
    ticketNumber: 7,
    gitPolicy: GIT,
    acceptanceCriteria: [{ id: "ac-1", text: "AC one" }],
    evidence: [{ acId: "ac-1", evidenceType: "test_output" }, { evidenceType: "lint" }],
    lintConfigured: true,
    requirements: ALL_REQUIRED,
    ...overrides,
  };
}

describe("post-condition checker", () => {
  it("classifies evidence types case-insensitively", async () => {
    expect(isTestEvidence("test_output")).toBe(true);
    expect(isTestEvidence("Test Run")).toBe(true);
    expect(isTestEvidence("note")).toBe(false);
    expect(isLintEvidence("lint_clean")).toBe(true);
    expect(isLintEvidence("coverage_report")).toBe(false);
  });

  it("passes when every required post-condition is satisfied", async () => {
    const report = checkPostConditions(facts());
    expect(report.passed).toBe(true);
    expect(report.failures).toHaveLength(0);
  });

  it("flags a delivery with no test evidence (the AC example)", async () => {
    const report = checkPostConditions(
      facts({ evidence: [{ acId: "ac-1", evidenceType: "note" }, { evidenceType: "lint" }] }),
    );
    expect(report.passed).toBe(false);
    expect(report.failures.map((f) => f.id)).toContain("tests.evidence");
    expect(summarisePostConditionFailures(report)).toMatch(/test/i);
  });

  it("flags an acceptance criterion with no evidence", async () => {
    const report = checkPostConditions(
      facts({
        acceptanceCriteria: [
          { id: "ac-1", text: "covered" },
          { id: "ac-2", text: "uncovered" },
        ],
      }),
    );
    expect(report.passed).toBe(false);
    expect(report.failures.map((f) => f.id)).toContain("ac.evidence");
  });

  it("flags a branch without the required prefix", async () => {
    const report = checkPostConditions(facts({ branch: "feature/add-reset" }));
    expect(report.passed).toBe(false);
    expect(report.failures.map((f) => f.id)).toContain("branch.prefix");
  });

  it("flags a prefixed branch that does not reference the ticket", async () => {
    const report = checkPostConditions(
      facts({ branch: `${GIT.require_branch_prefix}ticket-99-other` }),
    );
    expect(report.passed).toBe(false);
    expect(report.failures.map((f) => f.id)).toContain("branch.prefix");
  });

  it("flags missing lint evidence when a lint command is configured", async () => {
    const report = checkPostConditions(
      facts({ evidence: [{ acId: "ac-1", evidenceType: "test_output" }] }),
    );
    expect(report.passed).toBe(false);
    expect(report.failures.map((f) => f.id)).toContain("lint.clean");
  });

  it("treats lint as not-applicable (advisory) when no lint command is configured", async () => {
    const report = checkPostConditions(
      facts({ lintConfigured: false, evidence: [{ acId: "ac-1", evidenceType: "test_output" }] }),
    );
    expect(report.passed).toBe(true);
    const lint = report.checks.find((c) => c.id === "lint.clean");
    expect(lint?.required).toBe(false);
    expect(lint?.satisfied).toBe(true);
  });

  it("only enforces the post-conditions that are switched on", async () => {
    const report = checkPostConditions(
      facts({
        branch: "feature/no-prefix",
        evidence: [],
        requirements: {
          branchPrefix: false,
          testEvidence: false,
          acEvidence: false,
          lintClean: false,
        },
      }),
    );
    expect(report.passed).toBe(true);
    expect(report.checks).toHaveLength(0);
  });
});

function loopDeps(
  wg: FakeDispatchClient,
  runtime: MockAgentRuntime,
  postConditionsEnabled: boolean,
) {
  const base = testConfig({
    repos: [{ ...testConfig().repos[0]!, path: "/tmp/web-app" }],
  });
  const config = {
    ...base,
    loops: {
      ...base.loops,
      implementation: {
        ...base.loops.implementation,
        post_conditions: {
          enabled: postConditionsEnabled,
          require_branch_prefix: true,
          require_test_evidence: true,
          require_ac_evidence: true,
          require_lint_clean: false, // repo lint not evidenced by the mock runtime
        },
      },
    },
  };
  return {
    config,
    policy: defaultSafetyPolicy(),
    repoRegistry: RepoRegistry.fromConfig(config, "/tmp"),
    dispatch: wg,
    memory: new NullMemoryClient(),
    git: new DryRunGitAdapter(),
    runtime,
    events: new EventLog(new TestClock()),
  };
}

describe("implementation loop — delivery post-conditions", () => {
  it("blocks the delivery when test evidence is missing", async () => {
    const wg = new FakeDispatchClient();
    wg.seedTicket({
      title: "Add reset",
      acceptanceCriteria: [{ text: "AC one" }],
      repositories: [{ name: "web-app", localPath: "/tmp/web-app" }],
    });
    // Mock runtime evidences the AC but never runs tests (type "note").
    const d = loopDeps(wg, new MockAgentRuntime(), true);
    const outcome = await runImplementationLoop({ agentId: "claude-auth-01", dryRun: true }, d);

    expect(outcome.status).toBe("blocked");
    if (outcome.status === "no_ticket" || outcome.status === "claim_vetoed")
      throw new Error("unreachable");
    expect(wg.getTicket(outcome.ticketId).ticket.status).toBe("blocked");
    expect(d.events.types()).toContain("postconditions_failed");
    expect(d.events.types()).not.toContain("ticket_submitted_for_review");
  });

  it("submits the delivery when every required post-condition holds", async () => {
    const wg = new FakeDispatchClient();
    const seeded = wg.seedTicket({
      title: "Add reset",
      acceptanceCriteria: [{ text: "AC one" }],
      repositories: [{ name: "web-app", localPath: "/tmp/web-app" }],
    });
    const acId = wg.getTicket(seeded.id).acceptanceCriteria[0]!.id;
    const runtime = new MockAgentRuntime({
      evidence: [{ acId, evidenceType: "test_output", summary: "vitest run: 42 passed" }],
    });
    const d = loopDeps(wg, runtime, true);
    const outcome = await runImplementationLoop({ agentId: "claude-auth-01", dryRun: true }, d);

    expect(outcome.status).toBe("submitted_for_review");
    if (outcome.status !== "submitted_for_review") throw new Error("unreachable");
    expect(wg.getTicket(outcome.ticketId).ticket.status).toBe("in_review");
    expect(d.events.types()).toContain("postconditions_passed");
  });

  it("does not gate when post-conditions are disabled (back-compat)", async () => {
    const wg = new FakeDispatchClient();
    wg.seedTicket({
      title: "Add reset",
      acceptanceCriteria: [{ text: "AC one" }],
      repositories: [{ name: "web-app", localPath: "/tmp/web-app" }],
    });
    const d = loopDeps(wg, new MockAgentRuntime(), false);
    const outcome = await runImplementationLoop({ agentId: "claude-auth-01", dryRun: true }, d);

    expect(outcome.status).toBe("submitted_for_review");
    expect(d.events.types()).not.toContain("postconditions_failed");
    expect(d.events.types()).not.toContain("postconditions_passed");
  });
});

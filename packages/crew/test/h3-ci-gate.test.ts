/**
 * H3 — CI-aware review gate (opt-in via injectable CiGate seam).
 *
 * Tests verify:
 *   1. Green checks → ticket proceeds to submitted_for_review.
 *   2. Red checks → ticket is auto-rejected with ci_rejected status, and the
 *      failing-check evidence is recorded.
 *   3. Flag off (no ciGate) → unchanged behaviour (today's path).
 *   4. Poll timeout → "CI still pending" is surfaced as evidence and the ticket
 *      proceeds to review (not hung).
 */

import { describe, expect, it } from "vitest";

import { runImplementationLoop } from "../src/loops/implementationLoop.js";
import type { CiGate, CiGateOutcome, CiFailingCheck } from "../src/loops/implementationLoop.js";
import { DryRunGitAdapter } from "../src/adapters/gitAdapter.js";
import { EventLog } from "../src/events/eventLog.js";
import { MockAgentRuntime } from "../src/runtime/agentRuntime.js";
import { NullMemoryClient } from "../src/memory/client.js";
import { defaultSafetyPolicy } from "../src/safety/policySchema.js";
import { FakeDispatchClient } from "../src/dispatch/fakeClient.js";
import { TestClock } from "../src/util/clock.js";
import { RepoRegistry } from "../src/index.js";
import { testConfig } from "./helpers.js";

// ---------------------------------------------------------------------------
// Fake CiGate implementations
// ---------------------------------------------------------------------------

class FakeCiGate implements CiGate {
  readonly calls: Array<Parameters<CiGate["pollChecks"]>[0]> = [];
  constructor(
    private readonly outcome: CiGateOutcome,
    private readonly failingChecks?: CiFailingCheck[],
  ) {}
  pollChecks(p: Parameters<CiGate["pollChecks"]>[0]) {
    this.calls.push(p);
    return {
      outcome: this.outcome,
      ...(this.failingChecks ? { failingChecks: this.failingChecks } : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeDeps(wg: FakeDispatchClient, ciGate?: CiGate, repoPath = "/tmp/web-app") {
  const config = testConfig({
    repos: [{ ...testConfig().repos[0]!, path: repoPath }],
  });
  return {
    config,
    policy: defaultSafetyPolicy(),
    repoRegistry: RepoRegistry.fromConfig(config, "/tmp"),
    dispatch: wg,
    memory: new NullMemoryClient(),
    git: new DryRunGitAdapter(),
    runtime: new MockAgentRuntime(),
    events: new EventLog(new TestClock()),
    ...(ciGate ? { ciGate } : {}),
  };
}

function seedTicket(wg: FakeDispatchClient) {
  return wg.seedTicket({
    title: "Fix login bug",
    acceptanceCriteria: [{ text: "Bug is fixed" }],
    repositories: [{ name: "web-app", localPath: "/tmp/web-app" }],
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("H3 — CI-aware review gate", () => {
  it("proceeds to submitted_for_review when CI checks are green", () => {
    const wg = new FakeDispatchClient();
    seedTicket(wg);
    const gate = new FakeCiGate("green");
    const d = makeDeps(wg, gate);

    const outcome = runImplementationLoop({ agentId: "claude-auth-01", dryRun: true }, d);

    expect(outcome.status).toBe("submitted_for_review");
    expect(gate.calls).toHaveLength(1);

    // ci_gate events are recorded.
    const types = d.events.types();
    expect(types).toContain("ci_gate_started");
    expect(types).toContain("ci_gate_finished");
    // No rejection event.
    expect(types).not.toContain("ci_rejected");
  });

  it("auto-rejects with ci_rejected status when CI checks are red", () => {
    const wg = new FakeDispatchClient();
    const ticket = seedTicket(wg);
    const gate = new FakeCiGate("red", [
      { name: "build", url: "https://github.com/org/repo/actions/runs/123" },
    ]);
    const d = makeDeps(wg, gate);

    const outcome = runImplementationLoop({ agentId: "claude-auth-01", dryRun: true }, d);

    expect(outcome.status).toBe("ci_rejected");
    if (outcome.status !== "ci_rejected") throw new Error("unreachable");

    // Ticket is blocked (not submitted for review).
    expect(wg.getTicket(ticket.id).ticket.status).toBe("blocked");

    // A failing-check evidence record exists.
    const ciEvidence = wg.evidence.find(
      (e) => e.ticketId === ticket.id && e.evidenceType === "test_output",
    );
    expect(ciEvidence).toBeDefined();
    expect(ciEvidence?.summary).toContain("build");

    // ci_rejected event in the log.
    const types = d.events.types();
    expect(types).toContain("ci_rejected");
    expect(types).not.toContain("ticket_submitted_for_review");
  });

  it("records the failing check name and url in the evidence when CI is red", () => {
    const wg = new FakeDispatchClient();
    const ticket = seedTicket(wg);
    const gate = new FakeCiGate("red", [
      { name: "unit-tests", url: "https://github.com/org/repo/actions/runs/99" },
    ]);
    const d = makeDeps(wg, gate);

    runImplementationLoop({ agentId: "claude-auth-01", dryRun: true }, d);

    const ciEvidence = wg.evidence.find(
      (e) => e.ticketId === ticket.id && e.evidenceType === "test_output",
    );
    expect(ciEvidence?.summary).toContain("unit-tests");
    expect(ciEvidence?.summary).toContain("https://github.com/org/repo/actions/runs/99");
  });

  it("is a no-op when no CiGate is injected (flag off — today's behaviour)", () => {
    const wg = new FakeDispatchClient();
    seedTicket(wg);
    const d = makeDeps(wg); // no ciGate

    const outcome = runImplementationLoop({ agentId: "claude-auth-01", dryRun: true }, d);

    // Behaves exactly as before: submitted_for_review, no CI events.
    expect(outcome.status).toBe("submitted_for_review");
    const types = d.events.types();
    expect(types).not.toContain("ci_gate_started");
    expect(types).not.toContain("ci_rejected");
  });

  it("surfaces 'CI still pending' as evidence and proceeds to review on poll timeout", () => {
    const wg = new FakeDispatchClient();
    const ticket = seedTicket(wg);
    const gate = new FakeCiGate("timeout");
    const d = makeDeps(wg, gate);

    const outcome = runImplementationLoop({ agentId: "claude-auth-01", dryRun: true }, d);

    // On timeout the ticket PROCEEDS to review (never hung).
    expect(outcome.status).toBe("submitted_for_review");

    // A timeout note is recorded in evidence.
    const timeoutEvidence = wg.evidence.find(
      (e) =>
        e.ticketId === ticket.id &&
        e.evidenceType === "manual_note" &&
        e.summary.includes("pending"),
    );
    expect(timeoutEvidence).toBeDefined();

    // ci_timeout_surfaced event in log.
    expect(d.events.types()).toContain("ci_timeout_surfaced");
    // Ticket still enters review.
    expect(d.events.types()).toContain("ticket_submitted_for_review");
  });

  it("polls checks with the delivery branch and passes the prUrl hint", () => {
    const wg = new FakeDispatchClient();
    seedTicket(wg);
    const gate = new FakeCiGate("green");
    const d = makeDeps(wg, gate);

    const outcome = runImplementationLoop({ agentId: "claude-auth-01", dryRun: true }, d);
    if (outcome.status !== "submitted_for_review") throw new Error("unreachable");

    // The gate was called with the delivery branch.
    expect(gate.calls[0]?.branch).toBe(outcome.branch);
  });
});

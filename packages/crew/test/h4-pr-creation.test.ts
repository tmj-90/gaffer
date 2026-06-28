/**
 * H4 — real PR creation (opt-in via injectable PrCreator seam).
 *
 * Tests verify:
 *   1. PR body is built from the evidence bundle and pr_url is persisted when the
 *      PrCreator succeeds.
 *   2. No-op when no PrCreator is injected (flag off / today's behaviour).
 *   3. pr_url is persisted to the ticket via recordDeliveryArtifact.
 *   4. A failing PrCreator (returns null prUrl) is handled gracefully — the
 *      delivery still proceeds and the ticket enters review.
 */

import { describe, expect, it } from "vitest";

import { runImplementationLoop } from "../src/loops/implementationLoop.js";
import type { PrCreator, PrCreateResult } from "../src/loops/implementationLoop.js";
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
// Fake PrCreator implementations for testing
// ---------------------------------------------------------------------------

class FakePrCreator implements PrCreator {
  readonly calls: Array<Parameters<PrCreator["createPr"]>[0]> = [];
  constructor(private readonly returnUrl: string | null) {}
  createPr(p: Parameters<PrCreator["createPr"]>[0]): PrCreateResult {
    this.calls.push(p);
    return this.returnUrl
      ? { prUrl: this.returnUrl, summary: `created PR ${this.returnUrl}` }
      : { prUrl: null, summary: "no GitHub remote — skipped" };
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeDeps(wg: FakeDispatchClient, prCreator?: PrCreator, repoPath = "/tmp/web-app") {
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
    ...(prCreator ? { prCreator } : {}),
  };
}

function seedTicket(wg: FakeDispatchClient) {
  return wg.seedTicket({
    title: "Add login form",
    acceptanceCriteria: [{ text: "Form renders" }, { text: "Submit works" }],
    repositories: [{ name: "web-app", localPath: "/tmp/web-app" }],
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("H4 — PR creation", () => {
  it("calls PrCreator with the evidence bundle and records pr_url when creation succeeds", () => {
    const wg = new FakeDispatchClient();
    seedTicket(wg);
    const creator = new FakePrCreator("https://github.com/org/repo/pull/42");
    const d = makeDeps(wg, creator);

    const outcome = runImplementationLoop({ agentId: "claude-auth-01", dryRun: true }, d);

    expect(outcome.status).toBe("submitted_for_review");
    if (outcome.status !== "submitted_for_review") throw new Error("unreachable");

    // PrCreator was called once.
    expect(creator.calls).toHaveLength(1);
    const call = creator.calls[0]!;

    // The call includes the evidence bundle from the runtime.
    expect(call.evidenceBundle.length).toBeGreaterThan(0);
    expect(call.branch).toBe(outcome.branch);
    expect(call.title).toBe("Add login form");

    // The outcome carries the pr_url.
    expect(outcome.prUrl).toBe("https://github.com/org/repo/pull/42");

    // The pr_url is persisted onto the ticket via recordDeliveryArtifact.
    const artifact = wg.deliveryArtifacts.find(
      (a) => a.ticketId === outcome.ticketId && a.prUrl === "https://github.com/org/repo/pull/42",
    );
    expect(artifact).toBeDefined();
  });

  it("is a no-op when no PrCreator is injected (flag off — today's behaviour)", () => {
    const wg = new FakeDispatchClient();
    seedTicket(wg);
    const d = makeDeps(wg); // no prCreator

    const outcome = runImplementationLoop({ agentId: "claude-auth-01", dryRun: true }, d);

    expect(outcome.status).toBe("submitted_for_review");
    if (outcome.status !== "submitted_for_review") throw new Error("unreachable");

    // No pr_url in the outcome.
    expect(outcome.prUrl).toBeUndefined();

    // No pr_url in any delivery artifact.
    const withPr = wg.deliveryArtifacts.filter((a) => a.prUrl !== null);
    expect(withPr).toHaveLength(0);

    // No pr_creation_attempted event.
    const prEvent = d.events.events.find((e) => e.type === "pr_creation_attempted");
    expect(prEvent).toBeUndefined();
  });

  it("records pr_url persisted via recordDeliveryArtifact when PrCreator succeeds", () => {
    const wg = new FakeDispatchClient();
    const ticket = seedTicket(wg);
    const creator = new FakePrCreator("https://github.com/org/repo/pull/99");
    const d = makeDeps(wg, creator);

    runImplementationLoop({ agentId: "claude-auth-01", dryRun: true }, d);

    // The delivery artifact with the pr_url exists (find the one with a non-null prUrl).
    const artifact = wg.deliveryArtifacts.find((a) => a.ticketId === ticket.id && a.prUrl !== null);
    expect(artifact?.prUrl).toBe("https://github.com/org/repo/pull/99");
  });

  it("proceeds to review even when PrCreator returns null (no remote / failed)", () => {
    const wg = new FakeDispatchClient();
    seedTicket(wg);
    const creator = new FakePrCreator(null); // simulates no remote
    const d = makeDeps(wg, creator);

    const outcome = runImplementationLoop({ agentId: "claude-auth-01", dryRun: true }, d);

    // Delivery still proceeds — PR failure is non-fatal.
    expect(outcome.status).toBe("submitted_for_review");
    if (outcome.status !== "submitted_for_review") throw new Error("unreachable");
    expect(outcome.prUrl).toBeNull();

    // pr_creation_attempted event is recorded with null url.
    const prEvent = d.events.events.find((e) => e.type === "pr_creation_attempted");
    expect(prEvent).toBeDefined();
    expect((prEvent?.payload as Record<string, unknown>)?.prUrl).toBeNull();

    // Ticket still in review.
    expect(wg.getTicket(outcome.ticketId).ticket.status).toBe("in_review");
  });

  it("does not record pr_url artifact when PrCreator returns null", () => {
    const wg = new FakeDispatchClient();
    seedTicket(wg);
    const creator = new FakePrCreator(null);
    const d = makeDeps(wg, creator);

    runImplementationLoop({ agentId: "claude-auth-01", dryRun: true }, d);

    // No delivery artifact with a non-null pr_url.
    const withPr = wg.deliveryArtifacts.filter((a) => a.prUrl !== null);
    expect(withPr).toHaveLength(0);
  });
});

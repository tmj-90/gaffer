import { describe, expect, it } from "vitest";

import { runImplementationLoop } from "../src/loops/implementationLoop.js";
import { DryRunGitAdapter } from "../src/adapters/gitAdapter.js";
import { EventLog } from "../src/events/eventLog.js";
import { MockAgentRuntime } from "../src/runtime/agentRuntime.js";
import { NullMemoryClient } from "../src/memory/client.js";
import { defaultSafetyPolicy } from "../src/safety/policySchema.js";
import { FakeDispatchClient } from "../src/dispatch/fakeClient.js";
import { TestClock } from "../src/util/clock.js";
import { RepoRegistry } from "../src/index.js";
import { crewConfigSchema, type CrewConfig } from "../src/index.js";

/**
 * FG-009 — implementation loop across single + multi-repo execution. Exercises
 * the loop end-to-end (Fake-backed) for: one unmapped single-repo ticket, two
 * write repos, and a read-only repo that must not be branched or written to.
 *
 * Repo paths use the config's `/repos/*` roots so `classifyRootAccess` resolves
 * changed paths against the same write/read roots the packet derives.
 */
const API_ROOT = "/repos/api";
const WEB_ROOT = "/repos/web";
const DOCS_ROOT = "/repos/docs";

/** A factory config with api (write), web-app (write), docs (read-only context). */
function multiRepoConfig(): CrewConfig {
  return crewConfigSchema.parse({
    factory: { name: "test-factory", mode: "local_strict" },
    repos: [
      {
        id: "api",
        name: "api",
        path: API_ROOT,
        stack: "typescript",
        test_command: "pnpm test",
        lore_tags: ["backend"],
      },
      {
        id: "web-app",
        name: "web-app",
        path: WEB_ROOT,
        stack: "typescript-react",
        test_command: "pnpm test",
        lore_tags: ["frontend"],
      },
      { id: "docs", name: "docs", path: DOCS_ROOT, stack: "markdown", lore_tags: ["docs"] },
    ],
  });
}

function deps(wg: FakeDispatchClient, config: CrewConfig, runtime = new MockAgentRuntime()) {
  return {
    config,
    policy: defaultSafetyPolicy(),
    repoRegistry: RepoRegistry.fromConfig(config, "/repos"),
    dispatch: wg,
    memory: new NullMemoryClient(),
    git: new DryRunGitAdapter(),
    runtime,
    events: new EventLog(new TestClock()),
  };
}

describe("FG-009 implementation loop — single + multi-repo delivery", () => {
  it("unmapped single-repo ticket: works and records exactly one repo delivery", () => {
    const config = multiRepoConfig();
    const wg = new FakeDispatchClient();
    // No seedWorkPacket → mono-fallback single-repo path.
    const ticket = wg.seedTicket({
      title: "Single-repo work",
      acceptanceCriteria: [{ text: "AC one" }],
      repositories: [{ name: "api", localPath: API_ROOT }],
    });

    const d = deps(
      wg,
      config,
      new MockAgentRuntime({ changedPaths: [`${API_ROOT}/src/index.ts`] }),
    );
    const outcome = runImplementationLoop({ agentId: "a", dryRun: true }, d);

    expect(outcome.status).toBe("submitted_for_review");
    if (outcome.status === "no_ticket" || outcome.status === "claim_vetoed")
      throw new Error("unreachable");
    expect(outcome.packet.workScope.monoFallback).toBe(true);

    // Exactly one per-repo delivery, for the single write repo.
    expect(wg.repoDeliveries).toHaveLength(1);
    expect(wg.repoDeliveries[0]).toMatchObject({ ticketId: ticket.id, status: "review_ready" });
    expect(d.events.types()).toContain("repo_deliveries_recorded");
    // One branch, in the single write repo.
    expect(d.git.createdBranches.map((b) => b.repoDir)).toEqual([API_ROOT]);
  });

  it("two write repos: records a delivery and a branch for each", () => {
    const config = multiRepoConfig();
    const wg = new FakeDispatchClient();
    const ticket = wg.seedTicket({
      title: "Cross-repo change",
      acceptanceCriteria: [{ text: "AC one" }],
      repositories: [{ name: "api", localPath: API_ROOT }],
    });
    wg.seedWorkPacket(ticket.id, {
      primaryScope: { id: "S1", name: "Billing", type: "product_area", loreTags: [] },
      writeRepos: [
        { id: "R-api", name: "api", path: API_ROOT, reason: "Service." },
        { id: "R-web", name: "web-app", path: WEB_ROOT, reason: "UI." },
      ],
    });

    const d = deps(
      wg,
      config,
      new MockAgentRuntime({ changedPaths: [`${API_ROOT}/src/a.ts`, `${WEB_ROOT}/src/b.tsx`] }),
    );
    const outcome = runImplementationLoop({ agentId: "a", dryRun: true }, d);

    expect(outcome.status).toBe("submitted_for_review");
    if (outcome.status === "no_ticket" || outcome.status === "claim_vetoed")
      throw new Error("unreachable");
    expect(outcome.packet.workScope.monoFallback).toBe(false);

    // One delivery per write repo, none for anything else.
    expect(wg.repoDeliveries.map((d) => d.repoId).sort()).toEqual(["R-api", "R-web"]);
    expect(wg.repoDeliveries).toHaveLength(2);
    // A branch was created in each write repo (and only those).
    expect(d.git.createdBranches.map((b) => b.repoDir).sort()).toEqual([API_ROOT, WEB_ROOT]);
  });

  it("read-only repo: not branched, not a delivery target; a write into it fails the loop", () => {
    const config = multiRepoConfig();
    const wg = new FakeDispatchClient();
    const ticket = wg.seedTicket({
      title: "Write API, read docs",
      acceptanceCriteria: [{ text: "AC one" }],
      repositories: [{ name: "api", localPath: API_ROOT }],
    });
    wg.seedWorkPacket(ticket.id, {
      primaryScope: { id: "S1", name: "Billing", type: "product_area", loreTags: [] },
      writeRepos: [{ id: "R-api", name: "api", path: API_ROOT, reason: "Service." }],
      readOnlyRepos: [{ id: "R-docs", name: "docs", path: DOCS_ROOT, reason: "Context." }],
    });

    // Agent illegally writes into the read-only docs repo.
    const d = deps(
      wg,
      config,
      new MockAgentRuntime({ changedPaths: [`${API_ROOT}/src/a.ts`, `${DOCS_ROOT}/guide.md`] }),
    );
    const outcome = runImplementationLoop({ agentId: "a", dryRun: true }, d);

    // The loop fails — the write into the read-only repo is rejected.
    expect(outcome.status).toBe("blocked");
    if (outcome.status !== "blocked") throw new Error("unreachable");
    expect(wg.getTicket(ticket.id).ticket.status).toBe("blocked");
    expect(d.events.types()).toContain("write_set_violation");

    // No CLEAN delivery is recorded: neither the ticket-level artifact nor any
    // per-repo delivery — and the read-only repo was never branched.
    expect(wg.repoDeliveries).toHaveLength(0);
    expect(wg.deliveryArtifacts).toHaveLength(0);
    expect(d.git.createdBranches.map((b) => b.repoDir)).not.toContain(DOCS_ROOT);
  });

  it("a write entirely outside every in-scope repo also fails the loop", () => {
    const config = multiRepoConfig();
    const wg = new FakeDispatchClient();
    const ticket = wg.seedTicket({
      title: "Mono ticket",
      acceptanceCriteria: [{ text: "AC one" }],
      repositories: [{ name: "api", localPath: API_ROOT }],
    });

    const d = deps(
      wg,
      config,
      new MockAgentRuntime({ changedPaths: [`${API_ROOT}/src/a.ts`, "/repos/secret-vault/.env"] }),
    );
    const outcome = runImplementationLoop({ agentId: "a", dryRun: true }, d);

    expect(outcome.status).toBe("blocked");
    expect(wg.getTicket(ticket.id).ticket.status).toBe("blocked");
    expect(wg.repoDeliveries).toHaveLength(0);
  });
});

describe("FakeDispatchClient.recordRepoDelivery", () => {
  it("records a per-repo delivery row and emits an event", () => {
    const wg = new FakeDispatchClient();
    const ticket = wg.seedTicket({ title: "x", repositories: [{ name: "api" }] });

    const res = wg.recordRepoDelivery({
      ticketId: ticket.id,
      repoId: "R-api",
      branchName: "dispatch/ticket-1",
      status: "review_ready",
    });

    expect(res).toMatchObject({
      ticketId: ticket.id,
      repoId: "R-api",
      branchName: "dispatch/ticket-1",
      status: "review_ready",
    });
    expect(res.eventId).toBeTruthy();
    expect(wg.repoDeliveries).toHaveLength(1);
    expect(wg.events.some((e) => e.type === "ticket.repo_delivery_recorded")).toBe(true);
  });

  it("defaults status to branch_created when omitted", () => {
    const wg = new FakeDispatchClient();
    const ticket = wg.seedTicket({ title: "x", repositories: [{ name: "api" }] });
    const res = wg.recordRepoDelivery({ ticketId: ticket.id, repoId: "R-api" });
    expect(res.status).toBe("branch_created");
    expect(res.branchName).toBeNull();
  });
});

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runImplementationLoop } from "../src/loops/implementationLoop.js";
import { DryRunGitAdapter, systemGitAdapter } from "../src/adapters/gitAdapter.js";
import { HookRegistry } from "../src/hooks/hookRegistry.js";
import {
  normalizeHookOutput,
  type Hook,
  type HookInput,
  type HookOutput,
} from "../src/hooks/types.js";
import { EventLog } from "../src/events/eventLog.js";
import { MockAgentRuntime } from "../src/runtime/agentRuntime.js";
import { NullMemoryClient, StubMemoryClient } from "../src/memory/client.js";
import { defaultSafetyPolicy } from "../src/safety/policySchema.js";
import { FakeDispatchClient } from "../src/dispatch/fakeClient.js";
import { TestClock } from "../src/util/clock.js";
import { RepoRegistry } from "../src/index.js";
import { SkillRegistry } from "../src/skills/registry.js";
import { skillSchema } from "../src/skills/schema.js";
import { testConfig } from "./helpers.js";

function deps(wg: FakeDispatchClient, repoPath: string, git = new DryRunGitAdapter()) {
  const config = testConfig({
    repos: [
      {
        ...testConfig().repos[0]!,
        path: repoPath,
      },
    ],
  });
  return {
    config,
    policy: defaultSafetyPolicy(),
    repoRegistry: RepoRegistry.fromConfig(config, "/tmp"),
    dispatch: wg,
    memory: new NullMemoryClient(),
    git,
    runtime: new MockAgentRuntime(),
    events: new EventLog(new TestClock()),
  };
}

describe("implementation loop", () => {
  it("claims a ticket, creates a prefixed branch, records evidence and enters review", async () => {
    const wg = new FakeDispatchClient();
    wg.seedTicket({
      title: "Add reset",
      acceptanceCriteria: [{ text: "AC one" }, { text: "AC two" }],
      repositories: [{ name: "web-app", localPath: "/tmp/web-app" }],
    });

    const d = deps(wg, "/tmp/web-app");
    const outcome = await runImplementationLoop({ agentId: "claude-auth-01", dryRun: true }, d);

    expect(outcome.status).toBe("submitted_for_review");
    if (outcome.status === "no_ticket" || outcome.status === "claim_vetoed") {
      throw new Error("unreachable");
    }
    expect(outcome.branch.startsWith("dispatch/")).toBe(true);
    expect(outcome.evidenceIds).toHaveLength(2);

    // Evidence recorded in Dispatch, ticket moved to review.
    expect(wg.evidence).toHaveLength(2);
    expect(wg.getTicket(outcome.ticketId).ticket.status).toBe("in_review");

    // The full path is observable in the event log.
    expect(d.events.types()).toEqual(
      expect.arrayContaining([
        "loop_started",
        "ticket_claimed",
        "context_packet_built",
        "branch_created",
        "evidence_recorded",
        "ticket_submitted_for_review",
        "loop_finished",
      ]),
    );
  });

  it("creates a real branch with the required prefix in a temp git repo", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "fg-impl-"));
    execFileSync("git", ["-C", repoDir, "init", "-q", "-b", "main"]);
    execFileSync("git", ["-C", repoDir, "config", "user.email", "t@example.com"]);
    execFileSync("git", ["-C", repoDir, "config", "user.name", "t"]);
    writeFileSync(join(repoDir, "README.md"), "# x");
    execFileSync("git", ["-C", repoDir, "add", "."]);
    execFileSync("git", ["-C", repoDir, "commit", "-q", "-m", "init"]);

    const wg = new FakeDispatchClient();
    wg.seedTicket({
      title: "Real branch ticket",
      acceptanceCriteria: [{ text: "done" }],
      repositories: [{ name: "web-app", localPath: repoDir, defaultBranch: "main" }],
    });

    const d = deps(wg, repoDir, undefined);
    // Replace dry-run adapter with the real system adapter for this test.
    const realDeps = { ...d, git: systemGitAdapter };
    const outcome = await runImplementationLoop(
      { agentId: "claude-auth-01", dryRun: false },
      realDeps,
    );

    if (outcome.status === "no_ticket" || outcome.status === "claim_vetoed") {
      throw new Error("unreachable");
    }
    expect(systemGitAdapter.branchExists(repoDir, outcome.branch)).toBe(true);
    expect(systemGitAdapter.currentBranch(repoDir)).toBe(outcome.branch);
  });

  it("pre-filters skills into the packet and reports its token cost", async () => {
    const wg = new FakeDispatchClient();
    wg.seedTicket({
      title: "Add reset",
      acceptanceCriteria: [{ text: "AC one" }],
      repositories: [{ name: "web-app", localPath: "/tmp/web-app" }],
    });
    const skillRegistry = new SkillRegistry([
      skillSchema.parse({
        id: "react-skill",
        name: "react-skill",
        applies_to: { stacks: ["react"] },
        steps: ["x"],
      }),
      skillSchema.parse({
        id: "go-skill",
        name: "go-skill",
        applies_to: { stacks: ["go"] },
        steps: ["x"],
      }),
    ]);
    const d = { ...deps(wg, "/tmp/web-app"), skillRegistry };
    const outcome = await runImplementationLoop({ agentId: "claude-auth-01", dryRun: true }, d);

    if (outcome.status === "no_ticket" || outcome.status === "claim_vetoed")
      throw new Error("unreachable");
    // The web-app repo stack ("typescript-react") selects the react skill, not go.
    expect(outcome.packet.skills.map((s) => s.id)).toEqual(["react-skill"]);
    // Token cost is measured + carried on the packet (AC: tokens measured + reported).
    expect(outcome.packet.tokens.total).toBeGreaterThan(0);
    expect(outcome.packet.fingerprint).toHaveLength(16);
  });

  it("claims the SAME ticket the before_claim hook evaluated (preselect-then-claim)", async () => {
    const wg = new FakeDispatchClient();
    // Two ready tickets: the loop preselects listReady()[0] and the hook must
    // evaluate the exact ticket that then gets claimed.
    const first = wg.seedTicket({
      title: "first",
      acceptanceCriteria: [{ text: "a" }],
      repositories: [{ name: "web-app", localPath: "/tmp/web-app" }],
    });
    wg.seedTicket({
      title: "second",
      acceptanceCriteria: [{ text: "b" }],
      repositories: [{ name: "web-app", localPath: "/tmp/web-app" }],
    });
    const expected = wg.listReady()[0]!.ticketId;

    const events = new EventLog(new TestClock());
    const hooks = new HookRegistry(events);
    let evaluatedTicketId: string | undefined;
    hooks.register(
      new (class implements Hook {
        name = "capture";
        point = "before_claim" as const;
        run(input: HookInput): HookOutput {
          if (input.hook_name === "before_claim") evaluatedTicketId = input.ticket?.id;
          return normalizeHookOutput();
        }
      })(),
    );

    const d = { ...deps(wg, "/tmp/web-app"), hooks };
    const outcome = await runImplementationLoop({ agentId: "a", dryRun: true }, d);

    if (outcome.status === "no_ticket" || outcome.status === "claim_vetoed")
      throw new Error("unreachable");
    expect(evaluatedTicketId).toBe(expected);
    expect(outcome.ticketId).toBe(expected);
    expect(outcome.ticketId).toBe(first.id);
    expect(evaluatedTicketId).toBe(outcome.ticketId);
  });

  it("records a delivery artifact (branch) back to Dispatch after implementation", async () => {
    const wg = new FakeDispatchClient();
    wg.seedTicket({
      title: "Add reset",
      acceptanceCriteria: [{ text: "AC one" }],
      repositories: [{ name: "web-app", localPath: "/tmp/web-app" }],
    });

    const d = deps(wg, "/tmp/web-app");
    const outcome = await runImplementationLoop({ agentId: "a", dryRun: true }, d);

    if (outcome.status !== "submitted_for_review") throw new Error("unreachable");
    // The branch is recorded on the ticket so done-gates that require a branch
    // (factory_strict/regulated) are satisfied.
    expect(wg.deliveryArtifacts).toHaveLength(1);
    expect(wg.deliveryArtifacts[0]).toMatchObject({
      ticketId: outcome.ticketId,
      branchName: outcome.branch,
    });
    expect(wg.getTicket(outcome.ticketId).ticket.branchName).toBe(outcome.branch);
    expect(d.events.types()).toContain("delivery_artifact_recorded");
  });

  it("returns no_ticket when nothing is claimable", async () => {
    const wg = new FakeDispatchClient();
    const outcome = await runImplementationLoop({ agentId: "a" }, deps(wg, "/tmp/web-app"));
    expect(outcome.status).toBe("no_ticket");
  });

  it("marks blocked when the runtime reports blocked", async () => {
    const wg = new FakeDispatchClient();
    wg.seedTicket({ title: "x", repositories: [{ name: "web-app", localPath: "/tmp/web-app" }] });
    const base = deps(wg, "/tmp/web-app");
    const blockedDeps = {
      ...base,
      runtime: new MockAgentRuntime({
        status: "blocked",
        blockedReason: "needs decision",
        evidence: [],
      }),
    };
    const outcome = await runImplementationLoop({ agentId: "a", dryRun: true }, blockedDeps);
    expect(outcome.status).toBe("blocked");
    expect(wg.getTicket((outcome as { ticketId: string }).ticketId).ticket.status).toBe("blocked");
  });

  it("forwards lore suggestions without auto-approving", async () => {
    const wg = new FakeDispatchClient();
    wg.seedTicket({
      title: "x",
      acceptanceCriteria: [{ text: "a" }],
      repositories: [{ name: "web-app", localPath: "/tmp/web-app" }],
    });
    const lore = new StubMemoryClient();
    const base = deps(wg, "/tmp/web-app");
    const withLore = {
      ...base,
      memory: lore,
      runtime: new MockAgentRuntime({
        loreSuggestions: [
          { title: "Use argon2id", summary: "for password hashing", tags: ["auth"] },
        ],
      }),
    };
    await runImplementationLoop({ agentId: "a", dryRun: true }, withLore);
    // The agent's own suggestion is forwarded first, verbatim…
    expect(lore.suggestions[0]!.title).toBe("Use argon2id");
    // …and the loop ALSO distills the ticket's product intent (Track 1c): a
    // requirement draft harvested from the ticket's AC, so the "why" survives
    // close. Both are drafts — never auto-approved.
    const distilled = lore.suggestions.find((s) => s.kind === "requirement");
    expect(distilled).toBeDefined();
    expect(distilled!.tags).toContain("ticket-intent");
    // Snapshot before re-suggesting: the stub appends to `suggestions`, so
    // iterate a copy. Every record entered the gated draft flow (never approved).
    for (const suggestion of [...lore.suggestions]) {
      expect(lore.suggestLore(suggestion).status).toBe("draft");
    }
  });
});

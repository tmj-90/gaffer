import { describe, expect, it } from "vitest";

import { runImplementationLoop } from "../src/loops/implementationLoop.js";
import { DryRunGitAdapter } from "../src/adapters/gitAdapter.js";
import { EventLog } from "../src/events/eventLog.js";
import { HookRegistry } from "../src/hooks/hookRegistry.js";
import { CaptureLoreReflectionHook } from "../src/hooks/builtins.js";
import {
  normalizeHookOutput,
  type Hook,
  type HookInput,
  type HookOutput,
} from "../src/hooks/types.js";
import { MockAgentRuntime } from "../src/runtime/agentRuntime.js";
import { NullMemoryClient } from "../src/memory/client.js";
import { defaultSafetyPolicy } from "../src/safety/policySchema.js";
import { FakeDispatchClient } from "../src/dispatch/fakeClient.js";
import { TestClock } from "../src/util/clock.js";
import { RepoRegistry } from "../src/index.js";
import { testConfig } from "./helpers.js";

function deps(wg: FakeDispatchClient, events: EventLog, hooks?: HookRegistry) {
  const config = testConfig({
    repos: [{ ...testConfig().repos[0]!, path: "/tmp/web-app" }],
  });
  return {
    config,
    policy: defaultSafetyPolicy(),
    repoRegistry: RepoRegistry.fromConfig(config, "/tmp"),
    dispatch: wg,
    memory: new NullMemoryClient(),
    git: new DryRunGitAdapter(),
    runtime: new MockAgentRuntime(),
    events,
    ...(hooks ? { hooks } : {}),
  };
}

class PointTracker implements Hook {
  static seen: HookName[] = [];
  constructor(
    readonly name: string,
    readonly point: HookName,
  ) {}
  run(input: HookInput): HookOutput {
    PointTracker.seen.push(input.hook_name);
    return normalizeHookOutput();
  }
}
type HookName = HookInput["hook_name"];

describe("implementation loop + hooks", () => {
  it("a registered before_claim hook can veto the claim", async () => {
    const wg = new FakeDispatchClient();
    wg.seedTicket({ title: "risky", riskLevel: "critical", repositories: [{ name: "web-app" }] });
    const events = new EventLog(new TestClock());
    const hooks = new HookRegistry(events);
    hooks.register(
      new (class implements Hook {
        name = "veto";
        point = "before_claim" as const;
        run(): HookOutput {
          return normalizeHookOutput({ status: "veto", vetoReason: "blocked by policy window" });
        }
      })(),
    );

    const outcome = await runImplementationLoop(
      { agentId: "a", dryRun: true },
      deps(wg, events, hooks),
    );

    expect(outcome.status).toBe("claim_vetoed");
    if (outcome.status !== "claim_vetoed") throw new Error("unreachable");
    expect(outcome.reason).toMatch(/policy window/);
    // The ticket was never claimed — it is still ready.
    expect(wg.listReady()).toHaveLength(1);
    expect(events.types()).not.toContain("ticket_claimed");
  });

  it("fires the wired hook points in order on the happy path", async () => {
    PointTracker.seen = [];
    const wg = new FakeDispatchClient();
    wg.seedTicket({
      title: "x",
      acceptanceCriteria: [{ text: "a" }],
      repositories: [{ name: "web-app" }],
    });
    const events = new EventLog(new TestClock());
    const hooks = new HookRegistry(events);
    for (const p of [
      "before_claim",
      "after_claim",
      "before_context_packet",
      "after_context_packet",
      "before_implementation",
      "after_tests",
      "before_submit_review",
      "after_ticket_done",
    ] as const) {
      hooks.register(new PointTracker(`t-${p}`, p));
    }

    const outcome = await runImplementationLoop(
      { agentId: "a", dryRun: true },
      deps(wg, events, hooks),
    );
    expect(outcome.status).toBe("submitted_for_review");
    expect(PointTracker.seen).toEqual([
      "before_claim",
      "after_claim",
      "before_context_packet",
      "after_context_packet",
      "before_implementation",
      "after_tests",
      "before_submit_review",
      "after_ticket_done",
    ]);
  });

  it("the capture-lore-reflection builtin prompts once at after_ticket_done", async () => {
    const wg = new FakeDispatchClient();
    wg.seedTicket({
      title: "x",
      acceptanceCriteria: [{ text: "a" }],
      repositories: [{ name: "web-app" }],
    });
    const events = new EventLog(new TestClock());
    const hooks = new HookRegistry(events);
    hooks.register(new CaptureLoreReflectionHook());

    const outcome = await runImplementationLoop(
      { agentId: "a", dryRun: true },
      deps(wg, events, hooks),
    );
    expect(outcome.status).toBe("submitted_for_review");
    // The reflection prompt is recorded exactly once for the unit of work.
    expect(events.types().filter((t) => t === "hook_capture_lore_prompted")).toHaveLength(1);
  });

  it("behaves identically to the no-hook path when no hooks are registered", async () => {
    const wg = new FakeDispatchClient();
    wg.seedTicket({
      title: "x",
      acceptanceCriteria: [{ text: "a" }],
      repositories: [{ name: "web-app" }],
    });
    const events = new EventLog(new TestClock());

    const outcome = await runImplementationLoop({ agentId: "a", dryRun: true }, deps(wg, events));
    expect(outcome.status).toBe("submitted_for_review");
    expect(wg.getTicket((outcome as { ticketId: string }).ticketId).ticket.status).toBe(
      "in_review",
    );
  });

  it("a policy override request from a hook is never applied (safety preserved)", async () => {
    const wg = new FakeDispatchClient();
    wg.seedTicket({
      title: "x",
      acceptanceCriteria: [{ text: "a" }],
      repositories: [{ name: "web-app" }],
    });
    const events = new EventLog(new TestClock());
    const hooks = new HookRegistry(events);
    hooks.register(
      new (class implements Hook {
        name = "wants-force-push";
        point = "before_implementation" as const;
        run(): HookOutput {
          return normalizeHookOutput({
            policy_overrides_requested: [{ policy: "git.deny_force_push", reason: "x" }],
          });
        }
      })(),
    );

    await runImplementationLoop({ agentId: "a", dryRun: true }, deps(wg, events, hooks));
    expect(events.types()).toContain("hook_policy_override_requested");
    expect(events.types()).not.toContain("hook_policy_override_applied");
  });
});

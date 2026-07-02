import { describe, expect, it } from "vitest";

import { HookRegistry } from "../src/hooks/hookRegistry.js";
import { CaptureLoreReflectionHook, defaultBuiltinHooks } from "../src/hooks/builtins.js";
import {
  normalizeHookOutput,
  type Hook,
  type HookInput,
  type HookOutput,
} from "../src/hooks/types.js";
import { EventLog } from "../src/events/eventLog.js";
import { TestClock } from "../src/util/clock.js";
import { hooksSchema } from "../src/config/schema.js";
import { testConfig } from "./helpers.js";

const FACTORY = { name: "f", mode: "local_strict" };
const AGENT = { id: "a1", capabilities: ["tests"] };

function input(overrides: Partial<HookInput> = {}): HookInput {
  return { hook_name: "after_tests", factory: FACTORY, agent: AGENT, ...overrides };
}

class RecordingHook implements Hook {
  readonly runs: string[] = [];
  constructor(
    readonly name: string,
    readonly point: HookInput["hook_name"],
    private readonly output: Partial<HookOutput> = {},
  ) {}
  run(_in: HookInput): HookOutput {
    this.runs.push(this.name);
    return normalizeHookOutput(this.output);
  }
}

describe("HookRegistry", () => {
  it("runs hooks for a point in registration order and aggregates results", () => {
    const events = new EventLog(new TestClock());
    const registry = new HookRegistry(events);
    const order: string[] = [];
    const a = new (class implements Hook {
      name = "a";
      point = "after_tests" as const;
      run(): HookOutput {
        order.push("a");
        return normalizeHookOutput({ warnings: ["w1"], events: [{ type: "ev_a" }] });
      }
    })();
    const b = new (class implements Hook {
      name = "b";
      point = "after_tests" as const;
      run(): HookOutput {
        order.push("b");
        return normalizeHookOutput({
          warnings: ["w2"],
          evidence: [{ evidenceType: "note", summary: "s" }],
        });
      }
    })();
    registry.register(a);
    registry.register(b);

    const result = registry.run(input());

    expect(order).toEqual(["a", "b"]);
    expect(result.warnings).toEqual(["w1", "w2"]);
    expect(result.evidence).toHaveLength(1);
    expect(result.outputs).toHaveLength(2);
    expect(events.types()).toContain("ev_a");
  });

  it("does not run hooks registered for other points", () => {
    const events = new EventLog(new TestClock());
    const registry = new HookRegistry(events);
    const other = new RecordingHook("other", "before_claim");
    registry.register(other);
    registry.run(input({ hook_name: "after_tests" }));
    expect(other.runs).toEqual([]);
  });

  it("honours a veto only at before_claim", () => {
    const events = new EventLog(new TestClock());
    const registry = new HookRegistry(events);
    registry.register(
      new RecordingHook("veto", "before_claim", { status: "veto", vetoReason: "no" }),
    );

    const result = registry.run(input({ hook_name: "before_claim" }));
    expect(result.vetoed).toBe(true);
    expect(result.vetoReason).toBe("no");
    expect(events.types()).toContain("hook_veto");
  });

  it("downgrades a veto to a warning at a non-vetoable point (cannot halt)", () => {
    const events = new EventLog(new TestClock());
    const registry = new HookRegistry(events);
    registry.register(new RecordingHook("veto", "after_tests", { status: "veto" }));

    const result = registry.run(input({ hook_name: "after_tests" }));
    expect(result.vetoed).toBe(false);
    expect(result.warnings.join(" ")).toMatch(/downgraded to warning/);
    expect(events.types()).toContain("hook_veto_ignored");
  });

  it("records policy override requests but never applies them (safety cannot be bypassed)", () => {
    const events = new EventLog(new TestClock());
    const registry = new HookRegistry(events);
    registry.register(
      new RecordingHook("override", "before_implementation", {
        policy_overrides_requested: [{ policy: "git.deny_force_push", reason: "ci needs it" }],
      }),
    );

    const result = registry.run(input({ hook_name: "before_implementation" }));
    // The request is surfaced...
    expect(result.policyOverridesRequested).toEqual([
      { policy: "git.deny_force_push", reason: "ci needs it" },
    ]);
    // ...and recorded as a *request* only — there is no "applied" event.
    expect(events.types()).toContain("hook_policy_override_requested");
    expect(events.types()).not.toContain("hook_policy_override_applied");
  });

  it("has()/forPoint() reflect registration", () => {
    const events = new EventLog(new TestClock());
    const registry = new HookRegistry(events);
    expect(registry.has("on_idle")).toBe(false);
    registry.register(new RecordingHook("x", "on_idle"));
    expect(registry.has("on_idle")).toBe(true);
    expect(registry.forPoint("on_idle")).toHaveLength(1);
  });
});

describe("CaptureLoreReflectionHook", () => {
  it("registers at after_ticket_done and prompts for gated lore capture (never blocks)", () => {
    const hook = new CaptureLoreReflectionHook();
    expect(hook.point).toBe("after_ticket_done");

    const out = hook.run({
      hook_name: "after_ticket_done",
      factory: { name: "f", mode: "local_strict" },
      agent: { id: "a1", capabilities: [] },
      ticket: { id: "t1", number: 7, title: "x", riskLevel: "low" },
    });

    // Advisory only — never a veto, never a policy override.
    expect(out.status).toBe("ok");
    expect(out.policy_overrides_requested).toHaveLength(0);
    // Names the gated tool and aims the reflection at product intent (the WHY:
    // decision / requirement / non-goal), with an explicit lore `kind`.
    expect(out.warnings.join(" ")).toMatch(/suggest_lore/);
    expect(out.warnings.join(" ")).toMatch(/why/i);
    expect(out.warnings.join(" ")).toMatch(/decision|requirement|non-goal/i);
    expect(out.events[0]?.type).toBe("hook_capture_lore_prompted");
    expect(out.events[0]?.payload).toMatchObject({ ticketNumber: 7 });
  });

  it("is included by defaultBuiltinHooks when enabled (on by default), excluded when off", () => {
    const enabled = testConfig({ hooks: hooksSchema.parse({ enabled: true }) });
    expect(
      defaultBuiltinHooks(enabled).some((h) => h.name === "builtin:capture-lore-reflection"),
    ).toBe(true);

    const disabled = testConfig({
      hooks: hooksSchema.parse({ enabled: true, builtins: { capture_lore_reflection: false } }),
    });
    expect(
      defaultBuiltinHooks(disabled).some((h) => h.name === "builtin:capture-lore-reflection"),
    ).toBe(false);

    // Master gate off => no builtins at all.
    expect(defaultBuiltinHooks(testConfig())).toHaveLength(0);
  });
});

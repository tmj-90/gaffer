import type { EventLog } from "../events/eventLog.js";
import {
  normalizeHookOutput,
  type Hook,
  type HookEvidence,
  type HookInput,
  type HookName,
  type HookOutput,
  type PolicyOverrideRequest,
} from "./types.js";

/**
 * Points at which a hook's `veto` is honoured. Everywhere else a veto is
 * downgraded to a warning so a hook can never halt the happy path mid-flight.
 */
const VETOABLE_POINTS: ReadonlySet<HookName> = new Set<HookName>(["before_claim"]);

/**
 * Aggregated result of running every hook registered for a point. Safety is
 * never altered here: `policyOverridesRequested` is a list of *requests*, and
 * `vetoed` only ever blocks at a vetoable point.
 */
export interface HookRunResult {
  point: HookName;
  vetoed: boolean;
  vetoReason?: string;
  warnings: string[];
  evidence: HookEvidence[];
  policyOverridesRequested: PolicyOverrideRequest[];
  outputs: HookOutput[];
}

/**
 * Holds hooks per point and runs them in registration order. The registry is the
 * single place hooks touch the system: it aggregates their reports and records
 * every emitted event + every override *request* to the event log. It never
 * applies a policy override — overrides are surfaced for human approval only.
 */
export class HookRegistry {
  private readonly hooks = new Map<HookName, Hook[]>();

  constructor(private readonly events: EventLog) {}

  /** Register a hook for its declared point. Order of registration is preserved. */
  register(hook: Hook): void {
    const list = this.hooks.get(hook.point) ?? [];
    list.push(hook);
    this.hooks.set(hook.point, list);
  }

  /** Hooks registered for a point, in order. */
  forPoint(point: HookName): readonly Hook[] {
    return this.hooks.get(point) ?? [];
  }

  /** True if anything is registered for a point — lets callers skip cheaply. */
  has(point: HookName): boolean {
    return (this.hooks.get(point)?.length ?? 0) > 0;
  }

  /**
   * Run every hook for `input.hook_name` in order, aggregate their reports, and
   * record events. A veto is only effective at a vetoable point; elsewhere it is
   * recorded as a warning. Override requests are recorded but NEVER applied.
   */
  run(input: HookInput): HookRunResult {
    const point = input.hook_name;
    const hooks = this.hooks.get(point) ?? [];

    const warnings: string[] = [];
    const evidence: HookEvidence[] = [];
    const policyOverridesRequested: PolicyOverrideRequest[] = [];
    const outputs: HookOutput[] = [];
    let vetoed = false;
    let vetoReason: string | undefined;

    for (const hook of hooks) {
      const output = normalizeHookOutput(hook.run(input));
      outputs.push(output);

      for (const ev of output.events) {
        this.events.record(ev.type, { hook: hook.name, point, ...(ev.payload ?? {}) });
      }

      warnings.push(...output.warnings);
      evidence.push(...output.evidence);

      for (const override of output.policy_overrides_requested) {
        policyOverridesRequested.push(override);
        // Surfaced for approval; the engine records but does not apply it.
        this.events.record("hook_policy_override_requested", {
          hook: hook.name,
          point,
          policy: override.policy,
          reason: override.reason,
        });
      }

      if (output.status === "veto") {
        if (VETOABLE_POINTS.has(point)) {
          vetoed = true;
          vetoReason = output.vetoReason ?? `Vetoed by hook '${hook.name}'.`;
          this.events.record("hook_veto", { hook: hook.name, point, reason: vetoReason });
        } else {
          const note = `Hook '${hook.name}' requested veto at non-vetoable point '${point}'; downgraded to warning.`;
          warnings.push(note);
          this.events.record("hook_veto_ignored", { hook: hook.name, point });
        }
      }
    }

    return {
      point,
      vetoed,
      ...(vetoReason ? { vetoReason } : {}),
      warnings,
      evidence,
      policyOverridesRequested,
      outputs,
    };
  }
}

import type { CrewConfig } from "../config/schema.js";
import type { Hook, HookInput, HookOutput } from "./types.js";
import { normalizeHookOutput } from "./types.js";

/**
 * Built-in hooks. v1 ships config-driven, advisory hooks only — none of them
 * mutate state or bypass safety. They emit events/warnings so the wired points
 * are observably exercised even before users author their own hooks.
 */

const RISK_ORDER: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };

function riskRank(level: string): number {
  return RISK_ORDER[level] ?? RISK_ORDER.medium!;
}

/**
 * Vetoes a claim when the ticket's risk exceeds the agent's capability profile.
 * This is advisory routing assistance — the hard risk gate still lives in the
 * agent registry / Dispatch policy. Vetoes only, never overrides safety.
 */
export class RiskGuardClaimHook implements Hook {
  readonly name = "builtin:risk-guard-claim";
  readonly point = "before_claim" as const;

  constructor(private readonly maxRiskByCapabilityGap = "high") {}

  run(input: HookInput): HookOutput {
    const ticket = input.ticket;
    if (!ticket) return normalizeHookOutput();
    if (riskRank(ticket.riskLevel) > riskRank(this.maxRiskByCapabilityGap)) {
      return normalizeHookOutput({
        status: "veto",
        vetoReason: `Ticket #${ticket.number} risk '${ticket.riskLevel}' exceeds advisory ceiling '${this.maxRiskByCapabilityGap}'.`,
        events: [{ type: "hook_risk_guard_triggered", payload: { ticketNumber: ticket.number } }],
      });
    }
    return normalizeHookOutput();
  }
}

/**
 * Records the agent + factory environment after a claim. Purely observational —
 * emits an event for traceability.
 */
export class RecordEnvironmentHook implements Hook {
  readonly name = "builtin:record-environment";
  readonly point = "after_claim" as const;

  run(input: HookInput): HookOutput {
    return normalizeHookOutput({
      events: [
        {
          type: "hook_environment_recorded",
          payload: {
            agentId: input.agent.id,
            factory: input.factory.name,
            ...(input.ticket ? { ticketNumber: input.ticket.number } : {}),
          },
        },
      ],
    });
  }
}

/**
 * Warns (does not block) before submitting a review if no evidence is present on
 * the packet's acceptance criteria. Enforcement remains in the loop/Dispatch.
 */
export class RequireEvidenceBeforeReviewHook implements Hook {
  readonly name = "builtin:require-evidence-before-review";
  readonly point = "before_submit_review" as const;

  run(input: HookInput): HookOutput {
    const acCount = input.context_packet?.acceptanceCriteria.length ?? 0;
    if (acCount === 0) {
      return normalizeHookOutput({
        warnings: ["No acceptance criteria found on the context packet before review."],
      });
    }
    return normalizeHookOutput();
  }
}

/** Emits a structured event when a ticket is blocked, so humans can be notified. */
export class NotifyOnBlockedHook implements Hook {
  readonly name = "builtin:notify-on-blocked";
  readonly point = "on_blocked" as const;

  run(input: HookInput): HookOutput {
    return normalizeHookOutput({
      events: [
        {
          type: "hook_blocked_notification",
          payload: { ...(input.ticket ? { ticketNumber: input.ticket.number } : {}) },
        },
      ],
    });
  }
}

/**
 * Prompts the agent to capture durable lore at the natural close of a unit of
 * work (`after_ticket_done`). Most knowledge an agent accrues — conventions,
 * gotchas, architectural facts, boundaries — never gets recorded because nothing
 * in the normal plan→build→test→review flow asks for it; the Memory views stay
 * empty as a result. This hook closes that gap by surfacing a once-per-ticket
 * reminder to call the Memory `suggest_lore` tool for any REUSABLE finding.
 *
 * It is advisory and gated: it only emits a warning + event (the agent decides
 * whether anything durable surfaced, and `suggest_lore` itself lands a DRAFT a
 * human approves). It never records lore directly and never blocks — honesty and
 * the gate are preserved. Reusable knowledge only: per-ticket trivia is noise.
 */
export class CaptureLoreReflectionHook implements Hook {
  readonly name = "builtin:capture-lore-reflection";
  readonly point = "after_ticket_done" as const;

  run(input: HookInput): HookOutput {
    return normalizeHookOutput({
      warnings: [
        "Reflect: did you learn a reusable convention, gotcha, decision, or " +
          "boundary on this ticket? If so, call the Memory `suggest_lore` tool " +
          "once (with repo, tags, a source URL, and confidence) so it enters the " +
          "gated lore draft flow. Skip per-ticket trivia — capture only what the " +
          "next agent should know before they start.",
      ],
      events: [
        {
          type: "hook_capture_lore_prompted",
          payload: {
            ...(input.ticket ? { ticketNumber: input.ticket.number } : {}),
            ...(input.repo ? { repo: input.repo.name } : {}),
          },
        },
      ],
    });
  }
}

/** Classifies a failure event so on_failure handling is observable. */
export class ClassifyFailureHook implements Hook {
  readonly name = "builtin:classify-failure";
  readonly point = "on_failure" as const;

  run(input: HookInput): HookOutput {
    return normalizeHookOutput({
      events: [
        {
          type: "hook_failure_classified",
          payload: { classification: input.event?.type ?? "unknown" },
        },
      ],
    });
  }
}

/**
 * Build the default set of built-in hooks. v1 returns no-op/advisory hooks; the
 * deliverable is the engine + wired points, so this is intentionally minimal and
 * config-gated. Returns an empty array unless explicitly enabled.
 */
export function defaultBuiltinHooks(config: CrewConfig): Hook[] {
  if (!config.hooks.enabled) return [];
  const hooks: Hook[] = [];
  if (config.hooks.builtins.risk_guard_claim) hooks.push(new RiskGuardClaimHook());
  if (config.hooks.builtins.record_environment) hooks.push(new RecordEnvironmentHook());
  if (config.hooks.builtins.require_evidence_before_review)
    hooks.push(new RequireEvidenceBeforeReviewHook());
  if (config.hooks.builtins.notify_on_blocked) hooks.push(new NotifyOnBlockedHook());
  if (config.hooks.builtins.classify_failure) hooks.push(new ClassifyFailureHook());
  if (config.hooks.builtins.capture_lore_reflection) hooks.push(new CaptureLoreReflectionHook());
  return hooks;
}

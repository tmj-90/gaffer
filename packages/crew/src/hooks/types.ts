import { z } from "zod";

import type { ContextPacket } from "../context/packet.js";
import type { RuntimeEvent } from "../events/eventLog.js";

/**
 * Every hook point Crew exposes (see 04-loops-hooks-skills.md). Hooks are
 * advisory: they may veto a claim, emit events/warnings, attach evidence, and
 * *request* (never apply) policy overrides. They can never bypass safety.
 */
export const hookNameSchema = z.enum([
  "before_claim",
  "after_claim",
  "before_context_packet",
  "after_context_packet",
  "before_implementation",
  "after_tests",
  "before_submit_review",
  "after_ticket_done",
  "on_blocked",
  "on_idle",
  "on_failure",
]);

export type HookName = z.infer<typeof hookNameSchema>;

/** A policy override is only ever a *request* for human approval — never applied. */
export interface PolicyOverrideRequest {
  /** Stable machine-readable key, e.g. "git.deny_force_push". */
  policy: string;
  /** Human-readable justification recorded for the approver. */
  reason: string;
}

export interface HookEvidence {
  evidenceType: string;
  summary: string;
  acId?: string;
  uri?: string;
  payload?: unknown;
}

export interface HookEventRequest {
  type: string;
  payload?: Record<string, unknown>;
}

/**
 * What a hook receives. All fields beyond `hook_name`/`factory`/`agent` are
 * optional because not every point has a ticket, repo, packet or event yet.
 * Mirrors the doc's hook input contract.
 */
export interface HookInput {
  hook_name: HookName;
  factory: { name: string; mode: string };
  agent: { id: string; capabilities: string[] };
  ticket?: { id: string; number: number; title: string; riskLevel: string };
  repo?: { name: string; riskLevel: string } | undefined;
  context_packet?: ContextPacket | undefined;
  event?: RuntimeEvent | undefined;
}

export type HookStatus = "ok" | "veto";

/**
 * What a hook returns. The doc's output contract. `status: "veto"` is only
 * honoured at vetoable points (currently `before_claim`); elsewhere it degrades
 * to a warning so a hook can never silently halt the happy path.
 */
export interface HookOutput {
  status: HookStatus;
  events: HookEventRequest[];
  evidence: HookEvidence[];
  warnings: string[];
  policy_overrides_requested: PolicyOverrideRequest[];
  /** Optional reason surfaced when status is "veto". */
  vetoReason?: string;
}

/** A registered hook implementation. Pure: it reports, it does not act. */
export interface Hook {
  readonly name: string;
  readonly point: HookName;
  run(input: HookInput): HookOutput;
}

/** A partial output is convenient for authoring hooks; the registry normalises it. */
export type PartialHookOutput = Partial<HookOutput>;

/** Normalise a (possibly partial) hook output into a complete one. */
export function normalizeHookOutput(out: PartialHookOutput | void): HookOutput {
  return {
    status: out?.status ?? "ok",
    events: out?.events ?? [],
    evidence: out?.evidence ?? [],
    warnings: out?.warnings ?? [],
    policy_overrides_requested: out?.policy_overrides_requested ?? [],
    ...(out?.vetoReason ? { vetoReason: out.vetoReason } : {}),
  };
}

import { z, type ZodType } from "zod";

import {
  AC_STATUSES,
  DECISION_SEVERITIES,
  DECISION_STATUSES,
  POLICY_PACKS,
  RISK_LEVELS,
  TICKET_STATUSES,
  type AcceptanceCriterion,
  type Decision,
  type Ticket,
} from "../../domain/types.js";
import type { PrincipalView } from "../../repositories/principalRepository.js";
import type { AgentDisplay } from "../../services/squadService.js";

/**
 * Response-body schemas for the main ticket, gate, decision and principal
 * operations, rendered into the OpenAPI document as components (spec.ts names one
 * per response with `schema`). The entity shapes are pinned to the TypeScript row
 * types with `satisfies Record<keyof T, …>`, so a new column that is not added here
 * fails the build; test/api-openapi-responses.test.ts validates live bodies against
 * them, so a route that changes its envelope fails the suite.
 *
 * Envelopes are `.strict()` (the contract lists every key); entity rows are not, so
 * a client can rely on the documented fields without the doc going stale on an
 * additive column.
 */

const str = z.string();
const nstr = z.string().nullable();
const int = z.number().int();

export const TicketRow = z
  .object({
    id: str,
    number: int.nullable(),
    title: str,
    description: str,
    status: z.enum(TICKET_STATUSES),
    priority: int,
    risk_level: z.enum(RISK_LEVELS),
    policy_pack: z.enum(POLICY_PACKS),
    source: nstr,
    created_by: nstr,
    reviewer: nstr,
    branch_name: nstr,
    pr_url: nstr,
    attempt_count: int,
    row_version: int,
    scheduled_after: nstr,
    due_at: nstr,
    bootstrap: int,
    last_review_feedback: nstr.describe("JSON-encoded {reason, reviewer, at} or null."),
    can_be_tested: int,
    test_contract: nstr.describe("JSON-encoded test contract or null."),
    acceptance: int,
    allow_test_changes: int.describe(
      "1 ⇒ a human allowed this ticket to change its tests (gate integrity PASS-with-note).",
    ),
    human_owner: nstr,
    human_delivered: nstr,
    delivery_budget_usd: z.number().nullable(),
    created_at: str,
    updated_at: str,
  } satisfies Record<keyof Ticket, ZodType>)
  .describe("A ticket row.");

export const AcceptanceCriterionRow = z
  .object({
    id: str,
    ticket_id: str,
    text: str,
    sort_order: int,
    status: z.enum(AC_STATUSES),
    verification_method: nstr,
    evidence_required: int,
    verified_by: nstr,
    verified_at: nstr,
    check_command: nstr,
    spec_clause_id: nstr,
    created_at: str,
    updated_at: str,
  } satisfies Record<keyof AcceptanceCriterion, ZodType>)
  .describe("An acceptance criterion.");

export const DecisionRow = z
  .object({
    id: str,
    title: str,
    question: str,
    rationale: nstr,
    status: z.enum(DECISION_STATUSES),
    decision_type: str,
    severity: z.enum(DECISION_SEVERITIES),
    proposed_answer: nstr,
    proposed_by: nstr,
    confidence: nstr,
    resolved_answer: nstr,
    resolved_by: nstr,
    resolved_at: nstr,
    memory_record_id: nstr,
    created_at: str,
    updated_at: str,
  } satisfies Record<keyof Decision, ZodType>)
  .describe("A decision.");

export const PrincipalRowView = z
  .object({
    id: str,
    name: str,
    capability: z.enum(["full", "read"]),
    actor_type: z.enum(["human", "admin"]),
    actor_id: str,
    created_by: nstr,
    created_at: str,
    last_used_at: nstr,
    revoked_at: nstr,
  } satisfies Record<keyof PrincipalView, ZodType>)
  .describe("An API principal (never carries token material).");

export const AgentDisplayView = z
  .object({
    agent_id: str,
    display_name: nstr,
    display_name_effective: str,
    default_display_name: str,
    shirt_number: int.nullable(),
    role: z.enum(["delivery", "reviewer", "security_reviewer", "tester"]),
  } satisfies Record<keyof AgentDisplay, ZodType>)
  .describe("How an agent is presented (squad name, shirt number); the agent id never changes.");

// Compile-time: each row schema infers EXACTLY its TypeScript row type (keys and
// value types), so the contract cannot drift from the code in either direction.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const exact = <T extends true>(_: T): void => undefined;
exact<Exact<z.infer<typeof TicketRow>, Ticket>>(true);
exact<Exact<z.infer<typeof AcceptanceCriterionRow>, AcceptanceCriterion>>(true);
exact<Exact<z.infer<typeof DecisionRow>, Decision>>(true);
exact<Exact<z.infer<typeof PrincipalRowView>, PrincipalView>>(true);
exact<Exact<z.infer<typeof AgentDisplayView>, AgentDisplay>>(true);

const eventId = str.describe("The id of the work event the change wrote.");

// --- Envelopes ---------------------------------------------------------------

export const TicketEnvelope = z.object({ ticket: TicketRow }).strict();

export const TicketList = z
  .object({
    tickets: z.array(
      TicketRow.partial({ description: true, test_contract: true, last_review_feedback: true })
        // zod 4's .partial() returns a fresh object without the row's description.
        .describe(TicketRow.description ?? ""),
    ),
    total: int.describe("Every ticket matching the filters, regardless of paging."),
    limit: int.optional().describe("Echoed when paging."),
    offset: int.optional().describe("Echoed when paging."),
  })
  .strict();

export const TicketDetail = z
  .object({
    ticket: TicketRow,
    acceptance_criteria: z.array(AcceptanceCriterionRow),
    repositories: z.array(z.record(z.string(), z.unknown())),
    scopes: z.array(z.record(z.string(), z.unknown())),
    blocking_decisions: z.array(DecisionRow),
    dependencies: z.array(z.record(z.string(), z.unknown())),
    evidence: z.array(z.record(z.string(), z.unknown())),
    events: z.array(z.record(z.string(), z.unknown())),
    rework_trail: z.array(z.record(z.string(), z.unknown())),
    agent_display: z
      .record(z.string(), AgentDisplayView)
      .describe("Every agent the ticket's claims and events name, keyed by agent id."),
  })
  .strict();

export const TicketTransition = z
  .object({
    ticket: TicketRow,
    event_id: eventId,
    lore_capture: z
      .object({ captured: z.boolean(), id: nstr.optional(), reason: str.optional() })
      .optional()
      .describe("review/reject with captureLore only."),
  })
  .strict();

export const ReviewApproved = z
  .object({
    ticket: TicketRow,
    event_id: eventId,
    merge: z
      .object({ triggered: z.boolean(), pid: int.nullable(), skipped: str.optional() })
      .optional()
      .describe("The auto-merge command, when one is configured."),
  })
  .strict();

export const AcCreated = z
  .object({ acceptance_criterion: AcceptanceCriterionRow, event_id: eventId })
  .strict();

export const ReopenedForReview = z
  .object({ ticket_id: str, status: z.enum(TICKET_STATUSES), event_id: eventId })
  .strict();

export const TestableSet = z
  .object({
    ticket_id: str,
    can_be_tested: z.boolean(),
    event_id: eventId,
    ticketId: str.describe("Deprecated camelCase twin of ticket_id."),
    canBeTested: z.boolean().describe("Deprecated camelCase twin of can_be_tested."),
    eventId: str.describe("Deprecated camelCase twin of event_id."),
  })
  .strict();

export const TestChangesAllowed = z
  .object({ ticket_id: str, allow_test_changes: z.boolean(), event_id: eventId })
  .strict();

export const TestContractSet = z
  .object({
    test_contract: z.object({
      changed_surfaces: z.array(str),
      runtime_deps: z.array(str),
      env_vars: z.array(str),
      run_command: str,
      harness_ready: z.boolean(),
    }),
  })
  .strict();

export const MonoFallback = z
  .object({
    applied: z.boolean(),
    ticket_id: str,
    repo_id: str.optional(),
    reason: str.optional().describe("Why it did not apply."),
    event_id: eventId.optional(),
    ticketId: str.describe("Deprecated camelCase twin of ticket_id."),
    repoId: str.optional().describe("Deprecated camelCase twin of repo_id."),
    eventId: str.optional().describe("Deprecated camelCase twin of event_id."),
  })
  .strict();

export const DecisionEnvelope = z.object({ decision: DecisionRow }).strict();

export const Whoami = z
  .object({
    capability: z.enum(["full", "read"]),
    actor: z.object({ type: str, id: str.optional() }).strict(),
    principal: z.object({ id: str, name: str }).strict().nullable(),
  })
  .strict();

export const PrincipalEnvelope = z.object({ principal: PrincipalRowView }).strict();

export const PrincipalCreated = z
  .object({
    principal: PrincipalRowView,
    token: str.describe("The bearer token — shown this once; only its hash is stored."),
  })
  .strict();

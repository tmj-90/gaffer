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
import {
  APPROVE_OUTCOME_KINDS,
  type ApproveOutcome as ApproveOutcomeType,
} from "../../services/approveOutcome.js";
import type {
  ImpactFact as ImpactFactShape,
  RepoImpact as RepoImpactShape,
} from "../../services/changeImpact.js";
import type {
  RepoDiff as RepoDiffShape,
  TicketDiff as TicketDiffShape,
} from "../../services/diffService.js";
import {
  RISK_KINDS,
  type RiskAnnotation as RiskAnnotationShape,
} from "../../services/riskAnnotations.js";
import type { AgentDisplay } from "../../services/squadService.js";
import {
  REJECT_OUTCOME_KINDS,
  type RejectOutcome as RejectOutcomeType,
} from "../../services/rejectOutcome.js";
import type { ReviewComment as ReviewCommentShape } from "../../services/reviewCommentService.js";

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
    scope: z
      .object({
        repos: z
          .array(z.object({ id: str, name: nstr }).strict())
          .nullable()
          .describe("The repositories it may reach (null: no repo scope)."),
        tickets: z
          .array(z.object({ id: str, number: int.nullable() }).strict())
          .nullable()
          .describe("The tickets it may reach (null: no ticket scope)."),
      })
      .strict()
      .nullable()
      .describe(
        "PRINCIPAL SCOPES: null for an unscoped principal. Otherwise it reaches only tickets whose write repos all sit inside `repos`, or that are in `tickets`; everything else is 403 `SCOPE_DENIED`.",
      ),
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

const TicketWarningRow = z.object({ code: str, message: str }).strict();

export const TicketCreated = z
  .object({
    ticket: TicketRow,
    warnings: z
      .array(TicketWarningRow)
      .optional()
      .describe(
        "Present when the ticket's pack will refuse it at ready as created (DESCRIPTION_REQUIRED: a team_light-or-stricter ticket with no description).",
      ),
  })
  .strict();

export const TicketEdited = z
  .object({
    ticket: TicketRow,
    changed: z.array(str).describe("The fields the edit changed."),
    event_id: eventId,
  })
  .strict();

export const TicketList = z
  .object({
    tickets: z.array(
      TicketRow.partial({ description: true, test_contract: true, last_review_feedback: true })
        // zod 4's .partial() returns a fresh object without the row's description.
        .describe(TicketRow.description ?? ""),
    ),
    total: int.describe("Every ticket matching the filters, regardless of paging."),
    limit: int.describe("The page size applied (500 when the request names none)."),
    offset: int.describe("Where this page starts."),
    next_offset: int
      .nullable()
      .describe("The `offset` of the next page, or null when this page is the last."),
  })
  .strict();

const TicketSummaryRow = TicketRow.partial({
  description: true,
  test_contract: true,
  last_review_feedback: true,
});
const looseRows = z.array(z.record(z.string(), z.unknown()));

export const TicketDetailsBatch = z
  .object({
    details: z
      .array(
        z
          .object({
            ticket: TicketSummaryRow.describe("The ticket's summary row (plus `landing_state`)."),
            repositories: looseRows.optional(),
            scopes: looseRows.optional(),
            dependencies: looseRows.optional(),
            rework_trail: looseRows.optional(),
            events: looseRows.optional(),
            evidence: looseRows.optional(),
          })
          .strict(),
      )
      .describe("One entry per ticket, each carrying the parts `include` asked for."),
    missing: z.array(str).describe("Requested ids no ticket has."),
    total: int.describe("With `ids`: the tickets found. Without: every ticket."),
    limit: int.optional().describe("Without `ids`: the page size applied."),
    offset: int.optional().describe("Without `ids`: where this page starts."),
    next_offset: int
      .nullable()
      .optional()
      .describe("Without `ids`: the next page's `offset`, or null on the last page."),
  })
  .strict();

/** REVIEW RULES (D6): drafts a person's feedback just completed, proposed to memory. */
const ReviewRulesProposed = z
  .array(z.object({ repo: str, lore_id: nstr }).strict())
  .optional()
  .describe("Review-rule drafts this act completed and proposed (memory configured only).");

/** One side of an escaped-defect link (MF5). */
const RegressionLinkView = z
  .object({
    ticket_id: str,
    number: int.nullable(),
    title: nstr.describe("Null for a scoped principal outside its scope."),
    status: str,
    filed_by: z.object({ type: str, id: nstr }).strict(),
    filed_at: str,
    note: nstr,
    outside_scope: z.literal(true).optional(),
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
    review_comments: z
      .array(z.record(z.string(), z.unknown()))
      .describe("The reviewer's comments (the ReviewComment shape, without anchor_state)."),
    regression: z
      .object({
        regression_of: z.array(RegressionLinkView),
        regressed_by: z.array(RegressionLinkView),
      })
      .strict()
      .describe(
        "Escaped defects: the accepted changes a person linked this ticket to as their regression, and the later tickets linked to this one.",
      ),
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
      .object({
        captured: z.boolean(),
        id: nstr.optional(),
        repo: nstr.optional().describe("The repo whose Memory page lists the draft."),
        reason: str.optional(),
      })
      .optional()
      .describe("review/reject with captureLore only."),
    review_rules_proposed: ReviewRulesProposed,
    landed_already: z
      .array(
        z
          .object({
            repo: str,
            repoId: str,
            commit: str,
            landed: z.boolean().describe("false: the landing had started and may still be moving."),
            via: nstr,
            at: str,
          })
          .strict(),
      )
      .optional()
      .describe(
        "review/reject and wont-do: landings that had already started on the approval this revocation withdrew. It stops every landing not yet started and does not undo these.",
      ),
  })
  .strict();

/**
 * What a human Approve does, said as the first step that will certainly happen (see
 * services/approveOutcome.ts). On GET /tickets/:id/diff it is the prediction for an
 * in_review ticket; on review/approve it is what the click actually did.
 */
export const ApproveOutcome = z
  .object({
    kind: z.enum(APPROVE_OUTCOME_KINDS),
    approvable: z
      .boolean()
      .describe(
        "False only when the server would refuse (held_ci, held_repo_unavailable, or held_test_modified for an agent).",
      ),
    to_status: z.enum(["in_testing", "ready_for_merge"]).nullable(),
    label: str.describe('The sign-off button, e.g. "Approve and send to tester".'),
    confirm_label: str.describe("The armed button (the second press approves)."),
    done_label: str.describe("The button once approved."),
    sentence: str.describe("One line under the button: what follows the click."),
    via: z.enum(["pr", "local"]).nullable(),
    pr_url: nstr,
    lands_repo: nstr.describe("The primary write repo a landing merges first."),
    also_lands_repos: z
      .array(str)
      .describe("The other write repos the same landing merges after it, one merge each."),
    not_landed_repos: z
      .array(str)
      .describe("Write repos with no checkout here: no landing path can merge them."),
    review_mode: z.enum(["human", "agent", "both"]),
    agent_hold: z
      .object({
        kind: z.literal("held_test_modified"),
        label: str,
        sentence: str,
        holds: z.array(str).describe("The gate-integrity findings that hold it."),
      })
      .strict()
      .nullable()
      .describe(
        "The hold an agent or auto approval would hit now (the tests that gate it changed); a human approval is not held by it.",
      ),
  })
  .strict() satisfies ZodType<ApproveOutcomeType>;

export const ReviewApproved = z
  .object({
    ticket: TicketRow,
    event_id: eventId,
    merge: z
      .object({
        triggered: z.boolean(),
        pid: int.nullable(),
        skipped: str.optional(),
        runId: nstr.optional(),
      })
      .optional()
      .describe("The auto-merge command, when one is configured."),
    approve_outcome: ApproveOutcome.optional().describe(
      "What the approval did: the tester, a landing now, the merge lane's next tick, or a wait for Merge now.",
    ),
  })
  .strict();

export const AcCreated = z
  .object({ acceptance_criterion: AcceptanceCriterionRow, event_id: eventId })
  .strict();

export const AcEdited = z
  .object({ acceptance_criterion: AcceptanceCriterionRow, event_id: eventId })
  .strict();

export const AcRemoved = z.object({ ac_id: str, event_id: eventId }).strict();

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

export const RegressionOf = z
  .object({
    ticket_id: str,
    regression_of: str.describe("The accepted change's ticket id."),
    recorded: z.boolean().describe("false: the link already stood (or nothing to withdraw)."),
    withdrawn: z.boolean(),
    event_id: str.nullable(),
  })
  .strict();

export const ReviewRules = z
  .object({
    threshold: int.describe("GAFFER_REVIEW_RULE_REPEAT: distinct tickets a rule needs."),
    candidates: z
      .array(z.record(z.string(), z.unknown()))
      .describe(
        "Repeated feedback not proposed yet: repo, key, count, tickets, rule_text, examples.",
      ),
    proposed: z
      .array(z.record(z.string(), z.unknown()))
      .describe(
        "Proposed rules: repo, key, count, lore_id, lore_status, approved_at and measure (state not_approved | not_enough_data | measured, citing before/after per review round).",
      ),
    note: str,
  })
  .strict();

export const ReviewOpened = z
  .object({
    ticket_id: str,
    recorded: z.boolean(),
    reason: z
      .enum(["not_in_review", "no_review_round", "stale_round", "already_recorded"])
      .nullable()
      .describe("Why nothing was written; null when recorded."),
    event_id: str.nullable(),
    round_entered_at: str.nullable().describe("When the ticket last entered in_review."),
  })
  .strict();

export const RiskKind = z
  .enum(RISK_KINDS)
  .describe(
    "What a risk annotation flags. `sensitive-path`: secret/auth/infra paths; " +
      "`dependency-change`: a manifest or lockfile; `large-deletion`: many deleted lines; " +
      "`test-modified`: the delivery changed the tests that gate it (deleted/renamed a " +
      "test file, added a skip/only marker, changed a gate script, touched test or " +
      "package-manager config). Unallowed, `test-modified` raises observed risk to high " +
      "and holds an agent approve for a person.",
  );

export const RiskAnnotation = z
  .object({
    kind: RiskKind,
    severity: z.enum(["high", "medium"]),
    detail: str.describe("Short human summary."),
    paths: z.array(str).optional().describe("The concrete paths that triggered it."),
    items: z
      .array(str)
      .optional()
      .describe("`test-modified` only: one human line per finding, for the Review banner."),
    allowed: z
      .boolean()
      .optional()
      .describe(
        "`test-modified` only: a human allowed test changes on this ticket; the annotation " +
          "drops to medium and no longer holds an approve on its own.",
      ),
  } satisfies Record<keyof RiskAnnotationShape, ZodType>)
  .strict()
  .describe("An advisory risk flag on a repo's delivery diff.");

export const ImpactFact = z
  .object({
    kind: z.enum([
      "export_added",
      "export_removed",
      "export_changed",
      "migration",
      "ddl",
      "config",
      "env_added",
      "env_removed",
      "dependency_added",
      "dependency_removed",
      "dependency_bumped",
      "generated",
      "untested_module",
      "route",
      "downstream_repo",
    ] satisfies ImpactFactShape["kind"][]),
    text: str.describe("One plain line, e.g. `export function clearDone added`."),
    path: nstr.describe("The file in this diff the fact is about (its anchor), or null."),
    line: int.nullable().describe("The new-side line (old-side for a removal), when it has one."),
    method: z
      .enum([
        "from the diff's lines",
        "by path",
        "from the manifest diff",
        "by .gitattributes",
        "by import text",
        "pattern match",
        "scope graph depends_on",
      ] satisfies ImpactFactShape["method"][])
      .describe("How the fact was found. A text or path heuristic, never a certainty."),
  } satisfies Record<keyof ImpactFactShape, ZodType>)
  .strict()
  .describe("One deterministic change-impact fact.");

export const RepoImpact = z
  .object({
    facts: z.array(ImpactFact),
    none: z
      .array(str)
      .describe(
        "Surfaces scanned with nothing found (`migration or DDL`, `config`, …). Empty when the diff was cut at its size cap: a cut diff proves no absence.",
      ),
    not_analysed: z.array(str).describe("What the scan does not cover, said plainly."),
  } satisfies Record<keyof RepoImpactShape, ZodType>)
  .strict()
  .describe(
    "The Behavioural surface of one repo's delivery (`?include=impact`), read from the diff and the tree at `headSha`. Advisory: nothing gates on it.",
  );

export const RepoDiff = z
  .object({
    repo: str,
    branch: nstr.describe("The resolved delivery branch, or null."),
    baseBranch: str.describe("The default branch the delivery branch is diffed against."),
    diff: str.describe("Raw unified diff text (possibly truncated); empty when unavailable."),
    files: int,
    additions: int,
    deletions: int,
    truncated: z.boolean(),
    unavailable: z
      .enum(["no_branch", "repo_not_on_disk", "no_local_path", "empty", "git_error"])
      .optional()
      .describe("Why no diff text is available."),
    message: str.optional(),
    riskAnnotations: z.array(RiskAnnotation),
    repoId: str.optional().describe("The repository id, so an approval can name the repo it saw."),
    headSha: str
      .nullable()
      .optional()
      .describe(
        "The delivery branch head this diff was computed against; sent back on approve, and a moved head is refused (stale_revision).",
      ),
    impact: RepoImpact.optional().describe(
      "With `?include=impact`: the change-impact facts for this repo (advisory).",
    ),
  } satisfies Record<keyof RepoDiffShape, ZodType>)
  .strict()
  .describe("The delivery diff for one write repository.");

/**
 * What a "Fix these" send-back does (see services/rejectOutcome.ts): on GET /tickets/:id/diff
 * and GET …/review/comments the prediction for an in_review ticket; on review/fix what the
 * click did.
 */
export const RejectOutcome = z
  .object({
    kind: z.enum(REJECT_OUTCOME_KINDS),
    label: str.describe('The button, e.g. "Fix these (3)".'),
    sentence: str.describe("Where the ticket goes, what the next delivery gets, the AC reset."),
    to_status: z.enum(["refining", "ready", "blocked"]),
    attempt: int.describe("attempt_count after the send-back."),
    max_attempts: int,
    ac_reset: z.literal(true).describe("A send-back resets the acceptance criteria to not met."),
    requirements: int.describe("The open must-fix comments it carries."),
  })
  .strict() satisfies ZodType<RejectOutcomeType>;

export const ReviewComment = z
  .object({
    id: str,
    ticket_id: str,
    repo_id: nstr,
    path: nstr.describe("Null: a comment on the whole change."),
    side: z.enum(["new", "old"]).nullable(),
    line: int.nullable().describe("Null: a file (or ticket) comment."),
    anchor_sha: nstr.describe("The repo head the comment was written against."),
    anchor_excerpt: nstr.describe("The +-3 lines git holds at the anchor (line comments)."),
    anchor_hash: nstr.describe("sha256 of anchor_excerpt."),
    body: str,
    severity: z.enum(["must_fix", "consider"]),
    status: z.enum(["open", "resolved", "withdrawn"]),
    author_type: z.enum(["human", "admin"]),
    author_id: nstr,
    round: int.describe("The ticket's attempt_count when the comment was written."),
    sent_round: int.nullable().describe("The attempt a Fix these send-back carried it into."),
    created_at: str,
    updated_at: str,
    resolved_at: nstr,
    resolved_by: nstr,
    resolved_at_sha: nstr,
  } satisfies Record<keyof ReviewCommentShape, ZodType>)
  .extend({
    short_id: str.describe("The first 8 characters of the id."),
    repo: nstr,
    anchor_state: z
      .enum(["current", "untouched", "changed", "unknown"])
      .nullable()
      .optional()
      .describe(
        "`?anchors=1` only, from `git diff <anchor_sha> <head> -- <path>`: current (the head is the anchor), untouched, changed (a hunk touches the anchored lines, or the file), unknown (git cannot answer); null for a comment on the whole change.",
      ),
    anchor_head: nstr.optional().describe("The head the anchor state was computed against."),
    agent_replies: z
      .array(z.object({ evidence_id: str, summary: str, created_at: str }).strict())
      .optional()
      .describe("The delivery agent's replies: a claim about what it did, never a resolution."),
  })
  .describe("A reviewer's comment on a delivery.");

export const ReviewCommentEnvelope = z
  .object({ comment: ReviewComment, review_rules_proposed: ReviewRulesProposed })
  .strict();

export const ReviewCommentList = z
  .object({
    comments: z.array(ReviewComment),
    counts: z.object({ open: int, open_must_fix: int, resolved: int, withdrawn: int }).strict(),
    reject_outcome: RejectOutcome.optional().describe("An in_review ticket only."),
  })
  .strict();

export const FixTheseResult = z
  .object({
    ticket: TicketRow,
    event_id: eventId,
    requirements: z.array(ReviewComment).describe("The comments sent, as numbered requirements."),
    reject_outcome: RejectOutcome,
    landed_already: TicketTransition.shape.landed_already,
  })
  .strict();

export const TicketHeads = z
  .object({
    ticketId: str,
    heads: z.array(z.object({ repo: str, repo_id: str, sha: str }).strict()),
    unavailable: z.array(z.object({ repo: str, repo_id: str, why: str }).strict()),
  })
  .strict();

export const SinceRepo = z
  .object({
    repo: str,
    repoId: str,
    from_sha: nstr.describe("The commit a person last sent back (the latest human reject pin)."),
    to_sha: nstr.describe("The head now."),
    available: z.boolean(),
    history_rewritten: z
      .boolean()
      .describe("The sent-back commit is no longer an ancestor of the head (or is gone)."),
    reason: z.enum(["no_reject_pin", "no_head", "git_error"]).optional(),
    attempt: int.nullable().optional(),
    sent_back_at: nstr.optional(),
  })
  .strict();

export const TicketDiff = z
  .object({ ticketId: str, repos: z.array(RepoDiff) } satisfies Record<
    keyof TicketDiffShape,
    ZodType
  >)
  .extend({
    approve_outcome: ApproveOutcome.optional().describe(
      "An in_review ticket only: the first step a human Approve would certainly take now.",
    ),
    reject_outcome: RejectOutcome.optional().describe(
      "An in_review ticket only: what Fix these (a send-back with the open must-fix comments) does now.",
    ),
    since: z
      .array(SinceRepo)
      .optional()
      .describe(
        "`?since=rejected` only: per write repo, the interdiff's endpoints, or `history_rewritten`.",
      ),
  })
  .strict();

/** Response schemas rendered as their own components and `$ref`d where nested. */
export const SHARED_RESPONSE_COMPONENTS = [
  "ApproveOutcome",
  "RejectOutcome",
  "ReviewComment",
  "ImpactFact",
  "RepoDiff",
  "RepoImpact",
  "RiskAnnotation",
  "RiskKind",
] as const;

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
    scope: PrincipalRowView.shape.scope,
  })
  .strict();

export const PrincipalEnvelope = z.object({ principal: PrincipalRowView }).strict();

export const PrincipalCreated = z
  .object({
    principal: PrincipalRowView,
    token: str.describe("The bearer token — shown this once; only its hash is stored."),
  })
  .strict();

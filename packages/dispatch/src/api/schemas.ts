import { z } from "zod";

import {
  GIT_REF_SAFE,
  GIT_REF_SAFE_MESSAGE,
  PR_URL_SAFE,
  PR_URL_SAFE_MESSAGE,
} from "../domain/schemas.js";
import {
  RISK_LEVELS,
  SCOPE_EDGE_RELATIONS,
  SCOPE_NODE_TYPES,
  SCOPE_REPO_ACCESS,
  SCOPE_REPO_RELATIONS,
  SPEC_CLAUSE_KINDS,
  SPEC_STATUSES,
  TICKET_REPO_ACCESS,
  TICKET_REPO_RELATIONS,
  TICKET_REPO_DELIVERY_STATUSES,
  TICKET_REPO_SOURCES,
  TICKET_SCOPE_RELATIONS,
  TICKET_STATUSES,
} from "../domain/types.js";

/**
 * Zod schemas for the HTTP request bodies + query parameters. These validate the
 * untrusted JSON at the API boundary before any value reaches the facade — the
 * facade re-validates its own inputs, so this layer focuses on shaping the
 * request and producing 422s for malformed payloads.
 */

/**
 * One repo attached to a ticket at create time, with the access level the agent
 * gets there. `access` defaults to `write` so a bare repo id is treated as a
 * write target (the common single-repo case). `none` is intentionally excluded —
 * a "don't touch" outcome is the absence of an attachment, not an attachment.
 */
export const createTicketRepo = z.object({
  repo_id: z.string().trim().min(1).max(200),
  access: z.enum(["write", "read", "test"]).default("write"),
});
export type CreateTicketRepo = z.infer<typeof createTicketRepo>;

export const createTicketBody = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().max(20_000).optional(),
  priority: z.number().int().min(0).max(1_000).optional(),
  risk_level: z.enum(RISK_LEVELS).optional(),
  policy_pack: z.enum(["solo_loose", "team_light", "factory_strict", "regulated"]).optional(),
  source: z.string().max(200).optional(),
  /** Legacy single primary repo (kept for back-compat with older callers). */
  repo: z.string().max(200).optional(),
  /**
   * Feature A: one or more repos to attach, each with an access level. Applied
   * via setTicketRepoAccess after the ticket exists, so the ticket comes out of
   * create with a real execution boundary (write/read/test) rather than no repo.
   */
  repoIds: z.array(createTicketRepo).max(100).optional(),
  /** Feature A: scope node(s) to link to the ticket (the first is primary). */
  scopeNodeIds: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
});
export type CreateTicketBody = z.infer<typeof createTicketBody>;

/**
 * Body for POST /product-owner/runs. The run targets EITHER a single repo
 * (repo-level) OR a scope node (node-level, expanded server-side to that node's
 * repos). Both are optional and mutually exclusive; an empty body runs with no
 * explicit target (the pre-existing behaviour).
 */
export const runProductOwnerBody = z
  .object({
    repo: z.string().trim().min(1).max(200).optional(),
    scopeNodeId: z.string().trim().min(1).max(200).optional(),
  })
  .refine((v) => !(v.repo !== undefined && v.scopeNodeId !== undefined), {
    message: "Provide either repo (repo-level) or scopeNodeId (node-level), not both.",
  });
export type RunProductOwnerBody = z.infer<typeof runProductOwnerBody>;

/** Body for POST /repos/:id/hidden — toggle a repo's hidden flag (WG-006). */
export const setRepoHiddenBody = z.object({
  hidden: z.boolean(),
});
export type SetRepoHiddenBody = z.infer<typeof setRepoHiddenBody>;

/**
 * Body for POST /repos/onboard — kick off onboarding for a repo. `repo` is EITHER
 * a registered repo id/name OR a local filesystem path; the onboard command
 * resolves which it is. We only shape + sanitise the string here:
 *  - non-empty after trim (an empty target is meaningless);
 *  - length-capped;
 *  - rejects NUL and newline/control bytes (an argv/path-injection guard — the
 *    value rides in the child ENV, never a shell, but a control byte in a path is
 *    never legitimate and could confuse a downstream parser).
 * Path traversal itself is NOT a 422: a relative or `..`-containing path can be a
 * legitimate onboard target; the onboard command owns where it may read.
 */
export const onboardRepoBody = z.object({
  repo: z
    .string()
    .trim()
    .min(1, "A repo id/name or path is required to onboard.")
    .max(1_000)
    // eslint-disable-next-line no-control-regex -- explicit control-byte guard (NUL/newline/etc.).
    .refine((v) => !/[\x00-\x1f]/.test(v), {
      message: "Repo target must not contain control characters.",
    }),
});
export type OnboardRepoBody = z.infer<typeof onboardRepoBody>;

export const addAcBody = z.object({
  text: z.string().trim().min(1).max(2_000),
  verification_method: z.string().max(500).optional(),
  evidence_required: z.boolean().optional(),
});
export type AddAcBody = z.infer<typeof addAcBody>;

/**
 * Body for POST /tickets/:id/review/reject. `to` is the rejection target:
 *  - `refining` (default in the UI) — send back for rework (a human triages first);
 *  - `ready` — legacy skip-triage rework;
 *  - `cancelled` — abandon to the won't-do bucket in one step.
 * In every case the ticket's acceptance criteria are reset to not-satisfied.
 */
export const rejectReviewBody = z.object({
  to: z.enum(["ready", "refining", "cancelled"]),
  reason: z.string().trim().min(1).max(20_000),
});
export type RejectReviewBody = z.infer<typeof rejectReviewBody>;

/**
 * Body for POST /tickets/:id/wont-do — mark a ticket terminal "won't do"
 * (`cancelled` bucket). A reason is required so the abandonment is auditable.
 */
export const wontDoBody = z.object({
  reason: z.string().trim().min(1).max(20_000),
});
export type WontDoBody = z.infer<typeof wontDoBody>;

/**
 * PAUSE-ON-CAP bodies. POST /tickets/:id/continue takes no fields (the dashboard
 * Continue button just signals "resume this"); POST /tickets/:id/stop carries an
 * optional reason for the audit trail.
 */
export const continuePausedBody = z.object({}).strip();
export type ContinuePausedBody = z.infer<typeof continuePausedBody>;

/**
 * TRACK-2b bodies. POST /tickets/:id/human-claim ("I'll do this by hand") and
 * /tickets/:id/human-release (hand back) both take no fields — the ticket id in the
 * path plus the API's human actor are all that's needed. Shared empty (stripping)
 * schema so unexpected fields are dropped rather than 422'ing the action.
 */
export const humanClaimBody = z.object({}).strip();
export type HumanClaimBody = z.infer<typeof humanClaimBody>;

export const stopPausedBody = z.object({
  reason: z.string().trim().min(1).max(20_000).optional(),
});
export type StopPausedBody = z.infer<typeof stopPausedBody>;

/**
 * BBT-001 bodies. POST /tickets/:id/testable sets the testing-lane eligibility
 * flag; POST /tickets/:id/test-contract records the testing handover; POST
 * /tickets/:id/tester records a tester verdict (pass/fail) from the dashboard.
 */
export const setTestableBody = z.object({
  can_be_tested: z.boolean(),
});
export type SetTestableBody = z.infer<typeof setTestableBody>;

export const setTestContractBody = z.object({
  changed_surfaces: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
  runtime_deps: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
  env_vars: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
  run_command: z.string().trim().max(2_000).default(""),
  harness_ready: z.boolean().default(false),
});
export type SetTestContractBody = z.infer<typeof setTestContractBody>;

export const testerVerdictBody = z.object({
  verdict: z.enum(["pass", "fail"]),
  summary: z.string().trim().min(1).max(20_000),
  uri: z.string().trim().min(1).max(2_000).optional(),
});
export type TesterVerdictBody = z.infer<typeof testerVerdictBody>;

/**
 * Body for POST /tickets/:id/reopen — pull a won't-do (cancelled) ticket back into
 * the pipeline. Defaults to `refining` (triage first); `draft` for a clean restart.
 */
export const reopenWontDoBody = z.object({
  to: z.enum(["refining", "draft"]).default("refining"),
});
export type ReopenWontDoBody = z.infer<typeof reopenWontDoBody>;

/**
 * Body for POST /tickets/:id/move — a human/admin board move (drag a card to a
 * status column, or pick from the card's status menu). `to` is the target
 * ticket status; the board's "in_progress" column maps to the `in_progress`
 * status. The schema only constrains `to` to a known status — whether the move
 * is *legal* (the state machine + policy gates) is decided in the facade, so an
 * illegal drop comes back as ILLEGAL_TRANSITION rather than a 422.
 */
export const moveTicketBody = z.object({
  to: z.enum(TICKET_STATUSES),
});
export type MoveTicketBody = z.infer<typeof moveTicketBody>;

/**
 * Body for POST /tickets/:id/delivery-artifact. At least one of
 * `branch_name`/`pr_url` is required; this is the human/admin (tokenless) path.
 */
export const recordDeliveryArtifactBody = z
  .object({
    branch_name: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .regex(GIT_REF_SAFE, GIT_REF_SAFE_MESSAGE)
      .optional(),
    pr_url: z.string().trim().min(1).max(2_000).refine(PR_URL_SAFE, PR_URL_SAFE_MESSAGE).optional(),
    commit: z.string().trim().min(1).max(200).optional(),
    diff_summary: z.string().trim().min(1).max(20_000).optional(),
  })
  .refine((v) => v.branch_name !== undefined || v.pr_url !== undefined, {
    message: "At least one of branch_name or pr_url is required.",
  });
export type RecordDeliveryArtifactBody = z.infer<typeof recordDeliveryArtifactBody>;

/**
 * Body for POST /tickets/:id/reopen-for-review — the auto-merge re-approval
 * callback (`done -> in_review`). `reason` is a short why; `resolution` is the
 * resolver agent's summary of what was reconciled on the delivery branch. Both
 * are recorded so the reviewer sees them alongside the resolved diff.
 */
export const reopenForReviewBody = z.object({
  reason: z.string().trim().min(1).max(2_000),
  resolution: z.string().trim().min(1).max(20_000),
});
export type ReopenForReviewBody = z.infer<typeof reopenForReviewBody>;

/** Body for PUT /tickets/:id/required-capabilities — replaces the full set. */
export const setRequiredCapabilitiesBody = z.object({
  capabilities: z.array(z.string().trim().min(1).max(100)).max(100),
});
export type SetRequiredCapabilitiesBody = z.infer<typeof setRequiredCapabilitiesBody>;

/** Body for PUT /tickets/:id/reviewer — assigns the ticket reviewer. */
export const assignReviewerBody = z.object({
  reviewer: z.string().trim().min(1).max(200),
});
export type AssignReviewerBody = z.infer<typeof assignReviewerBody>;

export const createDecisionBody = z.object({
  title: z.string().trim().min(1).max(300),
  question: z.string().trim().min(1).max(20_000),
  severity: z
    .enum([
      "log_only",
      "agent_can_choose",
      "human_preferred",
      "human_required",
      "security_required",
    ])
    .optional(),
  ticket_id: z.string().min(1).optional(),
});
export type CreateDecisionBody = z.infer<typeof createDecisionBody>;

export const resolveDecisionBody = z.object({
  status: z.enum(["accepted", "rejected"]),
  answer: z.string().max(20_000).optional(),
  rationale: z.string().max(20_000).optional(),
});
export type ResolveDecisionBody = z.infer<typeof resolveDecisionBody>;

/** Query-string filters for GET /tickets. */
export const ticketListQuery = z.object({
  status: z.enum(TICKET_STATUSES).optional(),
  repo: z.string().min(1).optional(),
  risk: z.enum(RISK_LEVELS).optional(),
});
export type TicketListQuery = z.infer<typeof ticketListQuery>;

/** Largest activity page a single request may return. */
export const ACTIVITY_MAX_LIMIT = 200;
/** Default activity page size when none is supplied. */
export const ACTIVITY_DEFAULT_LIMIT = 50;

/**
 * Query-string parameters for GET /api/activity. `limit` is clamped to
 * [1, ACTIVITY_MAX_LIMIT]; `offset` is a non-negative row skip. Coerced from
 * strings because they arrive as query params.
 */
// --- Factory Map scope graph (FG-001 + FG-002) -----------------------------

const scopeTags = z.array(z.string().trim().min(1).max(100)).max(100);
const scopeReasons = z.array(z.string().trim().min(1).max(2_000)).max(50);

// eslint-disable-next-line no-control-regex -- explicit control-byte guard (NUL/newline/etc.).
const NO_CONTROL_CHARS = (v: string): boolean => !/[\x00-\x1f]/.test(v);
const NO_CONTROL_CHARS_MESSAGE = "must not contain control characters (NUL, newline, etc.)";

/** Body for POST /scope/nodes. */
export const createScopeNodeBody = z.object({
  name: z.string().trim().min(1).max(200).refine(NO_CONTROL_CHARS, NO_CONTROL_CHARS_MESSAGE),
  type: z.enum(SCOPE_NODE_TYPES),
  description: z.string().max(20_000).refine(NO_CONTROL_CHARS, NO_CONTROL_CHARS_MESSAGE).optional(),
  risk_level: z.enum(RISK_LEVELS).optional(),
  owner: z.string().max(200).refine(NO_CONTROL_CHARS, NO_CONTROL_CHARS_MESSAGE).optional(),
  tags: scopeTags.optional(),
  lore_tags: scopeTags.optional(),
});
export type CreateScopeNodeBody = z.infer<typeof createScopeNodeBody>;

/** Body for PATCH /scope/nodes/:id. */
export const updateScopeNodeBody = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine(NO_CONTROL_CHARS, NO_CONTROL_CHARS_MESSAGE)
    .optional(),
  type: z.enum(SCOPE_NODE_TYPES).optional(),
  description: z.string().max(20_000).refine(NO_CONTROL_CHARS, NO_CONTROL_CHARS_MESSAGE).optional(),
  risk_level: z.enum(RISK_LEVELS).optional(),
  owner: z.string().max(200).refine(NO_CONTROL_CHARS, NO_CONTROL_CHARS_MESSAGE).optional(),
  tags: scopeTags.optional(),
  lore_tags: scopeTags.optional(),
});
export type UpdateScopeNodeBody = z.infer<typeof updateScopeNodeBody>;

/** Body for POST /scope/edges. `advanced` unlocks relations beyond the v1 set. */
export const createScopeEdgeBody = z.object({
  from_node_id: z.string().min(1),
  to_node_id: z.string().min(1),
  relation: z.enum(SCOPE_EDGE_RELATIONS),
  confidence: z.number().min(0).max(1).optional(),
  reasons: scopeReasons.optional(),
  advanced: z.boolean().optional(),
});
export type CreateScopeEdgeBody = z.infer<typeof createScopeEdgeBody>;

/** Body for POST /scope/repos — create a scope↔repo association. */
export const createScopeRepoBody = z.object({
  scope_node_id: z.string().min(1),
  repo_id: z.string().min(1),
  relation: z.enum(SCOPE_REPO_RELATIONS).optional(),
  default_access: z.enum(SCOPE_REPO_ACCESS).optional(),
  confidence: z.number().min(0).max(1).optional(),
  role_description: z.string().max(2_000).optional(),
  reasons: scopeReasons.optional(),
});
export type CreateScopeRepoBody = z.infer<typeof createScopeRepoBody>;

/** Body for PATCH /scope/repos/:id — patch a scope↔repo association. */
export const updateScopeRepoBody = z.object({
  default_access: z.enum(SCOPE_REPO_ACCESS).optional(),
  confidence: z.number().min(0).max(1).optional(),
  role_description: z.string().max(2_000).optional(),
  reasons: scopeReasons.optional(),
});
export type UpdateScopeRepoBody = z.infer<typeof updateScopeRepoBody>;

// --- Ticket scope links (WG-001) -------------------------------------------

/** Body for POST /tickets/:id/scopes — link a scope node to the ticket. */
export const linkTicketScopeBody = z.object({
  scope_node_id: z.string().min(1),
  relation: z.enum(TICKET_SCOPE_RELATIONS).optional(),
  confidence: z.number().min(0).max(1).optional(),
  reasons: scopeReasons.optional(),
});
export type LinkTicketScopeBody = z.infer<typeof linkTicketScopeBody>;

/** Body for PUT /tickets/:id/primary-scope — mark a scope node primary. */
export const setPrimaryScopeBody = z.object({
  scope_node_id: z.string().min(1),
});
export type SetPrimaryScopeBody = z.infer<typeof setPrimaryScopeBody>;

// --- Ticket↔repo access boundaries (WG-002) --------------------------------

/** Body for PUT /tickets/:id/repo-access — set a repo's access boundary. */
export const setTicketRepoAccessBody = z.object({
  repo_id: z.string().min(1),
  access: z.enum(TICKET_REPO_ACCESS).optional(),
  relation: z.enum(TICKET_REPO_RELATIONS).optional(),
  source: z.enum(TICKET_REPO_SOURCES).optional(),
  confidence: z.number().min(0).max(1).optional(),
  reasons: scopeReasons.optional(),
});
export type SetTicketRepoAccessBody = z.infer<typeof setTicketRepoAccessBody>;

// --- Per-repo delivery artifacts (WG-005) ----------------------------------

/** Body for POST /tickets/:id/repo-deliveries — record one repo's delivery. */
export const recordRepoDeliveryBody = z.object({
  repo_id: z.string().min(1),
  branch_name: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .regex(GIT_REF_SAFE, GIT_REF_SAFE_MESSAGE)
    .optional(),
  commit_sha: z.string().trim().min(1).max(200).optional(),
  pr_url: z.string().trim().min(1).max(2_000).refine(PR_URL_SAFE, PR_URL_SAFE_MESSAGE).optional(),
  status: z.enum(TICKET_REPO_DELIVERY_STATUSES).optional(),
  evidence_ref: z.string().trim().min(1).max(2_000).optional(),
});
export type RecordRepoDeliveryBody = z.infer<typeof recordRepoDeliveryBody>;

// --- Scope→repo suggestions (FG-005) ---------------------------------------

/**
 * Body for POST /scope/repo-suggestions — pre-create suggestions for a draft that
 * does not exist as a ticket yet. Every field is optional; an empty body yields
 * an empty (advisory) suggestion list.
 */
export const suggestReposBody = z.object({
  title: z.string().max(300).optional(),
  description: z.string().max(20_000).optional(),
  scopeNodeIds: z.array(z.string().min(1)).max(100).optional(),
  repoIds: z.array(z.string().min(1)).max(100).optional(),
});
export type SuggestReposBody = z.infer<typeof suggestReposBody>;

// --- Ticket dependencies (EP-001) ------------------------------------------

/** Body for POST /tickets/:id/dependencies — declare a "must finish first" edge. */
export const addTicketDependencyBody = z.object({
  depends_on: z.string().min(1),
});
export type AddTicketDependencyBody = z.infer<typeof addTicketDependencyBody>;

// --- Epics (EP-001) --------------------------------------------------------

/** One ticket within a POST /epics plan. `dependsOn` indexes other plan tickets. */
const epicTicketBody = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().max(20_000).optional(),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(2_000)).max(50).optional(),
  priority: z.number().int().min(0).max(1_000).optional(),
  risk_level: z.enum(RISK_LEVELS).optional(),
  policy_pack: z.enum(["solo_loose", "team_light", "factory_strict", "regulated"]).optional(),
  repo: z.string().min(1).max(200).optional(),
  access: z.enum(TICKET_REPO_ACCESS).optional(),
  bootstrap: z.boolean().optional(),
  dependsOn: z.array(z.number().int().nonnegative()).max(100).optional(),
});

/** Body for POST /epics — the create_epic plan (epic node + dependency-ordered tickets). */
export const createEpicBody = z.object({
  epic: z.object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(20_000).optional(),
  }),
  tickets: z.array(epicTicketBody).min(1).max(100),
});
export type CreateEpicBody = z.infer<typeof createEpicBody>;

// --- Specs (Spec-Driven Development, Phase 1a) -----------------------------

/** One clause in a POST /specs or PATCH /specs/:id body. `clause_id` is optional. */
const specClauseBody = z.object({
  clause_id: z.string().trim().min(1).max(100).optional(),
  kind: z.enum(SPEC_CLAUSE_KINDS),
  text: z.string().trim().min(1).max(4_000),
  rationale: z.string().trim().min(1).max(4_000).optional(),
});

/** Body for POST /specs — create a draft spec. */
export const createSpecBody = z.object({
  title: z.string().trim().min(1).max(300),
  brief: z.string().max(20_000).optional(),
  clauses: z.array(specClauseBody).max(200).optional(),
  target_repo: z.string().trim().min(1).max(200).nullable().optional(),
  scope_node_id: z.string().trim().min(1).max(200).nullable().optional(),
});
export type CreateSpecBody = z.infer<typeof createSpecBody>;

/** Body for PATCH /specs/:id — replace a draft spec's clauses. */
export const updateSpecClausesBody = z.object({
  clauses: z.array(specClauseBody).max(200),
});
export type UpdateSpecClausesBody = z.infer<typeof updateSpecClausesBody>;

/** Query for GET /specs — optional status filter. */
export const specListQuery = z.object({
  status: z.enum(SPEC_STATUSES).optional(),
});
export type SpecListQuery = z.infer<typeof specListQuery>;

// --- Plan a build (decompose chat panel) -----------------------------------

/** One accumulated conversation turn the frontend replays each request. */
const planBuildTurn = z.object({
  role: z.enum(["assistant", "user"]),
  questions: z.array(z.string().max(2_000)).max(50).optional(),
  answer: z.string().max(20_000).optional(),
});

/**
 * Extend-existing context: the target scope node / epic the panel is extending.
 * Passed to the decomposer so it proposes tickets that EXTEND the named target
 * rather than rebuild from scratch. `mode` records which start toggle the user
 * picked ("new" vs "extend"); the target fields identify what to extend.
 */
const planBuildContext = z.object({
  mode: z.enum(["new", "extend"]),
  scopeNodeId: z.string().trim().min(1).max(200).optional(),
  scopeNodeName: z.string().trim().min(1).max(200).optional(),
  scopeNodeType: z.string().trim().min(1).max(100).optional(),
  // Brownfield target repo NAME. On "extend" the panel derives the target repo
  // from the chosen scope node (or extend target) and forwards it so the
  // decomposer takes the existing-repo (brownfield) path rather than scaffolding
  // a new repo. Absent for greenfield "new" builds and when no repo is resolved.
  repo: z.string().trim().min(1).max(200).optional(),
});
export type PlanBuildContext = z.infer<typeof planBuildContext>;

/**
 * Body for POST /plan-build — a one-line brief plus the conversation history the
 * frontend accumulates. `history` is bounded (each turn is a real `claude -p`
 * cost downstream); the brief is required and length-capped. `context` is the
 * optional extend-existing target (absent for a greenfield "New app" build).
 * `forcePlan` is the "Build the tickets now" escape: when true, the decomposer is
 * told to STOP clarifying and emit the best plan it can from the brief + history
 * so far (it returns a plan, never a clarify). The panel can send it at any point.
 */
export const planBuildBody = z.object({
  brief: z.string().trim().min(1).max(4_000),
  history: z.array(planBuildTurn).max(40).optional().default([]),
  context: planBuildContext.optional(),
  forcePlan: z.boolean().optional(),
});
export type PlanBuildBody = z.infer<typeof planBuildBody>;

// --- Author a spec (spec-author chat step) ---------------------------------

/**
 * Body for POST /spec-build — a one-line brief plus the conversation history the
 * frontend accumulates, mirroring {@link planBuildBody}. Unlike plan-build,
 * `context` here is optional free-text grounding (e.g. "existing repo uses Vite +
 * React"), not a structured extend target. `forcePlan` is the "Draft the spec now"
 * escape: when true the spec-author STOPS clarifying and emits the best spec it can
 * (it returns a spec, never a clarify). The panel can send it at any point.
 */
export const specBuildBody = z.object({
  brief: z.string().trim().min(1).max(4_000),
  history: z.array(planBuildTurn).max(40).optional().default([]),
  context: z.string().trim().min(1).max(20_000).optional(),
  forcePlan: z.boolean().optional(),
});
export type SpecBuildBody = z.infer<typeof specBuildBody>;

// --- Settings panel (UI-editable factory config) ---------------------------

/**
 * Body for POST /api/settings — a flat map of `SETTING_KEY -> string value`.
 * Values are always strings (env vars are strings); the settings module owns the
 * allow-list (drops unknown keys) and env-lock enforcement (refuses env-locked
 * keys), so here we only shape the JSON: a flat object of bounded string values.
 * Booleans/ints arrive pre-coerced from the UI as "0"/"1"/"50" etc.
 */
export const settingsBody = z.object({
  settings: z
    .record(z.string().max(4_000))
    // Bound the key count so a single POST can't hand the write loop a
    // huge-cardinality object (unknown keys are dropped later, but the loop
    // still iterates every key on this single-threaded process).
    .refine((r) => Object.keys(r).length <= 100, { message: "Too many settings keys." })
    .default({}),
});
export type SettingsBody = z.infer<typeof settingsBody>;

// --- Plan sessions (H9 — durable async plan-build chat) --------------------

/**
 * Body for POST /plan-sessions/:id/turns — appends a user or assistant message
 * to the session's history and, for the first user turn, records the brief.
 *
 * `role` is required. `content` is the raw text (user turns) or the JSON-
 * serialised decompose-result envelope (assistant turns). `plan` is the raw
 * plan object when an assistant turn delivers a plan phase — stored server-side
 * so the panel can restore the proposal on reload. `brief` is forwarded by the
 * client on the first user turn only.
 */
export const planSessionTurnBody = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(100_000),
  brief: z.string().trim().min(1).max(4_000).optional(),
  plan: z.unknown().optional(),
});
export type PlanSessionTurnBody = z.infer<typeof planSessionTurnBody>;

/**
 * Body for POST /plan-sessions/:id/archive — transitions the session to
 * 'confirmed' (user approved the plan) or 'abandoned' (user started fresh).
 */
export const planSessionArchiveBody = z.object({
  status: z.enum(["confirmed", "abandoned"]),
});
export type PlanSessionArchiveBody = z.infer<typeof planSessionArchiveBody>;

/**
 * Query for GET /plan-sessions — optional status filter + limit cap.
 */
export const planSessionListQuery = z.object({
  status: z.enum(["active", "confirmed", "abandoned"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type PlanSessionListQuery = z.infer<typeof planSessionListQuery>;

/**
 * Body for PUT /api/idle-loops — the editable slice of each idle scan loop. Each
 * entry names a known idle loop (`key`), its enabled flag, and the repo NAMES it
 * is scoped to (an empty list = all repos). The module owns the real validation
 * (key allow-list + repo-name existence); here we only shape the JSON: a bounded
 * list of `{ key, enabled, repos }`, with repo names bounded so a single PUT
 * can't hand the write path an unbounded array.
 */
export const idleLoopsBody = z.object({
  loops: z
    .array(
      z.object({
        key: z.string().min(1).max(64),
        enabled: z.boolean(),
        repos: z.array(z.string().min(1).max(256)).max(200).default([]),
      }),
    )
    // At most the known idle-loop count plus a little slack; the module rejects
    // unknown/duplicate keys, this just bounds the array the loop iterates.
    .max(32)
    .default([]),
});
export type IdleLoopsBody = z.infer<typeof idleLoopsBody>;

export const activityQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(ACTIVITY_MAX_LIMIT)
    .catch(ACTIVITY_DEFAULT_LIMIT)
    .default(ACTIVITY_DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).catch(0).default(0),
});
export type ActivityQuery = z.infer<typeof activityQuery>;

/** Default + max for the most-recent-runs list on GET /api/runs. */
export const RUNS_DEFAULT_LIMIT = 20;
export const RUNS_MAX_LIMIT = 100;

/**
 * Query for GET /api/runs. `active=1` ⇒ only the in-flight runs (the "Running
 * now" panel's primary feed); `limit` bounds the recent list returned alongside.
 * Both are best-effort coerced (`.catch`) so a junk query never 422s a read.
 */
export const runsQuery = z.object({
  active: z.coerce.boolean().catch(false).default(false),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(RUNS_MAX_LIMIT)
    .catch(RUNS_DEFAULT_LIMIT)
    .default(RUNS_DEFAULT_LIMIT),
});
export type RunsQuery = z.infer<typeof runsQuery>;

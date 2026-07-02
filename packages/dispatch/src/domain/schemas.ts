import { z } from "zod";

import {
  EVIDENCE_TYPES,
  POLICY_PACKS,
  RISK_LEVELS,
  SCOPE_EDGE_RELATIONS,
  SCOPE_NODE_TYPES,
  SCOPE_REPO_ACCESS,
  SCOPE_REPO_RELATIONS,
  SPEC_CLAUSE_KINDS,
  TICKET_REPO_ACCESS,
  TICKET_REPO_RELATIONS,
  TICKET_REPO_DELIVERY_STATUSES,
  TICKET_REPO_SOURCES,
  TICKET_SCOPE_RELATIONS,
} from "./types.js";

/** Zod input schemas — validate at the CLI/MCP boundary before touching the DB. */

/**
 * A reusable refine that enforces `http://` or `https://` on any pr_url string.
 * `javascript:`, `data:`, and other schemes that could run code in a browser
 * rendering the URL are explicitly rejected. Apply to every pr_url field across
 * the API, domain, and MCP boundaries.
 */
export const PR_URL_SAFE = (v: string): boolean => /^https?:\/\//i.test(v);
export const PR_URL_SAFE_MESSAGE = "pr_url must start with http:// or https://";

/**
 * Git-ref-safe pattern for any value handed to git as a positional ref/branch
 * argument downstream (P1-A: git option-injection). Rejects a LEADING `-` (so a
 * value like `--upload-pack=…`, `--output=x`, or a bare `-` can never be
 * option-parsed by git), any `..` (ref-range / traversal), and whitespace /
 * control chars; allows only `[A-Za-z0-9._/-]`. Length is bounded here too, but
 * each call site keeps its own `.max(...)` to preserve its column intent.
 *
 * NOTE: this is intentionally stricter than git's own check-ref-format — it is a
 * boundary allow-list, not a parser. Real branch names like `gaffer/ticket-12-x`
 * and `main` pass; anything that could be mistaken for a git option does not.
 */
export const GIT_REF_SAFE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;

/** Human-facing message for a {@link GIT_REF_SAFE} violation. */
export const GIT_REF_SAFE_MESSAGE =
  "must be a git-ref-safe name: only letters, digits, '.', '_', '/', '-', " +
  "no leading '-', no '..', no whitespace or control characters";

export const createTicketInput = z.object({
  title: z.string().trim().min(1, "title is required").max(300),
  description: z.string().max(20_000).default(""),
  priority: z.number().int().min(0).max(1_000).default(0),
  risk_level: z.enum(RISK_LEVELS).default("medium"),
  policy_pack: z.enum(POLICY_PACKS).default("solo_loose"),
  source: z.string().max(200).optional(),
  created_by: z.string().max(200).optional(),
  /** EP-001 greenfield marker — true ⇒ a bootstrap (create-a-repo) ticket. */
  bootstrap: z.boolean().default(false),
  /**
   * TRACK-3a: optional per-ticket delivery-budget ceiling in USD. A positive figure
   * caps this ticket's cumulative measured delivery spend; omitted/null ⇒ the
   * factory-wide env budget applies.
   */
  delivery_budget_usd: z.number().positive().nullable().optional(),
});
export type CreateTicketInput = z.infer<typeof createTicketInput>;

/** TRACK-3a: set or clear a ticket's per-ticket delivery-budget ceiling. */
export const setTicketBudgetInput = z.object({
  ticket: z.union([z.number().int().positive(), z.string().min(1)]),
  /** A positive USD ceiling, or null to clear the per-ticket budget. */
  delivery_budget_usd: z.number().positive().nullable(),
});
export type SetTicketBudgetInput = z.infer<typeof setTicketBudgetInput>;

export const addAcInput = z.object({
  ticket_id: z.string().min(1),
  text: z.string().trim().min(1, "AC text is required").max(2_000),
  verification_method: z.string().max(500).optional(),
  evidence_required: z.boolean().default(false),
});
export type AddAcInput = z.infer<typeof addAcInput>;

export const registerRepoInput = z.object({
  name: z.string().trim().min(1).max(200),
  local_path: z.string().max(2_000).optional(),
  remote_url: z.string().max(2_000).optional(),
  default_branch: z.string().max(200).regex(GIT_REF_SAFE, GIT_REF_SAFE_MESSAGE).default("main"),
  stack: z.string().max(500).optional(),
  risk_level: z.enum(RISK_LEVELS).default("medium"),
  test_command: z.string().max(1_000).optional(),
  lint_command: z.string().max(1_000).optional(),
  coverage_command: z.string().max(1_000).optional(),
});
export type RegisterRepoInput = z.infer<typeof registerRepoInput>;

export const registerAgentInput = z.object({
  display_name: z.string().max(200).optional(),
  agent_type: z.string().max(100).default("coding_agent"),
  model: z.string().max(200).optional(),
  runtime: z.string().max(200).optional(),
  host: z.string().max(200).optional(),
  max_risk: z.enum(RISK_LEVELS).default("medium"),
  capabilities: z.array(z.string().min(1)).default([]),
  created_by: z.string().max(200).optional(),
});
export type RegisterAgentInput = z.infer<typeof registerAgentInput>;

export const recordEvidenceInput = z.object({
  ticket_id: z.string().min(1),
  ac_id: z.string().min(1).optional(),
  repo_id: z.string().min(1).optional(),
  evidence_type: z.enum(EVIDENCE_TYPES),
  summary: z.string().trim().min(1).max(5_000),
  uri: z.string().max(2_000).optional(),
  payload: z.unknown().optional(),
});
export type RecordEvidenceInput = z.infer<typeof recordEvidenceInput>;

/**
 * Where a ticket's work was delivered. At least one of `branch_name`/`pr_url`
 * must be present so the record carries a real location; commit + diff_summary
 * are optional extras recorded on the event payload.
 */
export const recordDeliveryArtifactInput = z
  .object({
    ticket_id: z.string().min(1),
    claim_token: z.string().min(1).optional(),
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
export type RecordDeliveryArtifactInput = z.infer<typeof recordDeliveryArtifactInput>;

/** Claim a specific, chosen ticket (by id or number) rather than the next ready one. */
export const claimTicketInput = z.object({
  ticket_id: z.string().min(1),
  agent_id: z.string().min(1),
  ttl_seconds: z.number().int().positive(),
  capabilities: z.array(z.string().min(1)).optional(),
});
export type ClaimTicketInput = z.infer<typeof claimTicketInput>;

/** Set (replace) the capabilities a ticket requires of a claiming agent. */
export const setRequiredCapabilitiesInput = z.object({
  ticket_id: z.string().min(1),
  capabilities: z.array(z.string().trim().min(1).max(100)),
});
export type SetRequiredCapabilitiesInput = z.infer<typeof setRequiredCapabilitiesInput>;

// --- Factory Map scope graph (FG-001 + FG-002) -----------------------------

const tags = z.array(z.string().trim().min(1).max(100)).max(100);
const reasons = z.array(z.string().trim().min(1).max(2_000)).max(50);

// eslint-disable-next-line no-control-regex -- explicit control-byte guard (NUL/newline/etc.).
const NO_CONTROL_CHARS = (v: string): boolean => !/[\x00-\x1f]/.test(v);
const NO_CONTROL_CHARS_MESSAGE = "must not contain control characters (NUL, newline, etc.)";

/** Create a scope node. `type` is validated against the node-type enum. */
export const createScopeNodeInput = z.object({
  name: z
    .string()
    .trim()
    .min(1, "scope node name is required")
    .max(200)
    .refine(NO_CONTROL_CHARS, NO_CONTROL_CHARS_MESSAGE),
  type: z.enum(SCOPE_NODE_TYPES),
  description: z.string().max(20_000).refine(NO_CONTROL_CHARS, NO_CONTROL_CHARS_MESSAGE).optional(),
  risk_level: z.enum(RISK_LEVELS).default("medium"),
  owner: z.string().max(200).refine(NO_CONTROL_CHARS, NO_CONTROL_CHARS_MESSAGE).optional(),
  tags: tags.optional(),
  lore_tags: tags.optional(),
});
export type CreateScopeNodeInput = z.infer<typeof createScopeNodeInput>;

/** Patch a scope node. Every field is optional; only present keys are written. */
export const updateScopeNodeInput = z.object({
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
  tags: tags.optional(),
  lore_tags: tags.optional(),
});
export type UpdateScopeNodeInput = z.infer<typeof updateScopeNodeInput>;

/**
 * Create a graph edge. `advanced: true` is required to use any relation beyond
 * the v1 set (contains / depends_on); the facade enforces that gate.
 */
export const createScopeEdgeInput = z.object({
  from_node_id: z.string().min(1),
  to_node_id: z.string().min(1),
  relation: z.enum(SCOPE_EDGE_RELATIONS),
  confidence: z.number().min(0).max(1).optional(),
  reasons: reasons.optional(),
  advanced: z.boolean().default(false),
});
export type CreateScopeEdgeInput = z.infer<typeof createScopeEdgeInput>;

/** Link a repo into a scope node with a relation + default access. */
export const linkScopeRepoInput = z.object({
  scope_node_id: z.string().min(1),
  repo_id: z.string().min(1),
  relation: z.enum(SCOPE_REPO_RELATIONS).default("uses"),
  default_access: z.enum(SCOPE_REPO_ACCESS).default("read"),
  confidence: z.number().min(0).max(1).optional(),
  role_description: z.string().max(2_000).optional(),
  reasons: reasons.optional(),
});
export type LinkScopeRepoInput = z.infer<typeof linkScopeRepoInput>;

/** Patch an existing scope→repo association (by its id). */
export const updateScopeRepoInput = z.object({
  default_access: z.enum(SCOPE_REPO_ACCESS).optional(),
  confidence: z.number().min(0).max(1).optional(),
  role_description: z.string().max(2_000).optional(),
  reasons: reasons.optional(),
});
export type UpdateScopeRepoInput = z.infer<typeof updateScopeRepoInput>;

// --- Ticket scope links (WG-001) -------------------------------------------

/** Link a ticket to a scope node with a relation (+ optional confidence/reasons). */
export const linkTicketScopeInput = z.object({
  ticket_id: z.string().min(1),
  scope_node_id: z.string().min(1),
  relation: z.enum(TICKET_SCOPE_RELATIONS).default("secondary"),
  confidence: z.number().min(0).max(1).optional(),
  reasons: reasons.optional(),
});
export type LinkTicketScopeInput = z.infer<typeof linkTicketScopeInput>;

// --- Ticket↔repo access boundaries (WG-002) --------------------------------

/**
 * Set the explicit access boundary for a ticket↔repo link. Creates the link if
 * absent (upsert). `repo_id` accepts a repo id or name. The facade rejects
 * `relation:'implicit_single_repo'` via this manual path — that relation is
 * reserved for the mono_fallback auto-link.
 */
export const setTicketRepoAccessInput = z.object({
  ticket_id: z.string().min(1),
  repo_id: z.string().min(1),
  access: z.enum(TICKET_REPO_ACCESS).default("write"),
  relation: z.enum(TICKET_REPO_RELATIONS).default("confirmed"),
  source: z.enum(TICKET_REPO_SOURCES).default("manual"),
  confidence: z.number().min(0).max(1).optional(),
  reasons: reasons.optional(),
});
export type SetTicketRepoAccessInput = z.infer<typeof setTicketRepoAccessInput>;

// --- Per-repo delivery artifacts (WG-005) ----------------------------------

/**
 * Upsert a per-(ticket,repo) delivery artifact. `repo_id` accepts a repo id or
 * name. The repo MUST already be linked to the ticket via ticket_repos — the
 * facade rejects deliveries for an unlinked repo. Every field beyond the keys is
 * optional so a caller can record an early `branch_created` row and enrich it
 * (commit/pr/status/evidence) on later calls.
 */
export const recordRepoDeliveryInput = z.object({
  ticket_id: z.string().min(1),
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
export type RecordRepoDeliveryInput = z.infer<typeof recordRepoDeliveryInput>;

// --- Black-box testing handover (BBT-001) ----------------------------------

/**
 * Record (replace) a ticket's test_contract — the testing handover the
 * independent tester reads to stand the system up and probe the changed boundary
 * surfaces WITHOUT the implementation diff. Every list defaults to empty and
 * `harness_ready` defaults to false, so a minimal contract (just a run_command) is
 * valid; the lists are bounded to keep a single contract small.
 */
export const setTestContractInput = z.object({
  changed_surfaces: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
  runtime_deps: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
  env_vars: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
  run_command: z.string().trim().max(2_000).default(""),
  harness_ready: z.boolean().default(false),
});
export type SetTestContractInput = z.infer<typeof setTestContractInput>;

// --- Scope→repo suggestions (FG-005) ---------------------------------------

/**
 * Pre-create suggestion request: title/description/scopeNodeIds describing a
 * draft that does not exist as a ticket yet, plus optional repoIds the PO has
 * already selected (for the mono-fallback single-unmapped-repo case). Every field
 * is optional so an empty body yields an empty (advisory) suggestion list.
 */
export const suggestReposInput = z.object({
  title: z.string().max(300).optional(),
  description: z.string().max(20_000).optional(),
  scopeNodeIds: z.array(z.string().min(1)).max(100).optional(),
  repoIds: z.array(z.string().min(1)).max(100).optional(),
});
export type SuggestReposInput = z.infer<typeof suggestReposInput>;

// --- Ticket dependencies (EP-001) ------------------------------------------

/**
 * Declare a "must finish first" dependency: `ticket` cannot be claimed until
 * `depends_on` is `done`. Both accept a ticket id or #number (resolved by the
 * facade). The facade rejects a self-dependency and any edge that would close a
 * cycle.
 */
export const addDependencyInput = z.object({
  ticket: z.string().min(1),
  depends_on: z.string().min(1),
});
export type AddDependencyInput = z.infer<typeof addDependencyInput>;

// --- Epics (EP-001) --------------------------------------------------------

/** Maximum tickets a single create_epic call may create (bounded guardrail). */
export const MAX_EPIC_TICKETS = 100;

/**
 * One ticket within an epic plan. `dependsOn` references OTHER tickets in the
 * SAME `tickets[]` array by their zero-based index, so a self-contained,
 * dependency-ordered plan can be created in a single call (the facade resolves
 * the indexes to the created ticket ids). `repo` optionally links the ticket to
 * a registered repo with an access boundary; `bootstrap` marks a greenfield
 * ticket. Tickets are always created as `draft`.
 */
export const epicTicketInput = z.object({
  title: z.string().trim().min(1, "ticket title is required").max(300),
  description: z.string().max(20_000).default(""),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(2_000)).max(50).default([]),
  priority: z.number().int().min(0).max(1_000).optional(),
  risk_level: z.enum(RISK_LEVELS).optional(),
  policy_pack: z.enum(POLICY_PACKS).optional(),
  repo: z.string().min(1).max(200).optional(),
  access: z.enum(TICKET_REPO_ACCESS).optional(),
  bootstrap: z.boolean().optional(),
  /** TRACK-3a: per-ticket delivery budget; overrides the epic-level default below. */
  delivery_budget_usd: z.number().positive().nullable().optional(),
  dependsOn: z.array(z.number().int().nonnegative()).max(MAX_EPIC_TICKETS).default([]),
});
export type EpicTicketInput = z.infer<typeof epicTicketInput>;

/**
 * Create an epic atomically: a scope node of type `epic` that `contains` N
 * tickets (with ACs, per-ticket priority/repo/access, optional bootstrap marker)
 * plus the dependency edges declared by index. Returns the epic node id and the
 * created ticket numbers (in plan order).
 */
export const createEpicInput = z.object({
  epic: z.object({
    name: z.string().trim().min(1, "epic name is required").max(200),
    description: z.string().max(20_000).optional(),
    /**
     * TRACK-3a: a per-EPIC delivery budget in USD. When set, it is stamped onto each
     * child ticket that doesn't declare its own `delivery_budget_usd` — the per-epic
     * budget is inherited by its tickets (each ticket then carries + enforces it).
     */
    delivery_budget_usd: z.number().positive().nullable().optional(),
  }),
  tickets: z
    .array(epicTicketInput)
    .min(1, "an epic needs at least one ticket")
    .max(MAX_EPIC_TICKETS),
});
export type CreateEpicInput = z.infer<typeof createEpicInput>;

// --- Specs (Spec-Driven Development, Phase 1a) -----------------------------

/** Maximum clauses a single spec may carry (bounded guardrail). */
export const MAX_SPEC_CLAUSES = 200;

/**
 * One clause of a spec: a single testable statement, tagged with its `kind`.
 * `clause_id` is OPTIONAL on input — the service generates a stable id when it is
 * absent (and preserves a supplied one), so Phase 3 traceability always has a
 * stable reference.
 */
export const specClauseInput = z.object({
  clause_id: z.string().trim().min(1).max(100).optional(),
  kind: z.enum(SPEC_CLAUSE_KINDS),
  text: z.string().trim().min(1, "clause text is required").max(4_000),
  rationale: z.string().trim().min(1).max(4_000).optional(),
});
export type SpecClauseInput = z.infer<typeof specClauseInput>;

/**
 * Create a spec (always `draft`). `title` is required; `clauses` may be empty at
 * create time (a spec is drafted then filled in). `target_repo`/`scope_node_id`
 * are optional soft references to where the work will land.
 */
export const createSpecInput = z.object({
  title: z.string().trim().min(1, "spec title is required").max(300),
  brief: z.string().max(20_000).default(""),
  clauses: z.array(specClauseInput).max(MAX_SPEC_CLAUSES).default([]),
  target_repo: z.string().trim().min(1).max(200).nullable().optional(),
  scope_node_id: z.string().trim().min(1).max(200).nullable().optional(),
});
export type CreateSpecInput = z.infer<typeof createSpecInput>;

/**
 * Replace a draft spec's clauses. The service rejects this on a non-draft (frozen
 * or superseded) spec — a frozen spec is immutable.
 */
export const updateSpecClausesInput = z.object({
  clauses: z.array(specClauseInput).max(MAX_SPEC_CLAUSES),
});
export type UpdateSpecClausesInput = z.infer<typeof updateSpecClausesInput>;

/** Domain enums + row shapes. Unions mirror the schema CHECK constraints. */

export const TICKET_STATUSES = [
  "draft",
  "refining",
  "ready",
  "claimed",
  "in_progress",
  "blocked",
  "in_review",
  // Approved-and-merging: the human has approved the review, the merge runner is
  // doing the git merge. The ticket sits here until the runner confirms the merge
  // landed (`ready_for_merge -> done` via the guarded mark-merged path), so `done`
  // means ACTUALLY merged — not merely "approved but the merge may have failed".
  "ready_for_merge",
  "done",
  "failed",
  "cancelled",
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** Ordinal rank of a risk level; higher means riskier. Used for `ticket.risk <= agent.max_risk`. */
export function riskRank(level: RiskLevel): number {
  return RISK_LEVELS.indexOf(level);
}

export const POLICY_PACKS = ["solo_loose", "team_light", "factory_strict", "regulated"] as const;
export type PolicyPack = (typeof POLICY_PACKS)[number];

export const AC_STATUSES = ["pending", "satisfied", "failed", "waived"] as const;
export type AcStatus = (typeof AC_STATUSES)[number];

export const DECISION_STATUSES = [
  "requested",
  "agent_proposed",
  "human_required",
  "accepted",
  "rejected",
  "superseded",
] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export const DECISION_SEVERITIES = [
  "log_only",
  "agent_can_choose",
  "human_preferred",
  "human_required",
  "security_required",
] as const;
export type DecisionSeverity = (typeof DECISION_SEVERITIES)[number];

export const CLAIM_STATUSES = ["active", "released", "expired", "revoked", "completed"] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export const EVIDENCE_TYPES = [
  "test_output",
  "coverage_report",
  "commit",
  "branch",
  "pull_request",
  "diff_summary",
  "screenshot",
  "log",
  "manual_note",
  "ci_run",
  "static_analysis",
  "lore_record",
] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export const ACTOR_TYPES = ["human", "agent", "admin", "system"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export interface Actor {
  readonly type: ActorType;
  readonly id?: string;
}

export interface Ticket {
  id: string;
  number: number | null;
  title: string;
  description: string;
  status: TicketStatus;
  priority: number;
  risk_level: RiskLevel;
  policy_pack: PolicyPack;
  source: string | null;
  created_by: string | null;
  reviewer: string | null;
  branch_name: string | null;
  pr_url: string | null;
  attempt_count: number;
  row_version: number;
  scheduled_after: string | null;
  due_at: string | null;
  /**
   * Greenfield marker (EP-001). 1 ⇒ a "bootstrap" ticket: no repo to branch yet;
   * the runner uses create-a-repo mode and a scoped install allowance applies.
   * Persisted as INTEGER (0/1) to match the SQLite boolean convention.
   */
  bootstrap: number;
  /**
   * Latest review-rejection feedback (WG-049), stored as a JSON-encoded
   * {@link ReviewFeedback} or `null` when there is no outstanding rejection. Set
   * when a reviewer rejects the ticket, cleared when it re-enters `in_review`.
   * Parse with {@link parseReviewFeedback} before surfacing it.
   */
  last_review_feedback: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * The reviewer's latest rejection feedback surfaced to the re-claiming agent and
 * the board (WG-049): why the delivery was sent back, who rejected it, and when.
 */
export interface ReviewFeedback {
  reason: string;
  reviewer: string | null;
  at: string;
}

/**
 * Parse the `tickets.last_review_feedback` JSON column into a {@link ReviewFeedback}.
 * Returns `null` for an absent or malformed value so a corrupt row can never throw
 * on a read path.
 */
export function parseReviewFeedback(raw: string | null): ReviewFeedback | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ReviewFeedback>;
    if (typeof parsed.reason !== "string" || typeof parsed.at !== "string") return null;
    return {
      reason: parsed.reason,
      reviewer: typeof parsed.reviewer === "string" ? parsed.reviewer : null,
      at: parsed.at,
    };
  } catch {
    return null;
  }
}

export interface AcceptanceCriterion {
  id: string;
  ticket_id: string;
  text: string;
  sort_order: number;
  status: AcStatus;
  verification_method: string | null;
  evidence_required: number;
  verified_by: string | null;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Repository {
  id: string;
  name: string;
  local_path: string | null;
  remote_url: string | null;
  default_branch: string;
  stack: string | null;
  risk_level: RiskLevel;
  test_command: string | null;
  lint_command: string | null;
  coverage_command: string | null;
  /**
   * WG-006: 1 ⇒ the repo is hidden from the dashboard's default surfaces (repo
   * list, Factory Map unmapped repos, repo pickers) but stays registered and
   * reachable via the "Hidden repos" page. 0 ⇒ visible. Reversible.
   */
  hidden: number;
  created_at: string;
  updated_at: string;
}

export interface Decision {
  id: string;
  title: string;
  question: string;
  rationale: string | null;
  status: DecisionStatus;
  decision_type: string;
  severity: DecisionSeverity;
  proposed_answer: string | null;
  proposed_by: string | null;
  confidence: string | null;
  resolved_answer: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  memory_record_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Agent {
  id: string;
  display_name: string | null;
  agent_type: string;
  model: string | null;
  runtime: string | null;
  host: string | null;
  max_risk: RiskLevel;
  status: "active" | "paused" | "disabled";
  created_by: string | null;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TicketClaim {
  id: string;
  ticket_id: string;
  agent_id: string;
  claim_token_hash: string;
  status: ClaimStatus;
  expires_at: string;
  heartbeat_at: string;
  created_at: string;
  released_at: string | null;
}

export interface Evidence {
  id: string;
  ticket_id: string;
  ac_id: string | null;
  repo_id: string | null;
  decision_id: string | null;
  evidence_type: EvidenceType;
  summary: string;
  uri: string | null;
  payload_json: string | null;
  created_by: string;
  created_at: string;
}

export interface WorkEvent {
  id: string;
  entity_type: string;
  entity_id: string;
  actor_type: ActorType;
  actor_id: string | null;
  event_type: string;
  payload_json: string | null;
  correlation_id: string | null;
  created_at: string;
}

// --- Factory Map scope graph (FG-001 + FG-002) -----------------------------

/**
 * Product/system node types. Mirrors the scope_nodes CHECK constraint.
 * `epic` (EP-001) is a delivery-grouping node: it `contains` a cohort of tickets
 * created together by {@link createEpic}; it is not a long-lived product area.
 */
export const SCOPE_NODE_TYPES = [
  "factory",
  "domain",
  "product",
  "capability",
  "system",
  "service",
  "library",
  "external_dependency",
  "epic",
] as const;
export type ScopeNodeType = (typeof SCOPE_NODE_TYPES)[number];

/** Graph relations between scope nodes. Mirrors the scope_edges CHECK. */
export const SCOPE_EDGE_RELATIONS = [
  "contains",
  "depends_on",
  "calls",
  "publishes_to",
  "consumes_from",
  "shares_library",
  "deployed_with",
] as const;
export type ScopeEdgeRelation = (typeof SCOPE_EDGE_RELATIONS)[number];

/**
 * Edge relations exposed by the v1 UI/API/CLI by default. The remaining
 * relations are storable but require an explicit `advanced` opt-in.
 */
export const SCOPE_EDGE_RELATIONS_V1 = ["contains", "depends_on"] as const;
export type ScopeEdgeRelationV1 = (typeof SCOPE_EDGE_RELATIONS_V1)[number];

/** Scope→repo association relations. Mirrors the scope_repos CHECK. */
export const SCOPE_REPO_RELATIONS = [
  "owns",
  "contains",
  "uses",
  "depends_on",
  "shared_by",
  "deployed_with",
  "read_context",
  "write_target",
  "test_target",
] as const;
export type ScopeRepoRelation = (typeof SCOPE_REPO_RELATIONS)[number];

/** Default access a scope→repo association grants. Mirrors the CHECK. */
export const SCOPE_REPO_ACCESS = ["write", "read", "test", "none"] as const;
export type ScopeRepoAccess = (typeof SCOPE_REPO_ACCESS)[number];

export interface ScopeNode {
  id: string;
  name: string;
  type: ScopeNodeType;
  description: string | null;
  risk_level: RiskLevel;
  owner: string | null;
  tags_json: string | null;
  lore_tags_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScopeEdge {
  id: string;
  from_node_id: string;
  to_node_id: string;
  relation: ScopeEdgeRelation;
  confidence: number | null;
  reasons_json: string | null;
  created_at: string;
}

export interface ScopeRepo {
  id: string;
  scope_node_id: string;
  repo_id: string;
  relation: ScopeRepoRelation;
  default_access: ScopeRepoAccess;
  confidence: number | null;
  role_description: string | null;
  reasons_json: string | null;
  created_at: string;
  updated_at: string;
}

// --- Ticket scope links (WG-001) -------------------------------------------

/** How a scope node relates to a ticket. Mirrors the ticket_scope_nodes CHECK. */
export const TICKET_SCOPE_RELATIONS = [
  "primary",
  "secondary",
  "suggested",
  "rejected",
  "implicit_repo",
] as const;
export type TicketScopeRelation = (typeof TICKET_SCOPE_RELATIONS)[number];

export interface TicketScopeNode {
  ticket_id: string;
  scope_node_id: string;
  relation: TicketScopeRelation;
  confidence: number | null;
  reasons_json: string | null;
  created_at: string;
  updated_at: string;
}

// --- Ticket↔repo access boundaries (WG-002) --------------------------------

/** Access an agent is granted on a ticket's repo. Mirrors the ticket_repos CHECK. */
export const TICKET_REPO_ACCESS = ["write", "read", "test", "none"] as const;
export type TicketRepoAccess = (typeof TICKET_REPO_ACCESS)[number];

/** How a repo relates to a ticket. Mirrors the ticket_repos `relation` CHECK. */
export const TICKET_REPO_RELATIONS = [
  "confirmed",
  "suggested",
  "rejected",
  "context_only",
  "implicit_single_repo",
] as const;
export type TicketRepoRelation = (typeof TICKET_REPO_RELATIONS)[number];

/** Where a ticket↔repo link came from. Mirrors the ticket_repos `source` CHECK. */
export const TICKET_REPO_SOURCES = [
  "manual",
  "scope_inferred",
  "agent_suggested",
  "memory",
  "codeowners",
  "mono_fallback",
] as const;
export type TicketRepoSource = (typeof TICKET_REPO_SOURCES)[number];

/**
 * Relations that count as an ACTIVE execution boundary — i.e. the repo is really
 * part of this ticket's work. `suggested`/`rejected` are excluded (a suggestion
 * is not yet a boundary; a rejection is retained for audit only). Agents may only
 * write where access='write' AND the relation is one of these.
 */
export const TICKET_REPO_ACTIVE_RELATIONS = [
  "confirmed",
  "implicit_single_repo",
] as const satisfies readonly TicketRepoRelation[];

export function isActiveTicketRepoRelation(relation: TicketRepoRelation): boolean {
  return (TICKET_REPO_ACTIVE_RELATIONS as readonly string[]).includes(relation);
}

// --- Per-repo delivery artifacts (WG-005) ----------------------------------

/**
 * Lifecycle of a single repo's delivery within a ticket. Mirrors the
 * ticket_repo_delivery `status` CHECK. Progresses (loosely) not_started →
 * branch_created → changes_made → tests_passed → pr_opened → review_ready →
 * done; `tests_failed` is a recoverable off-ramp.
 */
export const TICKET_REPO_DELIVERY_STATUSES = [
  "not_started",
  "branch_created",
  "changes_made",
  "tests_failed",
  "tests_passed",
  "pr_opened",
  "review_ready",
  "done",
] as const;
export type TicketRepoDeliveryStatus = (typeof TICKET_REPO_DELIVERY_STATUSES)[number];

/**
 * Delivery-evidence statuses that, on their own, satisfy the strict done-gate's
 * per-repo evidence requirement (WG-005). A repo is also satisfied by a recorded
 * branch or PR regardless of status — see the policy gate.
 */
export const TICKET_REPO_DELIVERY_EVIDENCED_STATUSES = [
  "review_ready",
  "done",
] as const satisfies readonly TicketRepoDeliveryStatus[];

export interface TicketRepoDelivery {
  ticket_id: string;
  repo_id: string;
  branch_name: string | null;
  commit_sha: string | null;
  pr_url: string | null;
  status: TicketRepoDeliveryStatus;
  evidence_ref: string | null;
  created_at: string;
  updated_at: string;
}

// --- Ticket dependencies (EP-001) ------------------------------------------

/**
 * A directed "must finish first" edge between two tickets: the ticket at
 * `ticket_id` cannot be claimed until the ticket at `depends_on_ticket_id` is
 * `done`. Stored as its own table (not scope_edges, which are between scope
 * nodes). The pair is the primary key, so a dependency is declared at most once.
 */
export interface TicketDependency {
  ticket_id: string;
  depends_on_ticket_id: string;
  created_at: string;
}

/**
 * A dependency joined to the depended-on ticket's number/title/status, for
 * read surfaces (`ticket show` / get_ticket). `satisfied` is true when the
 * depended-on ticket is `done` — i.e. this edge no longer blocks claiming.
 */
export interface TicketDependencyView {
  depends_on_ticket_id: string;
  number: number | null;
  title: string;
  status: TicketStatus;
  satisfied: boolean;
}

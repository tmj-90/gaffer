/** Domain enums + row shapes. Unions mirror the schema CHECK constraints. */

import { DispatchError } from "../util/errors.js";

export const TICKET_STATUSES = [
  "draft",
  "refining",
  "ready",
  "claimed",
  "in_progress",
  "blocked",
  "in_review",
  // Independent black-box testing lane (BBT-001). When the global GAFFER_TESTING
  // toggle is on AND the ticket is `can_be_tested`, review approval routes here
  // (`in_review -> in_testing`) instead of straight to `ready_for_merge`: an
  // INDEPENDENT tester agent writes automated tests from the test_contract +
  // acceptance criteria ONLY — never the implementation diff — and submits the
  // results as evidence. Tests pass -> `ready_for_merge`; tests fail -> back to
  // `refining` (reusing the reject path). When the toggle is off or the ticket is
  // not testable, review approval keeps today's behaviour (straight to
  // `ready_for_merge`), so this lane is fully opt-in and skippable.
  "in_testing",
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
  /**
   * BBT-001: 1 ⇒ this ticket is eligible for the independent black-box testing
   * lane — set by the PO / clarify / reviewer once an observable boundary may have
   * changed. Gates entry to `in_testing`: review approval only routes through the
   * tester when this is 1 AND the global GAFFER_TESTING toggle is on. Persisted as
   * INTEGER (0/1) to match the SQLite boolean convention. Default 0.
   */
  can_be_tested: number;
  /**
   * BBT-001: the testing HANDOVER artifact — a JSON-encoded {@link TestContract}
   * (or `null` when none has been recorded). It declares the OPERATIONAL contract
   * the tester needs to stand the system up and probe it (changed boundary
   * surfaces, runtime deps, env vars, run command, harness readiness) WITHOUT ever
   * seeing the implementation diff. Parse with {@link parseTestContract} before
   * surfacing it.
   */
  test_contract: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * The independent black-box testing handover (BBT-001). This is the centerpiece:
 * the implementer/reviewer fills it so a SEPARATE tester agent can stand the
 * system up and probe the changed boundaries from the OUTSIDE, judging behaviour
 * against the acceptance criteria — without ever reading the implementation diff.
 *
 * Eligibility is "did any observable boundary change", not "is this an API
 * ticket": a refactor or internal-util change still belongs here because it can
 * shift an API's underlying logic, so {@link changed_surfaces} captures the
 * boundary contracts whose BEHAVIOUR may have moved.
 */
export interface TestContract {
  /**
   * The boundary contracts whose BEHAVIOUR may have changed — APIs / endpoints /
   * CLI verbs / pages. What the tester probes from the outside.
   */
  changed_surfaces: string[];
  /** Infrastructure the tester must stand up (e.g. "Postgres 16 (was MySQL)"), services. */
  runtime_deps: string[];
  /** Environment variables the tester sets to run the system. */
  env_vars: string[];
  /**
   * How to bring the system up / invoke the changed surface.
   *
   * SAFETY: this is CONTRACT TEXT ONLY — Gaffer never executes it today. It is a
   * free-form, contract-authored string surfaced to the (human or model) tester as
   * context for how to stand the system up. When live execution is eventually
   * implemented it MUST NOT be spawned as a contract-authored shell string: it has
   * to go through the safety hook and the worktree write-root/read-root boundary,
   * and be either a JSON argv vector (not a shell string) or a human-approved
   * harness file. Treat any code that `spawn`s this string directly as a bug.
   */
  run_command: string;
  /**
   * Whether a black-box harness already exists for this surface. Drives the two
   * tester modes: `false` ⇒ HARNESS mode (the tester may use startup/impl detail
   * to STAND UP the rig once, then flips this true); `true` ⇒ BLACK-BOX mode (the
   * tester gets the contract ONLY and extends tests against the existing harness).
   */
  harness_ready: boolean;
}

/**
 * Parse the `tickets.test_contract` JSON column into a {@link TestContract}.
 * Returns `null` for an absent or malformed value, and coerces each field to its
 * expected shape (string arrays for the lists, a string for the command, a boolean
 * for the flag) so a corrupt or partial row can never throw on a read path. A
 * missing field falls back to its empty/false default rather than rejecting the
 * whole record.
 */
export function parseTestContract(raw: string | null): TestContract | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<TestContract>;
    if (typeof parsed !== "object" || parsed === null) return null;
    const stringList = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
    return {
      changed_surfaces: stringList(parsed.changed_surfaces),
      runtime_deps: stringList(parsed.runtime_deps),
      env_vars: stringList(parsed.env_vars),
      run_command: typeof parsed.run_command === "string" ? parsed.run_command : "",
      harness_ready: parsed.harness_ready === true,
    };
  } catch {
    return null;
  }
}

/**
 * One implementation-pointer leak rule: a label, a matcher, and the fields it
 * guards. The whole point of the test contract is that the tester gets the
 * OPERATIONAL boundary — what changed, how to run it — and NEVER an implementation
 * breadcrumb (a branch name, a PR/commit pointer, a "I changed X to Y" narration).
 * A sloppily-authored contract can leak the diff in prose even though the runner
 * never hands over the actual diff; these rules reject that at the write path.
 */
interface LeakRule {
  readonly marker: string;
  readonly test: RegExp;
  /** Which {@link TestContract} list/field this rule scrutinises. */
  readonly fields: ReadonlyArray<"changed_surfaces" | "run_command" | "runtime_deps">;
}

/**
 * The leak rules. Strict implementation-pointer checks run over `changed_surfaces`
 * + `run_command` (and the branch/PR/URL ones also over `runtime_deps`). The bare
 * commit-hash check is DELIBERATELY scoped away from `env_vars` (whose values can
 * legitimately be hex) and `runtime_deps`, so it can't false-positive on a real
 * value — it only guards the surface description + run command.
 */
const LEAK_RULES: readonly LeakRule[] = [
  {
    // A `gaffer/…`-style delivery branch, or any `…/ticket-<n>…` branch pattern.
    marker: "branch name (gaffer/… or …/ticket-<n>…)",
    test: /(^|[\s"'(/])gaffer\/[\w./-]+|ticket-\d+/i,
    fields: ["changed_surfaces", "run_command", "runtime_deps"],
  },
  {
    // A PR URL or any URL pointing at a diff/commit/pull view.
    marker: "PR / diff / commit URL",
    test: /https?:\/\/\S*\/(pull|commit|commits|compare)\/\S+|https?:\/\/\S*\.diff/i,
    fields: ["changed_surfaces", "run_command", "runtime_deps"],
  },
  {
    // A bare commit-hash token. Scoped to surface + run command only — env_vars and
    // runtime_deps can legitimately carry hex, so they are NOT checked here.
    marker: "bare commit hash",
    test: /\b[0-9a-f]{7,40}\b/i,
    fields: ["changed_surfaces", "run_command"],
  },
  {
    // Leakage tokens used as implementation pointers: `diff`, `pr_url`,
    // `branch_name`, or `commit ` (word-boundaried, case-insensitive).
    marker: "leakage token (diff / pr_url / branch_name / commit)",
    test: /\b(diff|pr_url|branch_name|commit)\b/i,
    fields: ["changed_surfaces", "run_command"],
  },
  {
    // "I changed …" / "changed X to Y" narration — describing the EDIT, not the
    // observable surface. The tester gets the contract, never the change story.
    marker: '"I changed …" / "changed X to Y" phrasing',
    test: /\bi\s+changed\b|\bchanged\s+\S+\s+to\s+\S+/i,
    fields: ["changed_surfaces", "run_command"],
  },
  {
    // An internal SOURCE-file path (a token ending in a code extension). A changed
    // surface is an OBSERVABLE contract — an endpoint, CLI verb, page, or behaviour —
    // never a source file: `packages/dispatch/src/services/transitionService.ts` is an
    // implementation pointer, not a surface. Scoped to `changed_surfaces` ONLY —
    // `run_command` legitimately invokes script files (`node bin/x.mjs`, `pytest …`).
    // Data/config files (.json/.yaml/.toml/.env/.csv) are NOT code and remain allowed
    // as a genuine file-interface surface. (Bare implementation class/function names
    // are deliberately NOT pattern-matched — too false-positive-prone; the contract
    // discipline in SKILL.md + human review carry that, while this catches the path
    // that gives the symbol away.)
    marker: "internal source-file path",
    test: /[\w./-]*\.(ts|tsx|js|mjs|cjs|jsx|py|go|rs|java|rb|php|cs|cpp|kt|swift|scala|vue|svelte)\b/i,
    fields: ["changed_surfaces"],
  },
] as const;

/**
 * Validate a {@link TestContract} for implementation-pointer leaks before it is
 * persisted. The invariant the whole testing lane rests on is "the tester never
 * sees the diff" — but a contract author can still smuggle implementation
 * breadcrumbs into the prose (a branch name, a PR URL, a commit hash, a "changed X
 * to Y" narration). This is the choke-point guard that the CLI, MCP, and REST write
 * paths all funnel through (via {@link Wiglet.setTestContract}).
 *
 * Throws a {@link DispatchError} (`TEST_CONTRACT_LEAK`) naming the offending field +
 * marker on the first leak; returns the contract unchanged when clean.
 */
export function validateTestContract(contract: TestContract): TestContract {
  const valueFor = (field: LeakRule["fields"][number]): string[] => {
    switch (field) {
      case "changed_surfaces":
        return contract.changed_surfaces;
      case "runtime_deps":
        return contract.runtime_deps;
      case "run_command":
        return [contract.run_command];
    }
  };
  for (const rule of LEAK_RULES) {
    for (const field of rule.fields) {
      for (const entry of valueFor(field)) {
        if (typeof entry === "string" && rule.test.test(entry)) {
          throw new DispatchError(
            "TEST_CONTRACT_LEAK",
            `test_contract.${field} leaks an implementation pointer (${rule.marker}). ` +
              "The tester gets the operational contract + how to run it — never the diff, " +
              "a branch/PR/commit, or implementation class/function names. Offending entry: " +
              JSON.stringify(entry),
            { field, marker: rule.marker, entry },
          );
        }
      }
    }
  }
  return contract;
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

// ============================================================================
// RUN-ACTIVITY (schema_version 10): a control-plane registry of API-spawned
// detached runs (the "Suggest work" / onboard / poll-work / merge buttons).
// Each row tracks one detached child so the dashboard can show what's in flight
// and surface the per-run log a run that filed nothing would otherwise discard.
// ============================================================================

/** The kind of background run a {@link Run} row tracks. */
export const RUN_KINDS = ["product_owner", "onboard", "poll_work", "merge", "other"] as const;
export type RunKind = (typeof RUN_KINDS)[number];

/**
 * The lifecycle status of a {@link Run}:
 *  - `running`   — the child is live (recorded on spawn);
 *  - `succeeded` — the child exited 0;
 *  - `failed`    — the child exited non-zero (or its exit code was unknown);
 *  - `unknown`   — the run was `running` but its pid is no longer alive when the
 *    API swept stale rows on startup (the API restarted mid-run, so the exit
 *    listener never fired and we can't know the outcome).
 */
export const RUN_STATUSES = ["running", "succeeded", "failed", "unknown"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** A tracked background run (control-plane registry row). */
export interface Run {
  id: string;
  kind: RunKind;
  /** The repo the run targets, when known (null for poll-work / merge). */
  repo: string | null;
  /** OS process id of the spawned child, or null if the platform withheld one. */
  pid: number | null;
  status: RunStatus;
  started_at: string;
  /** When the child exited (or was swept stale). Null while still running. */
  ended_at: string | null;
  /** The child's exit code once it ended, when known. */
  exit_code: number | null;
  /** Absolute path to the per-run log file (captured stdout+stderr). */
  log_path: string | null;
  /** Optional free-text detail (e.g. a spawn-failure reason). */
  detail: string | null;
}

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
  // PAUSE-ON-CAP (schema_version 12): an IN-FLIGHT delivery that hit the turn cap
  // (GAFFER_MAX_TURNS) or the budget cap (GAFFER_BUDGET_REMAINING) mid-delivery and
  // was PAUSED IN PLACE — its worktree + branch (committed AND uncommitted work)
  // are kept alive on the runner host, and the resume context lives in the
  // `paused_deliveries` table. Distinct from `refining` (back in the queue) and
  // `cancelled` (abandoned): a paused ticket is parked awaiting a human's one-click
  // Continue (re-enter the SAME worktree) or Stop (tear down + abandon). Reached
  // only via the guarded pause path; left via the guarded resume / stop paths.
  "paused",
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/**
 * Why an in-flight delivery was paused (PAUSE-ON-CAP). `cap_hit` = the agent ran
 * to the turn cap; `budget_cap` = the configured USD budget headroom was exhausted.
 * Both are recoverable checkpoints, not failures — the work is preserved and the
 * ticket waits for a human Continue/Stop.
 */
export const PAUSE_REASONS = ["cap_hit", "budget_cap"] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];

/**
 * The durable resume context for a {@link TicketStatus} `paused` ticket (one row
 * per paused ticket in `paused_deliveries`). It survives a runner restart so the
 * factory loop can re-enter delivery IN THE EXISTING worktree without re-cloning or
 * losing context. `resume_requested` (0/1) is flipped to 1 by the human Continue
 * action; the factory-loop selection picks up resume-requested rows and re-invokes
 * the agent in `worktree_path` on `branch_name`.
 */
export interface PausedDelivery {
  ticket_id: string;
  /** Why the delivery paused — see {@link PauseReason}. */
  reason: PauseReason;
  /** The runner-owned delivery branch the partial work lives on (gaffer/…). */
  branch_name: string | null;
  /** Absolute path of the PRIMARY worktree kept alive for the resume. */
  worktree_path: string | null;
  /**
   * JSON-encoded full worktree map (the runner's WT_ROWS — one entry per write
   * repo) so a multi-repo delivery resumes every worktree, not just the primary.
   */
  worktrees_json: string | null;
  /** Primary repo name/path the delivery targets (display + audit). */
  repo: string | null;
  /** Delivery attempt number at the time of the pause (accumulates across resumes). */
  attempt: number;
  /** Accumulated agent turns reported by the capped call, or null if unmeasured. */
  turns: number | null;
  /** Spend-so-far relayed verbatim from the capped call (e.g. "$2.5600" / "unknown"). */
  spend: string | null;
  /** 1 ⇒ a human pressed Continue and the factory loop should resume this ticket. */
  resume_requested: number;
  created_at: string;
  updated_at: string;
}

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
  /**
   * TRACK-2b: the HUMAN-CLAIM marker. `null` ⇒ agent-shaped work the factory may
   * claim as normal. A non-null value (the human actor's id/name) ⇒ a human took the
   * ticket "by hand": it sits `in_progress` OWNED BY THE HUMAN, the agent selection
   * loop structurally skips it (the candidate queries filter `human_owner IS NULL`),
   * and the board renders it in a distinct "by hand" lane. Cleared when the ticket
   * leaves `in_progress` (hand-back to `ready`, submit to review, block, cancel …).
   */
  human_owner: string | null;
  /**
   * TRACK-2b: the durable DELIVERED-BY-HAND marker. {@link human_owner} is cleared
   * the instant the ticket leaves `in_progress`, so this separate marker records
   * that the work CURRENTLY under review was delivered by hand — set (to the human
   * actor's id/name) when a human-owned ticket submits `in_progress -> in_review`,
   * cleared whenever the ticket re-enters the delivery pipeline (any move out of
   * the review lane). The done-gate consults it to exempt a hand delivery from the
   * server-recomputed-diff requirement (PR_OR_DIFF_REQUIRED) it can structurally
   * never meet; a later agent redelivery is never exempted.
   */
  human_delivered: string | null;
  /**
   * TRACK-3a: the per-ticket DELIVERY BUDGET ceiling in USD, or `null` for no
   * per-ticket ceiling (the factory-wide env budget applies). A first-class
   * extension of the rework loop's per-ticket cost ceiling: the runner parks the
   * ticket to `blocked` once its cumulative MEASURED delivery spend (from the
   * usage-ledger) reaches this figure, even when retry attempts remain. An epic
   * stamps its budget onto each child ticket at creation (per-epic, inherited).
   */
  delivery_budget_usd: number | null;
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
  /**
   * Structured machine code for WHY the ticket bounced, so the board and the next
   * attempt can key off it rather than parsing free text. `rework_exhausted` marks
   * a delivery parked to `blocked` after the runner's rework loop hit its attempt
   * or per-ticket cost ceiling. Absent for ordinary human review rejections.
   */
  code?: string;
  /**
   * The runner's live rework attempt (1-based) while a ticket is being reworked in
   * place (`in_progress`), so the board can render "reworking · attempt N/M". Set by
   * the runner between delivery retries; absent for a human review rejection.
   */
  attempt?: number;
  /** The rework attempt ceiling (GAFFER_MAX_DELIVERY_ATTEMPTS) paired with {@link attempt}. */
  maxAttempts?: number;
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
    const out: ReviewFeedback = {
      reason: parsed.reason,
      reviewer: typeof parsed.reviewer === "string" ? parsed.reviewer : null,
      at: parsed.at,
    };
    if (typeof parsed.code === "string" && parsed.code.length > 0) out.code = parsed.code;
    if (typeof parsed.attempt === "number" && Number.isFinite(parsed.attempt)) {
      out.attempt = parsed.attempt;
    }
    if (typeof parsed.maxAttempts === "number" && Number.isFinite(parsed.maxAttempts)) {
      out.maxAttempts = parsed.maxAttempts;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * FAILURE-DIAGNOSIS: one persisted rework attempt in a ticket's failure trail.
 * Unlike {@link ReviewFeedback} (which keeps only the LATEST attempt on the card),
 * these APPEND — the full ordered history of why a ticket kept failing. Each row
 * carries the DISTILLED failure the runner's DoD distiller produced (the real
 * failing test + assertion/stack), not a gate-name summary.
 */
export interface ReworkAttempt {
  id: string;
  ticket_id: string;
  /** 1-based attempt counter for this rework loop. */
  attempt: number;
  /** The attempt ceiling in force when this row was recorded (may be null). */
  max_attempts: number | null;
  /** The gate that failed (e.g. `tests`, `definition-of-done`, `lint`). */
  gate: string | null;
  /** The full distilled failing test + assertion/stack — the crux of the trail. */
  distilled_failure: string;
  /** The acceptance criterion being worked toward when known (else null). */
  ac_id: string | null;
  created_at: string;
}

/**
 * FAILURE-DIAGNOSIS: the cross-ticket "these keep bouncing" aggregate. One row per
 * ticket with a rework trail, ranked so the operator sees the worst quality
 * offenders first — especially tickets that repeatedly fail the SAME gate
 * ({@link top_gate_count}), the strongest signal of a stuck ticket.
 */
export interface BouncingTicket {
  ticket_id: string;
  number: number | null;
  title: string;
  status: string;
  /** Total rework attempts recorded across the ticket's trail. */
  rework_count: number;
  /** How many DISTINCT gates the ticket failed. */
  distinct_gates: number;
  /** The single gate the ticket failed most often (null when no gate was recorded). */
  top_gate: string | null;
  /** How many times {@link top_gate} failed — the same-gate repeat signal. */
  top_gate_count: number;
  /** Timestamp of the most recent attempt in the trail. */
  last_attempt_at: string;
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

// ============================================================================
// Plan Sessions (H9 — durable async plan-build chat).
//
// A plan session persists the decompose conversation server-side so a reload or
// navigation-away restores the exact history + proposed plan. Each session
// belongs to one brief; the conversation lives in the `messages_json` column
// (JSON array of role+content+ts objects). When a plan is confirmed or
// abandoned the session is archived (status → 'confirmed' | 'abandoned') and
// the panel opens a fresh one on next use.
//
// NOTE (deferred): true background decompose jobs (fire, navigate away, poll
// on return) require a separate persistent job queue; the current approach
// persists in-progress state synchronously per turn so a reload mid-turn shows
// the last complete state rather than a blank panel.
// ============================================================================

/** Lifecycle status of a plan session. */
export const PLAN_SESSION_STATUSES = ["active", "confirmed", "abandoned"] as const;
export type PlanSessionStatus = (typeof PLAN_SESSION_STATUSES)[number];

/** A single message in the plan-build conversation. */
export interface PlanMessage {
  role: "user" | "assistant";
  /** ISO-8601 UTC timestamp the message was recorded. */
  ts: string;
  /**
   * Serialised content — for user turns this is the raw text; for assistant
   * turns it is the JSON-stringified `{ phase, questions? | plan? | error? }`
   * envelope from the decompose helper so the client can re-render it exactly.
   */
  content: string;
}

/** A durable plan-build chat session row. */
export interface PlanSession {
  id: string;
  status: PlanSessionStatus;
  /** The one-line brief the session started with (null until the first user turn). */
  brief: string | null;
  /** JSON-encoded array of {@link PlanMessage} objects. */
  messages_json: string;
  /**
   * JSON-encoded proposed plan from the decompose helper (`{ epic, tickets }`),
   * or null while the session is still in the clarification phase.
   */
  plan_json: string | null;
  /**
   * Target repo name (brownfield extend), or null for greenfield / unknown.
   * Stored as context for the session summary; the decomposer uses the full
   * `context` object carried in the message payload.
   */
  target_repo: string | null;
  /** Scope node name when the session is an "extend existing" session. */
  target_scope: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// Specs (Spec-Driven Development, Phase 1a).
//
// A spec is an AI-drafted, human-edited, then FROZEN statement of product intent
// that sits in front of the decompose engine. Each spec owns an ordered set of
// clauses — one testable statement each — with a STABLE clause_id so a later
// phase can thread provenance down to acceptance criteria.
// ============================================================================

/** Lifecycle status of a {@link Spec}. Mirrors the specs.status CHECK. */
export const SPEC_STATUSES = ["draft", "frozen", "superseded"] as const;
export type SpecStatus = (typeof SPEC_STATUSES)[number];

/**
 * The kind of a {@link SpecClause}. A `requirement` is something the system MUST
 * do; a `non-goal` is something it deliberately will NOT do; a `decision` records
 * a settled product/technical choice. These three map onto the durable
 * product-intent lore kinds (`requirement`/`non-goal`/`decision`) a later phase
 * seeds from a frozen spec.
 */
export const SPEC_CLAUSE_KINDS = ["requirement", "non-goal", "decision"] as const;
export type SpecClauseKind = (typeof SPEC_CLAUSE_KINDS)[number];

/**
 * One clause of a spec: a single testable statement of intent. `clause_id` is
 * STABLE — assigned server-side at create/edit time when absent and preserved
 * thereafter — so Phase 3 traceability can reference a clause even across edits
 * (before a freeze) and forever after a freeze.
 */
export interface SpecClause {
  /** Stable identifier for this clause (assigned server-side when absent). */
  clause_id: string;
  kind: SpecClauseKind;
  /** The clause text — one testable statement of intent. */
  text: string;
  /** Optional rationale explaining WHY this clause exists. */
  rationale?: string;
}

/**
 * A spec row. `clauses_json` is the JSON-encoded {@link SpecClause}[] (parse with
 * {@link parseSpecClauses}). `status` walks draft → frozen (an immutable snapshot,
 * frozen_at stamped) → superseded. `target_repo`/`scope_node_id` are OPTIONAL soft
 * references (by name / id) to where the spec's work will land.
 */
export interface Spec {
  id: string;
  title: string;
  brief: string;
  /** JSON-encoded array of {@link SpecClause} objects. */
  clauses_json: string;
  status: SpecStatus;
  target_repo: string | null;
  scope_node_id: string | null;
  created_at: string;
  updated_at: string;
  /** When the spec was frozen (draft→frozen), or null while still a draft. */
  frozen_at: string | null;
}

/**
 * Parse the `specs.clauses_json` column into a {@link SpecClause}[]. Returns `[]`
 * for an absent or malformed value, and coerces each entry to its expected shape
 * so a corrupt row can never throw on a read path. An entry with a missing/unknown
 * `kind` or empty `text` is dropped rather than rejecting the whole record.
 */
export function parseSpecClauses(raw: string | null): SpecClause[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const kinds = new Set<string>(SPEC_CLAUSE_KINDS);
    const out: SpecClause[] = [];
    for (const entry of parsed) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as Partial<SpecClause>;
      if (typeof e.clause_id !== "string" || e.clause_id.length === 0) continue;
      if (typeof e.kind !== "string" || !kinds.has(e.kind)) continue;
      if (typeof e.text !== "string" || e.text.length === 0) continue;
      const clause: SpecClause = {
        clause_id: e.clause_id,
        kind: e.kind as SpecClauseKind,
        text: e.text,
      };
      if (typeof e.rationale === "string" && e.rationale.length > 0) {
        clause.rationale = e.rationale;
      }
      out.push(clause);
    }
    return out;
  } catch {
    return [];
  }
}

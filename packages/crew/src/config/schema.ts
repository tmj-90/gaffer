import { z } from "zod";

/** Crew config schema (crew.yaml). Validated at every boundary. */

export const factoryModeSchema = z.enum(["local_loose", "local_strict", "shared_team"]);

export const factorySchema = z.object({
  name: z.string().min(1, "factory.name is required"),
  mode: factoryModeSchema.default("local_strict"),
  timezone: z.string().default("UTC"),
});

export const dispatchSchema = z
  .object({
    mode: z.enum(["local", "shared"]).default("local"),
    local: z.object({ sqlite_path: z.string().default("./.dispatch/dispatch.sqlite") }).default({}),
    shared: z
      .object({
        base_url: z.string().nullable().default(null),
        auth_profile: z.string().nullable().default(null),
      })
      .default({}),
    default_policy_pack: z.string().default("solo_loose"),
  })
  .default({});

export const memorySchema = z
  .object({
    enabled: z.boolean().default(true),
    mode: z.enum(["local", "shared"]).default("local"),
    // Optional real Memory MCP server. `command: null` (the default) keeps the
    // Null client wired, so existing configs stay valid and offline-runnable.
    mcp: z
      .object({
        command: z.string().nullable().default(null),
        args: z.array(z.string()).default([]),
      })
      .default({}),
    // Memory CLI write bridge. When `command` is set (or `MEMORY_CLI_BIN` is in
    // the environment), the onboard flush writes the digest + feature inventory via
    // the memory CLI verbs (`digest set` / `feature add`) instead of spawning an MCP
    // server — the SAME channel the factory's merge producer uses. `MEMORY_DB`
    // (env) names the sqlite the writes land in. Env wins over config.
    cli: z
      .object({
        command: z.string().nullable().default(null),
      })
      .default({}),
    required_before: z.object({ tags: z.array(z.string()).default([]) }).default({}),
    suggestion_policy: z
      .object({
        after_ticket_done: z.boolean().default(true),
        auto_approve: z.boolean().default(false),
      })
      .default({}),
  })
  .default({});

/**
 * Per-loop behaviour for the idle scan loops:
 *  - `observe_only` — scan and report the finding, but create nothing in Dispatch.
 *  - `create_draft_tickets` — create a DRAFT ticket per finding (the default).
 *  - `create_ready_tickets` — create the ticket AND mark it ready.
 */
export const idleLoopModeSchema = z.enum([
  "observe_only",
  "create_draft_tickets",
  "create_ready_tickets",
]);

export const mutationModeSchema = z.enum([
  "read_only",
  "branch_only",
  "branch_and_pr",
  "local_commit_allowed",
  "direct_push_allowed",
]);

/**
 * Definition-of-Done (audit I3). A deterministically-ENFORCED gate the RUNNER
 * (never the agent) runs on a non-empty delivery BEFORE the ticket may rest in
 * the human review lane. A failing gate auto-rejects the delivery back to rework
 * with the gate output as evidence — a human never spends time on it.
 *
 * Each gate is default-ON; a gate whose command is not configured for the repo
 * is SKIPPED (and that skip is logged), never failed. The master `enabled`
 * mirrors the `GAFFER_DOD` env toggle: when the runner sees `GAFFER_DOD=0` it
 * disables enforcement entirely (today's behaviour), and `GAFFER_DOD=1` forces
 * it on; with the env unset the runner enforces whenever commands are configured.
 *
 * Gate → command source (read deterministically by the runner):
 *   - tests     → the repo's `test_command`
 *   - lint      → the repo's `lint_command` (this is the existing
 *                 `require_lint_clean` policy, now actually RUN, not just asserted)
 *   - typecheck → the repo's `typecheck_command` (null on most repos ⇒ skipped)
 *
 * DEFERRED (documented follow-ups, intentionally NOT gates here):
 *   coverage-did-not-decrease (needs a stored baseline), SAST/SCA (needs I2),
 *   CI-green (H3), docs-updated.
 */
export const definitionOfDoneSchema = z
  .object({
    // Master switch for this DoD block. Mirrors `GAFFER_DOD`. When false the
    // runner skips DoD enforcement for the repo (today's behaviour). The env
    // toggle, when set, wins over this value at runtime.
    enabled: z.boolean().default(true),
    // Run the repo's test_command as a gate.
    tests: z.boolean().default(true),
    // Run the repo's typecheck_command as a gate (skipped when unset).
    typecheck: z.boolean().default(true),
    // Run the repo's lint_command as a gate (the enforced require_lint_clean).
    lint: z.boolean().default(true),
  })
  .default({});

export const repoSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1, "repo.path is required"),
  remote_url: z.string().nullable().default(null),
  default_branch: z.string().default("main"),
  protected_branches: z.array(z.string()).default(["main", "release/*"]),
  stack: z.string().nullable().default(null),
  package_manager: z.string().nullable().default(null),
  test_command: z.string().nullable().default(null),
  lint_command: z.string().nullable().default(null),
  coverage_command: z.string().nullable().default(null),
  build_command: z.string().nullable().default(null),
  // I3: the typecheck DoD gate's command (e.g. "pnpm typecheck"). Null ⇒ the
  // typecheck gate is SKIPPED for this repo, not failed.
  typecheck_command: z.string().nullable().default(null),
  // I3: per-repo Definition-of-Done override. Omitted ⇒ inherit the factory
  // default (`definition_of_done` at the top level).
  definition_of_done: definitionOfDoneSchema.optional(),
  mutation_mode: mutationModeSchema.default("branch_only"),
  risk_level: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  owners: z.array(z.string()).default([]),
  lore_tags: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  commands_allow: z.array(z.string()).default([]),
});

export const agentSchema = z.object({
  id: z.string().min(1),
  display_name: z.string().default(""),
  runtime: z.string().default("claude-code"),
  model: z.string().default("claude-sonnet"),
  host: z.string().default("local"),
  capabilities: z.array(z.string()).default([]),
  max_risk: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  allowed_repos: z.array(z.string()).default([]),
  denied_repos: z.array(z.string()).default([]),
  status: z.enum(["active", "paused", "disabled", "unhealthy"]).default("active"),
});

export const safetyRefSchema = z
  .object({
    policy_file: z.string().default("./safety_policy.yaml"),
    default_idle_loop_mode: z.string().default("create_draft_tickets"),
    require_clean_worktree_before_start: z.boolean().default(true),
    redact_secrets_in_context: z.boolean().default(true),
    model_may_read_secret_files: z.boolean().default(false),
  })
  .default({});

/**
 * Per-repo delivered-ticket gate. A scan loop must SKIP a repo until that repo
 * has had at least this many tickets DELIVERED (status `done`). Young repos
 * don't earn tech-debt/security scans until they've shipped real work. Non-
 * negative; per-loop value overrides the `loops`-level default. Nullable on a
 * loop means "inherit the shared default".
 */
const minDeliveredTicketsSchema = z.number().int().nonnegative();

export const loopsSchema = z
  .object({
    /**
     * Factory-wide default delivered-ticket threshold for every idle scan loop.
     * A loop's own `min_delivered_tickets`, when set, overrides this value.
     */
    default_min_delivered_tickets: minDeliveredTicketsSchema.default(0),
    implementation: z
      .object({
        enabled: z.boolean().default(true),
        trigger: z.string().default("manual_or_queue"),
        max_concurrent_agents: z.number().int().positive().default(1),
        requires_claim: z.boolean().default(true),
        submit_for_review: z.boolean().default(true),
        claim_ttl_seconds: z.number().int().positive().default(900),
        // Verifiable delivery post-conditions. Off by default so existing
        // configs behave identically; when enabled, a delivery missing a
        // required post-condition is blocked instead of submitted for review.
        post_conditions: z
          .object({
            enabled: z.boolean().default(false),
            require_branch_prefix: z.boolean().default(true),
            require_test_evidence: z.boolean().default(true),
            require_ac_evidence: z.boolean().default(true),
            require_lint_clean: z.boolean().default(true),
          })
          .default({}),
      })
      .default({}),
    idle_coverage: z
      .object({
        // OFF by default — opt in per factory. Each idle tick spends model
        // tokens analysing repos, so scan loops only run when explicitly enabled.
        enabled: z.boolean().default(false),
        trigger: z.string().default("when_queue_empty"),
        mode: idleLoopModeSchema.default("create_draft_tickets"),
        repos: z.array(z.string()).default([]),
        // Per-loop delivered-ticket threshold; null = inherit
        // loops.default_min_delivered_tickets.
        min_delivered_tickets: minDeliveredTicketsSchema.nullable().default(null),
        minimum_gap_threshold: z.number().default(10),
      })
      .default({}),
    idle_test_quality: z
      .object({
        enabled: z.boolean().default(false),
        trigger: z.string().default("when_queue_empty"),
        mode: idleLoopModeSchema.default("create_draft_tickets"),
        repos: z.array(z.string()).default([]),
        min_delivered_tickets: minDeliveredTicketsSchema.nullable().default(null),
      })
      .default({}),
    idle_documentation: z
      .object({
        enabled: z.boolean().default(false),
        trigger: z.string().default("when_queue_empty"),
        mode: idleLoopModeSchema.default("create_draft_tickets"),
        repos: z.array(z.string()).default([]),
        min_delivered_tickets: minDeliveredTicketsSchema.nullable().default(null),
      })
      .default({}),
    idle_dependencies: z
      .object({
        enabled: z.boolean().default(false),
        trigger: z.string().default("when_queue_empty"),
        mode: idleLoopModeSchema.default("create_draft_tickets"),
        repos: z.array(z.string()).default([]),
        min_delivered_tickets: minDeliveredTicketsSchema.nullable().default(null),
        // Optional read-only audit/outdated command, e.g. "pnpm outdated --json".
        // Idle loops never install; this is parsed for findings only.
        audit_command: z.string().nullable().default(null),
      })
      .default({}),
    idle_security_hotspot: z
      .object({
        enabled: z.boolean().default(false),
        trigger: z.string().default("when_queue_empty"),
        mode: idleLoopModeSchema.default("create_draft_tickets"),
        repos: z.array(z.string()).default([]),
        min_delivered_tickets: minDeliveredTicketsSchema.nullable().default(null),
      })
      .default({}),
    idle_type_quality: z
      .object({
        enabled: z.boolean().default(false),
        trigger: z.string().default("when_queue_empty"),
        mode: idleLoopModeSchema.default("create_draft_tickets"),
        repos: z.array(z.string()).default([]),
        min_delivered_tickets: minDeliveredTicketsSchema.nullable().default(null),
      })
      .default({}),
    idle_tech_debt: z
      .object({
        enabled: z.boolean().default(false),
        trigger: z.string().default("when_queue_empty"),
        mode: idleLoopModeSchema.default("create_draft_tickets"),
        repos: z.array(z.string()).default([]),
        min_delivered_tickets: minDeliveredTicketsSchema.nullable().default(null),
        // A non-test source file over this many LOC is flagged as a god-file.
        god_file_lines: z.number().int().positive().default(500),
        // A churn×size hotspot is flagged when (commit count × LOC) exceeds this.
        churn_size_product_threshold: z.number().int().positive().default(5000),
      })
      .default({}),
    idle_lore_gap: z
      .object({
        // Off by default: only meaningful with a real Memory configured.
        // Emits Memory *suggestions* (never approves) for repeated repo
        // conventions absent from lore; never edits code.
        enabled: z.boolean().default(false),
        trigger: z.string().default("when_queue_empty"),
        mode: z.string().default("suggest_lore"),
        repos: z.array(z.string()).default([]),
        // A repeated pattern must recur at least this many times to be flagged.
        minimum_occurrences: z.number().int().positive().default(3),
        // When true, also drafts a Dispatch ticket to ratify the suggestion.
        draft_ratify_ticket: z.boolean().default(false),
      })
      .default({}),
    idle_feature_backlog: z
      .object({
        // Off by default: only meaningful with a real Memory configured AND a
        // brownfield decomposer available. When enabled, a quiet idle tick pulls
        // ONE `backlog` feature from the memory ledger and turns it into a planned
        // epic so the backlog grinds down autonomously. Never edits code.
        enabled: z.boolean().default(false),
        trigger: z.string().default("when_queue_empty"),
        // Reuses the idle-loop mode vocabulary:
        //  - observe_only        — report the candidate, file NOTHING, do not advance.
        //  - create_draft_tickets — file the epic as DRAFTS awaiting human approval.
        //  - create_ready_tickets — file the epic as READY (past the human gate;
        //    only honour this when the operator has explicitly opted in).
        mode: idleLoopModeSchema.default("create_draft_tickets"),
        // Scope: empty = every onboarded repo; otherwise the named allow-list.
        repos: z.array(z.string()).default([]),
        // Absolute path to runner's `bin/decompose.mjs`. Null (the default)
        // means no decomposer is wired, so the loop is a no-op even when enabled —
        // keeping existing configs valid and offline-runnable.
        decompose_script: z.string().nullable().default(null),
        // Optional working directory for the spawned decomposer (runner root).
        decompose_cwd: z.string().nullable().default(null),
        // Hard wall-clock timeout for one decompose, in ms.
        decompose_timeout_ms: z.number().int().positive().default(180_000),
        // Hard cap on brownfield decompose turns (passed to the decomposer).
        max_turns: z.number().int().positive().default(6),
        // Hard cap on the number of tickets the epic plan may contain.
        max_tickets: z.number().int().positive().default(20),
      })
      .default({}),
    // The idle MAINTENANCE LANE (audit item A4). OFF BY DEFAULT. When enabled,
    // a quiet idle tick (no claimable ticket) runs ONE maintenance loop chosen
    // by a deterministic priority + rotation scheduler — NO LLM in the choice —
    // instead of the single fixed idle scan. Which loops it rotates through is
    // determined by each loop's own `enabled` flag above; this block only gates
    // the lane itself and points at the persisted rotation cursor.
    maintenance: z
      .object({
        // Master toggle. OFF respects token cost; ON turns the smart prioritised
        // lane on. The lane still only fires when at least one idle loop above is
        // enabled (those provide the lanes it rotates through).
        enabled: z.boolean().default(false),
        // Where the rotation cursor is persisted so cadence survives across
        // ticks/processes. Null = derive `<GAFFER_DATA>/maintenance-cursor.json`
        // at the call site; an explicit path overrides it (handy for tests).
        cursor_path: z.string().nullable().default(null),
      })
      .default({}),
    // The self-improving closed loop. OFF BY DEFAULT. When enabled, idle ticks may
    // auto-promote their own DRAFT improvement tickets to `ready` so the delivery
    // loop claims them — without a human in the promote step. It is deliberately
    // hard to fire: strict opt-in (a repo must be named in `repos`), capped at
    // `max_ready_per_run` promotions per tick, and limited to repos whose
    // risk_level is at/below `max_risk`. It never marks code-editing work ready;
    // it only flips idle-drafted tech-debt/coverage/docs findings to claimable.
    self_improve: z
      .object({
        enabled: z.boolean().default(false),
        // Strict opt-in: empty list = NO repos eligible (not "all").
        repos: z.array(z.string()).default([]),
        // Only repos at/below this risk level may be auto-promoted.
        max_risk: z.enum(["low", "medium", "high", "critical"]).default("low"),
        // Hard cap on auto-promotions per idle tick (the bound).
        max_ready_per_run: z.number().int().positive().default(1),
      })
      .default({}),
  })
  .default({});

/**
 * Context-packet token hygiene. Caps what gets assembled into the per-ticket
 * context so the packet stays lean and pre-filtered to the ticket's stack/area:
 *  - `lore_limit` — max ratified lore records pulled into a packet.
 *  - `max_skills` — max skills selected for the packet after stack filtering.
 *  - `product_context_limit` — max product-intent lore records (decisions /
 *    requirements / non-goals) surfaced in the packet's `productContext`
 *    section, budgeted separately so recall can be aimed at "why".
 *  - `token_budget` — optional soft budget; when set, packets over it are
 *    flagged (never silently truncated) so an operator can tighten the caps.
 */
export const contextSchema = z
  .object({
    lore_limit: z.number().int().positive().default(8),
    max_skills: z.number().int().positive().default(12),
    product_context_limit: z.number().int().positive().default(6),
    token_budget: z.number().int().positive().nullable().default(null),
  })
  .default({});

/**
 * GitHub issue ingest. Off by default so existing configs stay valid. When
 * enabled, `crew ingest` pulls open issues labelled `label` into Dispatch
 * as draft tickets, then relabels each issue to `ingested_label` so it is not
 * re-ingested. `repos` (empty = all configured repos) restricts which repos are
 * polled; a repo is only polled if it resolves to a github.com remote.
 */
export const ingestSchema = z
  .object({
    github: z
      .object({
        enabled: z.boolean().default(false),
        label: z.string().min(1).default("agent-ok"),
        ingested_label: z.string().min(1).default("agent-queued"),
        repos: z.array(z.string()).optional(),
      })
      .default({}),
    // Jira ingest. Mirrors the github adapter and shares its dedup contract
    // (identity = the issue's `self` REST URL). Off by default. Requires the
    // `jira` CLI authenticated on the host. `jql` overrides the default
    // `labels = "<label>"` scope; `repo` attaches drafts to a configured repo.
    jira: z
      .object({
        enabled: z.boolean().default(false),
        label: z.string().min(1).default("agent-ok"),
        jql: z.string().nullable().default(null),
        repo: z.string().nullable().default(null),
      })
      .default({}),
  })
  .default({});

export const hooksSchema = z
  .object({
    enabled: z.boolean().default(false),
    builtins: z
      .object({
        risk_guard_claim: z.boolean().default(false),
        record_environment: z.boolean().default(false),
        require_evidence_before_review: z.boolean().default(false),
        notify_on_blocked: z.boolean().default(false),
        classify_failure: z.boolean().default(false),
        // Prompts the agent to capture durable lore at after_ticket_done. On by
        // default (when hooks are enabled) so the normal plan→build→review flow
        // actively builds Memory — without it the lore views stay empty outside
        // the dedicated idle_lore_gap loop.
        capture_lore_reflection: z.boolean().default(true),
      })
      .default({}),
  })
  .default({});

export const loggingSchema = z
  .object({
    level: z.enum(["debug", "info", "warn", "error"]).default("info"),
    event_log_path: z.string().default("./.crew/events.jsonl"),
    redact: z.boolean().default(true),
  })
  .default({});

export const crewConfigSchema = z.object({
  factory: factorySchema,
  dispatch: dispatchSchema,
  memory: memorySchema,
  repos: z.array(repoSchema).default([]),
  agents: z.array(agentSchema).default([]),
  safety: safetyRefSchema,
  loops: loopsSchema,
  context: contextSchema,
  ingest: ingestSchema,
  hooks: hooksSchema,
  logging: loggingSchema,
  // I3: factory-wide Definition-of-Done default. A repo's own
  // `definition_of_done`, when present, overrides this (see resolveDefinitionOfDone).
  definition_of_done: definitionOfDoneSchema,
});

/**
 * Resolve a scan loop's effective delivered-ticket threshold: the loop's own
 * `min_delivered_tickets` when set, otherwise the factory-wide
 * `loops.default_min_delivered_tickets`.
 */
export function resolveMinDeliveredTickets(
  loops: z.infer<typeof loopsSchema>,
  loopValue: number | null | undefined,
): number {
  return loopValue ?? loops.default_min_delivered_tickets;
}

/**
 * Resolve a repo's effective Definition-of-Done: the repo's own
 * `definition_of_done` when present, otherwise the factory-wide default. Mirrors
 * resolveMinDeliveredTickets — specific overrides general.
 */
export function resolveDefinitionOfDone(
  repo: Pick<z.infer<typeof repoSchema>, "definition_of_done">,
  factoryDefault: z.infer<typeof definitionOfDoneSchema>,
): z.infer<typeof definitionOfDoneSchema> {
  return repo.definition_of_done ?? factoryDefault;
}

export type CrewConfig = z.infer<typeof crewConfigSchema>;
export type DefinitionOfDoneConfig = z.infer<typeof definitionOfDoneSchema>;
export type ContextConfig = z.infer<typeof contextSchema>;
export type IngestConfig = z.infer<typeof ingestSchema>;
export type RepoConfig = z.infer<typeof repoSchema>;
export type AgentConfig = z.infer<typeof agentSchema>;
export type FactoryMode = z.infer<typeof factoryModeSchema>;
export type IdleLoopMode = z.infer<typeof idleLoopModeSchema>;

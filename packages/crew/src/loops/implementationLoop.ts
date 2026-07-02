// ─────────────────────────────────────────────────────────────────────────────
// SEAL (Track 1c) — MOCK-ONLY TODAY, NOT THE LIVE DELIVERY PATH.
//
// This implementation loop runs ONLY `MockAgentRuntime` (see runtime/agentRuntime.ts
// and the crew `run` CLI command). It is a documented FUTURE seam plus the
// `--dry-run` test harness every crew test drives — it does NOT invoke a real
// agent and writes no files. The LIVE production delivery path is the bash runner:
// `runner/tick.sh` → `claude -p`, with context assembled in `runner/lib/*`.
//
// RULE: any NEW production delivery feature — context/prompt assembly, the close
// path, what the agent actually receives — MUST ALSO land in `runner/tick.sh`
// (and `runner/lib`) until a real `ClaudeAgentRuntime` is wired here. A feature
// added only to this loop silently misses the live agent (that is exactly the
// Track-1c stranding this seal exists to prevent). See runner/CLAUDE.md.
// ─────────────────────────────────────────────────────────────────────────────
import { checkBranchPolicy } from "../safety/branchPolicy.js";
import { checkPostConditions, summarisePostConditionFailures } from "../safety/postconditions.js";
import { classifyRootAccess, type RootSet } from "../safety/rootAccess.js";
import { CrewError } from "../util/errors.js";
import { buildContextPacket, type ContextPacket, type PacketWorkRepo } from "../context/packet.js";
import { distillTicketIntent } from "../context/ticketIntent.js";
import type { GitAdapter } from "../adapters/gitAdapter.js";
import type { CrewConfig } from "../config/schema.js";
import type { EventLog } from "../events/eventLog.js";
import type { HookRegistry } from "../hooks/hookRegistry.js";
import type { HookInput, HookName } from "../hooks/types.js";
import type { MemoryClient } from "../memory/client.js";
import type { ReadyTicket } from "../dispatch/client.js";
import type { RepoRegistry } from "../registry/repoRegistry.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { AgentRuntime } from "../runtime/agentRuntime.js";
import type { SafetyPolicy } from "../safety/policySchema.js";
import type { DispatchClient } from "../dispatch/client.js";

// ---------------------------------------------------------------------------
// H4 — injectable PR creation seam
// ---------------------------------------------------------------------------

/**
 * Result of a PR creation attempt. `prUrl` is the newly-created PR URL when the
 * attempt succeeded; `null` when the flag is off, there is no GitHub remote, or
 * the `gh` call failed. The implementation loop records a non-null URL back onto
 * the ticket via `recordDeliveryArtifact`.
 */
export interface PrCreateResult {
  /** The created PR URL, or null when creation was skipped / failed. */
  prUrl: string | null;
  /** Human-readable one-line summary of what happened (for the event log). */
  summary: string;
}

/**
 * Injectable seam for GitHub PR creation (H4). The real implementation runs
 * `gh pr create`; tests inject a `FakePrCreator` so no remote is needed.
 */
export interface PrCreator {
  /**
   * Create a PR for the delivery branch and return its URL.
   *
   * @param p.ticketId     Dispatch ticket id (for evidence recording).
   * @param p.ticketNumber Human-visible ticket number (for the PR body).
   * @param p.repoPath     Local path of the primary write repo.
   * @param p.branch       Delivery branch name.
   * @param p.baseBranch   Target base branch (default: "main").
   * @param p.title        PR title (usually the ticket title).
   * @param p.evidenceBundle  Evidence items to include in the PR body.
   */
  createPr(p: {
    ticketId: string;
    ticketNumber: number;
    repoPath: string;
    branch: string;
    baseBranch: string;
    title: string;
    evidenceBundle: ReadonlyArray<{
      evidenceType: string;
      summary: string;
      acId?: string;
    }>;
  }): PrCreateResult;
}

// ---------------------------------------------------------------------------
// H3 — injectable CI polling seam
// ---------------------------------------------------------------------------

/**
 * Outcome of a CI gate poll. `"green"` means all checks passed; `"red"` means at
 * least one check failed (caller should auto-reject); `"timeout"` means checks
 * are still pending after max attempts (caller should surface and proceed).
 */
export type CiGateOutcome = "green" | "red" | "timeout" | "skipped";

/**
 * A failing CI check record (for the auto-reject evidence).
 */
export interface CiFailingCheck {
  name: string;
  url?: string;
}

/**
 * Injectable seam for CI-gate polling (H3). The real implementation calls
 * `gh pr checks`; tests inject a `FakeCiGate` so no remote is needed.
 */
export interface CiGate {
  /**
   * Poll CI checks for the delivery branch and block until green, red, or
   * timeout (bounded by the implementation). Never throws.
   *
   * @param p.branch    The delivery branch to poll checks for.
   * @param p.repoPath  Local path of the primary write repo.
   * @param p.prUrl     The PR URL if already created (optional hint).
   */
  pollChecks(p: { branch: string; repoPath: string; prUrl?: string | null }): {
    outcome: CiGateOutcome;
    failingChecks?: CiFailingCheck[];
  };
}

export interface ImplementationLoopDeps {
  config: CrewConfig;
  policy: SafetyPolicy;
  repoRegistry: RepoRegistry;
  dispatch: DispatchClient;
  memory: MemoryClient;
  git: GitAdapter;
  runtime: AgentRuntime;
  events: EventLog;
  /** Optional skill registry; pre-filters skills into the context packet by stack. */
  skillRegistry?: SkillRegistry;
  /** Optional hook engine. When absent, the loop behaves exactly as before. */
  hooks?: HookRegistry;
  /**
   * H4: injectable PR creator. When absent, PR creation is skipped (today's
   * behaviour). Inject a real `GhPrCreator` (or `FakePrCreator` in tests) to
   * opt into real PR creation.
   */
  prCreator?: PrCreator;
  /**
   * H3: injectable CI gate. When absent, CI polling is skipped (today's
   * behaviour). Inject a real `GhCiGate` (or `FakeCiGate` in tests) to opt
   * into CI-aware gating.
   */
  ciGate?: CiGate;
}

export interface ImplementationLoopOptions {
  agentId: string;
  capabilities?: string[];
  /** When true, no real git mutation occurs (branch creation is logged only). */
  dryRun?: boolean;
}

export type ImplementationLoopOutcome =
  | { status: "no_ticket" }
  | { status: "claim_vetoed"; reason: string }
  | {
      status: "submitted_for_review" | "blocked" | "completed" | "ci_rejected";
      ticketId: string;
      ticketNumber: number;
      branch: string;
      packet: ContextPacket;
      evidenceIds: string[];
      /** H4: the created PR URL, when PR creation was attempted and succeeded. */
      prUrl?: string | null;
    };

/**
 * Run a hook point if a registry is present, else a no-op result. Centralises
 * the "behaves identically when no hooks registered" guarantee.
 */
function fireHook(
  deps: ImplementationLoopDeps,
  point: HookName,
  base: Omit<HookInput, "hook_name">,
): { vetoed: boolean; vetoReason?: string } {
  if (!deps.hooks || !deps.hooks.has(point)) return { vetoed: false };
  const result = deps.hooks.run({ hook_name: point, ...base });
  return { vetoed: result.vetoed, ...(result.vetoReason ? { vetoReason: result.vetoReason } : {}) };
}

/**
 * One tick of the implementation loop:
 *   claim → packet → branch (prefixed) → agent runtime → evidence → submit.
 * Returns `no_ticket` when nothing is claimable. Every step records a runtime
 * event so the full path is observable.
 */
export function runImplementationLoop(
  opts: ImplementationLoopOptions,
  deps: ImplementationLoopDeps,
): ImplementationLoopOutcome {
  // on_failure — only wrap when hooks are present, so behaviour is identical
  // (no extra try/catch frame) when no hook engine is wired.
  if (!deps.hooks) return runImplementationLoopInner(opts, deps);
  try {
    return runImplementationLoopInner(opts, deps);
  } catch (err) {
    const event = deps.events.record("on_failure", {
      agentId: opts.agentId,
      error: err instanceof Error ? err.message : String(err),
    });
    deps.hooks.run({
      hook_name: "on_failure",
      factory: { name: deps.config.factory.name, mode: deps.config.factory.mode },
      agent: { id: opts.agentId, capabilities: opts.capabilities ?? [] },
      event,
    });
    throw err;
  }
}

function runImplementationLoopInner(
  opts: ImplementationLoopOptions,
  deps: ImplementationLoopDeps,
): ImplementationLoopOutcome {
  const { events } = deps;
  events.record("loop_started", { loop: "implementation", agentId: opts.agentId });

  const factory = { name: deps.config.factory.name, mode: deps.config.factory.mode };
  const agent = { id: opts.agentId, capabilities: opts.capabilities ?? [] };

  // before_claim — hooks may veto the claim (the only vetoable point).
  const next: ReadyTicket | undefined = deps.dispatch.listReady()[0];
  const beforeClaim = fireHook(deps, "before_claim", {
    factory,
    agent,
    ...(next
      ? {
          ticket: {
            id: next.ticketId,
            number: next.number,
            title: next.title,
            riskLevel: next.riskLevel,
          },
        }
      : {}),
  });
  if (beforeClaim.vetoed) {
    const reason = beforeClaim.vetoReason ?? "Claim vetoed by a before_claim hook.";
    events.record("loop_finished", { loop: "implementation", result: "claim_vetoed", reason });
    return { status: "claim_vetoed", reason };
  }

  // No ready ticket to preselect → nothing to claim.
  if (!next) {
    events.record("loop_finished", { loop: "implementation", result: "no_ticket" });
    return { status: "no_ticket" };
  }

  const ttl = deps.config.loops.implementation.claim_ttl_seconds;
  // Claim the EXACT ticket the before_claim hook evaluated, not whatever
  // claimNextTicket would surface — otherwise the hook can veto/approve one
  // ticket while a different one gets worked on. Mirrors the bash runner's
  // preselect-then-claim flow.
  const claim = deps.dispatch.claimTicket({
    ticketId: next.ticketId,
    agentId: opts.agentId,
    ttlSeconds: ttl,
    ...(opts.capabilities ? { capabilities: opts.capabilities } : {}),
  });

  if (!claim) {
    events.record("loop_finished", { loop: "implementation", result: "no_ticket" });
    return { status: "no_ticket" };
  }

  events.record("ticket_claimed", { ticketId: claim.ticketId, number: claim.number });
  deps.dispatch.heartbeat(claim.claimToken);

  const claimedBundle = deps.dispatch.getTicket(claim.ticketId);
  const hookTicket = {
    id: claim.ticketId,
    number: claim.number,
    title: claimedBundle.ticket.title,
    riskLevel: claimedBundle.ticket.riskLevel,
  };

  // after_claim
  fireHook(deps, "after_claim", { factory, agent, ticket: hookTicket });

  // before_context_packet
  fireHook(deps, "before_context_packet", { factory, agent, ticket: hookTicket });

  const packet = buildContextPacket(claim.ticketId, deps);
  events.record("context_packet_built", {
    ticketId: claim.ticketId,
    repos: packet.repositories.map((r) => r.name),
    loreCount: packet.relevantLore.length,
    skillCount: packet.skills.length,
    stacks: packet.stacks,
    tokenEstimate: packet.tokens.total,
    tokensBySection: packet.tokens.bySection,
    fingerprint: packet.fingerprint,
  });

  // after_context_packet
  fireHook(deps, "after_context_packet", {
    factory,
    agent,
    ticket: hookTicket,
    context_packet: packet,
  });

  const branch = createBranch(claim.ticketId, packet, opts, deps);

  // before_implementation
  fireHook(deps, "before_implementation", {
    factory,
    agent,
    ticket: hookTicket,
    context_packet: packet,
  });

  const result = deps.runtime.run(packet);

  // after_tests — runs once the agent (which runs checks) has produced a result.
  fireHook(deps, "after_tests", { factory, agent, ticket: hookTicket, context_packet: packet });

  if (result.status === "blocked") {
    const reason = result.blockedReason ?? "Agent reported the ticket as blocked.";
    deps.dispatch.markBlocked({ claimToken: claim.claimToken, ticketId: claim.ticketId, reason });
    events.record("ticket_blocked", { ticketId: claim.ticketId, reason });
    // on_blocked
    fireHook(deps, "on_blocked", { factory, agent, ticket: hookTicket, context_packet: packet });
    return {
      status: "blocked",
      ticketId: claim.ticketId,
      ticketNumber: claim.number,
      branch,
      packet,
      evidenceIds: [],
    };
  }

  // Verify the agent only wrote inside the ticket's write set (FG-009). A change
  // that landed on a read-only repo, or outside every in-scope repo, fails the
  // loop BEFORE any clean delivery is recorded — the same root logic the runtime
  // safety hook enforces (classifyRootAccess over write/read roots).
  const writeRepos = packet.workScope.writeRepos;
  const offending = findOutsideWriteSet(result.changedPaths ?? [], packet.workScope);
  if (offending.length > 0) {
    const reason = summariseOutsideWriteSet(offending);
    deps.dispatch.markBlocked({ claimToken: claim.claimToken, ticketId: claim.ticketId, reason });
    events.record("write_set_violation", {
      ticketId: claim.ticketId,
      violations: offending.map((o) => ({ path: o.path, access: o.access })),
      reason,
    });
    fireHook(deps, "on_blocked", { factory, agent, ticket: hookTicket, context_packet: packet });
    events.record("loop_finished", { loop: "implementation", result: "blocked" });
    return {
      status: "blocked",
      ticketId: claim.ticketId,
      ticketNumber: claim.number,
      branch,
      packet,
      evidenceIds: [],
    };
  }

  // Write the delivery branch back to Dispatch so done-gates that require a
  // branch on the ticket (factory_strict/regulated) can see it, and reviewers
  // read the branch from Dispatch rather than grepping. Parity with the bash
  // runner's recordDeliveryArtifact step.
  deps.dispatch.recordDeliveryArtifact({
    claimToken: claim.claimToken,
    ticketId: claim.ticketId,
    branchName: branch,
  });
  events.record("delivery_artifact_recorded", { ticketId: claim.ticketId, branch });

  // Per-repo delivery (FG-009): record one delivery row per WRITE repo so a
  // mapped multi-repo ticket carries a branch/status for each repo it touched,
  // and a single unmapped repo records exactly one. Read-only repos are never a
  // delivery target. The clean delivery is only recorded once the write-set
  // guard above has passed.
  for (const repo of writeRepos) {
    deps.dispatch.recordRepoDelivery({
      ticketId: claim.ticketId,
      repoId: repo.id,
      branchName: branch,
      status: "review_ready",
    });
  }
  events.record("repo_deliveries_recorded", {
    ticketId: claim.ticketId,
    repoIds: writeRepos.map((r) => r.id),
    count: writeRepos.length,
  });

  const evidenceIds: string[] = [];
  for (const item of result.evidence) {
    const recorded = deps.dispatch.recordEvidence({
      claimToken: claim.claimToken,
      ticketId: claim.ticketId,
      ...(item.acId ? { acId: item.acId } : {}),
      evidenceType: item.evidenceType,
      summary: item.summary,
      ...(item.uri ? { uri: item.uri } : {}),
      ...(item.payload !== undefined ? { payload: item.payload } : {}),
    });
    evidenceIds.push(recorded.evidenceId);
  }
  events.record("evidence_recorded", { ticketId: claim.ticketId, count: evidenceIds.length });

  // ── H4: real PR creation (opt-in via prCreator dep) ─────────────────────────
  // When a PrCreator is injected, attempt to open a GitHub PR for this delivery
  // branch now — after evidence is recorded (so the PR body has content) but
  // before submitForReview (so the pr_url is on the ticket when it enters review).
  // Always best-effort: a failure is recorded in the event log but never blocks
  // the delivery or alters the ticket status.
  let prUrl: string | null = null;
  if (deps.prCreator) {
    const primary = packet.repositories[0];
    const prResult = deps.prCreator.createPr({
      ticketId: claim.ticketId,
      ticketNumber: claim.number,
      repoPath: primary?.path ?? "",
      branch,
      baseBranch: primary?.defaultBranch ?? "main",
      title: packet.ticket.title,
      evidenceBundle: result.evidence.map((e) => ({
        evidenceType: e.evidenceType,
        summary: e.summary,
        ...(e.acId ? { acId: e.acId } : {}),
      })),
    });
    prUrl = prResult.prUrl;
    events.record("pr_creation_attempted", {
      ticketId: claim.ticketId,
      prUrl,
      summary: prResult.summary,
    });
    if (prUrl) {
      // Record the PR URL back onto the ticket so the done-gate and reviewer
      // can resolve the PR from Dispatch rather than grepping git.
      deps.dispatch.recordDeliveryArtifact({
        ticketId: claim.ticketId,
        branchName: branch,
        prUrl,
      });
      events.record("pr_url_recorded", { ticketId: claim.ticketId, prUrl });
    }
  }

  // ── H3: CI-aware review gate (opt-in via ciGate dep) ─────────────────────────
  // When a CiGate is injected, poll CI checks for the delivery branch and hold
  // the ticket in an awaiting_ci sub-state (internally — no Dispatch status
  // change) until checks are green. If CI goes red, auto-reject back to rework
  // with the failing check as evidence. On timeout, surface and proceed.
  // Always best-effort: flag off (no ciGate) = today's behaviour.
  if (deps.ciGate) {
    events.record("ci_gate_started", { ticketId: claim.ticketId, branch });
    const ciResult = deps.ciGate.pollChecks({
      branch,
      repoPath: packet.repositories[0]?.path ?? "",
      prUrl,
    });
    events.record("ci_gate_finished", {
      ticketId: claim.ticketId,
      branch,
      outcome: ciResult.outcome,
      failingChecks: ciResult.failingChecks ?? [],
    });

    if (ciResult.outcome === "red") {
      // CI failed → auto-reject back to rework; never enter the human review lane.
      const failDetail =
        ciResult.failingChecks && ciResult.failingChecks.length > 0
          ? ciResult.failingChecks.map((c) => `${c.name}${c.url ? ` (${c.url})` : ""}`).join(", ")
          : "unknown failing check";
      const reason = `H3: CI checks failed on branch ${branch} — ${failDetail}`;
      deps.dispatch.recordEvidence({
        claimToken: claim.claimToken,
        ticketId: claim.ticketId,
        evidenceType: "test_output",
        summary: `CI FAIL: ${failDetail}`,
      });
      deps.dispatch.markBlocked({
        claimToken: claim.claimToken,
        ticketId: claim.ticketId,
        reason,
      });
      events.record("ci_rejected", { ticketId: claim.ticketId, reason, failDetail });
      events.record("loop_finished", { loop: "implementation", result: "ci_rejected" });
      return {
        status: "ci_rejected",
        ticketId: claim.ticketId,
        ticketNumber: claim.number,
        branch,
        packet,
        evidenceIds,
        prUrl,
      };
    }

    if (ciResult.outcome === "timeout") {
      // CI still pending: surface via evidence and proceed to review so a human
      // can watch CI finish.
      deps.dispatch.recordEvidence({
        claimToken: claim.claimToken,
        ticketId: claim.ticketId,
        evidenceType: "manual_note",
        summary: `H3: CI checks still pending after max poll attempts — proceeding to human review; CI may still be running on branch ${branch}`,
      });
      events.record("ci_timeout_surfaced", { ticketId: claim.ticketId, branch });
    }
    // outcome === "green" or "skipped" → fall through to submitForReview.
  }

  if (deps.config.loops.implementation.submit_for_review) {
    // Verifiable delivery post-conditions: re-derive from the delivery's own
    // facts that required steps actually happened, instead of trusting them. A
    // failed required post-condition blocks the delivery rather than submitting.
    const postConditions = deps.config.loops.implementation.post_conditions;
    if (postConditions.enabled) {
      const primary = packet.repositories[0];
      const report = checkPostConditions({
        branch,
        ticketNumber: packet.ticket.number,
        gitPolicy: deps.policy.git,
        acceptanceCriteria: packet.acceptanceCriteria.map((ac) => ({ id: ac.id, text: ac.text })),
        evidence: result.evidence.map((e) => ({ acId: e.acId, evidenceType: e.evidenceType })),
        lintConfigured: Boolean(primary?.lintCommand),
        requirements: {
          branchPrefix: postConditions.require_branch_prefix,
          testEvidence: postConditions.require_test_evidence,
          acEvidence: postConditions.require_ac_evidence,
          lintClean: postConditions.require_lint_clean,
        },
      });
      if (!report.passed) {
        const reason = `Delivery blocked: required post-condition(s) not met — ${summarisePostConditionFailures(report)}`;
        deps.dispatch.markBlocked({
          claimToken: claim.claimToken,
          ticketId: claim.ticketId,
          reason,
        });
        events.record("postconditions_failed", {
          ticketId: claim.ticketId,
          failures: report.failures.map((f) => f.id),
          reason,
        });
        fireHook(deps, "on_blocked", {
          factory,
          agent,
          ticket: hookTicket,
          context_packet: packet,
        });
        events.record("loop_finished", { loop: "implementation", result: "blocked" });
        return {
          status: "blocked",
          ticketId: claim.ticketId,
          ticketNumber: claim.number,
          branch,
          packet,
          evidenceIds,
        };
      }
      events.record("postconditions_passed", {
        ticketId: claim.ticketId,
        checks: report.checks.map((c) => c.id),
      });
    }

    // before_submit_review — advisory checks (e.g. require evidence/PR/diff).
    fireHook(deps, "before_submit_review", {
      factory,
      agent,
      ticket: hookTicket,
      context_packet: packet,
    });
    deps.dispatch.submitForReview({
      claimToken: claim.claimToken,
      ticketId: claim.ticketId,
      reason: result.summary,
    });
    events.record("ticket_submitted_for_review", { ticketId: claim.ticketId });
  }

  // after_ticket_done — the natural close of a unit of work. Advisory only: the
  // capture-lore-reflection hook prompts (once) for any durable lore the agent
  // should record via `suggest_lore`. Fired before forwarding the agent's own
  // suggestions so the reflection point is observable even when none surfaced.
  fireHook(deps, "after_ticket_done", {
    factory,
    agent,
    ticket: hookTicket,
    context_packet: packet,
  });

  // Suggest (never approve) durable lore if the agent surfaced any.
  if (deps.config.memory.enabled && result.loreSuggestions) {
    for (const suggestion of result.loreSuggestions) {
      deps.memory.suggestLore({
        title: suggestion.title,
        summary: suggestion.summary,
        ...(suggestion.tags ? { tags: suggestion.tags } : {}),
        sourceTicketId: claim.ticketId,
      });
      events.record("lore_suggested", { ticketId: claim.ticketId, title: suggestion.title });
    }
  }

  // Ticket → lore distillation (Track 1c). The ticket's product intent — WHY it
  // was built, distilled from its title + AC — evaporates at close otherwise.
  // Harvest a decision/requirement DRAFT so the "why" survives the ticket. Draft
  // only (human-gated via `suggest_lore`); never auto-promoted. Runs regardless
  // of whether the agent surfaced its own suggestions.
  if (deps.config.memory.enabled) {
    const repoName = packet.repositories[0]?.name ?? factory.name;
    const distilled = distillTicketIntent(repoName, {
      number: packet.ticket.number,
      title: packet.ticket.title,
      description: packet.ticket.description,
      acceptanceCriteria: packet.acceptanceCriteria.map((ac) => ({
        text: ac.text,
        status: ac.status,
      })),
      ...(result.summary ? { outcomeSummary: result.summary } : {}),
    });
    for (const suggestion of distilled) {
      deps.memory.suggestLore({
        title: suggestion.title,
        summary: suggestion.summary,
        ...(suggestion.tags ? { tags: suggestion.tags } : {}),
        ...(suggestion.kind ? { kind: suggestion.kind } : {}),
        sourceTicketId: claim.ticketId,
      });
      events.record("ticket_intent_distilled", {
        ticketId: claim.ticketId,
        title: suggestion.title,
        kind: suggestion.kind,
      });
    }
  }

  events.record("loop_finished", { loop: "implementation", result: result.status });
  // Include prUrl in the outcome whenever a PrCreator was present (even if it
  // returned null, so callers can distinguish "not attempted" from "attempted but
  // no remote"). When no PrCreator is injected the field is absent.
  const prUrlField = deps.prCreator !== undefined ? { prUrl } : {};
  return {
    status: result.status,
    ticketId: claim.ticketId,
    ticketNumber: claim.number,
    branch,
    packet,
    evidenceIds,
    ...prUrlField,
  };
}

/** A changed path that fell outside the ticket's write set, with its classification. */
interface WriteSetViolation {
  path: string;
  access: "read" | "outside";
}

/**
 * Derive the FG-007 {@link RootSet} from a packet's work scope: write-roots are
 * the resolved paths of the WRITE repos; read-roots are the READ-ONLY + TEST
 * repos. Repos with no resolved local path can't be classified against, so they
 * are skipped (they contribute no root).
 */
function rootSetFromWorkScope(workScope: ContextPacket["workScope"]): RootSet {
  const paths = (repos: PacketWorkRepo[]): string[] =>
    repos.map((r) => r.path).filter((p): p is string => Boolean(p));
  return {
    writeRoots: paths(workScope.writeRepos),
    readRoots: [...paths(workScope.readOnlyRepos), ...paths(workScope.testRepos)],
  };
}

/**
 * Classify every changed path against the ticket's write/read roots (FG-009) and
 * return those that are NOT writable — a path inside a read-only/test repo
 * ("read") or outside every in-scope repo ("outside"). An empty result means the
 * agent stayed within its write set.
 */
function findOutsideWriteSet(
  changedPaths: readonly string[],
  workScope: ContextPacket["workScope"],
): WriteSetViolation[] {
  const roots = rootSetFromWorkScope(workScope);
  const violations: WriteSetViolation[] = [];
  for (const path of changedPaths) {
    const access = classifyRootAccess(path, roots);
    if (access !== "write") violations.push({ path, access });
  }
  return violations;
}

/** Human-readable one-line reason for a write-set violation, for markBlocked. */
function summariseOutsideWriteSet(violations: readonly WriteSetViolation[]): string {
  const detail = violations.map((v) => `${v.path} (${v.access})`).join(", ");
  return `Delivery blocked: agent changed ${violations.length} path(s) outside the ticket's write set — ${detail}`;
}

function createBranch(
  ticketId: string,
  packet: ContextPacket,
  opts: ImplementationLoopOptions,
  deps: ImplementationLoopDeps,
): string {
  const primary = packet.repositories[0];
  const branch =
    primary?.branchPolicy.suggestedBranch ??
    `${deps.policy.git.require_branch_prefix}ticket-${packet.ticket.number}`;

  const decision = checkBranchPolicy(branch, deps.policy.git);
  if (!decision.allowed) {
    deps.events.record("safety_check_denied", {
      action: "create_branch",
      branch,
      reason: decision.reason,
    });
    throw new CrewError("BRANCH_POLICY_DENIED", decision.reason, { branch, ticketId });
  }

  // Branch every WRITE repo, never the read-only/test repos (FG-009). For a
  // single unmapped repo this is exactly one branch (today's behaviour); a mapped
  // multi-write ticket gets a branch in each write repo. The default branch is
  // taken from the matching configured repo where known, else the primary's.
  const defaultBranchFor = (repoName: string): string =>
    packet.repositories.find((r) => r.name === repoName)?.defaultBranch ??
    primary?.defaultBranch ??
    "main";

  const branchTargets =
    packet.workScope.writeRepos.length > 0
      ? packet.workScope.writeRepos.map((r) => ({
          path: r.path,
          defaultBranch: defaultBranchFor(r.name),
        }))
      : primary
        ? [{ path: primary.path, defaultBranch: primary.defaultBranch }]
        : [];

  for (const target of branchTargets) {
    if (!target.path) continue;
    if (opts.dryRun) {
      // Dry-run adapter records the branch without touching the real repo.
      deps.git.createBranch(target.path, branch, target.defaultBranch);
    } else if (!deps.git.branchExists(target.path, branch)) {
      deps.git.createBranch(target.path, branch, target.defaultBranch);
    }
  }

  deps.events.record("branch_created", { ticketId, branch, dryRun: opts.dryRun ?? false });
  return branch;
}

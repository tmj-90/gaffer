import { checkBranchPolicy } from "../safety/branchPolicy.js";
import { checkPostConditions, summarisePostConditionFailures } from "../safety/postconditions.js";
import { classifyRootAccess, type RootSet } from "../safety/rootAccess.js";
import { CrewError } from "../util/errors.js";
import { buildContextPacket, type ContextPacket, type PacketWorkRepo } from "../context/packet.js";
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
      status: "submitted_for_review" | "blocked" | "completed";
      ticketId: string;
      ticketNumber: number;
      branch: string;
      packet: ContextPacket;
      evidenceIds: string[];
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

  events.record("loop_finished", { loop: "implementation", result: result.status });
  return {
    status: result.status,
    ticketId: claim.ticketId,
    ticketNumber: claim.number,
    branch,
    packet,
    evidenceIds,
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

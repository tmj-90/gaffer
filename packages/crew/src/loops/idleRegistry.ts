import { runIdleCoverageLoop, type IdleLoopDeps } from "./idleLoop.js";
import { runIdleDependencyLoop } from "./idleDependencies.js";
import { runIdleDocsLoop } from "./idleDocs.js";
import { runIdleLoreGapLoop, type IdleLoreGapDeps } from "./idleLoreGap.js";
import { runIdleFeatureBacklogLoop, type IdleFeatureBacklogDeps } from "./idleFeatureBacklog.js";
import { runIdleSecurityHotspotLoop } from "./idleSecurityHotspot.js";
import { runIdleTechDebtLoop } from "./idleTechDebt.js";
import { runIdleTestQualityLoop } from "./idleTestQuality.js";
import { runIdleTypeQualityLoop } from "./idleTypeQuality.js";
import { SelfImproveGate } from "./selfImprove.js";
import type { IdleScanOutcome } from "./idleScans.js";

/** A normalised outcome the registry reports for every idle loop. */
export type IdleLoopRunOutcome =
  | { status: "skipped_tickets_ready" }
  | { status: "no_repos" }
  | { status: "no_findings" }
  | { status: "draft_created"; draftCount: number }
  | { status: "ready_created"; draftCount: number }
  | { status: "observed"; observationCount: number }
  | { status: "suggested"; suggestionCount: number };

export interface IdleLoopDefinition {
  /** Stable id, matched against config to decide whether the loop runs. */
  id: IdleLoopId;
  /** Whether this loop is enabled in config. */
  enabled(deps: IdleLoopDeps): boolean;
  run(deps: IdleLoopDeps): IdleLoopRunOutcome;
}

export type IdleLoopId =
  | "coverage"
  | "test_quality"
  | "type_quality"
  | "documentation"
  | "dependency_hygiene"
  | "security_hotspot"
  | "tech_debt"
  | "lore_gap"
  | "design_drift";

/** Coverage loop returns its own outcome shape; normalise it like the scans. */
function normalizeCoverage(deps: IdleLoopDeps): IdleLoopRunOutcome {
  const outcome = runIdleCoverageLoop(deps);
  if (outcome.status === "draft_created" || outcome.status === "ready_created") {
    return { status: outcome.status, draftCount: outcome.drafts.length };
  }
  if (outcome.status === "observed") {
    return { status: "observed", observationCount: outcome.observations.length };
  }
  return { status: outcome.status };
}

function normalizeScan(outcome: IdleScanOutcome): IdleLoopRunOutcome {
  if (outcome.status === "draft_created" || outcome.status === "ready_created") {
    return { status: outcome.status, draftCount: outcome.drafts.length };
  }
  if (outcome.status === "observed") {
    return { status: "observed", observationCount: outcome.observations.length };
  }
  return { status: outcome.status };
}

/**
 * The built-in SYNC idle loops. These only ever create DRAFT tickets.
 *
 * `lore_gap` is implemented but ASYNC (it queries the real Memory MCP client)
 * so it is NOT in this sync array — it runs via {@link runIdleLoreGap} from the
 * async entry points, behind `loops.idle_lore_gap.enabled`. `design_drift`
 * remains a TODO stub — it needs Memory boundary definitions.
 */
export const IDLE_LOOPS: readonly IdleLoopDefinition[] = [
  {
    id: "coverage",
    enabled: (d) => d.config.loops.idle_coverage.enabled,
    run: (d) => normalizeCoverage(d),
  },
  {
    id: "test_quality",
    enabled: (d) => d.config.loops.idle_test_quality.enabled,
    run: (d) => normalizeScan(runIdleTestQualityLoop(d)),
  },
  {
    id: "type_quality",
    enabled: (d) => d.config.loops.idle_type_quality.enabled,
    run: (d) => normalizeScan(runIdleTypeQualityLoop(d)),
  },
  {
    id: "documentation",
    enabled: (d) => d.config.loops.idle_documentation.enabled,
    run: (d) => normalizeScan(runIdleDocsLoop(d)),
  },
  {
    id: "dependency_hygiene",
    enabled: (d) => d.config.loops.idle_dependencies.enabled,
    run: (d) => normalizeScan(runIdleDependencyLoop(d)),
  },
  {
    id: "security_hotspot",
    enabled: (d) => d.config.loops.idle_security_hotspot.enabled,
    run: (d) => normalizeScan(runIdleSecurityHotspotLoop(d)),
  },
  {
    id: "tech_debt",
    enabled: (d) => d.config.loops.idle_tech_debt.enabled,
    run: (d) => normalizeScan(runIdleTechDebtLoop(d)),
  },
  // TODO(memory): design-drift scan needs Memory boundary definitions.
];

export interface IdleRunReport {
  loops: Array<{ id: IdleLoopId; outcome: IdleLoopRunOutcome }>;
  totalDrafts: number;
  /** How many drafts the self-improve gate auto-promoted to ready this tick. */
  selfImprovePromoted: number;
}

/**
 * Run every enabled idle loop in order and aggregate the outcomes. This is the
 * entry point for `crew idle` and the `on_idle` hook. Each loop applies
 * its own "skip when tickets ready" guard, so a busy queue means every loop
 * reports `skipped_tickets_ready`.
 */
export function runIdleLoops(deps: IdleLoopDeps): IdleRunReport {
  deps.events.record("idle_registry_started", {});
  // One gate per tick so the per-tick cap spans every loop. Reuse a gate passed
  // in by the caller (e.g. tests) if present; otherwise build it from config.
  const selfImprove = deps.selfImprove ?? SelfImproveGate.fromConfig(deps.config, deps.events);
  const runDeps: IdleLoopDeps = { ...deps, selfImprove };
  const loops: Array<{ id: IdleLoopId; outcome: IdleLoopRunOutcome }> = [];
  let totalDrafts = 0;

  for (const def of IDLE_LOOPS) {
    if (!def.enabled(runDeps)) continue;
    const outcome = def.run(runDeps);
    if (outcome.status === "draft_created" || outcome.status === "ready_created") {
      totalDrafts += outcome.draftCount;
    }
    loops.push({ id: def.id, outcome });
  }

  const selfImprovePromoted = selfImprove.promotedCount;
  deps.events.record("idle_registry_finished", {
    ranLoops: loops.length,
    totalDrafts,
    selfImprovePromoted,
  });
  return { loops, totalDrafts, selfImprovePromoted };
}

/**
 * Run the ASYNC lore-gap idle loop when enabled in config. Kept separate from
 * the sync registry because it depends on the async Memory MCP client. Wired
 * in at the async CLI/MCP entry points; behind `loops.idle_lore_gap.enabled`.
 */
export async function runIdleLoreGap(
  deps: IdleLoreGapDeps,
): Promise<{ id: "lore_gap"; outcome: IdleLoopRunOutcome } | null> {
  if (!deps.config.loops.idle_lore_gap.enabled) return null;
  const outcome = await runIdleLoreGapLoop(deps);
  if (outcome.status === "suggested") {
    return {
      id: "lore_gap",
      outcome: { status: "suggested", suggestionCount: outcome.suggestions.length },
    };
  }
  return { id: "lore_gap", outcome };
}

/**
 * Run the ASYNC feature-backlog idle loop when enabled. Pulls ONE `backlog`
 * feature from the memory ledger and files it as a planned epic (respecting the
 * configured idle mode + the human gate). Kept separate from the sync registry
 * because it depends on the async memory MCP client and the brownfield
 * decomposer; wired at the async CLI/MCP entry points behind
 * `loops.idle_feature_backlog.enabled`. Best-effort: a failure is reported, never
 * thrown.
 */
export async function runIdleFeatureBacklog(
  deps: IdleFeatureBacklogDeps,
): Promise<{ id: "feature_backlog"; outcome: IdleLoopRunOutcome } | null> {
  if (!deps.config.loops.idle_feature_backlog.enabled) return null;
  const outcome = await runIdleFeatureBacklogLoop(deps);
  if (outcome.status === "draft_created" || outcome.status === "ready_created") {
    return {
      id: "feature_backlog",
      outcome: { status: outcome.status, draftCount: outcome.ticketCount },
    };
  }
  if (outcome.status === "observed") {
    return { id: "feature_backlog", outcome: { status: "observed", observationCount: 1 } };
  }
  // The remaining variants (skipped_tickets_ready / no_repos / no_findings) carry
  // no extra payload and map straight onto the registry's normalised outcome.
  return { id: "feature_backlog", outcome: { status: outcome.status } };
}

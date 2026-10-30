import { resolveDecomposer } from "../adapters/decomposerFactory.js";
import type { Decomposer } from "../adapters/decomposer.js";
import type { CrewConfig } from "../config/schema.js";
import { ingestGithubIssues } from "../ingest/githubIssues.js";
import { ingestJiraIssues } from "../ingest/jiraIssues.js";
import type { IngestSummary } from "../ingest/core.js";
import type { EventLog } from "../events/eventLog.js";
import { resolveAsyncMemory } from "../memory/factory.js";
import type { AsyncMemoryClient } from "../memory/mcpClient.js";
import { withDispatchRepos } from "../registry/dispatchRepos.js";
import type { IdleLoopDeps } from "./idleLoop.js";
import { buildOracleSet } from "./oracles/build.js";
import {
  runIdleFeatureBacklog,
  runIdleLoops,
  runIdleLoreGap,
  runMaintenanceLane,
  type IdleLoopRunOutcome,
  type IdleRunReport,
  type MaintenanceLaneReport,
} from "./idleRegistry.js";

/**
 * ONE idle tick — the body `crew idle` and the crew-mcp `run_idle_loop` tool both
 * run, so the two surfaces cannot drift apart again. (They used to: the MCP path
 * scanned crew.yaml's repos only and skipped ingest, so on a dashboard-onboarded
 * factory it answered `no_repos` forever while `crew idle` drafted work.)
 *
 * Order: merge Dispatch's repo registry into crew.yaml's (what onboarding writes),
 * ingest labelled GitHub / Jira issues (each guarded by its config switch), run
 * every enabled sync idle loop, then the async lore-gap and feature-backlog loops
 * when a real Memory (and, for the backlog, a decomposer) is configured.
 *
 * {@link runMaintenanceTick} is the same tick for the MAINTENANCE LANE (`crew
 * maintain`, the default idle path): ingest, ONE scheduler-chosen scan lane, then
 * the same async loops — so ingest, the lore gap and the feature backlog run on
 * the recommended setup too, not only on the legacy every-loop scan.
 */
export interface IdleTickDeps extends Omit<IdleLoopDeps, "selfImprove"> {
  /** Test seam; defaults to {@link resolveAsyncMemory}. */
  resolveMemory?: (config: CrewConfig, events: EventLog) => Promise<AsyncMemoryClient | null>;
  /** Test seam; defaults to {@link resolveDecomposer}. */
  resolveDecomposer?: (config: CrewConfig) => Decomposer | null;
}

/** What the ingest + async-loop half of an idle tick produced. */
interface IdleExtras {
  /** GitHub ingest summary, or null when `ingest.github.enabled` is false. */
  ingest: IngestSummary | null;
  /** Jira ingest summary, or null when `ingest.jira.enabled` is false. */
  jira: IngestSummary | null;
  loreGap: { id: "lore_gap"; outcome: IdleLoopRunOutcome } | null;
  featureBacklog: { id: "feature_backlog"; outcome: IdleLoopRunOutcome } | null;
  /**
   * True when the tick invoked a model-backed step (the feature-backlog
   * decomposer spawns a planning `claude -p`), whatever it produced. The runner
   * counts such a tick against MAX_TICKS_PER_DAY even when it filed nothing; every
   * other idle step is a local scan that costs nothing.
   */
  spent: boolean;
}

export interface IdleTickResult extends IdleExtras {
  report: IdleRunReport;
  /** Ids of the repos this tick could scan (crew.yaml + Dispatch, merged). */
  repoIds: string[];
  /** Tickets, epic tickets and memory suggestions this tick filed (see {@link countFiled}). */
  filed: number;
}

export interface MaintenanceTickResult extends IdleExtras {
  report: MaintenanceLaneReport;
  /** Tickets, epic tickets and memory suggestions this tick filed (see {@link countFiled}). */
  filed: number;
}

/** Build the shared deps for one idle tick (merged repos + oracles). */
function idleBaseDeps(deps: IdleTickDeps): IdleLoopDeps {
  const { config, events } = deps;
  const env = deps.env ?? process.env;
  const repoRegistry = withDispatchRepos(deps.repoRegistry, deps.dispatch, events);
  // Tool-backed oracles only when `loops.oracles.enabled` (default off), and never
  // under strict containment unless GAFFER_IDLE_HOST_EXEC=1 (they run on the host).
  const oracles = deps.oracles ?? buildOracleSet(deps.runner, config, { env, events });
  return {
    config,
    repoRegistry,
    dispatch: deps.dispatch,
    runner: deps.runner,
    events,
    clock: deps.clock,
    env,
    ...(oracles ? { oracles } : {}),
  };
}

/** Pull labelled GitHub/Jira issues (each behind its own switch). */
function runIngest(base: IdleLoopDeps): Pick<IdleExtras, "ingest" | "jira"> {
  const { config } = base;
  const ingestDeps = {
    config,
    repoRegistry: base.repoRegistry,
    dispatch: base.dispatch,
    runner: base.runner,
    events: base.events,
  };
  return {
    ingest: config.ingest.github.enabled ? ingestGithubIssues(ingestDeps) : null,
    jira: config.ingest.jira.enabled ? ingestJiraIssues(ingestDeps) : null,
  };
}

/**
 * The async loops (lore gap, feature backlog). They share one live Memory client,
 * which is only spawned when one of them is enabled; each no-ops behind its own
 * switch. Records whether the decomposer (a model call) was invoked.
 */
async function runAsyncLoops(
  deps: IdleTickDeps,
  base: IdleLoopDeps,
): Promise<Pick<IdleExtras, "loreGap" | "featureBacklog" | "spent">> {
  const { config, events } = deps;
  let loreGap: IdleExtras["loreGap"] = null;
  let featureBacklog: IdleExtras["featureBacklog"] = null;
  let spent = false;
  if (!config.loops.idle_lore_gap.enabled && !config.loops.idle_feature_backlog.enabled) {
    return { loreGap, featureBacklog, spent };
  }
  const memory = await (deps.resolveMemory ?? resolveAsyncMemory)(config, events);
  if (!memory) {
    events.record("idle_async_loops_skipped", { reason: "no memory server reachable" });
    return { loreGap, featureBacklog, spent };
  }
  try {
    loreGap = await runIdleLoreGap({ ...base, memory });
    const decomposer = (deps.resolveDecomposer ?? resolveDecomposer)(config);
    if (decomposer) {
      const counted: Decomposer = {
        decompose: (request) => {
          spent = true;
          return decomposer.decompose(request);
        },
      };
      featureBacklog = await runIdleFeatureBacklog({ ...base, memory, decomposer: counted });
    } else if (config.loops.idle_feature_backlog.enabled) {
      events.record("idle_async_loops_skipped", {
        loop: "feature_backlog",
        reason:
          "no decomposer (loops.idle_feature_backlog.decompose_script / GAFFER_DECOMPOSE_SCRIPT)",
      });
    }
  } finally {
    await memory.close();
  }
  return { loreGap, featureBacklog, spent };
}

/** Drafts/ready tickets in a normalised outcome (0 for every other status). */
function draftsIn(outcome: IdleLoopRunOutcome | null | undefined): number {
  if (!outcome) return 0;
  return outcome.status === "draft_created" || outcome.status === "ready_created"
    ? outcome.draftCount
    : 0;
}

/**
 * Everything one idle tick FILED for a human (or, under self-improve, the delivery
 * loop) to act on: the scan drafts, ingested issues, the backlog epic's tickets and
 * the lore-gap suggestions. The runner reports a tick that filed something as a
 * productive idle result; one that filed nothing is an empty poll.
 */
function countFiled(scanDrafts: number, extras: IdleExtras): number {
  const lore = extras.loreGap?.outcome;
  return (
    scanDrafts +
    (extras.ingest?.ingested.length ?? 0) +
    (extras.jira?.ingested.length ?? 0) +
    draftsIn(extras.featureBacklog?.outcome) +
    (lore && lore.status === "suggested" ? lore.suggestionCount : 0)
  );
}

export async function runIdleTick(deps: IdleTickDeps): Promise<IdleTickResult> {
  const base = idleBaseDeps(deps);
  // Pull real labelled GitHub/Jira issues BEFORE the scan loops, so an idle tick
  // first ingests teammate-filed work, then scans.
  const ingested = runIngest(base);
  const report = runIdleLoops(base);
  const asyncLoops = await runAsyncLoops(deps, base);
  const extras: IdleExtras = { ...ingested, ...asyncLoops };
  return {
    ...extras,
    report,
    repoIds: base.repoRegistry.list().map((r) => r.id),
    filed: countFiled(report.totalDrafts, extras),
  };
}

/**
 * One MAINTENANCE-LANE idle tick (`crew maintain`). While the lane is off
 * (`loops.maintenance.enabled=false`, no `force`) it does nothing and reports
 * `disabled`. Otherwise: ingest, ONE scheduler-chosen scan lane
 * ({@link runMaintenanceLane}), then the async lore-gap / feature-backlog loops.
 */
export async function runMaintenanceTick(
  deps: IdleTickDeps,
  cursorPath: string,
  opts: { force?: boolean } = {},
): Promise<MaintenanceTickResult> {
  const base = idleBaseDeps(deps);
  const on = deps.config.loops.maintenance.enabled || opts.force === true;
  const ingested = on ? runIngest(base) : { ingest: null, jira: null };
  const report = runMaintenanceLane(base, cursorPath, opts);
  const asyncLoops = on
    ? await runAsyncLoops(deps, base)
    : { loreGap: null, featureBacklog: null, spent: false };
  const extras: IdleExtras = { ...ingested, ...asyncLoops };
  return { ...extras, report, filed: countFiled(draftsIn(report.outcome), extras) };
}

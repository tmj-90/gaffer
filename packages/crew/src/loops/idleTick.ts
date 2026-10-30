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
  type IdleLoopRunOutcome,
  type IdleRunReport,
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
 */
export interface IdleTickDeps extends Omit<IdleLoopDeps, "selfImprove"> {
  /** Test seam; defaults to {@link resolveAsyncMemory}. */
  resolveMemory?: (config: CrewConfig, events: EventLog) => Promise<AsyncMemoryClient | null>;
  /** Test seam; defaults to {@link resolveDecomposer}. */
  resolveDecomposer?: (config: CrewConfig) => Decomposer | null;
}

export interface IdleTickResult {
  /** GitHub ingest summary, or null when `ingest.github.enabled` is false. */
  ingest: IngestSummary | null;
  /** Jira ingest summary, or null when `ingest.jira.enabled` is false. */
  jira: IngestSummary | null;
  report: IdleRunReport;
  loreGap: { id: "lore_gap"; outcome: IdleLoopRunOutcome } | null;
  featureBacklog: { id: "feature_backlog"; outcome: IdleLoopRunOutcome } | null;
  /** Ids of the repos this tick could scan (crew.yaml + Dispatch, merged). */
  repoIds: string[];
}

export async function runIdleTick(deps: IdleTickDeps): Promise<IdleTickResult> {
  const { config, events } = deps;
  const repoRegistry = withDispatchRepos(deps.repoRegistry, deps.dispatch, events);
  // Tool-backed oracles only when `loops.oracles.enabled` (default off).
  const oracles = deps.oracles ?? buildOracleSet(deps.runner, config);
  const baseDeps: IdleLoopDeps = {
    config,
    repoRegistry,
    dispatch: deps.dispatch,
    runner: deps.runner,
    events,
    clock: deps.clock,
    ...(oracles ? { oracles } : {}),
  };

  // Pull real labelled GitHub/Jira issues BEFORE the scan loops, so an idle tick
  // first ingests teammate-filed work, then scans.
  const ingestDeps = { config, repoRegistry, dispatch: deps.dispatch, runner: deps.runner, events };
  const ingest = config.ingest.github.enabled ? ingestGithubIssues(ingestDeps) : null;
  const jira = config.ingest.jira.enabled ? ingestJiraIssues(ingestDeps) : null;

  const report = runIdleLoops(baseDeps);

  // Async loops share one live Memory client; each no-ops behind its own switch.
  let loreGap: IdleTickResult["loreGap"] = null;
  let featureBacklog: IdleTickResult["featureBacklog"] = null;
  const memory = await (deps.resolveMemory ?? resolveAsyncMemory)(config, events);
  if (memory) {
    try {
      loreGap = await runIdleLoreGap({ ...baseDeps, memory });
      const decomposer = (deps.resolveDecomposer ?? resolveDecomposer)(config);
      if (decomposer) {
        featureBacklog = await runIdleFeatureBacklog({ ...baseDeps, memory, decomposer });
      }
    } finally {
      await memory.close();
    }
  }

  return {
    ingest,
    jira,
    report,
    loreGap,
    featureBacklog,
    repoIds: repoRegistry.list().map((r) => r.id),
  };
}

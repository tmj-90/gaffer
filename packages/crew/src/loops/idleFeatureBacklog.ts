/**
 * Idle feature-backlog loop.
 *
 * In quiet times (no ready work in the queue), the factory pulls ONE `backlog`
 * feature from the memory feature ledger and turns it into a planned epic, so the
 * backlog grinds down autonomously. The lifecycle is `backlog → building →
 * shipped`; this loop claims a feature into `building`, decomposes it into a
 * brownfield epic plan, and files that epic through the SAME create-epic path the
 * other idle loops respect — gated by the configured idle mode:
 *
 *   observe_only          — report the candidate; file NOTHING; do NOT advance.
 *   create_draft_tickets  — advance to `building`; file the epic as DRAFTS (human gate).
 *   create_ready_tickets  — advance to `building`; file the epic READY (past the gate;
 *                           only honoured because the operator explicitly opted in).
 *
 * This loop is ASYNC (it queries the real memory MCP client + spawns the
 * decomposer) and lives outside the sync registry, wired at the async entry
 * points behind `loops.idle_feature_backlog.enabled`.
 *
 * Defensive + idempotent like the other idle loops:
 *  - only ONE feature is picked per tick;
 *  - the feature is advanced to `building` BEFORE decomposing so a concurrent tick
 *    can't pick it twice;
 *  - if decompose or create_epic fails, the feature is ROLLED BACK to `backlog`
 *    (never stranded in `building`);
 *  - a stable finding key makes the epic idempotent across ticks;
 *  - any failure is caught and reported — a bad tick never crashes the runtime.
 */
import { dateStamp } from "../util/clock.js";
import { findingKey } from "./idleScans.js";
import type { Clock } from "../util/clock.js";
import type { Decomposer, EpicPlan } from "../adapters/decomposer.js";
import type { IdleLoopDeps } from "./idleLoop.js";
import type { AsyncMemoryClient } from "../memory/mcpClient.js";
import type { BacklogFeature } from "../memory/client.js";
import type { IdleLoopMode, RepoConfig } from "../config/schema.js";

const LOOP = "feature_backlog";

export type IdleFeatureBacklogOutcome =
  | { status: "skipped_tickets_ready" }
  | { status: "no_repos" }
  | { status: "no_findings" }
  | { status: "observed"; feature: { repo: string; id: string; name: string } }
  | {
      status: "draft_created" | "ready_created";
      feature: { repo: string; id: string; name: string };
      epicId: string;
      ticketCount: number;
    };

export interface IdleFeatureBacklogDeps extends IdleLoopDeps {
  memory: AsyncMemoryClient;
  decomposer: Decomposer;
}

/**
 * Pick the single feature to work this tick. Order: lowest `priority` first when
 * present (lower = more urgent), then oldest by `createdAt`, then by id for a
 * deterministic tiebreak. Pure + exported so it is unit-testable.
 */
export function pickBacklogFeature(
  features: readonly BacklogFeature[],
): BacklogFeature | undefined {
  if (features.length === 0) return undefined;
  return [...features].sort(compareBacklogFeatures)[0];
}

function compareBacklogFeatures(a: BacklogFeature, b: BacklogFeature): number {
  const ap = a.priority ?? Number.POSITIVE_INFINITY;
  const bp = b.priority ?? Number.POSITIVE_INFINITY;
  if (ap !== bp) return ap - bp;
  const at = a.createdAt ?? "";
  const bt = b.createdAt ?? "";
  if (at !== bt) return at < bt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Repos in scope for the loop: the configured allow-list, or every onboarded repo. */
function scopedRepos(deps: IdleFeatureBacklogDeps, allow: readonly string[]): RepoConfig[] {
  return deps.repoRegistry.list().filter((r) => allow.length === 0 || allow.includes(r.name));
}

/**
 * Gather backlog features across every in-scope repo and pick ONE. Returns the
 * chosen feature, or undefined when the whole scope is empty. A per-repo lookup
 * failure is tolerated (logged) so one dead repo can't blank the whole tick.
 */
async function chooseFeature(
  deps: IdleFeatureBacklogDeps,
  repos: readonly RepoConfig[],
): Promise<BacklogFeature | undefined> {
  const all: BacklogFeature[] = [];
  for (const repo of repos) {
    try {
      const features = await deps.memory.listBacklogFeatures(repo.name, "backlog");
      all.push(...features);
    } catch (err) {
      deps.events.record("feature_backlog_list_failed", {
        loop: LOOP,
        repoName: repo.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return pickBacklogFeature(all);
}

/**
 * Run one tick of the idle feature-backlog loop. Skips when the queue has ready
 * work (the factory is busy) or when no backlog features exist. Catches every
 * failure so a bad tick reports `no_findings` instead of crashing.
 */
export async function runIdleFeatureBacklogLoop(
  deps: IdleFeatureBacklogDeps,
): Promise<IdleFeatureBacklogOutcome> {
  deps.events.record("loop_started", { loop: LOOP });

  if (deps.dispatch.listReady().length > 0) {
    deps.events.record("loop_finished", { loop: LOOP, result: "skipped_tickets_ready" });
    return { status: "skipped_tickets_ready" };
  }

  const cfg = deps.config.loops.idle_feature_backlog;
  const repos = scopedRepos(deps, cfg.repos);
  if (repos.length === 0) {
    deps.events.record("loop_finished", { loop: LOOP, result: "no_repos" });
    return { status: "no_repos" };
  }

  const feature = await chooseFeature(deps, repos);
  if (!feature) {
    deps.events.record("loop_finished", { loop: LOOP, result: "no_findings" });
    return { status: "no_findings" };
  }

  const ident = { repo: feature.repo, id: feature.id, name: feature.name };

  // observe_only: report the candidate, file nothing, and DO NOT advance it.
  if (cfg.mode === "observe_only") {
    deps.events.record("feature_backlog_observed", { loop: LOOP, ...ident });
    deps.events.record("loop_finished", { loop: LOOP, result: "observed" });
    return { status: "observed", feature: ident };
  }

  return processFeature(deps, feature, cfg.mode);
}

/**
 * Claim the feature into `building`, decompose it, and file the epic — rolling
 * the feature back to `backlog` on any downstream failure so it is never stranded
 * in `building`.
 */
async function processFeature(
  deps: IdleFeatureBacklogDeps,
  feature: BacklogFeature,
  mode: IdleLoopMode,
): Promise<IdleFeatureBacklogOutcome> {
  const ident = { repo: feature.repo, id: feature.id, name: feature.name };
  const cfg = deps.config.loops.idle_feature_backlog;

  // Claim it FIRST so a concurrent tick can't pick the same feature twice.
  try {
    await deps.memory.advanceFeature(feature.id, "building");
    deps.events.record("feature_backlog_claimed", { loop: LOOP, ...ident, toStatus: "building" });
  } catch (err) {
    deps.events.record("feature_backlog_claim_failed", {
      loop: LOOP,
      ...ident,
      error: err instanceof Error ? err.message : String(err),
    });
    // Never advanced past backlog — nothing to roll back; just skip this tick.
    deps.events.record("loop_finished", { loop: LOOP, result: "no_findings" });
    return { status: "no_findings" };
  }

  // From here on, the feature is in `building`; any failure must roll it back.
  try {
    const brief = buildBrief(feature);
    const plan = await deps.decomposer.decompose({
      brief,
      repo: feature.repo,
      maxTurns: cfg.max_turns,
      maxTickets: cfg.max_tickets,
    });
    deps.events.record("feature_backlog_decomposed", {
      loop: LOOP,
      ...ident,
      ticketCount: plan.tickets.length,
    });

    const ready = mode === "create_ready_tickets";
    const result = deps.dispatch.createEpic({
      name: plan.epic.name,
      description: epicDescription(feature, plan, deps.clock),
      tickets: plan.tickets.map((t) => ({
        title: t.title,
        description: t.description,
        acceptanceCriteria: t.acceptanceCriteria,
        priority: t.priority,
        repoName: t.repo,
        dependsOn: t.dependsOn,
      })),
      ready,
      findingKey: findingKey(LOOP, feature.repo, feature.id),
      policyPack: deps.config.dispatch.default_policy_pack,
    });
    deps.events.record("feature_backlog_epic_filed", {
      loop: LOOP,
      ...ident,
      epicId: result.epicId,
      ticketCount: result.ticketIds.length,
      ready,
    });

    const status = ready ? "ready_created" : "draft_created";
    deps.events.record("loop_finished", { loop: LOOP, result: status });
    return { status, feature: ident, epicId: result.epicId, ticketCount: result.ticketIds.length };
  } catch (err) {
    await rollback(deps, feature, err);
    deps.events.record("loop_finished", { loop: LOOP, result: "no_findings" });
    return { status: "no_findings" };
  }
}

/** Roll a `building` feature back to `backlog` so a failure never strands it. */
async function rollback(
  deps: IdleFeatureBacklogDeps,
  feature: BacklogFeature,
  cause: unknown,
): Promise<void> {
  const ident = { repo: feature.repo, id: feature.id, name: feature.name };
  deps.events.record("feature_backlog_failed", {
    loop: LOOP,
    ...ident,
    error: cause instanceof Error ? cause.message : String(cause),
  });
  try {
    await deps.memory.advanceFeature(feature.id, "backlog");
    deps.events.record("feature_backlog_rolled_back", {
      loop: LOOP,
      ...ident,
      toStatus: "backlog",
    });
  } catch (rollbackErr) {
    // Best-effort: a dead memory client on rollback is logged, never rethrown.
    deps.events.record("feature_backlog_rollback_failed", {
      loop: LOOP,
      ...ident,
      error: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
    });
  }
}

/** Brief handed to the decomposer: the feature's name + summary. */
function buildBrief(feature: BacklogFeature): string {
  return feature.summary.trim() ? `${feature.name}: ${feature.summary.trim()}` : feature.name;
}

/** A provenance-bearing epic description tying the epic back to the ledger feature. */
function epicDescription(feature: BacklogFeature, plan: EpicPlan, clock: Clock): string {
  const planNote = plan.epic.description.trim();
  return (
    `Auto-planned from backlog feature '${feature.name}' (${feature.id}) in ${feature.repo} by the ` +
    `idle ${LOOP} loop on ${dateStamp(clock)}. The feature was advanced backlog → building as ` +
    `provenance for this run; no code was changed by the loop itself.` +
    (planNote ? `\n\n${planNote}` : "")
  );
}

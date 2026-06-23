import { summariseRecentRuns, type RecentRunSummary } from "../audit/index.js";
import type { FactoryContext } from "../runtime/wiring.js";
import { loadSkillRegistry } from "../skills/loader.js";

/**
 * `crew stats` — a compact operational snapshot of the factory:
 * repositories, skills grouped by capability, idle-loop configuration, and the
 * recent run outcomes drawn from the redacted audit log. Pure: the CLI renders
 * and prints the returned object.
 */

export interface RepoStat {
  readonly id: string;
  readonly name: string;
  readonly stack: string | null;
  readonly mutationMode: string;
  readonly riskLevel: string;
}

export interface IdleLoopStat {
  readonly id: string;
  readonly enabled: boolean;
  readonly mode?: string;
  readonly repos: ReadonlyArray<string>;
}

export interface FactoryStats {
  readonly factory: { readonly name: string; readonly mode: string };
  readonly repos: ReadonlyArray<RepoStat>;
  /** Skill counts keyed by the capability they apply to (`*` = capability-agnostic). */
  readonly skillsByCapability: ReadonlyArray<{
    readonly capability: string;
    readonly count: number;
  }>;
  readonly idleLoops: ReadonlyArray<IdleLoopStat>;
  readonly implementationLoop: { readonly enabled: boolean; readonly maxConcurrentAgents: number };
  readonly recentRuns: RecentRunSummary;
}

const CAPABILITY_AGNOSTIC = "*";

/** Group loaded skills by the capabilities they declare (agnostic ones under `*`). */
function skillsByCapability(factoryDir: string): Array<{ capability: string; count: number }> {
  const skills = loadSkillRegistry({ factoryDir }).list();
  const counts = new Map<string, number>();
  for (const skill of skills) {
    const caps = skill.applies_to.capabilities;
    const keys = caps.length === 0 ? [CAPABILITY_AGNOSTIC] : caps;
    for (const cap of keys) counts.set(cap, (counts.get(cap) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([capability, count]) => ({ capability, count }))
    .sort((a, b) => b.count - a.count || a.capability.localeCompare(b.capability));
}

/** Collect the idle-loop config from the typed config object. */
function idleLoops(config: FactoryContext["loaded"]["config"]): IdleLoopStat[] {
  const l = config.loops;
  return [
    {
      id: "idle_coverage",
      enabled: l.idle_coverage.enabled,
      mode: l.idle_coverage.mode,
      repos: l.idle_coverage.repos,
    },
    {
      id: "idle_test_quality",
      enabled: l.idle_test_quality.enabled,
      mode: l.idle_test_quality.mode,
      repos: l.idle_test_quality.repos,
    },
    {
      id: "idle_documentation",
      enabled: l.idle_documentation.enabled,
      mode: l.idle_documentation.mode,
      repos: l.idle_documentation.repos,
    },
    {
      id: "idle_dependencies",
      enabled: l.idle_dependencies.enabled,
      mode: l.idle_dependencies.mode,
      repos: l.idle_dependencies.repos,
    },
  ];
}

export interface StatsOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly recentLimit?: number;
}

/** Build the factory stats snapshot from a loaded context + the audit log. */
export function buildStats(ctx: FactoryContext, opts: StatsOptions = {}): FactoryStats {
  const { config } = ctx.loaded;
  const repos: RepoStat[] = ctx.repoRegistry.list().map((r) => ({
    id: r.id,
    name: r.name,
    stack: r.stack,
    mutationMode: r.mutation_mode,
    riskLevel: r.risk_level,
  }));

  const recentRuns = summariseRecentRuns({
    dataDir: ctx.loaded.rootDir,
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.recentLimit !== undefined ? { recentLimit: opts.recentLimit } : {}),
  });

  return {
    factory: { name: config.factory.name, mode: config.factory.mode },
    repos,
    skillsByCapability: skillsByCapability(ctx.loaded.rootDir),
    idleLoops: idleLoops(config),
    implementationLoop: {
      enabled: config.loops.implementation.enabled,
      maxConcurrentAgents: config.loops.implementation.max_concurrent_agents,
    },
    recentRuns,
  };
}

/** Render stats as a compact human-readable report. */
export function renderStats(stats: FactoryStats): string {
  const lines = [
    `crew stats — ${stats.factory.name} (${stats.factory.mode})`,
    "",
    `Repos (${stats.repos.length}):`,
  ];
  for (const r of stats.repos) {
    lines.push(`  • ${r.id}  [${r.stack ?? "stack?"}]  ${r.mutationMode}  risk:${r.riskLevel}`);
  }
  lines.push("", "Skills by capability:");
  for (const s of stats.skillsByCapability) lines.push(`  • ${s.capability}: ${s.count}`);
  lines.push("", "Idle loops:");
  for (const l of stats.idleLoops) {
    const state = l.enabled ? `on (${l.mode ?? "?"})` : "off";
    lines.push(`  • ${l.id}: ${state}  repos:[${l.repos.join(", ")}]`);
  }
  lines.push(
    "",
    `Implementation loop: ${stats.implementationLoop.enabled ? "on" : "off"} ` +
      `(max ${stats.implementationLoop.maxConcurrentAgents} concurrent)`,
  );
  const rr = stats.recentRuns;
  lines.push("", `Recent MCP runs: ${rr.total} (${rr.errors} error(s))`);
  for (const t of rr.byTool) lines.push(`  • ${t.tool}: ${t.count}`);
  return lines.join("\n");
}

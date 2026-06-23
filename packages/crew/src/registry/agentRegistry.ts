import { notFound } from "../util/errors.js";
import type { AgentConfig, CrewConfig } from "../config/schema.js";

const RISK_ORDER: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };

function riskRank(level: string): number {
  return RISK_ORDER[level] ?? RISK_ORDER.medium!;
}

/** Read-only view over the configured agents, with capability routing helpers. */
export class AgentRegistry {
  private readonly byId: Map<string, AgentConfig>;

  constructor(agents: readonly AgentConfig[]) {
    this.byId = new Map(agents.map((a) => [a.id, a]));
  }

  static fromConfig(config: CrewConfig): AgentRegistry {
    return new AgentRegistry(config.agents);
  }

  list(): AgentConfig[] {
    return [...this.byId.values()];
  }

  find(id: string): AgentConfig | undefined {
    return this.byId.get(id);
  }

  get(id: string): AgentConfig {
    const agent = this.find(id);
    if (!agent) throw notFound("agent", id);
    return agent;
  }

  /** Active agents only (paused/disabled/unhealthy excluded from routing). */
  active(): AgentConfig[] {
    return this.list().filter((a) => a.status === "active");
  }

  /**
   * Can `agent` take work needing `requiredCapabilities` at `riskLevel` in `repoName`?
   * Mirrors the routing rule in docs/05-agent-and-repo-registry.md.
   */
  canClaim(
    agent: AgentConfig,
    requiredCapabilities: readonly string[],
    riskLevel: string,
    repoName?: string,
  ): boolean {
    if (agent.status !== "active") return false;
    const hasCaps = requiredCapabilities.every((cap) => agent.capabilities.includes(cap));
    const withinRisk = riskRank(riskLevel) <= riskRank(agent.max_risk);
    const repoOk =
      repoName === undefined ||
      (!agent.denied_repos.includes(repoName) &&
        (agent.allowed_repos.length === 0 || agent.allowed_repos.includes(repoName)));
    return hasCaps && withinRisk && repoOk;
  }
}

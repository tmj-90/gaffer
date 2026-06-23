import type { CrewConfig, RepoConfig } from "../config/schema.js";
import type { EventLog } from "../events/eventLog.js";

/**
 * The guard that closes the self-improving idle loop.
 *
 * Idle loops draft tech-debt / coverage / docs findings as DRAFT tickets that a
 * human normally has to promote. When `loops.self_improve` is enabled this gate
 * lets an idle tick promote a bounded number of those drafts to `ready` itself,
 * so the delivery loop claims them — closing the loop without a human in the
 * promote step.
 *
 * It is intentionally hard to fire. Every promotion must pass four checks:
 *  1. the feature is enabled (off by default);
 *  2. the repo is explicitly opted in (`repos` — empty list means NONE);
 *  3. the repo's risk_level is at/below `max_risk`;
 *  4. the per-tick cap (`max_ready_per_run`) has not been reached.
 *
 * The gate is stateful for a single idle tick: construct one per run so the cap
 * spans every loop in that tick, and read {@link promotedCount} afterwards.
 */

const RISK_ORDER = ["low", "medium", "high", "critical"] as const;
type RiskLevel = (typeof RISK_ORDER)[number];

/** Rank a risk level; an unknown value is treated as the most restrictive. */
function riskRank(risk: string): number {
  const index = RISK_ORDER.indexOf(risk as RiskLevel);
  return index === -1 ? RISK_ORDER.length : index;
}

export class SelfImproveGate {
  private promoted = 0;

  private constructor(
    private readonly enabled: boolean,
    private readonly repos: readonly string[],
    private readonly maxRiskRank: number,
    private readonly cap: number,
    private readonly events: EventLog,
  ) {}

  /** Build the gate for one idle tick from validated config. */
  static fromConfig(config: CrewConfig, events: EventLog): SelfImproveGate {
    const self = config.loops.self_improve;
    return new SelfImproveGate(
      self.enabled,
      self.repos,
      riskRank(self.max_risk),
      self.max_ready_per_run,
      events,
    );
  }

  /** How many drafts this gate has promoted to ready during this tick. */
  get promotedCount(): number {
    return this.promoted;
  }

  /**
   * Decide whether an idle DRAFT ticket for `repo` may be auto-promoted to
   * `ready`. Has the side effect of consuming one unit of the per-tick cap when
   * it returns `true`, and records a runtime event for both promotions and
   * meaningful denials (risk too high, cap reached) so the closed loop is
   * auditable. Disabled / not-opted-in repos are skipped silently to avoid
   * noise on every untargeted finding.
   */
  tryPromote(repo: RepoConfig): boolean {
    if (!this.enabled) return false;
    if (!this.repos.includes(repo.name)) return false;

    if (riskRank(repo.risk_level) > this.maxRiskRank) {
      this.events.record("self_improve_skipped", {
        repoName: repo.name,
        reason: "risk_above_max",
        risk: repo.risk_level,
      });
      return false;
    }

    if (this.promoted >= this.cap) {
      this.events.record("self_improve_cap_reached", { repoName: repo.name, cap: this.cap });
      return false;
    }

    this.promoted += 1;
    this.events.record("self_improve_promoted", {
      repoName: repo.name,
      count: this.promoted,
      cap: this.cap,
    });
    return true;
  }
}

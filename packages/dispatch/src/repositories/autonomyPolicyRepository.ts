import type { Db } from "../db/connection.js";

/**
 * GRADUATED-AUTONOMY (Spec 2, Phase 3) — data access for the `autonomy_policy`
 * table (SECURITY-CRITICAL enablement store).
 *
 * Append-once-per-(repo × risk × gate) with an idempotent UPSERT keyed on the
 * UNIQUE(repo_id, risk_level, gate) index. Nothing here reads the environment or
 * makes a policy DECISION — enforcement (env fallback + fail-closed semantics)
 * lives in {@link import("../services/autonomyPolicyService.js")}. This layer is a
 * dumb store: it records what the operator explicitly confirmed and reads it back.
 */

/** The three enforcement chokepoints a policy row can concern. */
export const AUTONOMY_POLICY_GATES = ["approve", "merge", "memory"] as const;
export type AutonomyPolicyGate = (typeof AUTONOMY_POLICY_GATES)[number];

/** How much the factory may do at a gate. Only `auto` grants an allow-path. */
export const AUTONOMY_MODES = ["off", "recommend", "auto"] as const;
export type AutonomyMode = (typeof AUTONOMY_MODES)[number];

/** One stored policy row (snake_case, straight from the table). */
export interface AutonomyPolicyRow {
  id: string;
  repo_id: string;
  risk_level: string;
  gate: AutonomyPolicyGate;
  mode: AutonomyMode;
  enabled_by: string | null;
  enabled_at: string | null;
  evidence_json: string | null;
  created_at: string;
  updated_at: string;
}

/** A stored policy row joined to its repo name, for display surfaces. */
export interface AutonomyPolicyView extends AutonomyPolicyRow {
  repo_name: string;
}

/** Fully-formed fields for an idempotent upsert (id + timestamps supplied by the caller). */
export interface AutonomyPolicyUpsert {
  id: string;
  repoId: string;
  riskLevel: string;
  gate: AutonomyPolicyGate;
  mode: AutonomyMode;
  enabledBy: string | null;
  enabledAt: string | null;
  evidenceJson: string | null;
  /** ISO instant used for created_at (insert) / updated_at (both paths). */
  now: string;
}

export class AutonomyPolicyRepository {
  constructor(private readonly db: Db) {}

  /**
   * Insert or update the single row for (repo, risk, gate). The UNIQUE index makes
   * this idempotent: a second enable/disable for the same triple UPDATEs in place
   * (preserving the original created_at), so a policy is never duplicated. Returns
   * the resulting row.
   */
  upsert(input: AutonomyPolicyUpsert): AutonomyPolicyRow {
    this.db
      .prepare(
        `INSERT INTO autonomy_policy
           (id, repo_id, risk_level, gate, mode, enabled_by, enabled_at, evidence_json, created_at, updated_at)
         VALUES
           (@id, @repoId, @riskLevel, @gate, @mode, @enabledBy, @enabledAt, @evidenceJson, @now, @now)
         ON CONFLICT(repo_id, risk_level, gate) DO UPDATE SET
           mode          = excluded.mode,
           enabled_by    = excluded.enabled_by,
           enabled_at    = excluded.enabled_at,
           evidence_json = excluded.evidence_json,
           updated_at    = excluded.updated_at`,
      )
      .run(input);
    const row = this.get(input.repoId, input.riskLevel, input.gate);
    if (!row) {
      // Should be unreachable — the upsert we just ran guarantees the row exists.
      throw new Error("autonomy_policy upsert did not persist a row");
    }
    return row;
  }

  /** The single policy row for (repo, risk, gate), or undefined when none exists. */
  get(repoId: string, riskLevel: string, gate: string): AutonomyPolicyRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM autonomy_policy
          WHERE repo_id = @repoId AND risk_level = @riskLevel AND gate = @gate`,
      )
      .get({ repoId, riskLevel, gate }) as AutonomyPolicyRow | undefined;
  }

  /**
   * Every policy row joined to its repo name, newest-updated first, for the
   * Settings "active policies" surface. Only rows the operator has touched exist,
   * so this list is naturally small.
   */
  list(): AutonomyPolicyView[] {
    return this.db
      .prepare(
        `SELECT p.*, r.name AS repo_name
           FROM autonomy_policy p
           JOIN repositories r ON r.id = p.repo_id
          ORDER BY p.updated_at DESC, r.name ASC`,
      )
      .all() as AutonomyPolicyView[];
  }
}

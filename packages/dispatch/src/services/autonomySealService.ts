/**
 * SEALED AUTONOMY on the facade: the policy store every autonomy decision reads
 * (`Dispatch.autonomyPolicy`), with the seals of events/autonomySeal.ts applied.
 *
 *  - `get` answers for a DECISION: a row whose seal does not verify is ABSENT (a person
 *    decides). `getStored` and `list` are the raw rows, for display and for the writer.
 *  - `stepDownInForce` honours only SEALED lifts, and answers "not in force" only when the
 *    event log verifies (events/autonomySeal.ts sealedStepDownInForce).
 * Every check is fail closed: a throw, a missing key, an unreadable seal is "a person
 * decides". Nothing here signs or repairs anything.
 */
import type { GateKeyring } from "../events/gateSeal.js";
import {
  sealedStepDownInForce,
  verifyPolicyRow,
  type PolicySealRow,
} from "../events/autonomySeal.js";
import type { RowSealCheck } from "../events/rowSeal.js";
import {
  AutonomyPolicyRepository,
  type AutonomyPolicyRow,
  type AutonomyPolicyUpsert,
  type AutonomyPolicyView,
} from "../repositories/autonomyPolicyRepository.js";
import type { Db } from "../db/connection.js";

/** A stored policy row with what its seal says. */
export type SealedPolicyView = AutonomyPolicyView & {
  /** The row's seal verifies (a row in mode `off` needs none: true). */
  signed: boolean;
  /** Why it does not verify (null when signed). */
  seal_problem: string | null;
};

export class SealedAutonomyPolicy {
  private readonly repo: AutonomyPolicyRepository;

  constructor(
    private readonly db: Db,
    private readonly keyring: () => GateKeyring,
  ) {
    this.repo = new AutonomyPolicyRepository(db);
  }

  /** The seal check of one stored row. Never throws (a throw is `unreadable`). */
  check(row: AutonomyPolicyRow): RowSealCheck {
    try {
      return verifyPolicyRow(this.db, this.keyring(), row as PolicySealRow);
    } catch (e) {
      return {
        ok: false,
        failure: "unreadable",
        detail: `its signature could not be checked (${e instanceof Error ? e.message : String(e)})`,
      };
    }
  }

  /**
   * The policy row for (repo, risk, gate) AS A DECISION READS IT: undefined when there is
   * none, or when its seal does not verify (an unsigned `auto` row grants nothing).
   */
  get(repoId: string, riskLevel: string, gate: string): AutonomyPolicyRow | undefined {
    let row: AutonomyPolicyRow | undefined;
    try {
      row = this.repo.get(repoId, riskLevel, gate);
    } catch {
      return undefined;
    }
    if (!row) return undefined;
    return this.check(row).ok ? row : undefined;
  }

  /** The stored row, sealed or not (display and the writer only; never for a decision). */
  getStored(repoId: string, riskLevel: string, gate: string): AutonomyPolicyRow | undefined {
    return this.repo.get(repoId, riskLevel, gate);
  }

  upsert(input: AutonomyPolicyUpsert): AutonomyPolicyRow {
    return this.repo.upsert(input);
  }

  /** Every stored row (sealed or not), newest first. */
  list(): AutonomyPolicyView[] {
    return this.repo.list();
  }

  /** Every stored row with its seal verdict (Settings, the ladder, doctor). */
  listSealed(): SealedPolicyView[] {
    return this.repo.list().map((row) => {
      const c = this.check(row);
      return { ...row, signed: c.ok, seal_problem: c.ok ? null : c.detail };
    });
  }

  /** A step-down in force (sealed lifts only; fail closed). */
  stepDownInForce(repoId: string, riskLevel: string, gate: string): boolean {
    return sealedStepDownInForce(this.db, this.keyring(), repoId, riskLevel, gate);
  }
}

import {
  type ClauseCoverage,
  type CoveringAc,
  type DanglingAc,
  parseSpecClauses,
  type SpecClause,
  type SpecCoverage,
  type SpecLoreStatus,
} from "../domain/types.js";
import { isSpecCoverageGateEnabled } from "../policy/specCoverageGate.js";
import type {
  ClauseBounceRow,
  CoveringAcRow,
  SpecCoverageRepository,
} from "../repositories/specCoverageRepository.js";
import type { SpecRepository } from "../repositories/specRepository.js";
import { notFound } from "../util/errors.js";
import { NullSpecLoreReader, type SpecLoreReader } from "./specLoreReader.js";

export interface SpecCoverageServiceDeps {
  readonly specs: SpecRepository;
  readonly coverage: SpecCoverageRepository;
  /**
   * Best-effort seeded-lore status reader. Defaults to a no-op ({@link
   * NullSpecLoreReader}) so callers/tests without Memory wired report `unknown` —
   * the read is auxiliary and NEVER blocks the coverage response.
   */
  readonly loreReader?: SpecLoreReader;
  /** Reads the (non-enforcing) spec-coverage DoD flag. Injectable for tests. */
  readonly gateEnabled?: () => boolean;
}

/**
 * TRACEABILITY (Spec-Driven Development, Phase 3): the spec-coverage read model.
 *
 * For a spec it computes, per clause, the covering ACs, whether the clause is
 * COVERED / SATISFIED / an ORPHAN (the gap report), and the bounce count from the
 * rework trail — with the heavy joins done SQL-side by {@link
 * SpecCoverageRepository}. The clause list itself (order, kind, text) comes from the
 * spec's frozen `clauses_json`, so a clause with NO covering AC correctly surfaces
 * as an orphan rather than vanishing. Seeded-lore status is attached best-effort.
 *
 * Pure read model — it never mutates the board and the DoD gate is advisory only.
 */
export class SpecCoverageService {
  private readonly specs: SpecRepository;
  private readonly coverage: SpecCoverageRepository;
  private readonly loreReader: SpecLoreReader;
  private readonly gateEnabled: () => boolean;

  constructor(deps: SpecCoverageServiceDeps) {
    this.specs = deps.specs;
    this.coverage = deps.coverage;
    this.loreReader = deps.loreReader ?? new NullSpecLoreReader();
    this.gateEnabled = deps.gateEnabled ?? (() => isSpecCoverageGateEnabled());
  }

  /** Compute the coverage read model for a spec, or throw NOT_FOUND when absent. */
  specCoverage(id: string): SpecCoverage {
    const spec = this.specs.findById(id);
    if (!spec) throw notFound("spec", id);
    const clauses = parseSpecClauses(spec.clauses_json);
    const clauseIds = clauses.map((c) => c.clause_id);

    // SQL-side aggregation: covering ACs (joined to their tickets) + per-clause
    // bounce counts. A clause absent from these results is an orphan / zero-bounce.
    const acsByClause = groupBy(this.coverage.coveringAcs(clauseIds), (r) => r.clause_id);
    const bounceByClause = indexBy(this.coverage.bounceCounts(clauseIds), (r) => r.clause_id);
    const loreStatus = safeLoreStatus(this.loreReader, spec, clauses);
    // Ticket-side gap report: ACs that still claim a (now-removed) clause of THIS
    // spec. Scoped to the spec's namespace by id, so it can't pick up other specs' ACs.
    const danglingAcs: DanglingAc[] = this.coverage.danglingAcs(spec.id, clauseIds).map((r) => ({
      ac_id: r.ac_id,
      ac_text: r.ac_text,
      spec_clause_id: r.spec_clause_id,
      ticket_id: r.ticket_id,
      ticket_number: r.ticket_number,
      ticket_title: r.ticket_title,
      ticket_status: r.ticket_status,
    }));

    const clauseCoverage = clauses.map((clause) =>
      this.buildClauseCoverage(
        clause,
        acsByClause.get(clause.clause_id) ?? [],
        bounceByClause.get(clause.clause_id),
        loreStatus.get(clause.clause_id) ?? "unknown",
      ),
    );

    return {
      spec_id: spec.id,
      title: spec.title,
      status: spec.status,
      scope_node_id: spec.scope_node_id,
      clauses: clauseCoverage,
      rollup: rollup(clauseCoverage, danglingAcs.length),
      dangling_acs: danglingAcs,
      gate_enabled: this.gateEnabled(),
    };
  }

  private buildClauseCoverage(
    clause: SpecClause,
    acRows: readonly CoveringAcRow[],
    bounce: ClauseBounceRow | undefined,
    loreStatusValue: SpecLoreStatus,
  ): ClauseCoverage {
    const coveringAcs: CoveringAc[] = acRows.map((r) => ({
      ac_id: r.ac_id,
      ac_text: r.ac_text,
      ac_status: r.ac_status,
      satisfied: r.ac_status === "satisfied",
      ticket_id: r.ticket_id,
      ticket_number: r.ticket_number,
      ticket_title: r.ticket_title,
      ticket_status: r.ticket_status,
    }));
    const covered = coveringAcs.length > 0;
    const satisfied = coveringAcs.some((ac) => ac.satisfied);
    const result: ClauseCoverage = {
      clause_id: clause.clause_id,
      kind: clause.kind,
      text: clause.text,
      covering_acs: coveringAcs,
      covered,
      satisfied,
      orphan: !covered,
      bounce_count: bounce?.bounce_count ?? 0,
      lore_status: loreStatusValue,
    };
    if (clause.rationale !== undefined) result.rationale = clause.rationale;
    return result;
  }
}

/** Spec-level rollup: covered/total, satisfied/total, orphan clause ids + dangling count. */
function rollup(clauses: readonly ClauseCoverage[], danglingCount: number): SpecCoverage["rollup"] {
  return {
    total: clauses.length,
    covered: clauses.filter((c) => c.covered).length,
    satisfied: clauses.filter((c) => c.satisfied).length,
    orphans: clauses.filter((c) => c.orphan).map((c) => c.clause_id),
    dangling: danglingCount,
  };
}

/** Read seeded-lore status, degrading to all-`unknown` on any reader failure. */
function safeLoreStatus(
  reader: SpecLoreReader,
  spec: Parameters<SpecLoreReader["statusFor"]>[0],
  clauses: readonly SpecClause[],
): Map<string, SpecLoreStatus> {
  try {
    return reader.statusFor(spec, clauses);
  } catch {
    // Defence in depth: a non-conforming reader must never fail the endpoint.
    return new Map(clauses.map((c) => [c.clause_id, "unknown" as SpecLoreStatus]));
  }
}

function groupBy<T, K>(rows: readonly T[], key: (row: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const row of rows) {
    const k = key(row);
    const bucket = out.get(k);
    if (bucket) bucket.push(row);
    else out.set(k, [row]);
  }
  return out;
}

function indexBy<T, K>(rows: readonly T[], key: (row: T) => K): Map<K, T> {
  const out = new Map<K, T>();
  for (const row of rows) out.set(key(row), row);
  return out;
}

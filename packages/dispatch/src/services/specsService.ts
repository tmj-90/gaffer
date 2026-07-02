import { type Db, inTransaction } from "../db/connection.js";
import {
  createSpecInput,
  type SpecClauseInput,
  updateSpecClausesInput,
} from "../domain/schemas.js";
import {
  type Actor,
  parseSpecClauses,
  type Spec,
  type SpecClause,
  type SpecStatus,
} from "../domain/types.js";
import { writeEvent } from "../events/eventWriter.js";
import type { SpecRepository } from "../repositories/specRepository.js";
import { NullSpecClauseSeeder, type SpecClauseSeeder } from "./specClauseSeeder.js";
import type { Clock } from "../util/clock.js";
import { DispatchError, notFound } from "../util/errors.js";
import { newId } from "../util/id.js";

export interface SpecsServiceDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly specs: SpecRepository;
  /**
   * Seeds a frozen spec's clauses into Memory as gated draft lore (Phase 2b).
   * Optional: defaults to a no-op so existing callers/tests are unaffected. The
   * live wiring ({@link file://./specClauseSeeder.ts}) shells out to the Memory
   * CLI; seeding is best-effort and NEVER blocks or rolls back a freeze.
   */
  readonly clauseSeeder?: SpecClauseSeeder;
}

/**
 * Spec-Driven Development (Phase 1a): the `specs` first-class object.
 *
 * A spec is drafted, edited, then FROZEN. The centrepiece invariant is that a
 * FROZEN SPEC IS IMMUTABLE — {@link freezeSpec} only permits draft→frozen, and any
 * edit or freeze of a non-draft (frozen / superseded) spec is rejected. Clause ids
 * are generated server-side when absent and preserved thereafter, so a later phase
 * can thread provenance from a clause down to acceptance criteria.
 */
export class SpecsService {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly specs: SpecRepository;
  private readonly clauseSeeder: SpecClauseSeeder;

  constructor(deps: SpecsServiceDeps) {
    this.db = deps.db;
    this.clock = deps.clock;
    this.specs = deps.specs;
    this.clauseSeeder = deps.clauseSeeder ?? new NullSpecClauseSeeder();
  }

  /** Create a spec (always `draft`). Clause ids are minted server-side when absent. */
  createSpec(raw: unknown, actor: Actor): Spec {
    const input = createSpecInput.parse(raw);
    const now = this.clock.now();
    // The spec id is minted FIRST so clause ids can be namespaced under it (see
    // {@link assignClauseIds}) — the namespace is what keeps clause ids globally
    // unique across specs, so two specs' `c1`s can never cross-contaminate.
    const id = newId();
    const clauses = this.assignClauseIds(input.clauses, id);
    const spec: Spec = {
      id,
      title: input.title,
      brief: input.brief,
      clauses_json: JSON.stringify(clauses),
      status: "draft",
      target_repo: input.target_repo ?? null,
      scope_node_id: input.scope_node_id ?? null,
      created_at: now,
      updated_at: now,
      frozen_at: null,
    };
    return inTransaction(this.db, () => {
      this.specs.insert(spec);
      writeEvent(this.db, {
        entity_type: "spec",
        entity_id: spec.id,
        actor,
        event_type: "spec.created",
        payload: { title: spec.title, clause_count: clauses.length },
      });
      return spec;
    });
  }

  /** Fetch a spec by id, or throw NOT_FOUND. */
  getSpec(id: string): Spec {
    const spec = this.specs.findById(id);
    if (!spec) throw notFound("spec", id);
    return spec;
  }

  /** List specs newest-first, optionally filtered by status. */
  listSpecs(status?: SpecStatus): Spec[] {
    return this.specs.list(status);
  }

  /**
   * Replace a draft spec's clauses. Rejected (STATE_CONFLICT) on a non-draft spec —
   * a frozen spec is immutable. Clause ids are minted for new clauses and preserved
   * for supplied ones.
   */
  updateSpecClauses(id: string, raw: unknown, actor: Actor): Spec {
    const input = updateSpecClausesInput.parse(raw);
    return inTransaction(this.db, () => {
      const spec = this.specs.findById(id);
      if (!spec) throw notFound("spec", id);
      this.assertDraft(spec);
      const clauses = this.assignClauseIds(input.clauses, spec.id);
      this.specs.updateClauses(id, JSON.stringify(clauses), this.clock.now());
      writeEvent(this.db, {
        entity_type: "spec",
        entity_id: id,
        actor,
        event_type: "spec.clauses_updated",
        payload: { clause_count: clauses.length },
      });
      return this.getSpec(id);
    });
  }

  /**
   * Freeze a spec (draft→frozen), stamping frozen_at. INVARIANT: only a `draft`
   * spec can be frozen; freezing a `frozen` or `superseded` spec is rejected with a
   * clear STATE_CONFLICT — a frozen spec is immutable, so it can never be re-frozen
   * or re-drafted.
   */
  freezeSpec(id: string, actor: Actor): Spec {
    const frozen = inTransaction(this.db, () => {
      const spec = this.specs.findById(id);
      if (!spec) throw notFound("spec", id);
      this.assertDraft(spec);
      // A frozen spec is the AUTHORITATIVE, immutable source of intent that drives
      // decompose + coverage. Freezing an EMPTY spec would produce a spec that
      // asserts nothing — every downstream coverage rollup would be vacuously
      // satisfied. Require at least one clause so a freeze always captures intent.
      if (parseSpecClauses(spec.clauses_json).length === 0) {
        throw new DispatchError(
          "STATE_CONFLICT",
          `Spec ${spec.id} has no clauses — a spec must have at least one clause before it ` +
            `can be frozen.`,
          { spec_id: spec.id },
        );
      }
      this.specs.freeze(id, this.clock.now());
      writeEvent(this.db, {
        entity_type: "spec",
        entity_id: id,
        actor,
        event_type: "spec.frozen",
        payload: { title: spec.title },
      });
      return this.getSpec(id);
    });

    // Seed each clause into Memory as gated draft lore (Phase 2b) — done AFTER
    // the freeze transaction has committed, and best-effort, so a Memory hiccup
    // can never roll back or block the freeze. The seeder itself never throws;
    // the extra guard is defence in depth against a future non-conforming impl.
    try {
      this.clauseSeeder.seedFrozenSpec(frozen, parseSpecClauses(frozen.clauses_json));
    } catch {
      // Intentionally swallowed — the spec is already frozen and immutable.
    }
    return frozen;
  }

  /**
   * Guard the immutability invariant: reject any edit/freeze of a non-draft spec.
   * A frozen spec is a durable, immutable snapshot; a superseded one is retired.
   */
  private assertDraft(spec: Spec): void {
    if (spec.status !== "draft") {
      throw new DispatchError(
        "STATE_CONFLICT",
        `Spec ${spec.id} is '${spec.status}' and is immutable — only a draft spec can be ` +
          `edited or frozen.`,
        { spec_id: spec.id, status: spec.status },
      );
    }
  }

  /**
   * Mint a stable `clause_id` for every clause that lacks one, preserving any
   * supplied id, and NAMESPACE every id under the owning `specId` as
   * `<specId>:<base>`. Stability matters: Phase 3 references a clause by this id,
   * so once assigned it must not change.
   *
   * Namespacing is the correctness fix for cross-spec id collision: the spec-author
   * emits POSITIONAL ids (`c1`, `c2`, …), so two independent spec-driven builds both
   * carry `c1`. Coverage joins ACs to clauses by `spec_clause_id IN (…)` with no
   * per-spec scoping, so bare positional ids let one spec's ACs inflate another's
   * coverage/bounce counts. Prefixing every id with the spec's own (globally-unique)
   * id makes the id itself globally unique, so the same match can only ever pick up
   * ONE spec's ACs. The namespaced id is what flows onward — into decompose's
   * `clauseRef`, the AC's `spec_clause_id` provenance, and the lore seeder — so the
   * whole chain stays internally consistent.
   */
  private assignClauseIds(clauses: readonly SpecClauseInput[], specId: string): SpecClause[] {
    return clauses.map((c) => {
      const clause: SpecClause = {
        clause_id: this.namespaceClauseId(specId, c.clause_id ?? newId()),
        kind: c.kind,
        text: c.text,
      };
      if (c.rationale !== undefined) clause.rationale = c.rationale;
      return clause;
    });
  }

  /**
   * Namespace a clause id under its spec as `<specId>:<base>`. IDEMPOTENT: a base
   * that already carries this spec's prefix is returned unchanged, so re-editing a
   * draft (which round-trips already-namespaced ids back in) never double-prefixes
   * and clause ids stay stable across edits.
   */
  private namespaceClauseId(specId: string, base: string): string {
    const prefix = `${specId}:`;
    return base.startsWith(prefix) ? base : `${prefix}${base}`;
  }
}

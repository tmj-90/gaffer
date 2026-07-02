/**
 * Freeze → seed clauses into Memory as gated draft lore (Spec-Driven
 * Development, Phase 2b).
 *
 * Asserts the DISPATCH side of the seam in isolation (Memory is stubbed):
 *   - freezeSpec seeds exactly ONE lore record per clause, carrying the
 *     clause's kind and its (spec_id, clause_id) linkage;
 *   - the CLI seeder emits a gated `suggest` by default and an active `add`
 *     under MEMORY_AUTO_APPROVE, with the provenance flags on every call;
 *   - NEGATIVE CONTROL: a Memory failure during seeding does NOT block or roll
 *     back the freeze — the spec is still frozen and immutable.
 */
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { migrate } from "../src/db/connection.js";
import { type Actor, parseSpecClauses, type Spec, type SpecClause } from "../src/domain/types.js";
import { SpecRepository } from "../src/repositories/specRepository.js";
import {
  buildSeedArgs,
  CliSpecClauseSeeder,
  type CliRunResult,
  type SpecClauseSeeder,
} from "../src/services/specClauseSeeder.js";
import { SpecsService } from "../src/services/specsService.js";
import { TestClock } from "../src/util/clock.js";

const human: Actor = { type: "human", id: "tom" };

function svcWith(seeder: SpecClauseSeeder): { svc: SpecsService; db: Database.Database } {
  const db = new Database(":memory:");
  migrate(db);
  const svc = new SpecsService({
    db,
    clock: new TestClock(),
    specs: new SpecRepository(db),
    clauseSeeder: seeder,
  });
  return { svc, db };
}

/** Records what freeze handed the seeder. */
class RecordingSeeder implements SpecClauseSeeder {
  readonly calls: Array<{ spec: Spec; clauses: readonly SpecClause[] }> = [];
  seedFrozenSpec(spec: Spec, clauses: readonly SpecClause[]): void {
    this.calls.push({ spec, clauses });
  }
}

describe("freeze → clause seeding (dispatch side)", () => {
  it("seeds every frozen clause once, with kind + (spec_id, clause_id) linkage", () => {
    const seeder = new RecordingSeeder();
    const { svc } = svcWith(seeder);
    const draft = svc.createSpec(
      {
        title: "Checkout redesign",
        clauses: [
          { kind: "requirement", text: "User can pay with a saved card" },
          { kind: "non-goal", text: "No crypto payments", rationale: "Out of scope for v1" },
          { kind: "decision", text: "Use Stripe" },
        ],
      },
      human,
    );

    const frozen = svc.freezeSpec(draft.id, human);

    // Exactly one seeding pass, over the frozen spec's own clauses.
    expect(seeder.calls).toHaveLength(1);
    const { spec, clauses } = seeder.calls[0]!;
    expect(spec.id).toBe(frozen.id);
    expect(spec.status).toBe("frozen");

    // One record per clause, kinds preserved, every clause carries its stable id.
    const expected = parseSpecClauses(frozen.clauses_json);
    expect(clauses).toHaveLength(3);
    expect(clauses.map((c) => c.kind)).toEqual(["requirement", "non-goal", "decision"]);
    expect(clauses.map((c) => c.clause_id)).toEqual(expected.map((c) => c.clause_id));
    for (const c of clauses) expect(c.clause_id.length).toBeGreaterThan(0);
    // The (spec_id, clause_id) pair is the structured provenance link.
    expect(spec.id.length).toBeGreaterThan(0);
  });

  it("seeds nothing for a clause-less spec but still freezes", () => {
    const seeder = new RecordingSeeder();
    const { svc } = svcWith(seeder);
    const draft = svc.createSpec({ title: "Empty" }, human);
    const frozen = svc.freezeSpec(draft.id, human);
    expect(frozen.status).toBe("frozen");
    expect(seeder.calls).toHaveLength(1);
    expect(seeder.calls[0]!.clauses).toHaveLength(0);
  });

  // NEGATIVE CONTROL: a Memory failure must not block or roll back the freeze.
  it("keeps the freeze when the seeder throws (best-effort, non-fatal)", () => {
    const throwing: SpecClauseSeeder = {
      seedFrozenSpec() {
        throw new Error("memory is down");
      },
    };
    const { svc } = svcWith(throwing);
    const draft = svc.createSpec(
      { title: "Resilient", clauses: [{ kind: "requirement", text: "X" }] },
      human,
    );

    const frozen = svc.freezeSpec(draft.id, human);
    expect(frozen.status).toBe("frozen");
    // The freeze committed — it cannot be re-frozen (immutability holds).
    expect(svc.getSpec(draft.id).status).toBe("frozen");
    expect(() => svc.freezeSpec(draft.id, human)).toThrow();
  });
});

describe("CliSpecClauseSeeder — command shape", () => {
  const spec: Spec = {
    id: "spec-1",
    title: "Checkout",
    brief: "",
    clauses_json: "[]",
    status: "frozen",
    target_repo: "web",
    scope_node_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    frozen_at: "2026-01-01T00:00:00.000Z",
  };
  const clauses: SpecClause[] = [
    { clause_id: "c1", kind: "requirement", text: "Pay with saved card" },
    { clause_id: "c2", kind: "non-goal", text: "No crypto", rationale: "v1 scope" },
  ];

  const ok: CliRunResult = { status: 0, stdout: "memory: suggested x (draft)", stderr: "" };

  it("issues exactly one gated `suggest` per clause with provenance flags", () => {
    const seen: string[][] = [];
    const seeder = new CliSpecClauseSeeder({
      cliBin: "/memory.js",
      db: "/tmp/mem.sqlite",
      autoApprove: false,
      runner: (args) => {
        seen.push([...args]);
        return ok;
      },
      log: () => {},
    });

    seeder.seedFrozenSpec(spec, clauses);

    expect(seen).toHaveLength(2);
    for (const [i, args] of seen.entries()) {
      expect(args[0]).toBe("suggest");
      expect(args).toContain("--kind");
      expect(args[args.indexOf("--kind") + 1]).toBe(clauses[i]!.kind);
      expect(args[args.indexOf("--spec-id") + 1]).toBe("spec-1");
      expect(args[args.indexOf("--clause-id") + 1]).toBe(clauses[i]!.clause_id);
      expect(args[args.indexOf("--repo") + 1]).toBe("web");
    }
  });

  it("issues an active `add` under auto-approve", () => {
    const seen: string[][] = [];
    const seeder = new CliSpecClauseSeeder({
      cliBin: "/memory.js",
      db: "/tmp/mem.sqlite",
      autoApprove: true,
      runner: (args) => {
        seen.push([...args]);
        return ok;
      },
      log: () => {},
    });
    seeder.seedFrozenSpec(spec, clauses.slice(0, 1));
    expect(seen[0]![0]).toBe("add");
  });

  // NEGATIVE CONTROL: a runner that blows up must be swallowed, not propagated.
  it("swallows a runner error (never throws into the freeze path)", () => {
    const logs: string[] = [];
    const seeder = new CliSpecClauseSeeder({
      cliBin: "/memory.js",
      db: "/tmp/mem.sqlite",
      autoApprove: false,
      runner: () => {
        throw new Error("spawn exploded");
      },
      log: (m) => logs.push(m),
    });
    expect(() => seeder.seedFrozenSpec(spec, clauses)).not.toThrow();
    expect(logs.length).toBeGreaterThan(0);
  });

  it("builds a byte-safe argv carrying kind, tags and linkage", () => {
    const args = buildSeedArgs(spec, clauses[1]!, "suggest");
    expect(args[0]).toBe("suggest");
    expect(args).toContain("spec-clause");
    expect(args).toContain("spec-spec-1");
    expect(args[args.indexOf("--kind") + 1]).toBe("non-goal");
    expect(args[args.indexOf("--clause-id") + 1]).toBe("c2");
  });
});

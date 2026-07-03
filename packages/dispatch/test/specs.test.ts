import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import { migrate } from "../src/db/connection.js";
import { SCHEMA_VERSION } from "../src/db/schema.js";
import { parseSpecClauses, type Actor } from "../src/domain/types.js";
import { SpecRepository } from "../src/repositories/specRepository.js";
import { SpecsService } from "../src/services/specsService.js";
import { TestClock } from "../src/util/clock.js";
import { DispatchError } from "../src/util/errors.js";

const human: Actor = { type: "human", id: "tom" };

function freshWg(clock = new TestClock()): Dispatch {
  return Dispatch.open(":memory:", clock);
}

// --- specsService: create --------------------------------------------------

describe("Spec-Driven Development (Phase 1a): createSpec", () => {
  let wg: Dispatch;
  beforeEach(() => {
    wg = freshWg();
  });

  it("creates a draft spec with clauses and stamps server-side clause ids", () => {
    const spec = wg.createSpec(
      {
        title: "Checkout redesign",
        brief: "Rework the checkout flow",
        clauses: [
          { kind: "requirement", text: "User can pay with a saved card" },
          { kind: "non-goal", text: "No crypto payments", rationale: "Out of scope for v1" },
          { kind: "decision", text: "Use Stripe" },
        ],
      },
      human,
    );

    expect(spec.status).toBe("draft");
    expect(spec.frozen_at).toBeNull();
    expect(spec.title).toBe("Checkout redesign");

    const clauses = parseSpecClauses(spec.clauses_json);
    expect(clauses).toHaveLength(3);
    // Every clause got a stable, non-empty id generated server-side.
    for (const c of clauses) {
      expect(typeof c.clause_id).toBe("string");
      expect(c.clause_id.length).toBeGreaterThan(0);
    }
    // Ids are unique across clauses.
    expect(new Set(clauses.map((c) => c.clause_id)).size).toBe(3);
    expect(clauses[1]?.kind).toBe("non-goal");
    expect(clauses[1]?.rationale).toBe("Out of scope for v1");
  });

  it("namespaces a supplied clause_id under the spec (ids are stable + globally unique)", () => {
    const spec = wg.createSpec(
      { title: "Spec", clauses: [{ clause_id: "R-1", kind: "requirement", text: "Do X" }] },
      human,
    );
    // The supplied base id is preserved but namespaced under the spec id so two
    // specs' identical positional/supplied ids can never collide downstream.
    expect(parseSpecClauses(spec.clauses_json)[0]?.clause_id).toBe(`${spec.id}:R-1`);
  });

  it("allows a spec with no clauses (drafted then filled in)", () => {
    const spec = wg.createSpec({ title: "Empty draft" }, human);
    expect(parseSpecClauses(spec.clauses_json)).toHaveLength(0);
    expect(spec.brief).toBe("");
  });

  it("records a spec.created event", () => {
    const spec = wg.createSpec({ title: "Spec" }, human);
    const events = wg.db
      .prepare("SELECT event_type FROM work_events WHERE entity_type='spec' AND entity_id=?")
      .all(spec.id) as Array<{ event_type: string }>;
    expect(events.map((e) => e.event_type)).toContain("spec.created");
  });

  it("rejects an empty title (Zod boundary)", () => {
    expect(() => wg.createSpec({ title: "" }, human)).toThrow();
  });

  it("rejects an unknown clause kind (clause-kind validation)", () => {
    // The facade takes `unknown`, so an invalid kind is caught at the Zod boundary
    // at runtime (not by the type-checker).
    expect(() =>
      wg.createSpec({ title: "Spec", clauses: [{ kind: "wish", text: "nope" }] }, human),
    ).toThrow();
  });
});

// --- specsService: freeze + immutability -----------------------------------

describe("Spec-Driven Development (Phase 1a): freeze + immutability", () => {
  let wg: Dispatch;
  let clock: TestClock;
  beforeEach(() => {
    clock = new TestClock();
    wg = freshWg(clock);
  });

  it("freezes a draft spec (draft→frozen) and stamps frozen_at", () => {
    const draft = wg.createSpec(
      { title: "Spec", clauses: [{ kind: "requirement", text: "Do X" }] },
      human,
    );
    clock.advanceSeconds(60);
    const frozen = wg.freezeSpec(draft.id, human);

    expect(frozen.status).toBe("frozen");
    expect(frozen.frozen_at).not.toBeNull();
    // getSpec reflects the persisted frozen state.
    expect(wg.getSpec(draft.id).status).toBe("frozen");

    const events = wg.db
      .prepare("SELECT event_type FROM work_events WHERE entity_type='spec' AND entity_id=?")
      .all(draft.id) as Array<{ event_type: string }>;
    expect(events.map((e) => e.event_type)).toContain("spec.frozen");
  });

  it("updates a DRAFT spec's clauses", () => {
    const draft = wg.createSpec(
      { title: "Spec", clauses: [{ kind: "requirement", text: "Do X" }] },
      human,
    );
    const updated = wg.updateSpecClauses(
      draft.id,
      {
        clauses: [
          { kind: "requirement", text: "Do Y" },
          { kind: "non-goal", text: "Not Z" },
        ],
      },
      human,
    );
    const clauses = parseSpecClauses(updated.clauses_json);
    expect(clauses).toHaveLength(2);
    expect(clauses[0]?.text).toBe("Do Y");
  });

  // NEGATIVE CONTROL: a frozen spec is immutable — editing it must throw.
  it("rejects editing a FROZEN spec (immutability invariant)", () => {
    const draft = wg.createSpec(
      { title: "Spec", clauses: [{ kind: "requirement", text: "Do X" }] },
      human,
    );
    wg.freezeSpec(draft.id, human);

    expect(() =>
      wg.updateSpecClauses(draft.id, { clauses: [{ kind: "requirement", text: "sneaky" }] }, human),
    ).toThrow(DispatchError);

    // And the persisted clauses are untouched by the rejected edit.
    expect(parseSpecClauses(wg.getSpec(draft.id).clauses_json)[0]?.text).toBe("Do X");
  });

  it("rejects re-freezing an already-frozen spec (draft→frozen only)", () => {
    const draft = wg.createSpec(
      { title: "Spec", clauses: [{ kind: "requirement", text: "Do X" }] },
      human,
    );
    wg.freezeSpec(draft.id, human);
    expect(() => wg.freezeSpec(draft.id, human)).toThrow(DispatchError);
  });

  it("rejects freezing a spec with no clauses (a freeze must capture intent)", () => {
    const draft = wg.createSpec({ title: "Empty" }, human);
    expect(parseSpecClauses(draft.clauses_json)).toHaveLength(0);
    try {
      wg.freezeSpec(draft.id, human);
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DispatchError);
      expect((err as DispatchError).code).toBe("STATE_CONFLICT");
    }
    // The spec is left a draft — the rejected freeze changed nothing.
    expect(wg.getSpec(draft.id).status).toBe("draft");
  });

  it("surfaces STATE_CONFLICT when mutating a non-draft spec", () => {
    const draft = wg.createSpec(
      { title: "Spec", clauses: [{ kind: "requirement", text: "Do X" }] },
      human,
    );
    wg.freezeSpec(draft.id, human);
    try {
      wg.freezeSpec(draft.id, human);
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DispatchError);
      expect((err as DispatchError).code).toBe("STATE_CONFLICT");
    }
  });

  it("throws NOT_FOUND for an unknown spec id", () => {
    expect(() => wg.getSpec("does-not-exist")).toThrow(DispatchError);
    expect(() => wg.freezeSpec("does-not-exist", human)).toThrow(DispatchError);
  });
});

// --- specsService: list ----------------------------------------------------

describe("Spec-Driven Development (Phase 1a): listSpecs", () => {
  it("lists specs newest-first and filters by status", () => {
    const clock = new TestClock();
    const wg = freshWg(clock);
    const a = wg.createSpec(
      { title: "First", clauses: [{ kind: "requirement", text: "Do X" }] },
      human,
    );
    clock.advanceSeconds(1);
    const b = wg.createSpec({ title: "Second" }, human);
    clock.advanceSeconds(1);
    wg.freezeSpec(a.id, human);

    const all = wg.listSpecs();
    expect(all.map((s) => s.id)).toEqual([b.id, a.id]); // newest-first

    const drafts = wg.listSpecs("draft");
    expect(drafts.map((s) => s.id)).toEqual([b.id]);

    const frozen = wg.listSpecs("frozen");
    expect(frozen.map((s) => s.id)).toEqual([a.id]);
  });
});

// --- specRepository: round-trip --------------------------------------------

describe("Spec-Driven Development (Phase 1a): specRepository round-trip", () => {
  it("inserts, reads back, updates clauses, freezes and supersedes a row", () => {
    const db = new Database(":memory:");
    migrate(db);
    const repo = new SpecRepository(db);
    const clock = new TestClock();

    repo.insert({
      id: "spec-1",
      title: "Round trip",
      brief: "brief text",
      clauses_json: JSON.stringify([{ clause_id: "c1", kind: "requirement", text: "X" }]),
      status: "draft",
      target_repo: "web",
      scope_node_id: null,
      created_at: clock.now(),
      updated_at: clock.now(),
      frozen_at: null,
    });

    const read = repo.findById("spec-1");
    expect(read?.title).toBe("Round trip");
    expect(read?.target_repo).toBe("web");
    expect(parseSpecClauses(read?.clauses_json ?? null)[0]?.clause_id).toBe("c1");

    repo.updateClauses(
      "spec-1",
      JSON.stringify([{ clause_id: "c1", kind: "requirement", text: "Y" }]),
      clock.now(),
    );
    expect(parseSpecClauses(repo.findById("spec-1")?.clauses_json ?? null)[0]?.text).toBe("Y");

    clock.advanceSeconds(30);
    repo.freeze("spec-1", clock.now());
    const frozen = repo.findById("spec-1");
    expect(frozen?.status).toBe("frozen");
    expect(frozen?.frozen_at).toBe(clock.now());

    repo.markSuperseded("spec-1", clock.now());
    expect(repo.findById("spec-1")?.status).toBe("superseded");

    expect(repo.findById("missing")).toBeUndefined();
    db.close();
  });

  it("services back onto a repository directly (service + repo wiring)", () => {
    const db = new Database(":memory:");
    migrate(db);
    const clock = new TestClock();
    const svc = new SpecsService({ db, clock, specs: new SpecRepository(db) });

    const spec = svc.createSpec(
      { title: "Direct", clauses: [{ kind: "decision", text: "Pick A" }] },
      human,
    );
    expect(svc.getSpec(spec.id).title).toBe("Direct");
    expect(svc.freezeSpec(spec.id, human).status).toBe("frozen");
    db.close();
  });
});

// --- Additive migration (v16 → v17) ----------------------------------------

describe("Spec-Driven Development (Phase 1a): additive migration (v16 → v17)", () => {
  it("adds the specs table to a simulated v16 DB without touching existing data", () => {
    // A v16-shaped DB: a minimal tickets table + a stamped v16 version, no specs.
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE tickets (
        id TEXT PRIMARY KEY, number INTEGER UNIQUE, title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN (
          'draft','refining','ready','claimed','in_progress',
          'blocked','in_review','in_testing','ready_for_merge','done','failed','cancelled','paused')),
        priority INTEGER NOT NULL DEFAULT 0,
        risk_level TEXT NOT NULL DEFAULT 'medium',
        policy_pack TEXT NOT NULL DEFAULT 'solo_loose',
        source TEXT, created_by TEXT, reviewer TEXT, branch_name TEXT, pr_url TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0, row_version INTEGER NOT NULL DEFAULT 0,
        scheduled_after TEXT, due_at TEXT, bootstrap INTEGER NOT NULL DEFAULT 0,
        last_review_feedback TEXT, can_be_tested INTEGER NOT NULL DEFAULT 0, test_contract TEXT,
        human_owner TEXT, human_delivered TEXT, delivery_budget_usd REAL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
    db.prepare("INSERT INTO schema_meta(key,value) VALUES ('schema_version','16')").run();
    db.prepare(
      "INSERT INTO tickets (id, number, title, status) VALUES ('t1', 1, 'old', 'draft')",
    ).run();

    migrate(db);

    // Pre-existing data preserved.
    const t = db.prepare("SELECT title FROM tickets WHERE id='t1'").get() as { title: string };
    expect(t.title).toBe("old");

    // The specs table now exists and is usable.
    const repo = new SpecRepository(db);
    repo.insert({
      id: "s1",
      title: "post-migration spec",
      brief: "",
      clauses_json: "[]",
      status: "draft",
      target_repo: null,
      scope_node_id: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      frozen_at: null,
    });
    expect(repo.findById("s1")?.title).toBe("post-migration spec");

    // Version stamped to current.
    const ver = db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as {
      value: string;
    };
    expect(Number(ver.value)).toBe(SCHEMA_VERSION);
    db.close();
  });
});

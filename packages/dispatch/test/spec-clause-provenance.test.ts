import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import { migrate } from "../src/db/connection.js";
import { SCHEMA_VERSION } from "../src/db/schema.js";
import type { Actor } from "../src/domain/types.js";
import { TestClock } from "../src/util/clock.js";

/**
 * Spec-Driven Development (Phase 2a): the clause→AC provenance link. An acceptance
 * criterion can carry the frozen-spec `clause_id` it satisfies, persisted to the
 * nullable `acceptance_criteria.spec_clause_id` column and surfaced in the ticket
 * read model so Phase 3 coverage can join ACs back to clauses.
 */

const human: Actor = { type: "human", id: "tom" };

function freshWg(clock = new TestClock()): Dispatch {
  return Dispatch.open(":memory:", clock);
}

describe("Phase 2a: acceptance_criteria.spec_clause_id migration (v17 → v18)", () => {
  it("adds spec_clause_id to an existing pre-v18 acceptance_criteria table without data loss", () => {
    // A v17-shaped acceptance_criteria table: the full pre-Phase-2a column set,
    // but WITHOUT spec_clause_id.
    // Only the acceptance_criteria table needs to predate v18; leaving tickets to
    // SCHEMA_SQL keeps this test focused on the ADD COLUMN migration under test
    // (the tickets rebuild migrations treat an absent tickets table as fresh).
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE acceptance_criteria (
        id                 TEXT PRIMARY KEY,
        ticket_id          TEXT NOT NULL,
        text               TEXT NOT NULL,
        sort_order         INTEGER NOT NULL DEFAULT 0,
        status             TEXT NOT NULL DEFAULT 'pending',
        verification_method TEXT,
        evidence_required  INTEGER NOT NULL DEFAULT 0,
        verified_by        TEXT,
        verified_at        TEXT,
        created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
    db.prepare("INSERT INTO schema_meta(key,value) VALUES ('schema_version','17')").run();
    db.prepare(
      "INSERT INTO acceptance_criteria (id, ticket_id, text) VALUES ('a1','t1','legacy AC')",
    ).run();

    migrate(db);

    // The column now exists and the pre-existing row is intact with a NULL backfill.
    const cols = (
      db.prepare("PRAGMA table_info(acceptance_criteria)").all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    expect(cols).toContain("spec_clause_id");
    const row = db.prepare("SELECT * FROM acceptance_criteria WHERE id = 'a1'").get() as {
      text: string;
      spec_clause_id: string | null;
    };
    expect(row.text).toBe("legacy AC");
    expect(row.spec_clause_id).toBeNull();

    // Version stamp advanced to the current schema.
    const ver = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as {
      value: string;
    };
    expect(Number(ver.value)).toBe(SCHEMA_VERSION);
  });
});

describe("Phase 2a: an AC persists + reads back spec_clause_id", () => {
  let wg: Dispatch;
  beforeEach(() => {
    wg = freshWg();
  });

  it("persists a spec_clause_id and surfaces it in the ticket read model", () => {
    const t = wg.createTicket({ title: "Reset flow" }, human);
    const { ac } = wg.addAcceptanceCriterion(
      { ticket_id: t.id, text: "email reset works", spec_clause_id: "r1" },
      human,
    );
    expect(ac.spec_clause_id).toBe("r1");

    const view = wg.view(t.id);
    const found = view.acceptanceCriteria.find((a) => a.text === "email reset works");
    expect(found?.spec_clause_id).toBe("r1");
  });

  it("negative control: an AC without a clause id stays NULL", () => {
    const t = wg.createTicket({ title: "Misc" }, human);
    const { ac } = wg.addAcceptanceCriterion({ ticket_id: t.id, text: "plain AC" }, human);
    expect(ac.spec_clause_id).toBeNull();

    const view = wg.view(t.id);
    const found = view.acceptanceCriteria.find((a) => a.text === "plain AC");
    expect(found?.spec_clause_id).toBeNull();
  });
});

describe("Phase 2a: create_epic threads clauseRef onto the created tickets' ACs", () => {
  let wg: Dispatch;
  beforeEach(() => {
    wg = freshWg();
  });

  it("persists spec_clause_id from clauseRef-carrying ACs, keeping plain ACs NULL", () => {
    const res = wg.createEpic(
      {
        epic: { name: "Password reset", description: "spec-driven" },
        tickets: [
          {
            title: "Bootstrap",
            // Plain string ACs (the unchanged shape) — no provenance.
            acceptanceCriteria: ["scaffold", "first commit"],
            bootstrap: true,
            dependsOn: [],
          },
          {
            title: "Reset flow",
            // Mixed: clauseRef-carrying objects alongside a bare string.
            acceptanceCriteria: [
              { text: "reset by email", clauseRef: "r1" },
              { text: "link expires in 30m", clauseRef: "r2" },
              "extra AC with no clause",
            ],
            dependsOn: [0],
          },
        ],
      },
      human,
    );

    const [t0, t1] = res.ticketNumbers.map((n) => wg.resolveTicket(`#${n}`));

    // Bootstrap ticket: both ACs are plain → spec_clause_id NULL (negative control).
    const boot = wg.view(t0!.id).acceptanceCriteria;
    expect(boot).toHaveLength(2);
    expect(boot.every((a) => a.spec_clause_id === null)).toBe(true);

    // Reset ticket: the two clauseRef ACs thread their clause ids; the plain one stays NULL.
    const reset = wg.view(t1!.id).acceptanceCriteria;
    const byText = new Map(reset.map((a) => [a.text, a.spec_clause_id]));
    expect(byText.get("reset by email")).toBe("r1");
    expect(byText.get("link expires in 30m")).toBe("r2");
    expect(byText.get("extra AC with no clause")).toBeNull();
  });
});

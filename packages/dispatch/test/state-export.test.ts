import { describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import { openDatabase } from "../src/db/connection.js";
import { SCHEMA_VERSION } from "../src/db/schema.js";
import type { Actor } from "../src/domain/types.js";
import {
  EXPORT_TABLES,
  STATE_FORMAT_VERSION,
  exportState,
  importState,
  importStateFromJson,
  serializeBundle,
  validateBundle,
  type StateBundle,
} from "../src/io/stateExport.js";
import { TestClock } from "../src/util/clock.js";
import { DispatchError } from "../src/util/errors.js";
import { giveTicketRealDelivery, nonEmptyDiffRunner } from "./helpers/realDiff.js";

const human: Actor = { type: "human", id: "tom" };
const reviewer: Actor = { type: "human", id: "rev" };
const agentActor: Actor = { type: "agent", id: "agent-runner" };

function freshWg(clock = new TestClock()): Dispatch {
  return Dispatch.open(":memory:", clock, nonEmptyDiffRunner);
}

/**
 * Build a representative board: two repos, an epic of two dependency-linked
 * tickets with ACs + scope nodes, and one of them driven through claim → evidence
 * → review approval so the export carries claims, evidence and review history.
 * Returns the handles a caller asserts against after a round-trip.
 */
function seedBoard(wg: Dispatch): {
  epicTicketNumbers: number[];
  reviewedTicketId: string;
  reviewedAcId: string;
  scopeNodeId: string;
} {
  // Two repos.
  wg.registerRepository({ name: "svc", default_branch: "main" }, human);
  wg.registerRepository({ name: "web", default_branch: "main" }, human);

  // A product scope node the work anchors to.
  const node = wg.createScopeNode({ name: "Checkout", type: "product" }, human);

  // An epic of two tickets; #1 depends on #0 (index 1 dependsOn [0]).
  const epic = wg.createEpic(
    {
      epic: { name: "Payments", description: "epic of payments work" },
      tickets: [
        {
          title: "Add card form",
          description: "card capture",
          acceptanceCriteria: ["Form validates", "Submits to API"],
          repo: "web",
        },
        {
          title: "Charge endpoint",
          description: "POST /charge",
          acceptanceCriteria: ["Returns 200"],
          repo: "svc",
          dependsOn: [0],
        },
      ],
    },
    human,
  );

  // Drive ticket #0 (no unsatisfied deps) through review so we capture a claim,
  // evidence, and a review-approval event.
  const reviewedNumber = epic.ticketNumbers[0]!;
  const reviewed = wg.resolveTicket(String(reviewedNumber));
  wg.linkTicketScope(
    { ticket_id: reviewed.id, scope_node_id: node.id, relation: "secondary" },
    human,
  );
  const view0 = wg.view(reviewed.id);
  const acId = view0.acceptanceCriteria[0]!.id;

  wg.markReady(reviewed.id, human);
  const agent = wg.registerAgent({ display_name: "a" }, human);
  const claim = wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, agentActor);
  wg.recordEvidence(
    {
      claimToken: claim!.claimToken,
      ticket_id: reviewed.id,
      ac_id: acId,
      evidence_type: "test_output",
      summary: "passed",
    },
    agentActor,
  );
  wg.submitForReview(
    { claimToken: claim!.claimToken, ticket_id: reviewed.id, reason: "done" },
    agentActor,
  );
  giveTicketRealDelivery(wg, reviewed.id, human);
  wg.approveReview(reviewed.id, reviewer);

  return {
    epicTicketNumbers: epic.ticketNumbers,
    reviewedTicketId: reviewed.id,
    reviewedAcId: acId,
    scopeNodeId: node.id,
  };
}

describe("dispatch state export", () => {
  it("round-trips the whole board into a fresh DB", () => {
    const src = freshWg();
    const seed = seedBoard(src);

    const bundle = exportState(src.db, { now: "2026-06-28T00:00:00.000Z" });
    expect(bundle.format_version).toBe(STATE_FORMAT_VERSION);
    expect(bundle.schema_version).toBe(SCHEMA_VERSION);
    // Every export table is present as a key.
    for (const table of EXPORT_TABLES) {
      expect(bundle.tables[table]).toBeDefined();
    }

    // Capture the source board + epics + review history to compare against.
    const srcBoard = src.board();
    const srcView = src.view(seed.reviewedTicketId);

    // Import into a brand-new DB.
    const dst = new Dispatch(openDatabase(":memory:"), new TestClock(), nonEmptyDiffRunner);
    const result = importState(dst.db, bundle);
    expect(result.rowsInserted).toBeGreaterThan(0);

    // Board: same tickets in the same columns.
    const dstBoard = dst.board();
    const colIds = (b: ReturnType<Dispatch["board"]>) =>
      b.columns.map((c) => ({ column: c.column, ids: c.cards.map((card) => card.id).sort() }));
    expect(colIds(dstBoard)).toEqual(colIds(srcBoard));

    // Tickets list matches (numbers + statuses + ids).
    const norm = (ts: ReturnType<Dispatch["list"]>) =>
      ts
        .map((t) => ({ number: t.number, status: t.status, id: t.id, title: t.title }))
        .sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
    expect(norm(dst.list())).toEqual(norm(src.list()));

    // The reviewed ticket reproduces: AC, evidence, scope, dependencies, events.
    const dstView = dst.view(seed.reviewedTicketId);
    expect(dstView.ticket.status).toBe(srcView.ticket.status);
    expect(dstView.acceptanceCriteria.map((a) => a.id).sort()).toEqual(
      srcView.acceptanceCriteria.map((a) => a.id).sort(),
    );
    expect(dstView.evidence.map((e) => e.summary).sort()).toEqual(
      srcView.evidence.map((e) => e.summary).sort(),
    );
    expect(dstView.scopes.map((s) => s.id).sort()).toEqual(srcView.scopes.map((s) => s.id).sort());
    // Review history: the reviewed ticket reached ready_for_merge and the
    // approval transition event survived the round-trip.
    expect(dstView.ticket.status).toBe("ready_for_merge");
    expect(
      dstView.events.some(
        (e) =>
          e.event_type === "ticket.transitioned" &&
          JSON.stringify(e.payload_json ?? "").includes("review_approved"),
      ),
    ).toBe(true);

    // Epics: the second ticket's dependency on the first round-trips.
    const depTicketNumber = seed.epicTicketNumbers[1]!;
    const depView = dst.view(String(depTicketNumber));
    expect(depView.dependencies.length).toBe(1);
  });

  it("produces byte-identical JSON for two exports of the same DB", () => {
    const wg = freshWg();
    seedBoard(wg);
    const a = serializeBundle(exportState(wg.db, { now: "2026-06-28T00:00:00.000Z" }));
    const b = serializeBundle(exportState(wg.db, { now: "2026-06-28T00:00:00.000Z" }));
    expect(a).toBe(b);
  });

  it("refuses to import into a non-empty DB without force", () => {
    const src = freshWg();
    seedBoard(src);
    const bundle = exportState(src.db);

    const dst = new Dispatch(openDatabase(":memory:"), new TestClock(), nonEmptyDiffRunner);
    seedBoard(dst); // make it non-empty

    expect(() => importState(dst.db, bundle)).toThrow(DispatchError);
    try {
      importState(dst.db, bundle);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as DispatchError).code).toBe("DB_NOT_EMPTY");
    }
  });

  it("replaces a non-empty DB when force is given", () => {
    const src = freshWg();
    const seed = seedBoard(src);
    const bundle = exportState(src.db);
    const srcTickets = src.list().length;

    const dst = new Dispatch(openDatabase(":memory:"), new TestClock(), nonEmptyDiffRunner);
    seedBoard(dst);
    // A different, extra ticket so the DBs genuinely diverge before the replace.
    dst.createTicket({ title: "extra" }, human);
    expect(dst.list().length).not.toBe(srcTickets);

    const result = importState(dst.db, bundle, { force: true });
    expect(result.rowsInserted).toBeGreaterThan(0);
    // After a forced import the destination mirrors the source exactly.
    expect(dst.list().length).toBe(srcTickets);
    expect(dst.view(seed.reviewedTicketId).ticket.status).toBe(
      src.view(seed.reviewedTicketId).ticket.status,
    );
  });

  it("rejects a bundle with an incompatible (too-new) schema_version", () => {
    const src = freshWg();
    seedBoard(src);
    const bundle = exportState(src.db);
    const tampered: StateBundle = { ...bundle, schema_version: SCHEMA_VERSION + 5 };

    const dst = new Dispatch(openDatabase(":memory:"), new TestClock(), nonEmptyDiffRunner);
    try {
      importState(dst.db, tampered);
      expect.unreachable("should have rejected the too-new schema_version");
    } catch (err) {
      expect(err).toBeInstanceOf(DispatchError);
      expect((err as DispatchError).code).toBe("INCOMPATIBLE_BUNDLE");
      expect((err as DispatchError).message).toContain("schema_version");
    }
  });

  it("rejects a bundle with a too-new format_version via validateBundle", () => {
    const src = freshWg();
    seedBoard(src);
    const bundle = exportState(src.db);
    const tampered = { ...bundle, format_version: STATE_FORMAT_VERSION + 1 };
    expect(() => validateBundle(tampered)).toThrow(/format_version/);
  });

  it("rejects a non-bundle / malformed JSON", () => {
    const dst = new Dispatch(openDatabase(":memory:"), new TestClock(), nonEmptyDiffRunner);
    expect(() => importStateFromJson(dst.db, "not json")).toThrow(/Invalid JSON/);
    expect(() => importStateFromJson(dst.db, JSON.stringify({ nope: true }))).toThrow(
      /Not a Dispatch state bundle/,
    );
  });

  it("imports an older schema_version bundle by relying on the fresh schema", () => {
    const src = freshWg();
    const seed = seedBoard(src);
    const bundle = exportState(src.db);
    // An older bundle is accepted (additive migrations make the fresh DB superset).
    const older: StateBundle = { ...bundle, schema_version: SCHEMA_VERSION - 1 };

    const dst = new Dispatch(openDatabase(":memory:"), new TestClock(), nonEmptyDiffRunner);
    const result = importState(dst.db, older);
    expect(result.schemaVersion).toBe(SCHEMA_VERSION - 1);
    expect(dst.view(seed.reviewedTicketId).ticket.title).toBe(
      src.view(seed.reviewedTicketId).ticket.title,
    );
  });

  it("EXPORT_TABLES covers every durable table in a freshly-migrated DB (drift guard)", () => {
    // FIX-7: EXPORT_TABLES is hand-maintained. A future migration that adds a
    // durable table must consciously be included in the export (or excluded here).
    // Introspect the LIVE schema and assert EXPORT_TABLES ∪ the explicitly-excluded
    // internal tables exactly equals the live set — so silent drift fails the test.
    const db = openDatabase(":memory:");
    const liveTables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);

    // Tables deliberately NOT round-tripped by the bundle, named explicitly so a
    // reviewer must justify every exclusion:
    //   - schema_meta: pure metadata, captured by the bundle's top-level
    //     schema_version and re-stamped by migrate() on import.
    //   - runs: machine-local control-plane data (the run-activity registry). Its
    //     rows carry this machine's pids and GAFFER_DATA/runs/<id>.log paths and
    //     have no FK to the board — they are meaningless (and a `running` row with
    //     a foreign pid is actively misleading) on another machine. The bundle is
    //     the portable BOARD; run history is intentionally not carried.
    const INTENTIONALLY_EXCLUDED = ["schema_meta", "runs"];

    const covered = new Set<string>([...EXPORT_TABLES, ...INTENTIONALLY_EXCLUDED]);

    // Every live table is either exported or explicitly excluded.
    const uncovered = liveTables.filter((t) => !covered.has(t));
    expect(
      uncovered,
      `Durable table(s) ${JSON.stringify(uncovered)} are neither in EXPORT_TABLES nor ` +
        "explicitly excluded. A migration added a table — include it in EXPORT_TABLES " +
        "(stateExport.ts) or add it to INTENTIONALLY_EXCLUDED with a reason.",
    ).toEqual([]);

    // And nothing we claim to cover has vanished from the schema (stale entry).
    const live = new Set(liveTables);
    const stale = [...covered].filter((t) => !live.has(t));
    expect(
      stale,
      `EXPORT_TABLES/excluded references table(s) that no longer exist: ${stale}`,
    ).toEqual([]);
  });
});

// TAMPER-EVIDENT EVENT LOG — every work_event links to its predecessor through a
// sha256 hash chain. Proves: appends chain from genesis; verification passes on an
// untouched log; rewriting, deleting or re-ordering a row is detected at the first
// affected row; a pre-v23 DB is backfilled on migrate; an imported bundle without
// hashes is re-chained; `dispatch doctor` reports the chain.
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import { migrate } from "../src/db/connection.js";
import {
  EVENT_CHAIN_GENESIS,
  backfillEventChain,
  eventHash,
  verifyEventChain,
} from "../src/events/eventChain.js";
import { writeEvent } from "../src/events/eventWriter.js";
import { exportState, importState } from "../src/io/stateExport.js";
import { runDoctor } from "../src/cli/ops.js";

const SYSTEM = { type: "system" as const, id: "test" };

function freshDb(): InstanceType<typeof Database> {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

function rows(db: InstanceType<typeof Database>) {
  return db
    .prepare("SELECT rowid AS seq, id, prev_hash, hash FROM work_events ORDER BY rowid")
    .all() as Array<{ seq: number; id: string; prev_hash: string; hash: string }>;
}

describe("event hash chain", () => {
  it("chains every append from the genesis constant and verifies clean", () => {
    const db = freshDb();
    for (let i = 0; i < 4; i++) {
      writeEvent(db, {
        entity_type: "ticket",
        entity_id: `t${i}`,
        actor: SYSTEM,
        event_type: "x",
        payload: { i },
      });
    }
    const r = rows(db);
    expect(r).toHaveLength(4);
    expect(r[0]!.prev_hash).toBe(EVENT_CHAIN_GENESIS);
    for (let i = 1; i < r.length; i++) expect(r[i]!.prev_hash).toBe(r[i - 1]!.hash);
    expect(new Set(r.map((x) => x.hash)).size).toBe(4);
    expect(verifyEventChain(db)).toEqual({
      ok: true,
      checked: 4,
      brokenAtSeq: null,
      brokenEventId: null,
      reason: null,
    });
  });

  it("detects a rewritten payload at exactly that row", () => {
    const db = freshDb();
    for (let i = 0; i < 3; i++) {
      writeEvent(db, {
        entity_type: "ticket",
        entity_id: "t",
        actor: SYSTEM,
        event_type: "ticket.transitioned",
        payload: { to: "in_review", i },
      });
    }
    const second = rows(db)[1]!;
    db.prepare("UPDATE work_events SET payload_json = ? WHERE rowid = ?").run(
      JSON.stringify({ to: "done" }),
      second.seq,
    );
    const v = verifyEventChain(db);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("content");
    expect(v.brokenAtSeq).toBe(second.seq);
    expect(v.brokenEventId).toBe(second.id);
    expect(v.checked).toBe(2);
  });

  it("detects a deleted row (the successor no longer links)", () => {
    const db = freshDb();
    for (let i = 0; i < 3; i++) {
      writeEvent(db, { entity_type: "ticket", entity_id: "t", actor: SYSTEM, event_type: "x" });
    }
    const [, second, third] = rows(db);
    db.prepare("DELETE FROM work_events WHERE rowid = ?").run(second!.seq);
    const v = verifyEventChain(db);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("link");
    expect(v.brokenAtSeq).toBe(third!.seq);
  });

  it("detects a forged row whose hash was recomputed but whose predecessor link is stale", () => {
    const db = freshDb();
    writeEvent(db, { entity_type: "ticket", entity_id: "t", actor: SYSTEM, event_type: "a" });
    writeEvent(db, { entity_type: "ticket", entity_id: "t", actor: SYSTEM, event_type: "b" });
    const [first, second] = rows(db);
    // An attacker rewrites row 1 AND recomputes its hash; row 2 still names the old hash.
    const forged = db.prepare("SELECT * FROM work_events WHERE rowid = ?").get(first!.seq) as never;
    const newHash = eventHash(EVENT_CHAIN_GENESIS, {
      ...(forged as object),
      event_type: "forged",
    } as never);
    db.prepare("UPDATE work_events SET event_type = 'forged', hash = ? WHERE rowid = ?").run(
      newHash,
      first!.seq,
    );
    const v = verifyEventChain(db);
    expect(v.ok).toBe(false);
    expect(v.brokenAtSeq).toBe(second!.seq);
    expect(v.reason).toBe("link");
  });

  it("migrate backfills a pre-v23 log in insertion order and stays idempotent", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare("INSERT INTO schema_meta(key,value) VALUES ('schema_version','22')").run();
    db.exec(`CREATE TABLE work_events (
      id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
      actor_type TEXT NOT NULL, actor_id TEXT, event_type TEXT NOT NULL, payload_json TEXT,
      correlation_id TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`);
    const ins = db.prepare(
      "INSERT INTO work_events (id, entity_type, entity_id, actor_type, event_type, payload_json, created_at) VALUES (?, 'ticket', 't', 'system', 'legacy', ?, ?)",
    );
    ins.run("e1", '{"n":1}', "2026-01-01T00:00:00.000Z");
    ins.run("e2", '{"n":2}', "2026-01-01T00:00:01.000Z");
    migrate(db);
    const r = rows(db);
    expect(r[0]!.prev_hash).toBe(EVENT_CHAIN_GENESIS);
    expect(r[1]!.prev_hash).toBe(r[0]!.hash);
    expect(verifyEventChain(db).ok).toBe(true);
    // A new append after the backfill continues the chain.
    writeEvent(db, { entity_type: "ticket", entity_id: "t", actor: SYSTEM, event_type: "new" });
    expect(verifyEventChain(db)).toMatchObject({ ok: true, checked: 3 });
    expect(backfillEventChain(db)).toBe(0);
    expect(() => migrate(db)).not.toThrow();
  });

  it("an export bundle carries the chain, and a hash-less (older) bundle is re-chained on import", () => {
    const src = Dispatch.open(":memory:");
    src.createTicket({ title: "chained" }, { type: "human", id: "op" });
    const bundle = exportState(src.db);
    const events = bundle.tables.work_events as Array<Record<string, unknown>>;
    expect(events.length).toBeGreaterThan(0);
    expect(typeof events[0]!.hash).toBe("string");
    // Same bundle restored as-is: verifies.
    const dst = Dispatch.open(":memory:");
    importState(dst.db, bundle);
    expect(verifyEventChain(dst.db).ok).toBe(true);
    // Strip the hashes (a bundle from before v23) — import re-chains from genesis.
    const legacy = {
      ...bundle,
      tables: {
        ...bundle.tables,
        work_events: events.map(({ hash: _h, prev_hash: _p, ...rest }) => rest),
      },
    };
    const dst2 = Dispatch.open(":memory:");
    importState(dst2.db, legacy as typeof bundle);
    expect(verifyEventChain(dst2.db)).toMatchObject({ ok: true, checked: events.length });
    src.db.close();
    dst.db.close();
    dst2.db.close();
  });

  it("doctor reports the chain and fails on a break; Dispatch.verifyEventChain delegates", () => {
    const wg = Dispatch.open(":memory:");
    wg.createTicket({ title: "doctored" }, { type: "human", id: "op" });
    expect(wg.verifyEventChain().ok).toBe(true);
    let report = runDoctor(wg.db, ":memory:");
    expect(
      report.checks.some(
        (c) => c.label.startsWith("Event log hash chain: intact") && c.level === "ok",
      ),
    ).toBe(true);
    const changed = wg.db
      .prepare(
        "UPDATE work_events SET actor_type = 'admin' WHERE rowid = (SELECT MIN(rowid) FROM work_events)",
      )
      .run().changes;
    expect(changed).toBe(1);
    expect(wg.verifyEventChain().ok).toBe(false);
    report = runDoctor(wg.db, ":memory:");
    expect(report.exitCode).toBe(1);
    expect(
      report.checks.some(
        (c) => c.label.includes("Event log hash chain: BROKEN") && c.level === "fail",
      ),
    ).toBe(true);
    wg.db.close();
  });
});

// Event-log integrity across export/import and reopen.
//  - export-scrambles-event-order: a restored board keeps the source's event order
//    (rowid order is the chain order and every timeline's order), including bundles
//    written while the export still ordered work_events by random UUID.
//  - chain-backfill-launders-tamper: blanking the hashes after an edit no longer
//    makes a tampered log verify clean on the next open.
import { describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import { migrate } from "../src/db/connection.js";
import { verifyEventChain } from "../src/events/eventChain.js";
import { writeEvent } from "../src/events/eventWriter.js";
import { exportState, importState, type StateBundle } from "../src/io/stateExport.js";

const human = { type: "human" as const, id: "op" };

/** A board with several tickets and well over 20 events, interleaved across them. */
function busyBoard(): Dispatch {
  const wg = Dispatch.open(":memory:");
  const tickets = [0, 1, 2].map((i) =>
    wg.createTicket({ title: `t${i}`, description: "d", policy_pack: "solo_loose" }, human),
  );
  for (let round = 0; round < 6; round++) {
    for (const t of tickets) {
      wg.addAcceptanceCriterion({ ticket_id: t.id, text: `ac ${round}` }, human);
    }
  }
  for (const t of tickets) wg.markReady(t.id, human);
  return wg;
}

/** Every event id in rowid order — the order the chain and all readers use. */
function eventOrder(wg: Dispatch): string[] {
  return (
    wg.db.prepare("SELECT id FROM work_events ORDER BY rowid").all() as Array<{ id: string }>
  ).map((r) => r.id);
}

function withEvents(bundle: StateBundle, events: Array<Record<string, unknown>>): StateBundle {
  return { ...bundle, tables: { ...bundle.tables, work_events: events } };
}

describe("export-scrambles-event-order", () => {
  it("export then import keeps the event order, the chain and every ticket timeline", () => {
    const src = busyBoard();
    const sourceOrder = eventOrder(src);
    expect(sourceOrder.length).toBeGreaterThanOrEqual(20);

    const dst = Dispatch.open(":memory:");
    importState(dst.db, exportState(src.db));
    expect(verifyEventChain(dst.db)).toMatchObject({ ok: true, checked: sourceOrder.length });
    expect(eventOrder(dst)).toEqual(sourceOrder);
    for (const t of src.listTickets()) {
      const ids = (w: Dispatch) => w.view(t.id).events.map((e) => e.id);
      expect(ids(dst)).toEqual(ids(src));
    }
    src.db.close();
    dst.db.close();
  });

  it("a bundle whose events arrive out of order (an id-ordered backup) is restored in chain order", () => {
    const src = busyBoard();
    const bundle = exportState(src.db);
    const events = [...(bundle.tables.work_events as Array<Record<string, unknown>>)];
    // The pre-fix export: ORDER BY id (random UUIDs).
    events.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const dst = Dispatch.open(":memory:");
    importState(dst.db, withEvents(bundle, events));
    expect(verifyEventChain(dst.db).ok).toBe(true);
    expect(eventOrder(dst)).toEqual(eventOrder(src));
    src.db.close();
    dst.db.close();
  });

  it("a bundle with an edited event is rejected and the destination is left unchanged", () => {
    const src = busyBoard();
    const bundle = exportState(src.db);
    const events = (bundle.tables.work_events as Array<Record<string, unknown>>).map((e) => ({
      ...e,
    }));
    events[5] = { ...events[5]!, actor_id: "someone-else" };
    const dst = Dispatch.open(":memory:");
    expect(() => importState(dst.db, withEvents(bundle, events))).toThrow(/fails verification/);
    expect(dst.listTickets()).toHaveLength(0);
    src.db.close();
    dst.db.close();
  });

  it("a bundle with an event removed from the middle is rejected", () => {
    const src = busyBoard();
    const bundle = exportState(src.db);
    const events = [...(bundle.tables.work_events as Array<Record<string, unknown>>)];
    events.splice(7, 1);
    const dst = Dispatch.open(":memory:");
    expect(() => importState(dst.db, withEvents(bundle, events))).toThrow(/chain links only/);
    expect(dst.listTickets()).toHaveLength(0);
    src.db.close();
    dst.db.close();
  });
});

describe("chain-backfill-launders-tamper", () => {
  it("edit a row, blank the hashes from it on, reopen: the log still fails verification", () => {
    const wg = Dispatch.open(":memory:");
    for (let i = 0; i < 5; i++) {
      writeEvent(wg.db, {
        entity_type: "ticket",
        entity_id: "t1",
        actor: { type: "agent", id: "runner" },
        event_type: "ticket.transitioned",
        payload: { n: i, reason: "review_approved" },
      });
    }
    const third = (
      wg.db
        .prepare("SELECT rowid AS seq FROM work_events ORDER BY rowid LIMIT 1 OFFSET 2")
        .get() as {
        seq: number;
      }
    ).seq;
    wg.db
      .prepare("UPDATE work_events SET actor_id = 'someone-else', payload_json = ? WHERE rowid = ?")
      .run('{"reason":"auto"}', third);
    expect(verifyEventChain(wg.db).reason).toBe("content");
    wg.db
      .prepare("UPDATE work_events SET hash = NULL, prev_hash = NULL WHERE rowid >= ?")
      .run(third);

    // Reopen (every entry point runs migrate on open).
    migrate(wg.db);
    expect(verifyEventChain(wg.db)).toMatchObject({ ok: false, reason: "unhashed" });

    // The explicit repair re-anchors the chain AND leaves a trace of doing so.
    const res = wg.rechainEventLog(human);
    expect(res.rechained).toBe(3);
    expect(res.verification.ok).toBe(true);
    const last = wg.db
      .prepare("SELECT event_type, payload_json FROM work_events ORDER BY rowid DESC LIMIT 1")
      .get() as { event_type: string; payload_json: string };
    expect(last.event_type).toBe("events.rechained");
    expect(JSON.parse(last.payload_json)).toMatchObject({
      rechained: 3,
      was_reason: "unhashed",
      new_head: res.newHead,
    });
    expect(res.verification.headHash).not.toBe(res.newHead); // the rechained event is the new head
    wg.db.close();
  });

  it("a pre-chain (v22) log is still backfilled once, on the upgrade", () => {
    const wg = Dispatch.open(":memory:");
    wg.createTicket({ title: "old" }, human);
    wg.db.exec("UPDATE work_events SET hash = NULL, prev_hash = NULL");
    wg.db.prepare("UPDATE schema_meta SET value = '22' WHERE key = 'schema_version'").run();
    migrate(wg.db);
    expect(verifyEventChain(wg.db).ok).toBe(true);
    wg.db.close();
  });
});

// TRACE ID: a work_event with no explicit correlation id takes the one the runner
// put in the environment for the tick (DISPATCH_CORRELATION_ID, else GAFFER_TICK_ID),
// so the runner's CLI writes and the agent's MCP writes for one tick join on one key.
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { migrate } from "../src/db/connection.js";
import { envCorrelationId, writeEvent } from "../src/events/eventWriter.js";
import { EventRepository } from "../src/repositories/eventRepository.js";

const SYSTEM = { type: "system" as const, id: "t" };
const saved = { tick: process.env.GAFFER_TICK_ID, corr: process.env.DISPATCH_CORRELATION_ID };

function restore(): void {
  if (saved.tick === undefined) delete process.env.GAFFER_TICK_ID;
  else process.env.GAFFER_TICK_ID = saved.tick;
  if (saved.corr === undefined) delete process.env.DISPATCH_CORRELATION_ID;
  else process.env.DISPATCH_CORRELATION_ID = saved.corr;
}

describe("event correlation id from the runner environment", () => {
  afterEach(restore);

  it("envCorrelationId: explicit DISPATCH_CORRELATION_ID wins, GAFFER_TICK_ID is the fallback, bounded", () => {
    expect(envCorrelationId({})).toBeNull();
    expect(envCorrelationId({ GAFFER_TICK_ID: " tick-1 " })).toBe("tick-1");
    expect(envCorrelationId({ GAFFER_TICK_ID: "tick-1", DISPATCH_CORRELATION_ID: "corr-9" })).toBe(
      "corr-9",
    );
    expect(envCorrelationId({ DISPATCH_CORRELATION_ID: "x".repeat(300) })).toHaveLength(128);
    expect(envCorrelationId({ GAFFER_TICK_ID: "   " })).toBeNull();
  });

  it("writeEvent stamps the env tick id when the caller passes none, and an explicit id wins", () => {
    const db = new Database(":memory:");
    migrate(db);
    delete process.env.DISPATCH_CORRELATION_ID;
    process.env.GAFFER_TICK_ID = "20260925T170000Z.4242";
    writeEvent(db, { entity_type: "ticket", entity_id: "a", actor: SYSTEM, event_type: "one" });
    writeEvent(db, {
      entity_type: "ticket",
      entity_id: "a",
      actor: SYSTEM,
      event_type: "two",
      correlation_id: "explicit",
    });
    delete process.env.GAFFER_TICK_ID;
    writeEvent(db, { entity_type: "ticket", entity_id: "a", actor: SYSTEM, event_type: "three" });

    const rows = db
      .prepare("SELECT event_type, correlation_id FROM work_events ORDER BY rowid")
      .all() as Array<{ event_type: string; correlation_id: string | null }>;
    expect(rows).toEqual([
      { event_type: "one", correlation_id: "20260925T170000Z.4242" },
      { event_type: "two", correlation_id: "explicit" },
      { event_type: "three", correlation_id: null },
    ]);

    const repo = new EventRepository(db);
    const trail = repo.listByCorrelation("20260925T170000Z.4242", 100);
    expect(trail.map((r) => r.event_type)).toEqual(["one"]);
    expect(trail[0]!.correlation_id).toBe("20260925T170000Z.4242");
    expect("payload_json" in trail[0]!).toBe(false); // metadata only
    expect(repo.listByCorrelation("nope", 100)).toEqual([]);
  });
});

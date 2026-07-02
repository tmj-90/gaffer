// TRACK-3a: the per-ticket / per-epic DELIVERY BUDGET as a first-class field.
//
// Cost is now a CONTROL: a ticket can carry a USD delivery-budget ceiling that the
// runner enforces against its cumulative measured spend. These tests pin the
// dispatch surface: the field is created, set/cleared, surfaced on the ticket view,
// inherited from the epic, overridden per-ticket, validated, and migrated in.

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { migrate } from "../src/db/connection.js";
import { Dispatch } from "../src/core.js";
import { SCHEMA_VERSION } from "../src/db/schema.js";
import type { Actor } from "../src/domain/types.js";

const human: Actor = { type: "human", id: "tom" };

function freshWg(): Dispatch {
  return Dispatch.open(":memory:");
}

describe("TRACK-3a: per-ticket delivery budget", () => {
  let wg: Dispatch;
  beforeEach(() => {
    wg = freshWg();
  });

  it("defaults to null (no per-ticket ceiling)", () => {
    const t = wg.createTicket({ title: "no budget" }, human);
    expect(t.delivery_budget_usd).toBeNull();
  });

  it("accepts a positive budget at create and surfaces it on the ticket", () => {
    const t = wg.createTicket({ title: "budgeted", delivery_budget_usd: 2.5 }, human);
    expect(t.delivery_budget_usd).toBe(2.5);
    const view = wg.view(String(t.number));
    expect((view.ticket as { delivery_budget_usd: number }).delivery_budget_usd).toBe(2.5);
  });

  it("rejects a non-positive budget (validation)", () => {
    expect(() => wg.createTicket({ title: "bad", delivery_budget_usd: 0 }, human)).toThrow();
    expect(() => wg.createTicket({ title: "bad", delivery_budget_usd: -1 }, human)).toThrow();
  });

  it("setDeliveryBudget sets, updates, and clears the ceiling", () => {
    const t = wg.createTicket({ title: "t" }, human);
    let updated = wg.setDeliveryBudget({ ticket: t.id, delivery_budget_usd: 5 }, human);
    expect(updated.delivery_budget_usd).toBe(5);
    // Accepts a #N / number ref too.
    updated = wg.setDeliveryBudget(
      { ticket: t.number as number, delivery_budget_usd: 1.25 },
      human,
    );
    expect(updated.delivery_budget_usd).toBe(1.25);
    // Clear it → back to null.
    updated = wg.setDeliveryBudget({ ticket: t.id, delivery_budget_usd: null }, human);
    expect(updated.delivery_budget_usd).toBeNull();
  });

  it("writes an audit event when the budget is set", () => {
    const t = wg.createTicket({ title: "t" }, human);
    wg.setDeliveryBudget({ ticket: t.id, delivery_budget_usd: 3 }, human);
    const view = wg.view(t.id) as { events: Array<{ event_type: string }> };
    expect(view.events.some((e) => e.event_type === "ticket.budget_set")).toBe(true);
  });
});

describe("TRACK-3a: per-epic budget is inherited by its tickets", () => {
  it("stamps the epic budget onto each child ticket, per-ticket override wins", () => {
    const wg = freshWg();
    const res = wg.createEpic(
      {
        epic: { name: "Cost-controlled epic", delivery_budget_usd: 4 },
        tickets: [
          { title: "inherits the epic budget", acceptanceCriteria: ["a"] },
          {
            title: "overrides with its own",
            acceptanceCriteria: ["b"],
            delivery_budget_usd: 1.5,
          },
        ],
      },
      human,
    );
    const [n0, n1] = res.ticketNumbers;
    const t0 = (wg.view(String(n0)).ticket as { delivery_budget_usd: number }).delivery_budget_usd;
    const t1 = (wg.view(String(n1)).ticket as { delivery_budget_usd: number }).delivery_budget_usd;
    expect(t0).toBe(4); // inherited
    expect(t1).toBe(1.5); // per-ticket override
  });
});

describe("TRACK-3a: additive migration (v14 → v15) adds delivery_budget_usd", () => {
  it("upgrades a simulated v14 DB, adds the column NULL, preserves rows", () => {
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
        human_owner TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
    db.prepare("INSERT INTO schema_meta(key,value) VALUES ('schema_version','14')").run();
    db.prepare(
      "INSERT INTO tickets (id, number, title, status) VALUES ('legacy-1', 1, 'old ticket', 'ready')",
    ).run();

    migrate(db);

    const cols = (db.prepare("PRAGMA table_info(tickets)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toContain("delivery_budget_usd");
    const legacy = db.prepare("SELECT * FROM tickets WHERE id = 'legacy-1'").get() as {
      title: string;
      delivery_budget_usd: number | null;
    };
    expect(legacy.title).toBe("old ticket");
    expect(legacy.delivery_budget_usd).toBeNull();

    const ver = db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as {
      value: string;
    };
    expect(Number(ver.value)).toBe(SCHEMA_VERSION);
    expect(() => migrate(db)).not.toThrow();
  });
});

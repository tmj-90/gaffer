import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import {
  computeStats,
  type DoctorReport,
  renderDoctor,
  renderStats,
  runDoctor,
  type StatsReport,
} from "../src/cli/ops.js";
import { Dispatch } from "../src/core.js";
import { DatabaseTooNewError, migrate, openDatabase } from "../src/db/connection.js";
import { SCHEMA_VERSION } from "../src/db/schema.js";
import type { Actor } from "../src/domain/types.js";
import { makeHandlers } from "../src/mcp/tools.js";
import { TestClock } from "../src/util/clock.js";
import { VERSION } from "../src/version.js";

const agentActor: Actor = { type: "agent", id: "mcp-agent" };
const human: Actor = { type: "human", id: "tom" };

/** A ready ticket claimed by a fresh agent, returning {ticketId, token}. */
function seedClaimed(wg: Dispatch, ttlSeconds = 600): { ticketId: string; token: string } {
  const h = makeHandlers(wg, agentActor);
  const ticketId = h.create_ticket({ title: "Work", policy_pack: "solo_loose" }).structuredContent
    .ticket_id as string;
  h.add_acceptance_criterion({ ticket_id: ticketId, text: "AC" }); // Guard A: ≥1 AC required to ready
  h.mark_ticket_ready({ ticket_id: ticketId });
  const agent = wg.registerAgent({ display_name: "bot" }, human);
  const token = h.claim_next_ticket({ agent_id: agent.id, ttl_seconds: ttlSeconds })
    .structuredContent.claim_token as string;
  return { ticketId, token };
}

describe("doctor", () => {
  it("reports healthy on a fresh in-memory DB", () => {
    const clock = new TestClock();
    const wg = Dispatch.open(":memory:", clock);
    const report = runDoctor(wg.db, ":memory:", clock.now());
    expect(report.exitCode).toBe(0);
    const labels = report.checks.map((c) => c.label).join("\n");
    expect(labels).toContain(`Dispatch version: ${VERSION}`);
    expect(labels).toContain(`Schema version: ${SCHEMA_VERSION}`);
    expect(labels).toContain("Tickets: 0");
    expect(renderDoctor(report)).toContain("Healthy");
  });

  it("flags stale active claims past their expiry as a warning", () => {
    const clock = new TestClock();
    const wg = Dispatch.open(":memory:", clock);
    seedClaimed(wg, 60);
    // Advance well past the lease without heartbeat.
    clock.advanceSeconds(3600);
    const report = runDoctor(wg.db, ":memory:", clock.now());
    const stale = report.checks.find((c) => c.label.startsWith("Stale active claims"));
    expect(stale?.level).toBe("warn");
    expect(stale?.label).toContain("1");
    expect(stale?.fix).toContain("expire-claims");
  });

  it("counts tickets and active claims", () => {
    const clock = new TestClock();
    const wg = Dispatch.open(":memory:", clock);
    seedClaimed(wg);
    const report = runDoctor(wg.db, ":memory:", clock.now());
    const counts = report.checks.find((c) => c.label.startsWith("Tickets:"));
    expect(counts?.label).toContain("Tickets: 1");
    expect(counts?.label).toContain("active claims: 1");
  });
});

describe("stats", () => {
  it("buckets tickets by status and counts open decisions + claims", () => {
    const clock = new TestClock();
    const wg = Dispatch.open(":memory:", clock);
    const { token } = seedClaimed(wg, 60);
    // token kept so the claim stays active; advance to make it stale.
    expect(token).toBeTruthy();
    clock.advanceSeconds(3600);
    wg.createDecision({ title: "Q", question: "?", severity: "human_required" }, human);

    const stats = computeStats(wg.db, clock.now());
    // The claimed ticket is in a 'claimed' (or in_progress) status bucket.
    const total = Object.values(stats.ticketsByStatus).reduce((a, b) => a + b, 0);
    expect(total).toBe(1);
    expect(stats.openDecisions).toBe(1);
    expect(stats.activeClaims).toBe(1);
    expect(stats.staleClaims).toBe(1);

    const out = renderStats(stats);
    expect(out).toContain("Tickets by status:");
    expect(out).toContain("Open decisions:  1");
    expect(out).toContain("Stale claims:    1");
  });
});

// The CLI's `doctor --json` / `stats --json` flags serialise these report
// objects verbatim (see src/cli/index.ts printJson(report|stats)). These tests
// pin the JSON projection's SHAPE — valid JSON, exact top-level keys, and the
// nested element shape — so a field rename or accidental key can't silently
// break a downstream `--json` consumer (a CI health probe, a dashboard scrape).
describe("doctor --json projection shape", () => {
  it("is valid JSON with the documented top-level keys and check shape", () => {
    const clock = new TestClock();
    const wg = Dispatch.open(":memory:", clock);
    const report = runDoctor(wg.db, ":memory:", clock.now());

    // The exact bytes the CLI writes for `doctor --json`.
    const json = JSON.stringify(report, null, 2);
    const parsed = JSON.parse(json) as DoctorReport;

    expect(Object.keys(parsed).sort()).toEqual(["checks", "exitCode"]);
    expect(typeof parsed.exitCode).toBe("number");
    expect(Array.isArray(parsed.checks)).toBe(true);
    expect(parsed.checks.length).toBeGreaterThan(0);

    for (const check of parsed.checks) {
      // Required keys present and well-typed.
      expect(typeof check.label).toBe("string");
      expect(["ok", "warn", "fail"]).toContain(check.level);
      // Optional keys, when present, are strings — never some other type.
      if ("detail" in check) expect(typeof check.detail).toBe("string");
      if ("fix" in check) expect(typeof check.fix).toBe("string");
      // No stray keys beyond the allow-list leak into the JSON.
      for (const key of Object.keys(check)) {
        expect(["label", "level", "detail", "fix"]).toContain(key);
      }
    }
  });

  it("carries the optional detail/fix keys through on a warning check", () => {
    const clock = new TestClock();
    const wg = Dispatch.open(":memory:", clock);
    seedClaimed(wg, 60);
    clock.advanceSeconds(3600); // make the claim stale → a warn check with detail+fix

    const parsed = JSON.parse(
      JSON.stringify(runDoctor(wg.db, ":memory:", clock.now())),
    ) as DoctorReport;
    const stale = parsed.checks.find((c) => c.label.startsWith("Stale active claims"));
    expect(stale).toBeDefined();
    expect(stale?.level).toBe("warn");
    expect(typeof stale?.detail).toBe("string");
    expect(typeof stale?.fix).toBe("string");
  });
});

describe("stats --json projection shape", () => {
  it("is valid JSON with the documented keys and types", () => {
    const clock = new TestClock();
    const wg = Dispatch.open(":memory:", clock);
    seedClaimed(wg, 60);
    clock.advanceSeconds(3600);
    wg.createDecision({ title: "Q", question: "?", severity: "human_required" }, human);

    const json = JSON.stringify(computeStats(wg.db, clock.now()), null, 2);
    const parsed = JSON.parse(json) as StatsReport;

    expect(Object.keys(parsed).sort()).toEqual([
      "activeClaims",
      "openDecisions",
      "staleClaims",
      "ticketsByStatus",
    ]);
    expect(typeof parsed.openDecisions).toBe("number");
    expect(typeof parsed.activeClaims).toBe("number");
    expect(typeof parsed.staleClaims).toBe("number");
    // ticketsByStatus is a string→number map.
    expect(typeof parsed.ticketsByStatus).toBe("object");
    for (const [status, n] of Object.entries(parsed.ticketsByStatus)) {
      expect(typeof status).toBe("string");
      expect(typeof n).toBe("number");
    }
  });

  it("serialises an empty ticketsByStatus as {} on a fresh DB", () => {
    const clock = new TestClock();
    const wg = Dispatch.open(":memory:", clock);
    const parsed = JSON.parse(JSON.stringify(computeStats(wg.db, clock.now()))) as StatsReport;
    expect(parsed.ticketsByStatus).toEqual({});
    expect(parsed.openDecisions).toBe(0);
    expect(parsed.activeClaims).toBe(0);
    expect(parsed.staleClaims).toBe(0);
  });
});

describe("migration too-new guard", () => {
  it("refuses to open a DB stamped with a newer schema_version", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare("INSERT INTO schema_meta(key, value) VALUES ('schema_version', ?)").run(
      String(SCHEMA_VERSION + 1),
    );
    expect(() => migrate(db)).toThrow(DatabaseTooNewError);
    try {
      migrate(db);
    } catch (err) {
      expect(err).toBeInstanceOf(DatabaseTooNewError);
      expect((err as DatabaseTooNewError).code).toBe("DISPATCH_DB_TOO_NEW");
      expect((err as DatabaseTooNewError).found).toBe(SCHEMA_VERSION + 1);
    }
  });

  it("opens a DB at the current schema version without error", () => {
    expect(() => openDatabase(":memory:")).not.toThrow();
  });

  it("migrates an equal-version DB idempotently", () => {
    const db = new Database(":memory:");
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
    const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as {
      value: string;
    };
    expect(Number(row.value)).toBe(SCHEMA_VERSION);
  });
});

describe("structuredContent contract", () => {
  it("every successful tool result carries structuredContent equal to its text", () => {
    const wg = Dispatch.open(":memory:", new TestClock());
    const h = makeHandlers(wg, agentActor);

    const create = h.create_ticket({ title: "SC", policy_pack: "solo_loose" });
    expect(create.structuredContent).toBeDefined();
    expect(create.content[0]?.type).toBe("text");
    // The text payload is exactly the structuredContent serialised.
    expect(JSON.parse(create.content[0]!.text)).toEqual(create.structuredContent);

    const ticketId = create.structuredContent.ticket_id as string;
    const pending = h.list_pending_decisions({});
    expect(pending.structuredContent).toBeDefined();
    expect(Array.isArray((pending.structuredContent as { decisions: unknown[] }).decisions)).toBe(
      true,
    );

    const view = h.get_ticket({ ticket_id: ticketId });
    expect(view.structuredContent.ticket).toBeDefined();
    expect(JSON.parse(view.content[0]!.text)).toEqual(view.structuredContent);
  });

  it("error results also carry structuredContent with the error code", () => {
    const wg = Dispatch.open(":memory:", new TestClock());
    const h = makeHandlers(wg, agentActor);
    const res = h.release_claim({ claimToken: "nope" });
    expect(res.isError).toBe(true);
    expect((res.structuredContent.error as { code: string }).code).toBe("CLAIM_INVALID");
    expect(JSON.parse(res.content[0]!.text)).toEqual(res.structuredContent);
  });
});

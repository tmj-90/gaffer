// PRE-WORK SCOUT (delta roadmap gap 3): the runner records each delivery attempt's scout
// packet as `ticket.scout_recorded` (system/admin only). The record can only RAISE the
// declared risk (effective is recomputed here), the Review packet shows a raised risk as
// a backing row, and Health's scout read model counts coverage and splits first-pass
// acceptance by what the scout found. A report only; nothing gates on it.
import { afterEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { readReviewMeasures } from "../src/health/reviewMeasures.js";
import { scoutCoverage } from "../src/health/scoutMeasures.js";
import type { ReviewPacket } from "../src/services/reviewPacketService.js";
import {
  normalizeScoutRecord,
  scoutRaisedFact,
  SCOUT_RECORDED_EVENT,
} from "../src/services/scoutRecord.js";
import { TestClock } from "../src/util/clock.js";
import { FAKE_HEAD, nonEmptyDiffRunner } from "./helpers/realDiff.js";

const human: Actor = { type: "human", id: "tom" };
const runner: Actor = { type: "system" };

const cost = () => ({
  cost_usd: 0,
  measured_usd: 0,
  estimated_usd: 0,
  num_turns: 0,
  unknown_calls: 0,
  ledger_status: "ok",
});

const packet = (o: Record<string, unknown> = {}) => ({
  version: 1,
  base_sha: "abc1234def",
  attempt: 1,
  index: { status: "fresh", commit: "abc1234def", caps_hit: [] },
  counts: { items: 6, named: 1, stack: 1, index: 4, tests: 1, model: 0 },
  omitted: 0,
  items: [{ path: "src/x.ts", reasons: ["named"], sources: ["named"], tags: [] }],
  model_scout: null,
  risk: {
    declared: "medium",
    effective: "high",
    raised: true,
    signals: [
      {
        kind: "migration",
        detail: "migration file db/migrations/0042.sql",
        level: "high",
        raises: true,
      },
      {
        kind: "fan_out",
        detail: "14 callers of calculateInvoice (index, a lower bound)",
        level: "medium",
        raises: false,
      },
    ],
  },
  ...o,
});

describe("scout record: validated, only raises", () => {
  it("keeps counts, levels and short details; drops the packet's file list", () => {
    const r = normalizeScoutRecord(packet(), runner);
    expect(r).toMatchObject({
      attempt: 1,
      base_sha: "abc1234def",
      index_status: "fresh",
      items: 6,
      from_index: 4,
      named: 1,
      stack: 1,
      declared: "medium",
      effective: "high",
      raised: true,
      actor: "system",
    });
    expect(r.signals.map((s) => [s.kind, s.raises])).toEqual([
      ["migration", true],
      ["fan_out", false],
    ]);
    expect(JSON.stringify(r)).not.toContain("src/x.ts");
  });

  it("recomputes the effective level: a record can never lower the declared risk", () => {
    const low = normalizeScoutRecord(
      packet({ risk: { declared: "high", effective: "low", raised: false, signals: [] } }),
      runner,
    );
    expect(low.effective).toBe("high");
    expect(low.raised).toBe(false);
    const forged = normalizeScoutRecord(
      packet({
        risk: {
          declared: "low",
          effective: "critical",
          signals: [{ kind: "auth", level: "critical", detail: "x" }],
        },
      }),
      runner,
    );
    expect(forged.effective).toBe("high"); // a signal never asks for critical
    const junk = normalizeScoutRecord(
      packet({
        risk: { declared: "low", signals: [{ kind: "rm -rf", level: "high" }] },
        index: { status: "<x>" },
      }),
      runner,
    );
    expect(junk.signals).toEqual([]);
    expect(junk.effective).toBe("low");
    expect(junk.index_status).toBe("unavailable");
  });

  it("refuses a packet without its risk, and says the raise in one sentence", () => {
    expect(() => normalizeScoutRecord({ counts: {} }, runner)).toThrow(/risk/);
    expect(scoutRaisedFact(normalizeScoutRecord(packet(), runner))).toBe(
      "Risk raised to high by the scout before delivery (declared medium): migration file db/migrations/0042.sql",
    );
    expect(
      scoutRaisedFact(
        normalizeScoutRecord(packet({ risk: { declared: "high", signals: [] } }), runner),
      ),
    ).toBeNull();
  });
});

describe("scout record: on the ticket, in Review and Health", () => {
  let d: Dispatch;
  afterEach(() => d.db.close());

  function deliver(): { id: string; claimToken: string; agent: Actor } {
    d = Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner);
    const repo = d.registerRepository(
      { name: "svc", default_branch: "main", local_path: process.cwd() },
      human,
    );
    const t = d.createTicket({ title: "Add the total column", risk_level: "medium" }, human);
    d.linkRepository(t.id, "svc", "primary", human);
    d.addAcceptanceCriterion({ ticket_id: t.id, text: "adds it" }, human);
    d.markReady(t.id, human);
    const ag = d.registerAgent({ display_name: "Bot", max_risk: "critical" }, human);
    const agent: Actor = { type: "agent", id: ag.id };
    const claim = d.claimNextTicket({ agentId: ag.id, ttlSeconds: 600 }, agent)!;
    d.recordRepoDelivery({ ticket_id: t.id, repo_id: repo.id, branch_name: "feat/x" }, agent);
    d.recordRepoDelivery(
      { ticket_id: t.id, repo_id: repo.id, commit_sha: FAKE_HEAD, status: "review_ready" },
      runner,
    );
    return { id: t.id, claimToken: claim.claimToken, agent };
  }

  it("only the runner or an admin records it; an agent and a person are refused", () => {
    const { id, agent } = deliver();
    expect(() => d.recordScout(id, packet(), agent)).toThrow(/runner/);
    expect(() => d.recordScout(id, packet(), human)).toThrow(/runner/);
    const res = d.recordScout(id, packet(), runner);
    expect(res.scout.effective).toBe("high");
    const ev = d.db
      .prepare("SELECT count(*) AS n FROM work_events WHERE event_type = ?")
      .get(SCOUT_RECORDED_EVENT) as { n: number };
    expect(ev.n).toBe(1);
  });

  it("Review: a raised risk is a backing row with its signals; none when not raised", () => {
    const { id, claimToken, agent } = deliver();
    d.recordScout(id, packet(), runner);
    d.submitForReview({ claimToken, ticket_id: id, reason: "done" }, agent);
    const p: ReviewPacket = d.reviewPacket(id, cost);
    expect(p.scout?.effective).toBe("high");
    const row = p.backing.find((b) => b.cell === "risk");
    expect(row).toEqual({
      fact: "Risk raised to high by the scout before delivery (declared medium): migration file db/migrations/0042.sql",
      holds: false,
      source:
        "the runner's scout before delivery (ticket.scout_recorded): path patterns, ticket text, code index",
      cell: "risk",
    });
    // A later attempt's record that raised nothing replaces it.
    d.recordScout(id, packet({ attempt: 2, risk: { declared: "medium", signals: [] } }), runner);
    expect(d.reviewPacket(id, cost).backing.find((b) => b.cell === "risk")).toBeUndefined();
  });

  it("Health: coverage counts and the first-pass split by the first record", () => {
    const { id, claimToken, agent } = deliver();
    d.recordScout(
      id,
      packet({
        model_scout: {
          ran: true,
          kept_files: 2,
          dropped_files: 1,
          dropped_symbols: 0,
          notes: ["a"],
          cost_usd: 0.02,
        },
      }),
      runner,
    );
    d.submitForReview({ claimToken, ticket_id: id, reason: "done" }, agent);
    const m = readReviewMeasures(d.db);
    expect(m.scout).toMatchObject({
      measure: "scout_coverage",
      attempts: 1,
      tickets: 1,
      with_index_items: 1,
      named_only: 0,
      risk_raised: 1,
      index_status: { fresh: 1 },
      model_scout: { runs: 1, kept_files: 2, dropped: 1, cost_usd: 0.02, cost_unknown: 0 },
    });
    expect(m.scout.first_pass.index_items.done).toBe(0); // in review, not done yet
  });
});

describe("scout coverage: the pure read model", () => {
  const T0 = Date.parse("2026-06-01T09:00:00Z");
  const tr = (
    ticketId: string,
    from: string | null,
    to: string,
    m: number,
    actorType = "human",
  ) => ({
    ticketId,
    actorType,
    fromStatus: from,
    toStatus: to,
    reason: null,
    atMs: T0 + m * 60_000,
  });
  const ev = (ticketId: string, m: number, payload: Record<string, unknown>) => ({
    ticketId,
    atMs: T0 + m * 60_000,
    payload,
  });

  it("splits first-pass acceptance by what the first scout record found", () => {
    const r = scoutCoverage({
      events: [
        ev("a", 0, { items: 5, from_index: 3, index_status: "fresh" }),
        ev("b", 0, { items: 2, from_index: 0, index_status: "missing", raised: true }),
        // b's second attempt found index items: the split keeps its FIRST record.
        ev("b", 30, {
          items: 4,
          from_index: 2,
          index_status: "fresh",
          model_scout: { ran: true, cost_usd: null },
        }),
        ev("c", 0, { items: 0, from_index: 0, index_status: "unavailable" }),
      ],
      transitions: [
        tr("a", "in_progress", "in_review", 10, "system"),
        tr("a", "in_review", "done", 20),
        tr("b", "in_progress", "in_review", 10, "system"),
        tr("b", "in_review", "refining", 20),
        tr("b", "in_progress", "in_review", 40, "system"),
        tr("b", "in_review", "done", 50),
        tr("c", "in_progress", "in_review", 10, "system"),
        tr("c", "in_review", "done", 20),
        tr("d", "in_progress", "in_review", 10, "system"),
        tr("d", "in_review", "done", 20),
      ],
      retries: [],
      tickets: ["a", "b", "c", "d"].map((id) => ({ id, status: "done" })),
    });
    expect(r.attempts).toBe(4);
    expect(r.tickets).toBe(3);
    expect([r.with_index_items, r.named_only, r.empty]).toEqual([2, 1, 1]);
    expect(r.risk_raised).toBe(1);
    expect(r.model_scout).toMatchObject({ runs: 1, cost_unknown: 1, cost_usd: 0 });
    expect(r.first_pass.index_items).toEqual({ done: 1, first_pass: 1, rate_pct: 100 });
    expect(r.first_pass.named_only).toEqual({ done: 1, first_pass: 0, rate_pct: 0 });
    expect(r.first_pass.nothing_found).toEqual({ done: 1, first_pass: 1, rate_pct: 100 });
    expect(r.first_pass.no_record).toEqual({ done: 1, first_pass: 1, rate_pct: 100 });
  });

  it("is null-honest with nothing recorded", () => {
    const r = scoutCoverage({ events: [], transitions: [], retries: [], tickets: [] });
    expect(r.attempts).toBe(0);
    expect(r.first_pass.index_items.rate_pct).toBeNull();
  });
});

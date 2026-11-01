import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import {
  aucOf,
  coverageOf,
  judgeAgreement,
  mergeJudgments,
  outcomeAfter,
  parseLedgerJudgments,
  readJudgeAgreement,
  renderJudgeAgreement,
  THRESHOLDS,
  type JudgmentPoint,
  type TransitionPoint,
} from "../src/health/judgeAgreement.js";
import { TestClock } from "../src/util/clock.js";
import { giveTicketRealDelivery, nonEmptyDiffRunner } from "./helpers/realDiff.js";

/**
 * JUDGE AGREEMENT: does a low eval-judge score come before a rejection? Pins the pairing
 * of each judgment with what happened to that delivery next (who decided, and how), the
 * agreement figures, the reading's thresholds, the ledger merge, and the DB reader over a
 * real Dispatch.
 */

const T = (min: number): string => new Date(Date.UTC(2026, 9, 1, 9, min)).toISOString();
const tr = (
  ticketId: string,
  min: number,
  from: string,
  to: string,
  actorType = "human",
  reason: string | null = null,
): TransitionPoint => ({ ticketId, from, to, reason, actorType, at: T(min) });
const jp = (
  ticketId: string,
  min: number,
  overall: JudgmentPoint["overall"],
  score: number,
  extra: Partial<JudgmentPoint> = {},
): JudgmentPoint => ({
  ticketId,
  ticketNumber: Number(ticketId.replace(/\D/g, "")) || null,
  at: T(min),
  overall,
  score,
  dims: {},
  source: "event",
  ...extra,
});

describe("outcomeAfter: what happened to the judged delivery", () => {
  it("a human approval straight to ready_for_merge is accepted, by a person", () => {
    const o = outcomeAfter(jp("t1", 1, "pass", 4.6), [
      tr("t1", 0, "claimed", "in_review", "system"),
      tr("t1", 5, "in_review", "ready_for_merge", "human", "review_approved"),
    ]);
    expect(o).toMatchObject({ outcome: "accepted", decidedBy: "human", laterSendBacks: 0 });
  });

  it("a reviewer's send-back is sent_back with its reason", () => {
    const o = outcomeAfter(jp("t1", 1, "borderline", 3.2), [
      tr("t1", 4, "in_review", "refining", "human", "duplicates addTask instead of reusing it"),
    ]);
    expect(o).toMatchObject({
      outcome: "sent_back",
      decidedBy: "human",
      reason: "duplicates addTask instead of reusing it",
      laterSendBacks: 1,
    });
  });

  it("an approval to the tester waits for the tester: its fail is the outcome", () => {
    const o = outcomeAfter(jp("t1", 1, "pass", 4.4), [
      tr("t1", 3, "in_review", "in_testing", "human", "review_approved_to_testing"),
      tr("t1", 6, "in_testing", "refining", "agent", "tester_failed: empty list throws"),
    ]);
    expect(o).toMatchObject({ outcome: "sent_back", decidedBy: "tester" });
  });

  it("a tester pass after the approval is accepted, by the tester", () => {
    const o = outcomeAfter(jp("t1", 1, "pass", 4.4), [
      tr("t1", 3, "in_review", "in_testing", "human"),
      tr("t1", 6, "in_testing", "ready_for_merge", "agent", "tester_passed"),
    ]);
    expect(o).toMatchObject({ outcome: "accepted", decidedBy: "tester" });
  });

  it("a hold for CI is not a quality decision: the next decision counts", () => {
    const o = outcomeAfter(jp("t1", 1, "fail", 1.8), [
      tr("t1", 2, "in_review", "blocked", "system", "held:ci_red"),
      tr("t1", 3, "blocked", "in_review", "human"),
      tr("t1", 4, "in_review", "ready", "human", "wrong behaviour"),
    ]);
    expect(o).toMatchObject({ outcome: "sent_back", reason: "wrong behaviour" });
  });

  it("closed from review without landing is cancelled; no decision yet is pending", () => {
    expect(
      outcomeAfter(jp("t1", 1, "fail", 1), [tr("t1", 2, "in_review", "cancelled", "human")])
        .outcome,
    ).toBe("cancelled");
    expect(outcomeAfter(jp("t1", 1, "pass", 5), []).outcome).toBe("pending");
  });

  it("an agent review's approval is decided by the agent, kept apart from people", () => {
    const o = outcomeAfter(jp("t1", 1, "pass", 4.8), [
      tr("t1", 2, "in_review", "ready_for_merge", "agent", "review_approved"),
    ]);
    expect(o.decidedBy).toBe("agent");
  });

  it("decisions before the judgment and on other tickets are ignored", () => {
    const o = outcomeAfter(jp("t1", 10, "pass", 4.8), [
      tr("t1", 2, "in_review", "refining", "human", "attempt 1 was wrong"),
      tr("t2", 12, "in_review", "refining", "human"),
      tr("t1", 14, "in_review", "ready_for_merge", "human"),
    ]);
    expect(o).toMatchObject({ outcome: "accepted", laterSendBacks: 0 });
  });
});

describe("judgeAgreement: the figures and the reading", () => {
  it("aucOf ranks accepted above rejected, ties count half, 0.5 means no signal", () => {
    expect(aucOf([5, 4], [1, 2])).toBe(1);
    expect(aucOf([1, 2], [5, 4])).toBe(0);
    expect(aucOf([3], [3])).toBe(0.5);
    expect(aucOf([], [1])).toBeNull();
  });

  it("builds the confusion table, the warning figures, the misses and false alarms", () => {
    const js = [
      jp("t1", 1, "pass", 4.6, { dims: { test_adequacy: 5 } }),
      jp("t2", 1, "borderline", 3.4, { dims: { test_adequacy: 1 } }),
      jp("t3", 1, "pass", 4.2, { dims: { test_adequacy: 4 } }),
      jp("t4", 1, "fail", 2.0, { dims: { test_adequacy: 2 } }),
      jp("t5", 1, "borderline", 3.8, { dims: { test_adequacy: 3 } }),
    ];
    const ts = [
      tr("t1", 5, "in_review", "ready_for_merge"),
      tr("t2", 5, "in_review", "refining", "human", "assertion now passes for any value"),
      tr("t3", 5, "in_review", "refining", "human", "copied a helper"),
      tr("t4", 5, "in_review", "refining", "human", "inverted filter"),
      tr("t5", 5, "in_review", "ready_for_merge"),
    ];
    const r = judgeAgreement(js, ts);
    expect(r.judgments).toBe(5);
    expect(r.decided).toBe(5);
    expect(r.table.pass).toEqual({ accepted: 1, rejected: 1, pending: 0 });
    expect(r.table.borderline).toEqual({ accepted: 1, rejected: 1, pending: 0 });
    expect(r.table.fail).toEqual({ accepted: 0, rejected: 1, pending: 0 });
    // 3 of 5 rejected; 2 of the 3 non-pass verdicts were rejected; 2 of 3 rejections warned.
    expect(r.warning.rejectedRate).toBe(0.6);
    expect(r.warning.precision).toBe(0.67);
    expect(r.warning.recall).toBe(0.67);
    expect(r.warning.lift).toBe(1.12);
    expect(r.meanScore).toEqual({ accepted: 4.2, rejected: 3.2 });
    // 4.6 beats all three rejected scores, 3.8 beats two of them: 5 of 6 pairs.
    expect(r.auc).toBe(0.83);
    expect(r.dimensionMeans.test_adequacy).toEqual({ accepted: 4, rejected: 2.33, gap: 1.67 });
    expect(r.misses).toEqual([
      { ticketNumber: 3, score: 4.2, reason: "copied a helper", at: T(1) },
    ]);
    expect(r.falseAlarms).toMatchObject([
      { ticketNumber: 5, overall: "borderline", weakest: "test_adequacy 3/5" },
    ]);
    expect(r.byDecider.human).toEqual({ accepted: 2, rejected: 3 });
    // Five decided deliveries are far below the reading's sample.
    expect(r.reading.status).toBe("insufficient_data");
    expect(renderJudgeAgreement(r)).toContain(
      "miss: #3 judged pass 4.2, then sent back: copied a helper",
    );
  });

  it("reads separates / does_not_separate only above the sample thresholds", () => {
    const n = THRESHOLDS.minDecided;
    const make = (goodScore: (i: number) => number, badScore: (i: number) => number) => {
      const js: JudgmentPoint[] = [];
      const ts: TransitionPoint[] = [];
      for (let i = 0; i < n; i++) {
        const id = `t${i}`;
        const rejected = i % 2 === 1;
        const s = rejected ? badScore(i) : goodScore(i);
        js.push(jp(id, 1, s >= 4 ? "pass" : s >= 2.5 ? "borderline" : "fail", s));
        ts.push(tr(id, 5, "in_review", rejected ? "refining" : "ready_for_merge"));
      }
      return judgeAgreement(js, ts);
    };
    const good = make(
      () => 4.6,
      () => 2.8,
    );
    expect(good.auc).toBe(1);
    expect(good.reading.status).toBe("separates");
    const blind = make(
      (i) => (i % 4 === 0 ? 4.6 : 2.8),
      (i) => (i % 4 === 1 ? 4.6 : 2.8),
    );
    expect(blind.reading.status).toBe("does_not_separate");
    expect(judgeAgreement([], []).reading.status).toBe("no_judgments");
  });

  it("coverage counts review entries from the first judged one, so a quiet judge failure shows", () => {
    const ts = [
      tr("t0", 0, "claimed", "in_review", "system"), // before the judge was on
      tr("t1", 10, "claimed", "in_review", "system"),
      tr("t2", 20, "claimed", "in_review", "system"), // the judge failed for this one
      tr("t1", 30, "refining", "in_review", "system"), // attempt 2, judged
    ];
    const cov = coverageOf([jp("t1", 11, "pass", 4), jp("t1", 31, "pass", 4)], ts);
    expect(cov).toEqual({ reviewEntries: 3, judged: 2, rate: 0.67 });
  });

  it("a ledger record with a matching event is one judgment; an older one is kept", () => {
    const ev = [jp("t7", 10, "borderline", 3.2)];
    const led = parseLedgerJudgments(
      [
        JSON.stringify({ ts: T(9), ticketId: "7", overall: "borderline", score: 3.2, dims: {} }),
        JSON.stringify({
          ts: T(1),
          ticketId: "7",
          overall: "fail",
          score: 1.4,
          dims: { security: 1 },
        }),
        JSON.stringify({ ts: T(1), ticketId: "99", overall: "pass", score: 5 }), // not this factory's
        "{ not json",
        "",
      ].join("\n"),
      new Map([[7, "t7"]]),
    );
    expect(led).toHaveLength(2);
    const merged = mergeJudgments(ev, led);
    expect(merged.map((m) => [m.source, m.score])).toEqual([
      ["ledger", 1.4],
      ["event", 3.2],
    ]);
    expect(merged[0]!.dims).toEqual({ security: 1 });
  });
});

describe("readJudgeAgreement over a real factory database", () => {
  const human: Actor = { type: "human", id: "tom" };
  const agentActor: Actor = { type: "agent", id: "agent-runner" };
  const system: Actor = { type: "system" };
  let now = Date.UTC(2026, 9, 1, 9, 0);
  const step = (): void => {
    now += 60_000;
    vi.setSystemTime(now);
  };
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
  });
  afterEach(() => vi.useRealTimers());

  function toReview(wg: Dispatch, id: string, agentId: string, first = true): void {
    const claim = wg.claimTicket(
      { ticket_id: id, agent_id: agentId, ttl_seconds: 300 },
      agentActor,
    );
    if (first) giveTicketRealDelivery(wg, id, human, { repoName: `delivery-${id}` });
    wg.recordDeliveryArtifact(
      { claim_token: claim.claimToken, ticket_id: id, branch_name: "feat/x" },
      agentActor,
    );
    wg.submitForReview({ claimToken: claim.claimToken, ticket_id: id }, agentActor);
    step();
  }
  const verdict = (overall: string, score: number, test_adequacy: number) => ({
    overall,
    score,
    blocking: overall === "fail",
    judged: true,
    dimensions: [
      { dimension: "ac_coverage", score: 5, rationale: "covers the criterion" },
      { dimension: "test_adequacy", score: test_adequacy, rationale: "the test checks little" },
    ],
    summary: "graded",
  });

  it("pairs each delivery's judgment with its own review decision, across a rework", () => {
    const wg = Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner, {
      testingEnabled: false,
    });
    const agent = wg.registerAgent({ display_name: "a" }, human);
    const t = wg.createTicket(
      { title: "addTasks", policy_pack: "solo_loose", risk_level: "low" },
      human,
    );
    wg.addAcceptanceCriterion({ ticket_id: t.id, text: "AC" }, human);
    wg.markReady(t.id, human);
    step();
    // Attempt 1: judged borderline, the reviewer sends it back.
    toReview(wg, t.id, agent.id);
    wg.recordEvalJudgment(t.id, verdict("borderline", 3.5, 1), system);
    step();
    wg.rejectReview(t.id, "ready", human, "the assertion passes for any value");
    step();
    // Attempt 2: judged pass, the reviewer approves.
    toReview(wg, t.id, agent.id, false);
    wg.recordEvalJudgment(t.id, verdict("pass", 5, 5), system);
    step();
    wg.approveReview(t.id, human);
    step();

    const r = readJudgeAgreement(wg.db, {
      // The ledger copy of attempt 1 (same verdict, same minute): counted once.
      ledgerJsonl: JSON.stringify({
        ts: new Date(Date.UTC(2026, 9, 1, 9, 2)).toISOString(),
        ticketId: String(t.number),
        overall: "borderline",
        score: 3.5,
        dims: {},
      }),
    });
    expect(r.judgments).toBe(2);
    expect(r.fromLedger).toBe(0);
    expect(r.pairs.map((p) => [p.overall, p.outcome, p.decidedBy])).toEqual([
      ["borderline", "sent_back", "human"],
      ["pass", "accepted", "human"],
    ]);
    expect(r.pairs[0]!.reason).toBe("the assertion passes for any value");
    expect(r.coverage).toEqual({ reviewEntries: 2, judged: 2, rate: 1 });
    expect(r.auc).toBe(1);
    // An agent cannot record its own grade.
    expect(() => wg.recordEvalJudgment(t.id, verdict("pass", 5, 5), agentActor)).toThrow(
      /Only the runner/,
    );
  });
});

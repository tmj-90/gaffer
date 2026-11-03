/**
 * REVIEW-RULE DRAFTS (gap-specialists D6; strategy "Learn review preferences"): repeated
 * human review feedback becomes a proposed lore `convention` draft. Deterministic: the same
 * normalised send-back reason or must-fix comment body on N or more tickets in a repo (N =
 * GAFFER_REVIEW_RULE_REPEAT, default 3). Only a person's feedback seeds a draft; a draft is
 * never auto-approved; each proposed rule is measured by the rejections citing it before
 * and after its approval. Hand-worked fixtures.
 */
import { describe, expect, it } from "vitest";

import {
  normaliseFeedback,
  reviewRuleCandidates,
  reviewRuleMeasure,
  reviewRuleThreshold,
  type FeedbackItem,
} from "../src/health/reviewRules.js";

const DAY = 86_400_000;
const T0 = Date.parse("2026-06-01T00:00:00.000Z");

describe("normaliseFeedback", () => {
  it("drops ids, paths, numbers, ticket refs and punctuation", () => {
    expect(
      normaliseFeedback(
        "Repository methods in src/repo/userRepo.ts:42 must return `null`, not undefined (see #12, abc1234f)!",
      ),
    ).toBe("repository methods in must return null not undefined see");
    expect(
      normaliseFeedback("Repository methods in lib/x.ts must return null, not undefined. See #7."),
    ).toBe("repository methods in must return null not undefined see");
  });

  it("refuses text too short to be a rule", () => {
    expect(normaliseFeedback("no")).toBeNull();
    expect(normaliseFeedback("fix it")).toBeNull();
    expect(normaliseFeedback("#12 3f9a2b1c")).toBeNull();
  });
});

describe("reviewRuleCandidates", () => {
  const item = (
    ticketId: string,
    number: number,
    text: string,
    over: Partial<FeedbackItem> = {},
  ): FeedbackItem => ({
    ticketId,
    ticketNumber: number,
    repo: "app",
    source: "send_back_reason",
    text,
    actorType: "human",
    actorId: "tom",
    atMs: T0 + number * DAY,
    ...over,
  });
  const RULE = "New API handlers must include a negative authorisation case.";

  it("a rule needs the same feedback on N distinct tickets in one repo, from a person", () => {
    const items = [
      item("A", 1, RULE),
      item("A", 1, `${RULE}`, { source: "must_fix_comment" }), // same ticket twice: one ticket
      item("B", 2, "New API handlers must include a negative authorisation case (#2)", {
        source: "must_fix_comment",
      }),
      // An agent's and the tester's send-backs never seed a rule.
      item("C", 3, RULE, { actorType: "agent", actorId: "reviewer" }),
      item("D", 4, RULE, { actorType: "system", actorId: null }),
      // Another repo is another scope.
      item("E", 5, RULE, { repo: "web" }),
    ];
    expect(reviewRuleCandidates(items, 3)).toEqual([]);
    const withThird = [...items, item("F", 6, RULE, { actorType: "admin", actorId: "ops" })];
    const c = reviewRuleCandidates(withThird, 3);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({
      repo: "app",
      key: "new api handlers must include a negative authorisation case",
      count: 3,
      tickets: [1, 2, 6],
    });
    expect(c[0]!.examples).toHaveLength(4);
    expect(c[0]!.examples[0]).toMatchObject({ ticket: 6, source: "send_back_reason", by: "ops" });
    expect(c[0]!.rule_text).toBe(RULE);
  });

  it("the threshold knob: default 3, clamped 2..20", () => {
    expect(reviewRuleThreshold({})).toBe(3);
    expect(reviewRuleThreshold({ GAFFER_REVIEW_RULE_REPEAT: "5" })).toBe(5);
    expect(reviewRuleThreshold({ GAFFER_REVIEW_RULE_REPEAT: "1" })).toBe(2);
    expect(reviewRuleThreshold({ GAFFER_REVIEW_RULE_REPEAT: "99" })).toBe(20);
    expect(reviewRuleThreshold({ GAFFER_REVIEW_RULE_REPEAT: "x" })).toBe(3);
  });
});

describe("reviewRuleMeasure", () => {
  const KEY = "new api handlers must include a negative authorisation case";
  const cite = (ticketId: string, day: number): FeedbackItem => ({
    ticketId,
    ticketNumber: 0,
    repo: "app",
    source: "send_back_reason",
    text: "New API handlers must include a negative authorisation case",
    actorType: "human",
    actorId: "tom",
    atMs: T0 + day * DAY,
  });
  const round = (ticketId: string, day: number) => ({
    ticketId,
    repo: "app",
    atMs: T0 + day * DAY,
  });

  it("not approved yet", () => {
    const m = reviewRuleMeasure({
      repo: "app",
      key: KEY,
      approvedAtMs: null,
      items: [],
      rounds: [],
      nowMs: T0,
    });
    expect(m.state).toBe("not_approved");
  });

  it("not enough data with fewer than 5 person-decided review rounds after approval", () => {
    const m = reviewRuleMeasure({
      repo: "app",
      key: KEY,
      approvedAtMs: T0 + 10 * DAY,
      items: [cite("A", 2), cite("B", 5)],
      rounds: [round("A", 2), round("B", 5), round("C", 12)],
      nowMs: T0 + 20 * DAY,
    });
    expect(m).toMatchObject({ state: "not_enough_data", rounds_after: 1, citing_before: 2 });
  });

  it("citing rejections per review round, before vs after over equal windows", () => {
    // Approved day 10, now day 20: before = days 0..10, after = days 10..20.
    // Before: 3 citing tickets over 6 rounds (50%). After: 1 over 5 rounds (20%).
    // A citing item on day -5 is outside the before window.
    const m = reviewRuleMeasure({
      repo: "app",
      key: KEY,
      approvedAtMs: T0 + 10 * DAY,
      items: [cite("Z", -5), cite("A", 1), cite("B", 3), cite("C", 8), cite("H", 15)],
      rounds: [
        ...["A", "B", "C", "D", "E", "F"].map((id, i) => round(id, i + 1)),
        ...["G", "H", "I", "J", "K"].map((id, i) => round(id, i + 11)),
        { ticketId: "W", repo: "web", atMs: T0 + 12 * DAY },
      ],
      nowMs: T0 + 20 * DAY,
    });
    expect(m).toMatchObject({
      state: "measured",
      window_days: 10,
      citing_before: 3,
      rounds_before: 6,
      rate_before_pct: 50,
      citing_after: 1,
      rounds_after: 5,
      rate_after_pct: 20,
    });
  });
});

/**
 * MEASUREMENT — a recommendation's sample is DISTINCT human decisions.
 *
 * One human approval on a ticket that writes to ten repositories joined to ten review
 * rows (one per repository), and the cross-repo prior summed them: "approved 10/10
 * low-risk reviews across all repos — consider auto-approve / auto-merge". One person
 * looked once. The decision may inform each of the ten repositories' own histories (one
 * observation each), but across repositories it stays ONE observation.
 */
import { afterEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { writeEvent } from "../src/events/eventWriter.js";
import { MIN_SAMPLES } from "../src/services/autonomyRecommendationService.js";

const human: Actor = { type: "human", id: "tom" };

function approveEvent(d: Dispatch, ticketId: string): void {
  writeEvent(d.db, {
    entity_type: "ticket",
    entity_id: ticketId,
    actor: human,
    event_type: "ticket.transitioned",
    payload: {
      from: "in_review",
      to: "ready_for_merge",
      reason: "review_approved",
      approved_unchanged: true,
    },
  });
}

function ticketOver(d: Dispatch, repos: string[], title: string): string {
  const t = d.createTicket({ title, risk_level: "low" }, human);
  for (const r of repos) d.linkRepository(t.id, r, "primary", human);
  return t.id;
}

describe("autonomy recommendations count distinct human decisions", () => {
  let d: Dispatch;
  afterEach(() => d.db.close());

  it("one approval of a 10-repo ticket is ONE observation, not 10/10", () => {
    d = Dispatch.open(":memory:");
    const repos = Array.from({ length: 10 }, (_, i) => `svc-${i}`);
    for (const r of repos) d.registerRepository({ name: r, default_branch: "main" }, human);
    approveEvent(d, ticketOver(d, repos, "spans ten repos"));

    // Each repository's history carries the decision once…
    const rows = d.events.reviewDecisions();
    expect(new Set(rows.map((r) => r.repoName)).size).toBe(10);
    expect(new Set(rows.map((r) => r.decisionId)).size).toBe(1);
    // …and nothing is recommended from one look (the floor is MIN_SAMPLES decisions).
    const recs = d.autonomyRecommendationsList();
    expect(recs).toEqual([]);
    expect(MIN_SAMPLES).toBeGreaterThan(1);
  });

  it("fewer than MIN_SAMPLES decisions spanning three repos raise no cross-repo prior", () => {
    d = Dispatch.open(":memory:");
    const repos = ["a", "b", "c"];
    for (const r of repos) d.registerRepository({ name: r, default_branch: "main" }, human);
    // MIN_SAMPLES - 1 looks, each at a ticket spanning all three repositories: 3× as many
    // repo rows as decisions, which used to clear the floor.
    for (let i = 0; i < MIN_SAMPLES - 1; i++) approveEvent(d, ticketOver(d, repos, `t${i}`));
    expect(d.events.reviewDecisions()).toHaveLength((MIN_SAMPLES - 1) * 3);
    expect(d.autonomyRecommendationsList()).toEqual([]);
  });

  it("the cross-repo sample is the number of distinct decisions", () => {
    d = Dispatch.open(":memory:");
    const repos = ["a", "b", "c"];
    for (const r of repos) d.registerRepository({ name: r, default_branch: "main" }, human);
    // MIN_SAMPLES decisions over the three repos (none reaches the floor alone), the
    // first one spanning all three.
    approveEvent(d, ticketOver(d, repos, "wide"));
    for (let i = 1; i < MIN_SAMPLES; i++) approveEvent(d, ticketOver(d, [repos[i % 3]!], `t${i}`));
    const prior = d
      .autonomyRecommendationsList()
      .find((r) => r.repoId === "*" && r.gate === "approve");
    expect(prior?.sample.total).toBe(MIN_SAMPLES);
    expect(prior?.sample.approvals).toBe(MIN_SAMPLES);
    expect(prior?.headline).toContain(`${MIN_SAMPLES}/${MIN_SAMPLES}`);
  });
});

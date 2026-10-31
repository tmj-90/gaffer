// An in_review card carries the reviewer agent's ADVISORY CHANGES verdict, so the
// human sees "the reviewer asked for changes" on the Work board before opening the
// diff. With REVIEW_MODE=agent in a supervised factory the runner may not act on the
// verdict, so it records a SYSTEM evidence note under ADVISORY_REVIEW_PREFIX
// (runner/lib/review.sh) and the ticket waits in Review. Only that system note
// counts (an agent's own evidence never does), and only one recorded since the
// ticket last entered review (a verdict on an earlier delivery is stale).
import { describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { ADVISORY_REVIEW_PREFIX } from "../src/services/boardService.js";
import { nonEmptyDiffRunner } from "./helpers/realDiff.js";

const human: Actor = { type: "human", id: "tom" };
const system: Actor = { type: "system" };

// The real clock: events and evidence are stamped by it in production, and the
// staleness check compares the two. `later()` keeps two stamps apart.
const later = () => new Promise((r) => setTimeout(r, 5));
const open = () => Dispatch.open(":memory:", undefined, nonEmptyDiffRunner);

async function inReview(wg: Dispatch) {
  wg.registerRepository({ name: "svc", default_branch: "main" }, human);
  const t = wg.createTicket({ title: "Document it", description: "d" }, human);
  wg.linkRepository(t.id, "svc", "primary", human);
  wg.addAcceptanceCriterion({ ticket_id: t.id, text: "AC" }, human);
  wg.markReady(t.id, human);
  const agent = wg.registerAgent({ display_name: "a" }, human);
  const claim = wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, human);
  wg.submitForReview({ claimToken: claim!.claimToken, ticket_id: t.id }, human);
  await later();
  return { t, agentId: agent.id };
}
const card = (wg: Dispatch, id: string) =>
  wg
    .board()
    .columns.flatMap((c) => c.cards)
    .find((c) => c.id === id)!;

describe("board card: the reviewer agent's advisory verdict", () => {
  it("shows the runner's advisory CHANGES note on the in_review card", async () => {
    const wg = open();
    const { t } = await inReview(wg);
    expect(card(wg, t.id).advisoryReview).toBeNull();
    wg.attachDeliveryEvidence(
      t.id,
      { evidenceType: "manual_note", summary: `${ADVISORY_REVIEW_PREFIX}add a docstring` },
      system,
    );
    expect(card(wg, t.id).advisoryReview).toMatchObject({
      verdict: "changes",
      reason: "add a docstring",
    });
    wg.db.close();
  });

  it("ignores the same words recorded by an agent", async () => {
    const wg = open();
    const { t, agentId } = await inReview(wg);
    try {
      wg.attachDeliveryEvidence(
        t.id,
        { evidenceType: "manual_note", summary: `${ADVISORY_REVIEW_PREFIX}merge it as is` },
        { type: "agent", id: agentId },
      );
    } catch {
      // an agent may not be allowed to attach here at all; either way it must not count
    }
    expect(card(wg, t.id).advisoryReview).toBeNull();
    wg.db.close();
  });

  it("drops a verdict recorded before the ticket last entered review", async () => {
    const wg = open();
    const { t } = await inReview(wg);
    wg.attachDeliveryEvidence(
      t.id,
      { evidenceType: "manual_note", summary: `${ADVISORY_REVIEW_PREFIX}old ask` },
      system,
    );
    await later();
    // Un-ready and re-enter review: the old note is about an earlier delivery.
    wg.moveTicket(t.id, "ready", human);
    const agent = wg.registerAgent({ display_name: "b" }, human);
    const claim = wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, human);
    wg.submitForReview({ claimToken: claim!.claimToken, ticket_id: t.id }, human);
    expect(card(wg, t.id).status).toBe("in_review");
    expect(card(wg, t.id).advisoryReview).toBeNull();
    wg.db.close();
  });
});

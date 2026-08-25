// A board card must carry its confirmed write-boundary repos so the dashboard
// can cross-link a card straight to a repo's detail page (UX audit: "no path
// from a board card to its repo"). These pin the batched lookup: only ACTIVE
// write links surface, suggestions/reads do not, and the query is one round-trip
// for the whole board.

import { beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";

const human: Actor = { type: "human", id: "tom" };

function freshWg(): Dispatch {
  return Dispatch.open(":memory:");
}

/** A ready ticket linked to `repoName` as a confirmed WRITE boundary. */
function readyTicketWithWriteRepo(wg: Dispatch, title: string, repoName: string): string {
  const t = wg.createTicket({ title, policy_pack: "solo_loose" }, human);
  const r = wg.registerRepository({ name: repoName }, human);
  wg.linkRepository(t.id, repoName, "primary", human);
  wg.setTicketRepoAccess(
    { ticket_id: t.id, repo_id: r.id, access: "write", relation: "confirmed" },
    human,
  );
  wg.addAcceptanceCriterion({ ticket_id: t.id, text: "AC" }, human);
  wg.markReady(t.id, human);
  return t.id;
}

function cardById(wg: Dispatch, ticketId: string) {
  for (const col of wg.board().columns) {
    const found = col.cards.find((c) => c.id === ticketId);
    if (found) return found;
  }
  return undefined;
}

describe("board card repo cross-link", () => {
  let wg: Dispatch;
  beforeEach(() => {
    wg = freshWg();
  });

  it("carries the confirmed write repo (id + name) on the card", () => {
    const ticketId = readyTicketWithWriteRepo(wg, "Feature", "api");
    const card = cardById(wg, ticketId);
    expect(card).toBeDefined();
    expect(card!.repos).toHaveLength(1);
    expect(card!.repos[0]!.name).toBe("api");
    expect(card!.repos[0]!.id).toBeTruthy();
    wg.db.close();
  });

  it("a ticket with no confirmed boundary has an empty repos array", () => {
    const t = wg.createTicket({ title: "No repo", policy_pack: "solo_loose" }, human);
    wg.addAcceptanceCriterion({ ticket_id: t.id, text: "AC" }, human);
    wg.markReady(t.id, human);
    const card = cardById(wg, t.id);
    expect(card).toBeDefined();
    expect(card!.repos).toEqual([]);
    wg.db.close();
  });

  it("a read-only link is NOT a write boundary and is excluded", () => {
    const t = wg.createTicket({ title: "Reads only", policy_pack: "solo_loose" }, human);
    const r = wg.registerRepository({ name: "docs" }, human);
    wg.linkRepository(t.id, "docs", "primary", human);
    wg.setTicketRepoAccess(
      { ticket_id: t.id, repo_id: r.id, access: "read", relation: "confirmed" },
      human,
    );
    wg.addAcceptanceCriterion({ ticket_id: t.id, text: "AC" }, human);
    wg.markReady(t.id, human);
    const card = cardById(wg, t.id);
    expect(card!.repos).toEqual([]);
    wg.db.close();
  });

  it("resolves each card's repos independently across the board", () => {
    const a = readyTicketWithWriteRepo(wg, "Alpha", "svc-a");
    const b = readyTicketWithWriteRepo(wg, "Bravo", "svc-b");
    expect(cardById(wg, a)!.repos.map((x) => x.name)).toEqual(["svc-a"]);
    expect(cardById(wg, b)!.repos.map((x) => x.name)).toEqual(["svc-b"]);
    wg.db.close();
  });
});

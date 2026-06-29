import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApiServer } from "../src/api/server.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { TestClock } from "../src/util/clock.js";

const human: Actor = { type: "human", id: "tom" };

interface Harness {
  wg: Dispatch;
  clock: TestClock;
  baseUrl: string;
  close: () => Promise<void>;
}

async function startHarness(): Promise<Harness> {
  // Audit off by default so the activity/board tests don't touch the filesystem.
  process.env.DISPATCH_AUDIT_OFF = "1";
  const clock = new TestClock();
  const wg = Dispatch.open(":memory:", clock);
  const server = createApiServer(wg);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    wg,
    clock,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          wg.db.close();
          resolve();
        });
      }),
  };
}

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

async function call(baseUrl: string, method: string, path: string): Promise<JsonResponse> {
  const res = await fetch(`${baseUrl}${path}`, { method });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

/** Create a ticket directly via the facade and return it. */
function makeTicket(wg: Dispatch, title: string): { id: string; number: number | null } {
  const t = wg.createTicket({ title }, human);
  return { id: t.id, number: t.number };
}

describe("API: read-model surfaces (board + activity + dashboard)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  // --- /api/board ----------------------------------------------------------

  it("GET /api/board groups tickets by collapsed status into columns", async () => {
    // draft (stays draft)
    makeTicket(h.wg, "Draft ticket");
    // ready
    const ready = makeTicket(h.wg, "Ready ticket");
    h.wg.addAcceptanceCriterion({ ticket_id: ready.id, text: "AC" }, human); // Guard A: ≥1 AC required to ready
    h.wg.markReady(ready.id, human);
    // claimed/in_progress -> collapsed "in_progress" column
    const claimed = makeTicket(h.wg, "Claimed ticket");
    h.wg.addAcceptanceCriterion({ ticket_id: claimed.id, text: "AC" }, human); // Guard A: ≥1 AC required to ready
    h.wg.markReady(claimed.id, human);
    const agent = h.wg.registerAgent({ display_name: "claude-board" }, human);
    h.wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, human);

    const res = await call(h.baseUrl, "GET", "/api/board");
    expect(res.status).toBe(200);

    const columns = res.body.columns as Array<{ column: string; cards: Array<{ id: string }> }>;
    expect(columns.map((c) => c.column)).toEqual([
      "draft",
      "ready",
      "in_progress",
      "blocked",
      "in_review",
      "in_testing",
      "ready_for_merge",
      "done",
    ]);

    const col = (key: string): Array<{ id: string }> =>
      columns.find((c) => c.column === key)!.cards;
    expect(col("draft").length).toBe(1);
    expect(col("ready").length).toBe(1);
    expect(col("in_progress").length).toBe(1); // the claimed ticket collapsed in
    expect(Array.isArray(res.body.closed)).toBe(true);
  });

  it("board cards carry AC progress and an active claim holder (no token)", async () => {
    const t = makeTicket(h.wg, "Card detail");
    h.wg.addAcceptanceCriterion({ ticket_id: t.id, text: "AC one" }, human);
    h.wg.addAcceptanceCriterion({ ticket_id: t.id, text: "AC two" }, human);
    h.wg.markReady(t.id, human);
    const agent = h.wg.registerAgent({ display_name: "worker-7" }, human);
    h.wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, human);

    const res = await call(h.baseUrl, "GET", "/api/board");
    const columns = res.body.columns as Array<{
      column: string;
      cards: Array<Record<string, unknown>>;
    }>;
    const card = columns.find((c) => c.column === "in_progress")!.cards.find((c) => c.id === t.id)!;

    expect(card.acTotal).toBe(2);
    expect(card.acSatisfied).toBe(0);
    const claim = card.claim as { agentDisplayName: string; stale: boolean } & Record<
      string,
      unknown
    >;
    expect(claim.agentDisplayName).toBe("worker-7");
    expect(claim.stale).toBe(false);
    // No secret/token leaks onto the card or its claim.
    const serialized = JSON.stringify(card);
    expect(serialized).not.toMatch(/token/i);
    expect(serialized).not.toMatch(/hash/i);
  });

  it("board marks a claim stale once its lease has passed expiry", async () => {
    const t = makeTicket(h.wg, "Stale lease");
    h.wg.addAcceptanceCriterion({ ticket_id: t.id, text: "AC" }, human); // Guard A: ≥1 AC required to ready
    h.wg.markReady(t.id, human);
    const agent = h.wg.registerAgent({ display_name: "slow-agent" }, human);
    h.wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 60 }, human);

    // Advance the clock past the lease without expiring the claim.
    h.clock.advanceSeconds(120);

    const res = await call(h.baseUrl, "GET", "/api/board");
    const columns = res.body.columns as Array<{
      column: string;
      cards: Array<Record<string, unknown>>;
    }>;
    const card = columns.find((c) => c.column === "in_progress")!.cards.find((c) => c.id === t.id)!;
    expect((card.claim as { stale: boolean }).stale).toBe(true);
  });

  it("board returns cancelled/failed tickets in the closed area, not columns", async () => {
    // No direct cancel API; assert closed is present and live columns exclude it.
    const res = await call(h.baseUrl, "GET", "/api/board");
    expect(res.body).toHaveProperty("closed");
    const columns = res.body.columns as Array<{ column: string }>;
    expect(columns.some((c) => c.column === "cancelled" || c.column === "failed")).toBe(false);
  });

  // --- /api/board?repo= (repo filter) ----------------------------------------

  describe("GET /api/board?repo= — repo filter", () => {
    it("returns only tickets linked to the requested repo", async () => {
      // Register two repos and link one ticket to each.
      h.wg.registerRepository({ name: "repo-alpha" }, human);
      h.wg.registerRepository({ name: "repo-beta" }, human);

      const alpha = makeTicket(h.wg, "Alpha ticket");
      const beta = makeTicket(h.wg, "Beta ticket");
      const unlinked = makeTicket(h.wg, "Unlinked ticket");

      h.wg.linkRepository(alpha.id, "repo-alpha", "primary", human);
      h.wg.linkRepository(beta.id, "repo-beta", "primary", human);

      const res = await call(h.baseUrl, "GET", "/api/board?repo=repo-alpha");
      expect(res.status).toBe(200);

      const columns = res.body.columns as Array<{ column: string; cards: Array<{ id: string }> }>;
      const allCardIds = columns.flatMap((c) => c.cards.map((card) => card.id));

      expect(allCardIds).toContain(alpha.id);
      expect(allCardIds).not.toContain(beta.id);
      expect(allCardIds).not.toContain(unlinked.id);
    });

    it("returns an empty board for an unknown repo", async () => {
      makeTicket(h.wg, "Some ticket");

      const res = await call(h.baseUrl, "GET", "/api/board?repo=no-such-repo");
      expect(res.status).toBe(200);

      const columns = res.body.columns as Array<{ column: string; cards: Array<{ id: string }> }>;
      const allCardIds = columns.flatMap((c) => c.cards.map((card) => card.id));
      expect(allCardIds).toHaveLength(0);
    });

    it("returns the full board when no repo filter is provided (back-compat)", async () => {
      h.wg.registerRepository({ name: "repo-gamma" }, human);
      const t1 = makeTicket(h.wg, "Linked ticket");
      const t2 = makeTicket(h.wg, "Free ticket");
      h.wg.linkRepository(t1.id, "repo-gamma", "primary", human);

      const res = await call(h.baseUrl, "GET", "/api/board");
      expect(res.status).toBe(200);

      const columns = res.body.columns as Array<{ column: string; cards: Array<{ id: string }> }>;
      const allCardIds = columns.flatMap((c) => c.cards.map((card) => card.id));
      expect(allCardIds).toContain(t1.id);
      expect(allCardIds).toContain(t2.id);
    });
  });

  // --- /api/activity -------------------------------------------------------

  it("GET /api/activity returns events newest-first across all tickets", async () => {
    const a = makeTicket(h.wg, "First");
    h.clock.advanceSeconds(1);
    const b = makeTicket(h.wg, "Second");
    h.wg.addAcceptanceCriterion({ ticket_id: a.id, text: "AC" }, human); // Guard A: ≥1 AC required to ready
    h.clock.advanceSeconds(1);
    h.wg.markReady(a.id, human); // newest event

    const res = await call(h.baseUrl, "GET", "/api/activity");
    expect(res.status).toBe(200);
    const events = res.body.events as Array<{
      event_type: string;
      ticket_number: number | null;
      created_at: string;
    }>;
    expect(events.length).toBeGreaterThanOrEqual(3);

    // Newest first: the most recent event is the mark-ready transition on `a`.
    expect(events[0]!.event_type).toBe("ticket.transitioned");
    expect(events[0]!.ticket_number).toBe(a.number);

    // The two ticket.created events appear, with `b` before `a` (b is newer).
    const createdNumbers = events
      .filter((e) => e.event_type === "ticket.created")
      .map((e) => e.ticket_number);
    expect(createdNumbers).toEqual([b.number, a.number]);
  });

  it("activity feed honours limit + offset and reports a total", async () => {
    for (let i = 0; i < 5; i++) {
      makeTicket(h.wg, `T${i}`);
      h.clock.advanceSeconds(10);
    }
    const total = (await call(h.baseUrl, "GET", "/api/activity")).body.total as number;
    expect(total).toBe(5);

    const page = await call(h.baseUrl, "GET", "/api/activity?limit=2&offset=1");
    expect((page.body.events as unknown[]).length).toBe(2);
    expect(page.body.limit).toBe(2);
    expect(page.body.offset).toBe(1);
  });

  it("activity feed never leaks payload bodies, tokens or hashes", async () => {
    const t = makeTicket(h.wg, "Sensitive title here");
    // Add an AC whose text would be embarrassing to leak via the feed.
    h.wg.addAcceptanceCriterion({ ticket_id: t.id, text: "SECRET-AC-BODY-do-not-leak" }, human);
    h.wg.markReady(t.id, human);
    const agent = h.wg.registerAgent({ display_name: "agent-x" }, human);
    h.wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, human);

    const res = await call(h.baseUrl, "GET", "/api/activity?limit=200");
    const serialized = JSON.stringify(res.body.events);
    expect(serialized).not.toContain("SECRET-AC-BODY-do-not-leak");
    expect(serialized).not.toMatch(/payload_json/);
    expect(serialized).not.toMatch(/claim_token/i);
    expect(serialized).not.toMatch(/token_hash/i);
  });

  // --- /api/dashboard ------------------------------------------------------

  it("GET /api/dashboard summarises counts, open decisions and active claims", async () => {
    const draft = makeTicket(h.wg, "A draft");
    const ready = makeTicket(h.wg, "A ready");
    h.wg.addAcceptanceCriterion({ ticket_id: ready.id, text: "AC" }, human); // Guard A: ≥1 AC required to ready
    h.wg.markReady(ready.id, human);
    const agent = h.wg.registerAgent({ display_name: "claude-dash" }, human);
    h.wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, human);
    h.wg.createDecision({ title: "Pick a DB", question: "Which?" }, human);

    const res = await call(h.baseUrl, "GET", "/api/dashboard");
    expect(res.status).toBe(200);
    const summary = res.body.summary as {
      ticketsByStatus: Record<string, number>;
      openDecisions: number;
      activeClaims: number;
      staleClaims: number;
      blocked: number;
    };
    expect(summary.ticketsByStatus.draft).toBe(1);
    expect(summary.ticketsByStatus.claimed).toBe(1); // ready -> claimed
    expect(summary.openDecisions).toBe(1);
    expect(summary.activeClaims).toBe(1);
    expect(summary.staleClaims).toBe(0);
    expect(summary.blocked).toBe(0);
    expect(draft.id).toBeTruthy();
  });

  it("dashboard counts stale claims once their lease passes expiry", async () => {
    const t = makeTicket(h.wg, "Will go stale");
    h.wg.addAcceptanceCriterion({ ticket_id: t.id, text: "AC" }, human); // Guard A: ≥1 AC required to ready
    h.wg.markReady(t.id, human);
    const agent = h.wg.registerAgent({ display_name: "ghost" }, human);
    h.wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 30 }, human);
    h.clock.advanceSeconds(60);

    const res = await call(h.baseUrl, "GET", "/api/dashboard");
    const summary = res.body.summary as { activeClaims: number; staleClaims: number };
    expect(summary.activeClaims).toBe(1);
    expect(summary.staleClaims).toBe(1);
  });

  // --- /api/dashboard: cycle time + stuck tickets --------------------------
  //
  // Cycle-time/stuck analytics measure the gaps between `ticket.transitioned`
  // events, whose created_at is stamped by SQLite wall-clock (not the injected
  // TestClock). To assert deterministically we drive the real transition path
  // (so ticket status + the event sequence are genuine) then stamp the
  // transition events' created_at to known instants — the same log the
  // read-model aggregates in production.

  /** Pin a ticket's transition-into-`toStatus` event to a known instant. */
  function stampTransition(ticketId: string, toStatus: string, iso: string): void {
    h.wg.db
      .prepare(
        `UPDATE work_events SET created_at = ?
         WHERE entity_type = 'ticket' AND entity_id = ?
           AND event_type = 'ticket.transitioned'
           AND json_extract(payload_json, '$.to') = ?`,
      )
      .run(iso, ticketId, toStatus);
  }

  it("dashboard reports median cycle time per state over completed intervals", async () => {
    // Two tickets spend a known span in `ready` before being claimed: A 10s,
    // B 30s → median(ready) = 20s. The draft span before the first transition
    // and the still-open `claimed` span are not completed intervals, so absent.
    const a = makeTicket(h.wg, "A");
    h.wg.addAcceptanceCriterion({ ticket_id: a.id, text: "AC" }, human); // Guard A: ≥1 AC required to ready
    h.wg.markReady(a.id, human);
    const agentA = h.wg.registerAgent({ display_name: "worker-a" }, human);
    h.wg.claimNextTicket({ agentId: agentA.id, ttlSeconds: 600 }, human);
    stampTransition(a.id, "ready", "2026-01-01T00:00:00.000Z");
    stampTransition(a.id, "claimed", "2026-01-01T00:00:10.000Z"); // 10s in ready

    const b = makeTicket(h.wg, "B");
    h.wg.addAcceptanceCriterion({ ticket_id: b.id, text: "AC" }, human); // Guard A: ≥1 AC required to ready
    h.wg.markReady(b.id, human);
    const agentB = h.wg.registerAgent({ display_name: "worker-b" }, human);
    h.wg.claimNextTicket({ agentId: agentB.id, ttlSeconds: 600 }, human);
    stampTransition(b.id, "ready", "2026-01-01T00:00:00.000Z");
    stampTransition(b.id, "claimed", "2026-01-01T00:00:30.000Z"); // 30s in ready

    const res = await call(h.baseUrl, "GET", "/api/dashboard");
    const summary = res.body.summary as {
      cycleTimeByState: Array<{ status: string; medianMs: number; samples: number }>;
    };
    const ready = summary.cycleTimeByState.find((c) => c.status === "ready");
    expect(ready).toBeDefined();
    expect(ready!.medianMs).toBe(20_000); // (10s + 30s) / 2
    expect(ready!.samples).toBe(2);
    // The still-open `claimed` state has no completed interval, so it is absent.
    expect(summary.cycleTimeByState.some((c) => c.status === "claimed")).toBe(false);
  });

  it("dashboard flags tickets stuck in a non-terminal state beyond the threshold", async () => {
    const stale = makeTicket(h.wg, "Languishing");
    h.wg.addAcceptanceCriterion({ ticket_id: stale.id, text: "AC" }, human); // Guard A: ≥1 AC required to ready
    h.wg.markReady(stale.id, human); // enters ready
    // Pin the ready entry to the clock epoch, then advance 26h past it (>24h).
    stampTransition(stale.id, "ready", "2026-01-01T00:00:00.000Z");
    h.clock.advanceSeconds(26 * 3600);

    // A ticket that just entered draft (created at the advanced now) is not stuck.
    const fresh = makeTicket(h.wg, "Just created");

    const res = await call(h.baseUrl, "GET", "/api/dashboard");
    const summary = res.body.summary as {
      stuckThresholdHours: number;
      stuckTickets: Array<{
        id: string;
        status: string;
        stuckForMs: number;
        number: number | null;
      }>;
    };
    expect(summary.stuckThresholdHours).toBe(24);
    const ids = summary.stuckTickets.map((s) => s.id);
    expect(ids).toContain(stale.id);
    expect(ids).not.toContain(fresh.id);
    const flagged = summary.stuckTickets.find((s) => s.id === stale.id)!;
    expect(flagged.status).toBe("ready");
    expect(flagged.stuckForMs).toBe(26 * 3600 * 1000); // exactly 26h
  });

  // --- /api/audit ----------------------------------------------------------

  it("GET /api/audit reports the panel as unavailable when no log exists", async () => {
    // Point the audit path at a guaranteed-absent file for this test.
    const prev = process.env.DISPATCH_AUDIT;
    process.env.DISPATCH_AUDIT = "/tmp/dispatch-audit-does-not-exist-xyz.jsonl";
    try {
      const res = await call(h.baseUrl, "GET", "/api/audit");
      expect(res.status).toBe(200);
      expect(res.body.available).toBe(false);
      expect(res.body.entries).toEqual([]);
      expect(res.body.path).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.DISPATCH_AUDIT;
      else process.env.DISPATCH_AUDIT = prev;
    }
  });

  // --- method + 404 guards -------------------------------------------------

  it("read-model routes reject non-GET methods and unknown /api paths", async () => {
    const post = await call(h.baseUrl, "POST", "/api/board");
    expect(post.status).toBe(405);

    const unknown = await call(h.baseUrl, "GET", "/api/nope");
    expect(unknown.status).toBe(404);
    expect((unknown.body.error as { code: string }).code).toBe("NOT_FOUND");
  });
});

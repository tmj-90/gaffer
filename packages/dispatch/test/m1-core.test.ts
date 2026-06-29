import { beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { DispatchError } from "../src/util/errors.js";
import { TestClock } from "../src/util/clock.js";

const human: Actor = { type: "human", id: "tom" };

function freshWg(): Dispatch {
  return Dispatch.open(":memory:", new TestClock());
}

describe("M1: ticket creation + events", () => {
  let wg: Dispatch;
  beforeEach(() => {
    wg = freshWg();
  });

  it("creates a draft ticket with an incrementing number and an event", () => {
    const a = wg.createTicket({ title: "First" }, human);
    const b = wg.createTicket({ title: "Second" }, human);
    expect(a.status).toBe("draft");
    expect(a.number).toBe(1);
    expect(b.number).toBe(2);
    const view = wg.view(a.id);
    expect(view.events.map((e) => e.event_type)).toContain("ticket.created");
  });

  it("rejects an empty title", () => {
    expect(() => wg.createTicket({ title: "   " }, human)).toThrow();
  });
});

describe("M1: solo_loose readiness", () => {
  it("marks ready with only a title", () => {
    const wg = freshWg();
    const t = wg.createTicket({ title: "Quick fix", policy_pack: "solo_loose" }, human);
    wg.addAcceptanceCriterion({ ticket_id: t.id, text: "AC" }, human); // Guard A: ≥1 AC required to ready
    const res = wg.markReady(t.id, human);
    expect(res.ticket.status).toBe("ready");
    expect(res.policy?.allowed).toBe(true);
    // repo/description absence are warnings, not failures
    expect(res.policy?.warnings.map((w) => w.code)).toContain("REPO_RECOMMENDED");
  });
});

describe("M1: team_light readiness", () => {
  it("blocks ready without AC + repo, then allows once satisfied", () => {
    const wg = freshWg();
    const t = wg.createTicket(
      { title: "Feature", description: "Build it", policy_pack: "team_light" },
      human,
    );

    const denied = wg.transitions.preview(t.id, "ready");
    expect(denied?.allowed).toBe(false);
    expect(denied?.failures.map((f) => f.code)).toEqual(
      expect.arrayContaining(["REPO_REQUIRED", "AC_REQUIRED"]),
    );

    expect(() => wg.markReady(t.id, human)).toThrowError(DispatchError);

    wg.registerRepository({ name: "api" }, human);
    wg.linkRepository(t.id, "api", "primary", human);
    wg.addAcceptanceCriterion({ ticket_id: t.id, text: "Endpoint returns 200" }, human);

    const ok = wg.markReady(t.id, human);
    expect(ok.ticket.status).toBe("ready");
  });
});

describe("M1: transition rules", () => {
  it("rejects an illegal transition (draft -> done)", () => {
    const wg = freshWg();
    const t = wg.createTicket({ title: "x" }, human);
    try {
      wg.transitions.transition({ ticketId: t.id, actor: human, toStatus: "done" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DispatchError);
      expect((err as DispatchError).code).toBe("ILLEGAL_TRANSITION");
    }
  });

  it("records every transition in the event log", () => {
    const wg = freshWg();
    const t = wg.createTicket({ title: "x" }, human);
    wg.addAcceptanceCriterion({ ticket_id: t.id, text: "AC" }, human); // Guard A: ≥1 AC required to ready
    wg.transitions.transition({ ticketId: t.id, actor: human, toStatus: "refining" });
    wg.markReady(t.id, human);
    const events = wg
      .view(t.id)
      .events.map((e) => e.event_type)
      .filter((type) => type !== "ac.added");
    expect(events).toEqual(["ticket.created", "ticket.transitioned", "ticket.transitioned"]);
  });

  it("blocks ready under team_light when a human_required decision is open", () => {
    const wg = freshWg();
    const t = wg.createTicket(
      { title: "Risky", description: "d", policy_pack: "team_light" },
      human,
    );
    wg.registerRepository({ name: "api" }, human);
    wg.linkRepository(t.id, "api", "primary", human);
    wg.addAcceptanceCriterion({ ticket_id: t.id, text: "AC" }, human);
    wg.createDecision(
      {
        title: "Schema change?",
        question: "Migrate now?",
        severity: "human_required",
        ticketId: t.id,
      },
      human,
    );
    const res = wg.transitions.preview(t.id, "ready");
    expect(res?.allowed).toBe(false);
    expect(res?.failures.map((f) => f.code)).toContain("HUMAN_BLOCKER_OPEN");
  });
});

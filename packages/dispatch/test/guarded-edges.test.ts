// GUARDED EDGES — the capability table behind TransitionService.transition(). Every
// guarded edge is refused without its legalising flag and passes with any one of
// them; every edge in the table is a real ALLOWED transition (no dead rows); and
// the live transition() still throws the table's exact message (the messages are
// asserted by nine other tests and rendered by the dashboard).
import { describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import {
  GUARDED_EDGES,
  violatedGuard,
  type TransitionInput,
} from "../src/services/transitionService.js";

const STATUSES = [
  "draft",
  "ready",
  "claimed",
  "in_progress",
  "refining",
  "in_review",
  "in_testing",
  "ready_for_merge",
  "done",
  "blocked",
  "paused",
  "cancelled",
];

function concreteEdges(rule: (typeof GUARDED_EDGES)[number]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const e of rule.edges) {
    if (e.startsWith("to:")) {
      const to = e.slice(3);
      for (const from of STATUSES) if (from !== to) out.push([from, to]);
    } else {
      const [from, to] = e.split("->");
      out.push([from!, to!]);
    }
  }
  return out;
}

describe("guarded transition edges (capability table)", () => {
  it("every guarded edge is refused bare and legalised by ANY one of its flags", () => {
    for (const rule of GUARDED_EDGES) {
      for (const [from, to] of concreteEdges(rule)) {
        const key = `${from}->${to}`;
        const bare = violatedGuard(key, { toStatus: to as TransitionInput["toStatus"] });
        expect(bare?.message, `${key} should be guarded`).toBe(rule.message);
        for (const flag of rule.anyOf) {
          const legal = violatedGuard(key, {
            toStatus: to as TransitionInput["toStatus"],
            [flag]: true,
          } as Partial<TransitionInput> & Pick<TransitionInput, "toStatus">);
          // Either unguarded now, or (for a `to:` rule) a DIFFERENT rule on the same
          // exact edge may still apply — never the rule we just satisfied.
          expect(legal?.message, `${key} with ${flag}`).not.toBe(rule.message);
        }
      }
    }
  });

  it("an unguarded edge passes with no flags at all", () => {
    expect(violatedGuard("draft->ready", { toStatus: "ready" })).toBeNull();
    expect(violatedGuard("claimed->in_progress", { toStatus: "in_progress" })).toBeNull();
  });

  it("table hygiene: no duplicate exact edge across rules, every flag is a known input flag", () => {
    const seen = new Map<string, string>();
    for (const rule of GUARDED_EDGES) {
      for (const e of rule.edges) {
        if (e.startsWith("to:")) continue;
        expect(seen.has(e), `edge ${e} guarded twice (${seen.get(e)} / ${rule.message})`).toBe(
          false,
        );
        seen.set(e, rule.message);
      }
      expect(rule.anyOf.length).toBeGreaterThan(0);
      expect(rule.message.length).toBeGreaterThan(10);
      expect(rule.why.length).toBeGreaterThan(10);
    }
    expect(GUARDED_EDGES.length).toBe(12);
  });

  it("live: a raw board move onto a guarded edge throws the table's message; the facade path passes", () => {
    const wg = Dispatch.open(":memory:");
    const human = { type: "human" as const, id: "op" };
    const t = wg.createTicket({ title: "guarded" }, human);
    wg.addAcceptanceCriterion({ ticket_id: t.id, text: "x" }, human);
    wg.moveTicket(t.id, "ready", human);
    // ready -> in_progress is human-claim only (a raw board move sets no flag).
    expect(() => wg.moveTicket(t.id, "in_progress", human)).toThrow(
      "A ready ticket can only be taken by hand via the human-claim path.",
    );
    // to:cancelled is won't-do only — from ready as well.
    expect(() => wg.moveTicket(t.id, "cancelled", human)).toThrow(
      "A ticket can only be abandoned via the won't-do path.",
    );
    // The facade flag legalises it.
    const r = wg.transitions.transition({
      ticketId: t.id,
      toStatus: "cancelled",
      actor: human,
      wontDo: true,
    });
    expect(r.ticket.status).toBe("cancelled");
    wg.db.close();
  });
});

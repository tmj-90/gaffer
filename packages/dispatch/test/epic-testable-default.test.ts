/**
 * GREENFIELD GOTCHA (tester lane): with the independent tester on (GAFFER_TESTING),
 * only tickets carrying the testable flag are routed through it, and the planner never
 * set the flag. So a person who turned the tester on and planned a build had to run
 * `wg ticket set-testable <n>` on every planned ticket before readying it, or the
 * tester saw none of them. createEpic now decides it at the moment the plan becomes
 * tickets: with the lane on, every implementation ticket is created testable (the
 * bootstrap is not: it scaffolds, there is no behaviour to black-box test), and a plan
 * can say `testable` per ticket either way. With the lane off nothing is marked, as
 * before, so the default never adds a gate the person did not turn on.
 */
import { afterEach, describe, expect, it } from "vitest";

import { createEpicBody } from "../src/api/schemas.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";

const human: Actor = { type: "human", id: "tom" };

function plan(extra: Record<number, Record<string, unknown>> = {}) {
  return {
    epic: { name: "Habit Ledger", description: "greenfield" },
    tickets: [
      {
        title: "Bootstrap the repo",
        description: "scaffold",
        acceptanceCriteria: ["repo exists"],
        bootstrap: true,
        repo: "habit-ledger",
        dependsOn: [],
        ...(extra[0] ?? {}),
      },
      {
        title: "Core store",
        description: "json",
        acceptanceCriteria: ["atomic writes"],
        repo: "habit-ledger",
        dependsOn: [0],
        ...(extra[1] ?? {}),
      },
      {
        title: "CLI",
        description: "commands",
        acceptanceCriteria: ["habit add works"],
        repo: "habit-ledger",
        dependsOn: [1],
        ...(extra[2] ?? {}),
      },
    ],
  };
}

describe("createEpic: the testable flag at plan time", () => {
  let d: Dispatch | undefined;
  afterEach(() => d?.db.close());

  const testable = (wg: Dispatch, n: number) => wg.view(String(n)).ticket.can_be_tested;

  it("tester lane ON: implementation tickets are created testable, the bootstrap is not", () => {
    d = Dispatch.open(":memory:", undefined, undefined, { testingEnabled: true });
    const res = d.createEpic(plan(), human);
    const [boot, store, cli, acceptance] = res.ticketNumbers;
    expect(testable(d, boot!)).toBe(0);
    expect(testable(d, store!)).toBe(1);
    expect(testable(d, cli!)).toBe(1);
    // The acceptance ticket is always testable (unchanged).
    expect(testable(d, acceptance!)).toBe(1);
    expect(res.testableTickets).toBe(2);
  });

  it("tester lane ON: a plan can opt a ticket out (testable:false)", () => {
    d = Dispatch.open(":memory:", undefined, undefined, { testingEnabled: true });
    const res = d.createEpic(plan({ 2: { testable: false } }), human);
    expect(testable(d, res.ticketNumbers[1]!)).toBe(1);
    expect(testable(d, res.ticketNumbers[2]!)).toBe(0);
    expect(res.testableTickets).toBe(1);
  });

  it("tester lane OFF: nothing is marked unless the plan asks", () => {
    d = Dispatch.open(":memory:", undefined, undefined, { testingEnabled: false });
    const res = d.createEpic(plan(), human);
    expect(testable(d, res.ticketNumbers[1]!)).toBe(0);
    expect(testable(d, res.ticketNumbers[2]!)).toBe(0);
    expect(res.testableTickets).toBe(0);
    const res2 = d.createEpic(plan({ 1: { testable: true } }), human);
    expect(testable(d, res2.ticketNumbers[1]!)).toBe(1);
    expect(res2.testableTickets).toBe(1);
  });

  it("marking is recorded as a ticket.testable_set event, like set-testable", () => {
    d = Dispatch.open(":memory:", undefined, undefined, { testingEnabled: true });
    const res = d.createEpic(plan(), human);
    const id = d.view(String(res.ticketNumbers[1])).ticket.id;
    const row = d.db
      .prepare(
        "SELECT count(*) AS n FROM work_events WHERE entity_id = ? AND event_type = 'ticket.testable_set'",
      )
      .get(id) as { n: number };
    expect(row.n).toBe(1);
  });

  it("POST /epics keeps a ticket's testable answer (the API body does not strip it)", () => {
    const body = createEpicBody.parse(plan({ 1: { testable: false }, 2: { testable: true } }));
    expect(body.tickets[1]!.testable).toBe(false);
    expect(body.tickets[2]!.testable).toBe(true);
  });
});

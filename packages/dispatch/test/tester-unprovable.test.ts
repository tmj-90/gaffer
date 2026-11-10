/**
 * UNPROVABLE (package H3): "this cannot be proven on this host" is a hold for a person,
 * never a FAIL and never a PASS. The dispatch side:
 *
 *  - the runner records the hold as a held tester `ticket.lane_verdict` with the code
 *    `tester_unprovable` and the criteria not proven; the code is a closed list, only on a
 *    held tester verdict, and criteria only with it (an agent records no lane verdict);
 *  - Health's lane verdict counts and `wg stats` count it apart from pass, fail and the
 *    other holds, and `wg stats` lists the in_testing tickets held for it this stay;
 *  - a test contract may declare host capabilities its proof needs (`needs`, a closed list:
 *    browser); an unknown name is refused when the contract is set, only a person declares
 *    or changes the list (never an agent: the agent delivering a ticket must not turn its
 *    own tester PASS into a hold a person waives), leaving it out keeps the list, and the
 *    event that changed it says who and when.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { computeStats, renderStats } from "../src/cli/ops.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { writeEvent } from "../src/events/eventWriter.js";
import { readReviewMeasures } from "../src/health/reviewMeasures.js";
import { makeHandlers } from "../src/mcp/tools.js";
import { readTesterHolds } from "../src/services/testerHolds.js";
import { TestClock } from "../src/util/clock.js";

const human: Actor = { type: "human", id: "tom" };
const system: Actor = { type: "system" };
const agent: Actor = { type: "agent", id: "gaffer-factory" };
const SHA = "a".repeat(40);

function open(): Dispatch {
  process.env.DISPATCH_AUDIT_OFF = "1";
  return Dispatch.open(":memory:", new TestClock());
}

/** A ticket in in_testing the way the log records it (a transition into in_testing). */
function inTesting(wg: Dispatch, title = "Enter submits"): { id: string; number: number } {
  const t = wg.createTicket({ title }, human);
  wg.db.prepare(`UPDATE tickets SET status='in_testing' WHERE id=?`).run(t.id);
  writeEvent(wg.db, {
    entity_type: "ticket",
    entity_id: t.id,
    actor: system,
    event_type: "ticket.transitioned",
    payload: { from: "in_review", to: "in_testing" },
  });
  return { id: t.id, number: t.number as number };
}

describe("the tester_unprovable lane verdict", () => {
  it("records the code and the criteria on a held tester verdict", () => {
    const wg = open();
    const t = inTesting(wg);
    const r = wg.recordLaneVerdict(
      String(t.number),
      {
        lane: "tester",
        verdict: "held",
        commit: SHA,
        held_reason: "criteria 5: no browser",
        held_code: "tester_unprovable",
        criteria: [5, 2, 5],
      },
      system,
    );
    expect(r.verdict.held_code).toBe("tester_unprovable");
    expect(r.verdict.criteria).toEqual([2, 5]);
    wg.db.close();
  });

  it("refuses an unknown code, a code on a pass or another lane, and bad criteria", () => {
    const wg = open();
    const t = inTesting(wg);
    const rec =
      (input: Record<string, unknown>, actor: Actor = system) =>
      () =>
        wg.recordLaneVerdict(String(t.number), input, actor);
    expect(rec({ lane: "tester", verdict: "held", held_code: "pass_anyway" })).toThrow(/held_code/);
    expect(rec({ lane: "tester", verdict: "pass", held_code: "tester_unprovable" })).toThrow(
      /held tester verdict/,
    );
    expect(rec({ lane: "agent-review", verdict: "held", held_code: "tester_unprovable" })).toThrow(
      /held tester verdict/,
    );
    expect(rec({ lane: "tester", verdict: "held", criteria: [1] })).toThrow(/criteria/);
    expect(
      rec({ lane: "tester", verdict: "held", held_code: "tester_unprovable", criteria: [] }),
    ).toThrow(/criteria/);
    expect(
      rec({ lane: "tester", verdict: "held", held_code: "tester_unprovable", criteria: ["5"] }),
    ).toThrow(/criteria/);
    expect(
      rec({ lane: "tester", verdict: "held", held_code: "tester_unprovable", criteria: [0] }),
    ).toThrow(/criteria/);
    // An agent never records a lane verdict, coded or not.
    expect(
      rec(
        { lane: "tester", verdict: "held", held_code: "tester_unprovable", criteria: [1] },
        agent,
      ),
    ).toThrow(/runner/);
    wg.db.close();
  });

  it("is counted apart from pass, fail and the other holds, and listed while in_testing", () => {
    const wg = open();
    const held = inTesting(wg, "held unprovable");
    const other = inTesting(wg, "held other");
    const passed = inTesting(wg, "passed");
    const lv = (n: number, input: Record<string, unknown>) =>
      wg.recordLaneVerdict(String(n), { lane: "tester", ...input }, system);
    lv(held.number, {
      verdict: "held",
      commit: SHA,
      held_reason: "criteria 5: no browser on this host",
      held_code: "tester_unprovable",
      criteria: [5],
    });
    lv(other.number, { verdict: "held", held_reason: "the tester produced no verdict token" });
    lv(passed.number, { verdict: "pass", commit: SHA });
    lv(passed.number, { verdict: "fail", commit: SHA });

    const report = readTesterHolds(wg.db);
    expect(report.counts).toEqual({ pass: 1, fail: 1, unprovable: 1, held: 1 });
    const mine = report.held.find((h) => h.number === held.number);
    expect(mine).toMatchObject({ code: "tester_unprovable", criteria: [5], commit: SHA });
    expect(report.held.find((h) => h.number === other.number)?.code).toBeNull();
    expect(report.held.some((h) => h.number === passed.number)).toBe(false);

    const m = readReviewMeasures(wg.db, { nowMs: Date.now(), ledger: [] });
    expect(m.lane_verdicts.by_lane.tester).toMatchObject({
      unprovable: 1,
      held: 1,
      pass: 1,
      fail: 1,
    });

    const stats = computeStats(wg.db, new Date().toISOString(), {});
    expect(stats.testerHolds?.counts.unprovable).toBe(1);
    const text = renderStats(stats);
    expect(text).toMatch(/1 cannot be proven on this host \(held for a person\) · 1 other holds/);
    expect(text).toMatch(
      new RegExp(`#${held.number} held for a person: criteria 5 cannot be proven`),
    );
    // Every other lane verdict's stored payload is unchanged: no code, no criteria keys.
    const plain = wg.recordLaneVerdict(
      String(other.number),
      { lane: "tester", verdict: "held" },
      system,
    );
    expect(plain.verdict).not.toHaveProperty("held_code");
    expect(plain.verdict).not.toHaveProperty("criteria");
    wg.db.close();
  });

  it("a hold from an earlier testing stay is not listed once the ticket re-entered", () => {
    const wg = open();
    const t = inTesting(wg);
    wg.recordLaneVerdict(
      String(t.number),
      { lane: "tester", verdict: "held", held_code: "tester_unprovable", criteria: [1] },
      system,
    );
    writeEvent(wg.db, {
      entity_type: "ticket",
      entity_id: t.id,
      actor: system,
      event_type: "ticket.transitioned",
      payload: { from: "in_review", to: "in_testing" },
    });
    expect(readTesterHolds(wg.db).held).toEqual([]);
    wg.db.close();
  });
});

describe("declared needs on the test contract", () => {
  it("stores a known capability, refuses an unknown one, and keeps the list when left out", () => {
    const wg = open();
    const t = wg.createTicket({ title: "Enter submits the form" }, human);
    const c = wg.setTestContract(t.id, { run_command: "npm test", needs: ["browser"] }, human);
    expect(c.needs).toEqual(["browser"]);
    expect(() =>
      wg.setTestContract(t.id, { run_command: "npm test", needs: ["gpu"] }, human),
    ).toThrow();
    const kept = wg.setTestContract(t.id, { run_command: "npm run test" }, human);
    expect(kept.needs).toEqual(["browser"]);
    // A person may clear it.
    const cleared = wg.setTestContract(t.id, { run_command: "npm test", needs: [] }, human);
    expect(cleared.needs).toBeUndefined();
    const raw = wg.db.prepare("SELECT test_contract FROM tickets WHERE id = ?").get(t.id) as {
      test_contract: string;
    };
    expect(JSON.parse(raw.test_contract)).not.toHaveProperty("needs");
    wg.db.close();
  });

  it("an agent (the delivery's own, or the runner) never declares, adds or drops a need", () => {
    const wg = open();
    const t = wg.createTicket({ title: "Enter submits the form" }, human);
    // The agent delivering the ticket cannot declare a need on its own contract: it would
    // turn every tester PASS into a hold a person waives.
    expect(() =>
      wg.setTestContract(t.id, { run_command: "npm test", needs: ["browser"] }, agent),
    ).toThrow(/Only a person may declare/);
    expect(() =>
      wg.setTestContract(t.id, { run_command: "npm test", needs: ["browser"] }, system),
    ).toThrow(/Only a person may declare/);
    expect(wg.setTestContract(t.id, { run_command: "npm test" }, agent).needs).toBeUndefined();
    // A person declares it; the agent can neither drop nor change it, but may resend it.
    wg.setTestContract(t.id, { run_command: "npm test", needs: ["browser"] }, human);
    expect(() => wg.setTestContract(t.id, { run_command: "npm test", needs: [] }, agent)).toThrow(
      /Only a person may declare/,
    );
    expect(
      wg.setTestContract(t.id, { run_command: "npm test", needs: ["browser"] }, agent).needs,
    ).toEqual(["browser"]);
    expect(wg.setTestContract(t.id, { run_command: "npm run test" }, agent).needs).toEqual([
      "browser",
    ]);
    // The event that declared it names the person and the time; resends do not.
    const rows = wg.db
      .prepare(
        `SELECT actor_type, actor_id, json_extract(payload_json, '$.needs_declared') AS d
           FROM work_events WHERE entity_id = ? AND event_type = 'ticket.test_contract_set'
          ORDER BY rowid`,
      )
      .all(t.id) as Array<{ actor_type: string; actor_id: string | null; d: number | null }>;
    expect(rows.filter((r) => r.d === 1)).toEqual([{ actor_type: "human", actor_id: "tom", d: 1 }]);
    wg.db.close();
  });

  it("the agent's MCP tool refuses an unknown capability name and any need it declares", () => {
    const wg = open();
    const t = wg.createTicket({ title: "Enter submits the form" }, human);
    const tools = makeHandlers(wg, agent);
    const bad = tools.set_test_contract({ ticket_id: t.id, needs: ["camera"] });
    expect(JSON.stringify(bad)).toMatch(/error|invalid|VALIDATION/i);
    const own = tools.set_test_contract({ ticket_id: t.id, needs: ["browser"] });
    expect(JSON.stringify(own)).toMatch(/ACTOR_NOT_PERMITTED/);
    expect(wg.resolveTicket(t.id).test_contract ?? "").not.toMatch(/browser/);
    wg.db.close();
  });
});

describe("the dashboard ticket page says the ticket is held for a person", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../src/api/web/js/views/ticket.js", import.meta.url)),
    "utf8",
  );
  const start = src.indexOf("function testerUnprovableHold(");
  const end = src.indexOf("\n}\n", start);
  const parseJsonSafe = (s: string | null) => {
    try {
      return JSON.parse(s ?? "");
    } catch {
      return null;
    }
  };
  // The page's own reader, run on the ticket view's events.
  const hold = new Function(
    "parseJsonSafe",
    `${src.slice(start, end + 2)}; return testerUnprovableHold;`,
  )(parseJsonSafe) as (events: unknown[]) => { criteria: number[]; commit: string } | null;
  const ev = (event_type: string, payload: Record<string, unknown>) => ({
    event_type,
    payload_json: JSON.stringify(payload),
  });
  const entered = ev("ticket.transitioned", { from: "in_review", to: "in_testing" });
  const unprov = ev("ticket.lane_verdict", {
    lane: "tester",
    verdict: "held",
    held_code: "tester_unprovable",
    criteria: [5],
    held_reason: "criteria 5: no browser",
    commit: SHA,
  });

  it("reads the runner's hold for this testing stay", () => {
    expect(start).toBeGreaterThan(0);
    expect(hold([entered, unprov])).toMatchObject({ criteria: [5], commit: SHA });
    expect(src).toMatch(/const hold = testerUnprovableHold\(events\);/);
    expect(src).toMatch(/"Held for you\. "/);
  });

  it("not for an earlier stay, a later verdict, or another lane", () => {
    expect(hold([unprov, entered])).toBeNull();
    expect(
      hold([entered, unprov, ev("ticket.lane_verdict", { lane: "tester", verdict: "fail" })]),
    ).toBeNull();
    expect(
      hold([
        entered,
        ev("ticket.lane_verdict", {
          lane: "agent-review",
          verdict: "held",
          held_code: "tester_unprovable",
        }),
      ]),
    ).toBeNull();
  });
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { listEvents } from "../src/events/eventWriter.js";
import { EVAL_JUDGED_EVENT } from "../src/services/evalJudgment.js";
import { TestClock } from "../src/util/clock.js";
import { errorCode, runCli } from "./helpers/cli.js";
import { giveTicketRealDelivery, nonEmptyDiffRunner } from "./helpers/realDiff.js";

/**
 * EVAL JUDGE ON THE TICKET: the judge's verdict is recorded as a system event beside the
 * review outcome, read back by `wg ticket show` (evalJudgment) and the review packet
 * (judge) for the CURRENT delivery only, refused from an agent, and never recorded for a
 * reply that carried no grading. The runner's record shape (json-tool judge-record) is
 * what `wg ticket eval-score` takes.
 */
const human: Actor = { type: "human", id: "tom" };
const agentActor: Actor = { type: "agent", id: "agent-runner" };
const system: Actor = { type: "system" };

/** What runner/lib/json-tool.mjs judge-record writes after a parse. */
const RECORD = {
  overall: "borderline",
  score: 3.4,
  blocking: false,
  judged: true,
  dimensions: [
    { dimension: "ac_coverage", score: 5, rationale: "addTasks exists and appends" },
    { dimension: "correctness", score: 4, rationale: "correct" },
    { dimension: "minimalism", score: 2, rationale: "re-implements addTask as appendTask" },
    { dimension: "test_adequacy", score: 3, rationale: "one happy-path test" },
    { dimension: "security", score: 5, rationale: "nothing risky" },
  ],
  summary: "Works, but duplicates an existing helper.",
  ticketId: "1",
  repo: "svc",
  memoryPresent: true,
  costUsd: "$0.4210",
  judgeModel: "judge-model-x",
};

let now = Date.UTC(2026, 9, 1, 9, 0);
const step = (): void => {
  now += 60_000;
  vi.setSystemTime(now);
};

function readyTicket(wg: Dispatch): string {
  const t = wg.createTicket(
    { title: "addTasks", policy_pack: "solo_loose", risk_level: "low" },
    human,
  );
  wg.addAcceptanceCriterion({ ticket_id: t.id, text: "AC" }, human);
  wg.markReady(t.id, human);
  return t.id;
}
function toReview(wg: Dispatch, id: string, agentId: string, first: boolean): void {
  const claim = wg.claimTicket({ ticket_id: id, agent_id: agentId, ttl_seconds: 300 }, agentActor);
  if (first) giveTicketRealDelivery(wg, id, human, { repoName: `delivery-${id}` });
  wg.recordDeliveryArtifact(
    { claim_token: claim.claimToken, ticket_id: id, branch_name: "feat/x" },
    agentActor,
  );
  wg.submitForReview({ claimToken: claim.claimToken, ticket_id: id }, agentActor);
  step();
}
const NO_COST = () => ({
  cost_usd: 0,
  measured_usd: 0,
  estimated_usd: 0,
  num_turns: 0,
  unknown_calls: 0,
  ledger_status: "ok",
});

describe("eval judge verdict on the ticket", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
  });
  afterEach(() => vi.useRealTimers());

  it("records the runner's record as a system event; show and the packet carry it", () => {
    const wg = Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner, {
      testingEnabled: false,
    });
    const agent = wg.registerAgent({ display_name: "a" }, human);
    const id = readyTicket(wg);
    expect(wg.view(id).evalJudgment).toBeNull();
    toReview(wg, id, agent.id, true);
    const res = wg.recordEvalJudgment(id, RECORD, system);
    expect(res.judgment).toMatchObject({
      overall: "borderline",
      score: 3.4,
      dims: { minimalism: 2, test_adequacy: 3 },
      judge_model: "judge-model-x",
      memory_present: true,
      cost_usd: 0.421,
      attempt: 0,
    });
    expect(res.judgment.rationale.minimalism).toBe("re-implements addTask as appendTask");
    const ev = listEvents(wg.db, "ticket", id).filter((e) => e.event_type === EVAL_JUDGED_EVENT);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.actor_type).toBe("system");

    const shown = wg.view(id).evalJudgment;
    expect(shown).toMatchObject({ overall: "borderline", score: 3.4, recorded_by: "system" });
    const packet = wg.reviewPacket(id, NO_COST);
    expect(packet.judge).toMatchObject({ overall: "borderline", summary: RECORD.summary });
    // Telemetry: recording it moved nothing.
    expect(wg.view(id).ticket.status).toBe("in_review");
  });

  it("a judgment of an earlier attempt is not this delivery's", () => {
    const wg = Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner, {
      testingEnabled: false,
    });
    const agent = wg.registerAgent({ display_name: "a" }, human);
    const id = readyTicket(wg);
    toReview(wg, id, agent.id, true);
    wg.recordEvalJudgment(id, RECORD, system);
    step();
    wg.rejectReview(id, "ready", human, "copied a helper");
    step();
    toReview(wg, id, agent.id, false);
    // The second delivery has not been judged (the judge failed, or is off now).
    expect(wg.view(id).evalJudgment).toBeNull();
    expect(wg.reviewPacket(id, NO_COST).judge).toBeNull();
  });

  it("refuses an agent, a reply with no grading, and a record with no rubric score", () => {
    const wg = Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner);
    const id = readyTicket(wg);
    expect(() => wg.recordEvalJudgment(id, RECORD, agentActor)).toThrow(/Only the runner/);
    expect(() => wg.recordEvalJudgment(id, { ...RECORD, judged: false }, system)).toThrow(
      /no rubric grading/,
    );
    expect(() =>
      wg.recordEvalJudgment(id, { overall: "fail", score: 0, dimensions: [] }, system),
    ).toThrow(/at least one rubric dimension/);
    expect(() => wg.recordEvalJudgment(id, { ...RECORD, overall: "great" }, system)).toThrow(
      /overall must be/,
    );
    expect(listEvents(wg.db, "ticket", id).some((e) => e.event_type === EVAL_JUDGED_EVENT)).toBe(
      false,
    );
  });
});

describe("CLI: wg ticket eval-score and wg judge-agreement", () => {
  let dir: string;
  let db: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wg-eval-judge-"));
    db = join(dir, "d.sqlite");
    const wg = Dispatch.open(db);
    wg.createTicket({ title: "t", policy_pack: "solo_loose", risk_level: "low" }, human);
    wg.db.close();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("eval-score records from --file as system; show prints evalJudgment; --as agent is refused", () => {
    const f = join(dir, "record.json");
    writeFileSync(f, JSON.stringify(RECORD));
    const r = runCli(db, ["ticket", "eval-score", "1", "--file", f]);
    expect(r.error).toBeUndefined();
    expect(r.json).toMatchObject({ ok: true, judgment: { overall: "borderline" } });
    const show = runCli(db, ["ticket", "show", "1"]);
    expect((show.json as { evalJudgment: unknown }).evalJudgment).toMatchObject({
      overall: "borderline",
      score: 3.4,
      rationale: { minimalism: "re-implements addTask as appendTask" },
    });
    const bad = runCli(db, ["ticket", "eval-score", "1", "--file", f, "--as", "agent"]);
    expect(bad.error).toBeDefined();
  });

  it("judge-agreement reports on the factory, and reads a missing ledger as none", () => {
    const f = join(dir, "record.json");
    writeFileSync(f, JSON.stringify(RECORD));
    runCli(db, ["ticket", "eval-score", "1", "--file", f]);
    const r = runCli(db, ["judge-agreement", "--json", "--ledger", join(dir, "absent.jsonl")]);
    expect(r.error).toBeUndefined();
    expect(r.json).toMatchObject({
      judgments: 1,
      pending: 1,
      reading: { status: "insufficient_data" },
    });
    const text = runCli(db, ["judge-agreement"]);
    expect(text.stdout).toContain("judged deliveries: 1 (1 on the ticket, 0 from the ledger only)");
    expect(errorCode(text.error)).toBeUndefined();
  });
});

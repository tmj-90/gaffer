/**
 * AUTONOMY STEP-DOWN, trigger (b), external review 20: a person reopening a delivery a
 * PERSON approved is not evidence against the merge gate.
 *
 * The reviewer, with public Dispatch methods: create a ticket, approve it as a person, land
 * it, mark it done and reopen it for review. Before the reopen its classification was
 * "automatic approval: false, automatic merge: false"; the reopen then recorded a low-risk
 * merge step-down cascading to medium, high and critical, explained as "landed
 * automatically". The reopen was written first, and the approval-history reader then took
 * the reopen's move into in_review as the start of the ticket's current path, found no
 * approval after it, and read the missing approval as automatic.
 *
 * Pinned here: the reopen classifies the history as it stood BEFORE the reopen (in the same
 * transaction). A person's approval that landed steps nothing down; an agent's approval
 * that landed steps down as before; a landed delivery with no approval on record at all
 * still counts as automatic (fail closed: a missing approval is never a person's).
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor, RiskLevel } from "../src/domain/types.js";
import { decidedRisk } from "../src/events/autonomySeal.js";
import { writeEvent } from "../src/events/eventWriter.js";
import { fileGateKeyring } from "../src/events/gateSeal.js";
import { automaticGates } from "../src/services/autonomyStepDownService.js";
import { AUTONOMY_STEPPED_DOWN_EVENT } from "../src/services/autonomyStepDownStore.js";
import type { GitRunner } from "../src/services/diffService.js";
import { systemClock } from "../src/util/clock.js";
import { repoNamed, ticketOn } from "./helpers/autonomyLadder.js";
import { FAKE_HEAD, giveTicketRealDelivery, nonEmptyDiffRunner } from "./helpers/realDiff.js";

const human: Actor = { type: "human", id: "tom" };
const admin: Actor = { type: "admin", id: "ops" };
const system: Actor = { type: "system" };
const agent: Actor = { type: "agent", id: "gaffer-factory" };
const agentRunner: Actor = { type: "agent", id: "agent-runner" };

const FLAGS = ["AUTO_MERGE", "MERGE_ON_AGENT_REVIEW", "DISPATCH_ALLOW_AGENT_APPROVE"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const f of FLAGS) {
    saved[f] = process.env[f];
    delete process.env[f];
  }
});
const roots: string[] = [];
const dbs: Dispatch[] = [];
afterEach(() => {
  for (const wg of dbs.splice(0)) wg.db.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  for (const f of FLAGS) {
    if (saved[f] === undefined) delete process.env[f];
    else process.env[f] = saved[f];
  }
});

let onDefault = false;
const runner: GitRunner = (cwd, args, opts) => {
  if (args[0] === "merge-base" && args[1] === "--is-ancestor")
    return { status: onDefault ? 0 : 1, stdout: "", stderr: "" };
  return nonEmptyDiffRunner(cwd, args, opts);
};

/** A factory on disk with its gate keyring (signed approvals, signed risk). */
function freshWg(): Dispatch {
  onDefault = false;
  const root = mkdtempSync(join(tmpdir(), "r20-reopen-"));
  roots.push(root);
  const data = join(root, "data");
  mkdirSync(data, { recursive: true });
  const dbPath = join(data, "dispatch.sqlite");
  const wg = Dispatch.open(dbPath, systemClock, runner, {
    gateKeyring: fileGateKeyring({ dbPath, keysDir: join(root, "keys") }),
  });
  dbs.push(wg);
  return wg;
}

/** A real delivery in review on repoA at `risk`. */
function delivered(wg: Dispatch, risk: RiskLevel) {
  const t = wg.createTicket(
    { title: "Ship", description: "x", policy_pack: "team_light", risk_level: risk },
    human,
  );
  const { ac } = wg.addAcceptanceCriterion({ ticket_id: t.id, text: "ok" }, human);
  const { repoId } = giveTicketRealDelivery(wg, t.id, human, { repoName: "repoA" });
  wg.markReady(t.id, human);
  const a = wg.registerAgent({ display_name: "a", max_risk: "critical" }, human);
  const claim = wg.claimNextTicket({ agentId: a.id, ttlSeconds: 600 }, agentRunner);
  wg.recordEvidence(
    {
      claimToken: claim!.claimToken,
      ticket_id: t.id,
      ac_id: ac.id,
      evidence_type: "test_output",
      summary: "passed",
    },
    agentRunner,
  );
  wg.submitForReview({ claimToken: claim!.claimToken, ticket_id: t.id, reason: "d" }, agentRunner);
  return { id: t.id, number: wg.resolveTicket(t.id).number ?? 0, repoId };
}

/** The commit the approver was shown (as REST and the CLI pin it). */
const shown = { commits: [{ repo: "repoA", sha: FAKE_HEAD }] };

function enable(wg: Dispatch, repoId: string, risk: RiskLevel, gate: "approve" | "merge") {
  wg.setAutonomyPolicy({ repoId, riskLevel: risk, gate, mode: "auto", confirm: true }, human);
}

/** Land the approved delivery and mark it done, as the merge lane does. */
function land(wg: Dispatch, id: string) {
  const approval = wg.landingApproval(id)!;
  wg.beginLanding(id, { repo: "repoA", commit: FAKE_HEAD, approval, via: "local" }, system);
  onDefault = true;
  wg.recordLanding(id, { repo: "repoA", commit: FAKE_HEAD, via: "local" }, system);
  expect(wg.markMerged(id, system).ticket.status).toBe("done");
}

function stepDowns(wg: Dispatch) {
  return (
    wg.db
      .prepare(`SELECT payload_json FROM work_events WHERE event_type = ? ORDER BY rowid`)
      .all(AUTONOMY_STEPPED_DOWN_EVENT) as Array<{ payload_json: string }>
  ).map(
    (r) =>
      JSON.parse(r.payload_json) as {
        risk_level: string;
        gate: string;
        trigger: string;
        why: string;
      },
  );
}

describe("a person reopens a delivery a person approved", () => {
  it("records no step-down at any risk level, and the classification does not change", () => {
    const wg = freshWg();
    const { id } = delivered(wg, "low");
    // The fixture's low risk is legitimately signed: a step-down would land on low only.
    expect(decidedRisk(wg.db, wg.gateKeyring, wg.resolveTicket(id))).toMatchObject({
      level: "low",
      signed: true,
    });
    expect(wg.approveReview(id, human, shown).ticket.status).toBe("ready_for_merge");
    land(wg, id);
    expect(automaticGates(wg.db, id)).toEqual({ approve: false, merge: false });

    const r = wg.reopenForReview(
      id,
      { reason: "not what we wanted", resolution: "redo the export", cause: "other" },
      admin,
    );
    expect(r.status).toBe("in_review");
    expect({ returned: r.stepped_down, recorded: stepDowns(wg) }).toEqual({
      returned: [],
      recorded: [],
    });
    // Read after the reopen, the landed delivery is still a person's.
    expect(automaticGates(wg.db, id)).toEqual({ approve: false, merge: false });
  });
});

describe("a person reopens a delivery an agent approved", () => {
  it("steps approve and merge down at its risk, cascades merge, and says what happened", () => {
    const wg = freshWg();
    const { id, number, repoId } = delivered(wg, "low");
    enable(wg, repoId, "low", "approve");
    enable(wg, repoId, "low", "merge");
    expect(wg.approveReview(id, agent, shown).ticket.status).toBe("ready_for_merge");
    land(wg, id);
    expect(automaticGates(wg.db, id)).toEqual({ approve: true, merge: true });

    const r = wg.reopenForReview(
      id,
      { reason: "not what we wanted", resolution: "redo", cause: "other" },
      admin,
    );
    expect(r.stepped_down.map((s) => `${s.riskLevel}/${s.gate}/${s.trigger}`)).toEqual([
      "low/approve/reopened",
      "low/merge/reopened",
      "medium/merge/cascade",
      "high/merge/cascade",
      "critical/merge/cascade",
    ]);
    expect(stepDowns(wg)[0]!.why).toBe(
      `#${number} was reopened for review by admin:ops after it was approved and landed automatically (low risk).`,
    );
  });
});

describe("a landed delivery with no approval on record", () => {
  it("still counts as automatic on a reopen (a missing approval is never a person's)", () => {
    const wg = Dispatch.open(":memory:");
    dbs.push(wg);
    repoNamed(wg, "api");
    const t = ticketOn(wg, "api", "medium");
    // Into ready_for_merge by a system actor with no review approval on the path.
    writeEvent(wg.db, {
      entity_type: "ticket",
      entity_id: t.id,
      actor: system,
      event_type: "ticket.transitioned",
      payload: { from: "in_review", to: "ready_for_merge", reason: "imported" },
    });
    wg.db.prepare(`UPDATE tickets SET status='done' WHERE id=?`).run(t.id);
    writeEvent(wg.db, {
      entity_type: "ticket",
      entity_id: t.id,
      actor: system,
      event_type: "ticket.transitioned",
      payload: { from: "ready_for_merge", to: "done", reason: "merge_completed" },
    });
    expect(automaticGates(wg.db, t.id)).toEqual({ approve: false, merge: true });
    const r = wg.reopenForReview(t.id, { reason: "x", resolution: "y" }, admin);
    expect(r.stepped_down.map((s) => `${s.riskLevel}/${s.gate}`)).toEqual([
      "medium/merge",
      "high/merge",
      "critical/merge",
    ]);
  });
});

// Independent review: mixed histories, read from the history before each reopen.
describe("mixed histories (independent review)", () => {
  it("agent approves, sent back before landing, a person approves and it lands: no step-down", () => {
    const wg = freshWg();
    const { id, repoId } = delivered(wg, "low");
    enable(wg, repoId, "low", "approve");
    enable(wg, repoId, "low", "merge");
    expect(wg.approveReview(id, agent, shown).ticket.status).toBe("ready_for_merge");
    // Sent back by a person before landing: not a verdict on a landed change.
    const back = wg.reopenForReview(id, { reason: "look again", resolution: "re-review" }, admin);
    expect(back.stepped_down).toEqual([]);
    expect(wg.approveReview(id, human, shown).ticket.status).toBe("ready_for_merge");
    land(wg, id);
    const r = wg.reopenForReview(id, { reason: "x", resolution: "y" }, admin);
    expect({ returned: r.stepped_down, recorded: stepDowns(wg) }).toEqual({
      returned: [],
      recorded: [],
    });
  });

  it("a second reopen is classified from the delivery that landed last", () => {
    const wg = freshWg();
    const { id, repoId } = delivered(wg, "low");
    enable(wg, repoId, "low", "approve");
    enable(wg, repoId, "low", "merge");
    // First delivery: an agent's, landed, reopened by a person: steps down.
    expect(wg.approveReview(id, agent, shown).ticket.status).toBe("ready_for_merge");
    land(wg, id);
    onDefault = false;
    const first = wg.reopenForReview(id, { reason: "x", resolution: "y" }, admin);
    expect(first.stepped_down.length).toBeGreaterThan(0);
    const recorded = stepDowns(wg).length;
    // The redo: a person's approval, landed, reopened again: nothing new.
    expect(wg.approveReview(id, human, shown).ticket.status).toBe("ready_for_merge");
    land(wg, id);
    const second = wg.reopenForReview(id, { reason: "x", resolution: "y" }, admin);
    expect(second.stepped_down).toEqual([]);
    expect(stepDowns(wg).length).toBe(recorded);
  });

  it("a person's first delivery, an agent's redo landed: the second reopen steps down", () => {
    const wg = freshWg();
    const { id, repoId } = delivered(wg, "low");
    expect(wg.approveReview(id, human, shown).ticket.status).toBe("ready_for_merge");
    land(wg, id);
    onDefault = false;
    expect(wg.reopenForReview(id, { reason: "x", resolution: "y" }, admin).stepped_down).toEqual(
      [],
    );
    enable(wg, repoId, "low", "approve");
    enable(wg, repoId, "low", "merge");
    expect(wg.approveReview(id, agent, shown).ticket.status).toBe("ready_for_merge");
    land(wg, id);
    const r = wg.reopenForReview(id, { reason: "x", resolution: "y" }, admin);
    expect(r.stepped_down.map((s) => `${s.riskLevel}/${s.gate}`)).toContain("low/merge");
    expect(r.stepped_down.map((s) => `${s.riskLevel}/${s.gate}`)).toContain("low/approve");
  });
});

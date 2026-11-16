/**
 * SEALED AUTONOMY (S5 part B): a process that can write the sqlite file must not be able to
 * grant itself automatic approval or merge.
 *
 *  - a policy row forged, edited, or carrying another row's seal grants nothing, at every
 *    decision (the gate decision the runner asks, an agent's approve, the ladder);
 *  - a ticket whose risk was lowered by direct SQL is decided as the highest risk; a
 *    ticket created by a keyless process is unsigned until its first claim by the host,
 *    and a later claim never re-signs a changed value;
 *  - a forged lift lifts nothing, and a deleted step-down does not lift.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor, RiskLevel } from "../src/domain/types.js";
import { writeEvent } from "../src/events/eventWriter.js";
import { fileGateKeyring, refusingGateKeyring } from "../src/events/gateSeal.js";
import {
  AUTONOMY_STEP_DOWN_LIFTED_EVENT,
  AUTONOMY_STEPPED_DOWN_EVENT,
} from "../src/services/autonomyStepDownStore.js";
import { systemClock } from "../src/util/clock.js";
import { landedChange, repoNamed, ticketOn } from "./helpers/autonomyLadder.js";
import { giveTicketRealDelivery, nonEmptyDiffRunner } from "./helpers/realDiff.js";

const human: Actor = { type: "human", id: "tom" };
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
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  for (const f of FLAGS) {
    if (saved[f] === undefined) delete process.env[f];
    else process.env[f] = saved[f];
  }
});

interface World {
  wg: Dispatch;
  dbPath: string;
  keysDir: string;
}

/** A factory on disk with its own factory key (the host's keyring). */
function world(): World {
  const root = mkdtempSync(join(tmpdir(), "s5b-seal-"));
  roots.push(root);
  const data = join(root, "data");
  mkdirSync(data, { recursive: true });
  const dbPath = join(data, "dispatch.sqlite");
  const keysDir = join(root, "keys");
  // `gaffer setup` creates the factory key; the host's next write anchors the log.
  fileGateKeyring({ dbPath, keysDir }).ensure();
  const wg = Dispatch.open(
    dbPath,
    systemClock,
    (cwd, args, o) => {
      if (args[0] === "merge-base" && args[1] === "--is-ancestor")
        return { status: 1, stdout: "", stderr: "" };
      return nonEmptyDiffRunner(cwd, args, o);
    },
    { gateKeyring: fileGateKeyring({ dbPath, keysDir }) },
  );
  return { wg, dbPath, keysDir };
}

/** A second process on the same file that holds no key (the agent-facing MCP server). */
function keyless(w: World): Dispatch {
  return Dispatch.open(w.dbPath, systemClock, undefined, {
    gateKeyring: refusingGateKeyring("the dispatch MCP server"),
  });
}

function enable(wg: Dispatch, repoId: string, risk: RiskLevel, gate: "approve" | "merge") {
  return wg.setAutonomyPolicy(
    { repoId, riskLevel: risk, gate, mode: "auto", confirm: true },
    human,
  );
}

function decide(wg: Dispatch, ticketId: string, gate: "approve" | "merge") {
  return wg.autonomyGateDecision(wg.resolveTicket(ticketId), gate);
}

function refusal(fn: () => unknown): { code?: string; reason?: string; message?: string } {
  try {
    fn();
  } catch (err) {
    const e = err as { code?: string; details?: { reason?: string }; message?: string };
    return { code: e.code, reason: e.details?.reason, message: e.message };
  }
  throw new Error("expected a refusal, but the call succeeded");
}

/** A real delivery in review on repoA at `risk` (claimed by the host, so its risk is sealed). */
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
  return { id: t.id, repoId };
}

function sealRow(wg: Dispatch, kind: string, rowId: string) {
  return wg.db.prepare("SELECT * FROM row_seals WHERE kind = ? AND row_id = ?").get(kind, rowId) as
    Record<string, unknown> | undefined;
}

describe("policy rows: honoured only with a valid seal", () => {
  it("a signed row grants; setAutonomyPolicy writes the lifecycle events", () => {
    const { wg } = world();
    try {
      const api = repoNamed(wg, "api");
      const t = ticketOn(wg, "api", "low");
      const row = enable(wg, api, "low", "merge");
      expect(decide(wg, t.id, "merge").decision).toBe("allow");
      expect(sealRow(wg, "autonomy_policy", row.id)).toBeDefined();
      wg.setAutonomyPolicy(
        { repoId: api, riskLevel: "low", gate: "merge", mode: "recommend", confirm: true },
        human,
      );
      wg.setAutonomyPolicy({ repoId: api, riskLevel: "low", gate: "merge", mode: "off" }, human);
      expect(sealRow(wg, "autonomy_policy", row.id)).toBeUndefined();
      const types = (
        wg.db
          .prepare(
            "SELECT event_type FROM work_events WHERE entity_type = 'autonomy_policy' AND entity_id = ? ORDER BY rowid",
          )
          .all(row.id) as Array<{ event_type: string }>
      ).map((r) => r.event_type);
      expect(types).toEqual([
        "autonomy_policy.enabled",
        "autonomy_policy.changed",
        "autonomy_policy.disabled",
      ]);
      expect(decide(wg, t.id, "merge").decision).toBe("deny");
    } finally {
      wg.db.close();
    }
  });

  it("a row inserted by direct SQL grants nothing, says so, and holds an agent's approve", () => {
    const { wg } = world();
    try {
      const { id, repoId } = delivered(wg, "low");
      for (const gate of ["approve", "merge"]) {
        wg.db
          .prepare(
            "INSERT INTO autonomy_policy (id, repo_id, risk_level, gate, mode, enabled_by, enabled_at, created_at, updated_at) VALUES (?, ?, 'low', ?, 'auto', 'tom', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
          )
          .run(`forged-${gate}`, repoId, gate);
      }
      expect(decide(wg, id, "approve").decision).toBe("deny");
      expect(decide(wg, id, "merge").decision).toBe("deny");
      expect(wg.autonomyPolicy.get(repoId, "low", "merge")).toBeUndefined();
      expect(wg.autonomyPolicy.getStored(repoId, "low", "merge")?.mode).toBe("auto");
      expect(refusal(() => wg.approveReview(id, agent))).toMatchObject({
        code: "ACTOR_NOT_PERMITTED",
      });
      expect(wg.resolveTicket(id).status).toBe("in_review");
      const listed = wg.listAutonomyPolicies().filter((p) => p.repo_id === repoId);
      expect(listed.every((p) => p.signed === false)).toBe(true);
      const cell = wg.autonomyLadder(null, "repoA").repos[0]!.rows[0]!.gates.merge;
      expect(cell.rung).toBe("person");
      expect(cell.policy_signed).toBe(false);
      expect(cell.distance.text).toMatch(/^Not signed: a person decides/);
      expect(wg.autonomySealSummary().policies).toEqual({ unsigned: 2, auto: 2 });
      // A person who signs it (sealed through the service) turns it on.
      enable(wg, repoId, "low", "approve");
      expect(wg.approveReview(id, agent).ticket.status).toBe("ready_for_merge");
    } finally {
      wg.db.close();
    }
  });

  it("an edited row (risk moved, mode raised) grants nothing", () => {
    const { wg } = world();
    try {
      const api = repoNamed(wg, "api");
      const low = ticketOn(wg, "api", "low");
      const high = ticketOn(wg, "api", "high");
      const row = enable(wg, api, "low", "merge");
      wg.db.prepare("UPDATE autonomy_policy SET risk_level = 'high' WHERE id = ?").run(row.id);
      expect(decide(wg, high.id, "merge").decision).toBe("deny");
      expect(decide(wg, low.id, "merge").decision).toBe("deny");
      expect(wg.listAutonomyPolicies()[0]!.seal_problem).toMatch(/changed after it was signed/);
      const rec = wg.setAutonomyPolicy(
        { repoId: api, riskLevel: "low", gate: "approve", mode: "recommend", confirm: true },
        human,
      );
      wg.db.prepare("UPDATE autonomy_policy SET mode = 'auto' WHERE id = ?").run(rec.id);
      expect(decide(wg, low.id, "approve").decision).toBe("deny");
    } finally {
      wg.db.close();
    }
  });

  it("another row's seal copied onto a forged row, or an old seal restored after it was turned off, grants nothing", () => {
    const { wg } = world();
    try {
      const api = repoNamed(wg, "api");
      const t = ticketOn(wg, "api", "low");
      const a = enable(wg, api, "low", "approve");
      wg.db
        .prepare(
          "INSERT INTO autonomy_policy (id, repo_id, risk_level, gate, mode, enabled_by, enabled_at, created_at, updated_at) SELECT 'copy', repo_id, risk_level, 'merge', mode, enabled_by, enabled_at, created_at, updated_at FROM autonomy_policy WHERE id = ?",
        )
        .run(a.id);
      wg.db
        .prepare(
          "INSERT INTO row_seals (kind, row_id, event_id, facts_json, key_id, mac, created_at) SELECT kind, 'copy', event_id, facts_json, key_id, mac, created_at FROM row_seals WHERE kind = 'autonomy_policy' AND row_id = ?",
        )
        .run(a.id);
      expect(decide(wg, t.id, "approve").decision).toBe("allow");
      expect(decide(wg, t.id, "merge").decision).toBe("deny");
      // Restored after a person turned it off: the disable event supersedes the old seal.
      const old = sealRow(wg, "autonomy_policy", a.id)!;
      wg.setAutonomyPolicy({ repoId: api, riskLevel: "low", gate: "approve", mode: "off" }, human);
      wg.db
        .prepare(
          "UPDATE autonomy_policy SET mode = 'auto', enabled_by = ?, enabled_at = ? WHERE id = ?",
        )
        .run(a.enabled_by, a.enabled_at, a.id);
      wg.db
        .prepare(
          "INSERT INTO row_seals (kind, row_id, event_id, facts_json, key_id, mac, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          old.kind,
          old.row_id,
          old.event_id,
          old.facts_json,
          old.key_id,
          old.mac,
          old.created_at,
        );
      expect(decide(wg, t.id, "approve").decision).toBe("deny");
      expect(wg.listAutonomyPolicies().find((p) => p.id === a.id)?.seal_problem).toMatch(
        /autonomy_policy.disabled undoes/,
      );
    } finally {
      wg.db.close();
    }
  });
});

describe("ticket risk: read only through a verified seal", () => {
  it("a key holder seals at creation; a risk lowered by direct SQL is decided as the highest", () => {
    const { wg } = world();
    try {
      const api = repoNamed(wg, "api");
      enable(wg, api, "low", "approve");
      enable(wg, api, "low", "merge");
      const t = ticketOn(wg, "api", "high");
      const ev = wg.db
        .prepare(
          "SELECT payload_json FROM work_events WHERE entity_id = ? AND event_type = 'ticket.risk_set'",
        )
        .get(t.id) as { payload_json: string };
      expect(JSON.parse(ev.payload_json)).toMatchObject({ risk_level: "high", source: "created" });
      expect(wg.autonomyRisk(wg.resolveTicket(t.id))).toMatchObject({
        level: "high",
        signed: true,
      });
      expect(decide(wg, t.id, "merge").decision).toBe("deny");
      wg.db.prepare("UPDATE tickets SET risk_level = 'low' WHERE id = ?").run(t.id);
      expect(wg.autonomyRisk(wg.resolveTicket(t.id))).toMatchObject({
        level: "critical",
        stored: "low",
        signed: false,
      });
      for (const gate of ["approve", "merge"] as const) {
        expect(decide(wg, t.id, gate)).toMatchObject({
          decision: "deny",
          risk_level: "critical",
          stored_risk_level: "low",
          risk_signed: false,
          held: { kind: "risk_unsigned" },
        });
      }
      // Even the mode's env floor does not reach it (the ceiling holds for a person).
      process.env.AUTO_MERGE = "1";
      process.env.MERGE_ON_AGENT_REVIEW = "1";
      expect(decide(wg, t.id, "merge").decision).toBe("deny");
      expect(wg.reviewUnsignedTicketRisks().unsigned.map((u) => u.id)).toEqual([t.id]);
    } finally {
      wg.db.close();
    }
  });

  it("an agent's approve on a delivery whose risk was lowered is held for a person", () => {
    const { wg } = world();
    try {
      const { id, repoId } = delivered(wg, "high");
      enable(wg, repoId, "low", "approve");
      wg.db.prepare("UPDATE tickets SET risk_level = 'low' WHERE id = ?").run(id);
      expect(refusal(() => wg.approveReview(id, agent))).toMatchObject({
        code: "ACTOR_NOT_PERMITTED",
        reason: "autonomy_risk_unsigned",
      });
    } finally {
      wg.db.close();
    }
  });

  it("a keyless creation is unsigned until the host's first claim, which seals it", () => {
    const w = world();
    const mcp = keyless(w);
    try {
      const t = mcp.createTicket({ title: "From MCP", description: "x", risk_level: "low" }, agent);
      expect(sealRow(w.wg, "ticket_risk", t.id)).toBeUndefined();
      expect(w.wg.autonomyRisk(w.wg.resolveTicket(t.id)).signed).toBe(false);
      expect(w.wg.reviewUnsignedTicketRisks().unsigned[0]).toMatchObject({
        id: t.id,
        sealed_at_claim: true,
      });
      w.wg.addAcceptanceCriterion({ ticket_id: t.id, text: "ok" }, human);
      w.wg.markReady(t.id, human);
      const a = w.wg.registerAgent({ display_name: "a", max_risk: "critical" }, human);
      expect(w.wg.claimNextTicket({ agentId: a.id, ttlSeconds: 600 }, agentRunner)).not.toBeNull();
      expect(w.wg.autonomyRisk(w.wg.resolveTicket(t.id))).toMatchObject({
        level: "low",
        signed: true,
      });
      const ev = w.wg.db
        .prepare(
          "SELECT payload_json FROM work_events WHERE entity_id = ? AND event_type = 'ticket.risk_set'",
        )
        .get(t.id) as { payload_json: string };
      expect(JSON.parse(ev.payload_json)).toMatchObject({ risk_level: "low", source: "claim" });
    } finally {
      mcp.db.close();
      w.wg.db.close();
    }
  });

  it("a process with only a process-local key (crew's idle loops) on the file leaves the risk to the first claim", () => {
    const w = world();
    const lib = Dispatch.open(w.dbPath); // the library default: a key only that process holds
    try {
      const t = lib.createTicket({ title: "From an idle loop", description: "x" }, agent);
      const events = w.wg.db
        .prepare(
          "SELECT count(*) AS n FROM work_events WHERE entity_id = ? AND event_type = 'ticket.risk_set'",
        )
        .get(t.id) as { n: number };
      expect(events.n).toBe(0);
      w.wg.addAcceptanceCriterion({ ticket_id: t.id, text: "ok" }, human);
      w.wg.markReady(t.id, human);
      const a = w.wg.registerAgent({ display_name: "a", max_risk: "critical" }, human);
      w.wg.claimNextTicket({ agentId: a.id, ttlSeconds: 600 }, agentRunner);
      expect(w.wg.autonomyRisk(w.wg.resolveTicket(t.id)).signed).toBe(true);
    } finally {
      lib.db.close();
      w.wg.db.close();
    }
  });

  it("a later claim never re-signs: a keyless first claim, or a value changed after the seal", () => {
    const w = world();
    const mcp = keyless(w);
    try {
      const mk = (title: string) => {
        const t = mcp.createTicket({ title, description: "x", risk_level: "high" }, agent);
        w.wg.addAcceptanceCriterion({ ticket_id: t.id, text: "ok" }, human);
        w.wg.markReady(t.id, human);
        return t.id;
      };
      const a = mcp.registerAgent({ display_name: "a", max_risk: "critical" }, human);
      // (1) The first claim is made by the keyless process: nothing is sealed. A writer
      // lowers the risk and the host claims it again: a second claim never seals.
      const one = mk("one");
      const c1 = mcp.claimNextTicket({ agentId: a.id, ttlSeconds: 600 }, agentRunner)!;
      expect(c1.ticketId).toBe(one);
      expect(sealRow(w.wg, "ticket_risk", one)).toBeUndefined();
      mcp.releaseClaim(c1.claimToken, agentRunner);
      w.wg.db.prepare("UPDATE tickets SET risk_level = 'low' WHERE id = ?").run(one);
      const c2 = w.wg.claimNextTicket({ agentId: a.id, ttlSeconds: 600 }, agentRunner)!;
      expect(c2.ticketId).toBe(one);
      expect(sealRow(w.wg, "ticket_risk", one)).toBeUndefined();
      expect(w.wg.autonomyRisk(w.wg.resolveTicket(one)).level).toBe("critical");
      // (2) Sealed at the host's first claim; then lowered; claimed again: still unsigned.
      w.wg.releaseClaim(c2.claimToken, agentRunner);
      w.wg.db.prepare("UPDATE tickets SET status = 'done' WHERE id = ?").run(one);
      const two = mk("two");
      const c3 = w.wg.claimNextTicket({ agentId: a.id, ttlSeconds: 600 }, agentRunner)!;
      expect(c3.ticketId).toBe(two);
      expect(w.wg.autonomyRisk(w.wg.resolveTicket(two))).toMatchObject({ signed: true });
      w.wg.releaseClaim(c3.claimToken, agentRunner);
      w.wg.db.prepare("UPDATE tickets SET risk_level = 'low' WHERE id = ?").run(two);
      w.wg.db.prepare("DELETE FROM row_seals WHERE kind = 'ticket_risk' AND row_id = ?").run(two);
      w.wg.claimNextTicket({ agentId: a.id, ttlSeconds: 600 }, agentRunner);
      expect(sealRow(w.wg, "ticket_risk", two)).toBeUndefined();
      expect(w.wg.autonomyRisk(w.wg.resolveTicket(two))).toMatchObject({
        level: "critical",
        signed: false,
      });
    } finally {
      mcp.db.close();
      w.wg.db.close();
    }
  });
});

describe("step-down lifts: a person's sealed act", () => {
  function stepDown(wg: Dispatch, repoId: string, risk: RiskLevel, gate: "approve" | "merge") {
    return writeEvent(wg.db, {
      entity_type: "repository",
      entity_id: repoId,
      actor: human,
      event_type: AUTONOMY_STEPPED_DOWN_EVENT,
      payload: {
        risk_level: risk,
        gate,
        trigger: "regression",
        why: "a regression",
        tickets: [],
        cascade_from: null,
      },
    });
  }
  function forgedLift(wg: Dispatch, repoId: string, risk: RiskLevel, gate: "approve" | "merge") {
    return writeEvent(wg.db, {
      entity_type: "repository",
      entity_id: repoId,
      actor: human,
      event_type: AUTONOMY_STEP_DOWN_LIFTED_EVENT,
      payload: { risk_level: risk, gate, how: "override", reason: "forged", evidence: {} },
    });
  }

  it("a forged lift event lifts nothing; a person's lift does; its seal does not carry to another lift", () => {
    const { wg } = world();
    try {
      const api = repoNamed(wg, "api");
      const t = ticketOn(wg, "api", "low");
      enable(wg, api, "low", "merge");
      enable(wg, api, "low", "approve");
      stepDown(wg, api, "low", "merge");
      stepDown(wg, api, "low", "approve");
      forgedLift(wg, api, "low", "merge");
      expect(wg.autonomyPolicy.stepDownInForce(api, "low", "merge")).toBe(true);
      expect(decide(wg, t.id, "merge")).toMatchObject({
        decision: "deny",
        held: { kind: "stepped_down" },
      });
      const cell = wg.autonomyLadder(null, "api").repos[0]!.rows[0]!.gates.merge;
      expect(cell.step_down).not.toBeNull();
      const real = wg.liftAutonomyStepDown(
        { repo: "api", riskLevel: "low", gate: "merge", how: "override", reason: "a person" },
        human,
        {},
      );
      expect(wg.autonomyPolicy.stepDownInForce(api, "low", "merge")).toBe(false);
      expect(decide(wg, t.id, "merge").decision).toBe("allow");
      // The genuine lift's seal copied onto a forged lift of the approve row: ignored.
      const fake = forgedLift(wg, api, "low", "approve");
      wg.db
        .prepare(
          "INSERT INTO row_seals (kind, row_id, event_id, facts_json, key_id, mac, created_at) SELECT kind, ?, event_id, facts_json, key_id, mac, created_at FROM row_seals WHERE kind = 'autonomy_lift' AND row_id = ?",
        )
        .run(fake, real.eventId);
      expect(wg.autonomyPolicy.stepDownInForce(api, "low", "approve")).toBe(true);
    } finally {
      wg.db.close();
    }
  });

  it("a step-down deleted from the log does not lift (the chain or the anchor catches it)", () => {
    const { wg } = world();
    try {
      const api = repoNamed(wg, "api");
      const t = ticketOn(wg, "api", "low");
      enable(wg, api, "low", "merge");
      expect(wg.autonomyPolicy.stepDownInForce(api, "low", "merge")).toBe(false);
      const sd = stepDown(wg, api, "low", "merge");
      ticketOn(wg, "api", "low", "later work"); // the log moves on past the step-down
      expect(wg.autonomyPolicy.stepDownInForce(api, "low", "merge")).toBe(true);
      wg.db.prepare("DELETE FROM work_events WHERE id = ?").run(sd);
      expect(wg.autonomyPolicy.stepDownInForce(api, "low", "merge")).toBe(true);
      expect(decide(wg, t.id, "merge").decision).toBe("deny");
      // A fresh process (no memory of the log) refuses as well.
      const again = Dispatch.open(wg.db.name, systemClock, undefined, {
        gateKeyring: wg.gateKeyring,
      });
      try {
        expect(again.autonomyPolicy.stepDownInForce(api, "low", "merge")).toBe(true);
      } finally {
        again.db.close();
      }
    } finally {
      wg.db.close();
    }
  });
});

describe("step-downs land on the signed risk, not the stored column", () => {
  function steppedRows(wg: Dispatch, repoId: string): string[] {
    return (
      wg.db
        .prepare(
          "SELECT payload_json FROM work_events WHERE entity_type = 'repository' AND entity_id = ? AND event_type = ? ORDER BY rowid",
        )
        .all(repoId, AUTONOMY_STEPPED_DOWN_EVENT) as Array<{ payload_json: string }>
    ).map((r) => {
      const p = JSON.parse(r.payload_json) as { risk_level: string; gate: string };
      return `${p.risk_level}/${p.gate}`;
    });
  }

  it("a regression of a change whose stored risk was raised after it landed still steps its own row down", () => {
    for (const raised of ["high", "critical"] as const) {
      const { wg } = world();
      try {
        const api = repoNamed(wg, "api");
        enable(wg, api, "low", "approve");
        enable(wg, api, "low", "merge");
        const landed = landedChange(wg, "api", "low");
        // A database writer moves the landed change out of the low row.
        wg.db.prepare("UPDATE tickets SET risk_level = ? WHERE id = ?").run(raised, landed.id);
        const defect = ticketOn(wg, "api", "medium", "It broke");
        const res = wg.fileRegression(String(defect.number), String(landed.number), human);
        const rows = res.stepped_down.map((r) => `${r.riskLevel}/${r.gate}`);
        expect(rows).toEqual(expect.arrayContaining(["low/approve", "low/merge"]));
        expect(steppedRows(wg, api)).toEqual(expect.arrayContaining(["low/approve", "low/merge"]));
        const next = ticketOn(wg, "api", "low", "Next");
        expect(decide(wg, next.id, "approve").decision).toBe("deny");
        expect(decide(wg, next.id, "merge").decision).toBe("deny");
      } finally {
        wg.db.close();
      }
    }
  });

  it("a signed risk steps down exactly its own row, as before", () => {
    const { wg } = world();
    try {
      const api = repoNamed(wg, "api");
      enable(wg, api, "low", "approve");
      const landed = landedChange(wg, "api", "low");
      const defect = ticketOn(wg, "api", "medium", "It broke");
      const res = wg.fileRegression(String(defect.number), String(landed.number), human);
      expect(res.stepped_down.map((r) => `${r.riskLevel}/${r.gate}`).sort()).toEqual([
        "critical/merge",
        "high/merge",
        "low/approve",
        "low/merge",
        "medium/merge",
      ]);
    } finally {
      wg.db.close();
    }
  });

  it("tester failures counted toward a row cannot be moved out of it by editing the stored risk", () => {
    const { wg } = world();
    try {
      const api = repoNamed(wg, "api");
      enable(wg, api, "low", "approve");
      const strike = (title: string) => {
        const t = ticketOn(wg, "api", "low", title);
        writeEvent(wg.db, {
          entity_type: "ticket",
          entity_id: t.id,
          actor: agent,
          event_type: "ticket.transitioned",
          payload: { from: "in_review", to: "in_testing", reason: "review_approved_to_testing" },
        });
        wg.db.prepare("UPDATE tickets SET status = 'in_testing' WHERE id = ?").run(t.id);
        return t;
      };
      const unprovable = (id: string) =>
        wg.recordLaneVerdict(
          id,
          { lane: "tester", verdict: "held", held_code: "tester_unprovable", held_reason: "x" },
          { type: "system" },
        );
      const a = strike("A");
      unprovable(a.id);
      // The writer moves the first strike's ticket out of the low row before the second.
      wg.db.prepare("UPDATE tickets SET risk_level = 'high' WHERE id = ?").run(a.id);
      const b = strike("B");
      unprovable(b.id);
      expect(steppedRows(wg, api)).toContain("low/approve");
      const next = ticketOn(wg, "api", "low", "Next");
      expect(decide(wg, next.id, "approve").decision).toBe("deny");
    } finally {
      wg.db.close();
    }
  });
});

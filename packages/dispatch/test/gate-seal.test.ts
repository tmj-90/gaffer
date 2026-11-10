// SIGNED GATE EVENTS (package H2): approvals and tester verdicts are sealed with the
// factory key, and nothing lands on an unsigned one.
//
// The attacks every test below makes are the ones main used to accept: a row written into
// the sqlite file directly with a correctly recomputed hash chain (the chain has no key),
// an edited approval, a stripped signature, a replaced or deleted key, and a forged tester
// PASS beside a genuine approval. Each must leave the landing refused (STATE_CONFLICT,
// details.reason unsigned_approval / unsigned_tester_verdict) and verification must never
// create a key. The genuine flows (a person's approval, a tester-first PASS then approval)
// still land.

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { eventHash, latestEventHash, verifyEventChain } from "../src/events/eventChain.js";
import {
  factoryKeyId,
  factoryKeysDir,
  fileGateKeyring,
  GateKeyError,
  refusingGateKeyring,
  verifyLandingActs,
} from "../src/events/gateSeal.js";
import { mcpGateKeyring } from "../src/mcp/server.js";
import type { GitRunner } from "../src/services/diffService.js";
import { systemClock } from "../src/util/clock.js";
import { FAKE_HEAD, giveTicketRealDelivery, nonEmptyDiffRunner } from "./helpers/realDiff.js";

const human: Actor = { type: "human", id: "tom" };
const system: Actor = { type: "system" };
const agentActor: Actor = { type: "agent", id: "agent-runner" };
const testerAgent: Actor = { type: "agent", id: "tester-1" };

let onDefault = false;
const runner: GitRunner = (cwd, args, opts) => {
  if (args[0] === "merge-base" && args[1] === "--is-ancestor")
    return { status: onDefault ? 0 : 1, stdout: "", stderr: "" };
  return nonEmptyDiffRunner(cwd, args, opts);
};

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  onDefault = false;
});

/** A file database and a keys directory outside it, as a factory has them. */
function world(opts: { testingEnabled?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "gate-seal-"));
  roots.push(root);
  const data = join(root, "data");
  const keysDir = join(root, "home", ".config", "gaffer", "keys");
  mkdirSync(data, { recursive: true });
  const dbPath = join(data, "dispatch.sqlite");
  const keyring = fileGateKeyring({ dbPath, keysDir });
  const wg = Dispatch.open(dbPath, systemClock, runner, {
    gateKeyring: keyring,
    ...(opts.testingEnabled !== undefined ? { testingEnabled: opts.testingEnabled } : {}),
  });
  return { root, data, dbPath, keysDir, keyring, wg, keyPath: keyring.keyPath };
}

/** A delivered ticket waiting in review (one write repo, its head at FAKE_HEAD). */
function inReview(wg: Dispatch) {
  const t = wg.createTicket({ title: "Ship", description: "x", policy_pack: "team_light" }, human);
  const { ac } = wg.addAcceptanceCriterion({ ticket_id: t.id, text: "ok" }, human);
  const { repoId } = giveTicketRealDelivery(wg, t.id, human, { repoName: "repoA" });
  wg.markReady(t.id, human);
  const agent = wg.registerAgent({ display_name: "a" }, human);
  const claim = wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, agentActor);
  wg.recordEvidence(
    {
      claimToken: claim!.claimToken,
      ticket_id: t.id,
      ac_id: ac.id,
      evidence_type: "test_output",
      summary: "passed",
    },
    agentActor,
  );
  wg.submitForReview({ claimToken: claim!.claimToken, ticket_id: t.id, reason: "d" }, agentActor);
  return { id: t.id, repoId };
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

/** Append a row the way an attacker with the sqlite file can: a correctly chained hash. */
function forgeEvent(
  wg: Dispatch,
  row: { entity_id: string; actor_type: string; event_type: string; payload: unknown },
): string {
  const id = `forged-${randomBytes(6).toString("hex")}`;
  const fields = {
    id,
    entity_type: "ticket",
    entity_id: row.entity_id,
    actor_type: row.actor_type,
    actor_id: "tom",
    event_type: row.event_type,
    payload_json: JSON.stringify(row.payload),
    correlation_id: null,
    created_at: new Date().toISOString(),
  };
  const prev = latestEventHash(wg.db);
  wg.db
    .prepare(
      `INSERT INTO work_events (id, entity_type, entity_id, actor_type, actor_id, event_type, payload_json, correlation_id, created_at, prev_hash, hash)
       VALUES (@id, @entity_type, @entity_id, @actor_type, @actor_id, @event_type, @payload_json, @correlation_id, @created_at, @prev_hash, @hash)`,
    )
    .run({ ...fields, prev_hash: prev, hash: eventHash(prev, fields) });
  return id;
}

/** Recompute every hash from rowid `fromSeq` on (what an attacker does after an edit). */
function rechainFrom(wg: Dispatch, fromId: string): void {
  const rows = wg.db
    .prepare(
      `SELECT rowid AS seq, id, entity_type, entity_id, actor_type, actor_id, event_type,
              payload_json, correlation_id, created_at, prev_hash FROM work_events ORDER BY rowid`,
    )
    .all() as Array<Record<string, string | null> & { seq: number }>;
  let prev: string | null = null;
  let go = false;
  const upd = wg.db.prepare("UPDATE work_events SET prev_hash = ?, hash = ? WHERE rowid = ?");
  for (const r of rows) {
    if (r.id === fromId) go = true;
    if (go) {
      const p = prev ?? (r.prev_hash as string);
      const h = eventHash(p, r as never);
      upd.run(p, h, r.seq);
      prev = h;
    } else {
      prev = (
        wg.db.prepare("SELECT hash FROM work_events WHERE rowid = ?").get(r.seq) as {
          hash: string;
        }
      ).hash;
    }
  }
}

describe("the factory key", () => {
  it("lives under ${XDG_CONFIG_HOME:-$HOME/.config}/gaffer/keys, named from the data dir's canonical path", () => {
    expect(factoryKeysDir({ HOME: "/h" } as NodeJS.ProcessEnv)).toBe("/h/.config/gaffer/keys");
    expect(factoryKeysDir({ HOME: "/h", XDG_CONFIG_HOME: "/x" } as NodeJS.ProcessEnv)).toBe(
      "/x/gaffer/keys",
    );
    const root = mkdtempSync(join(tmpdir(), "gate-seal-id-"));
    roots.push(root);
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "real"), join(root, "link"));
    // The same directory through a symlink is the same factory (canonical path).
    expect(factoryKeyId(join(root, "link", "dispatch.sqlite"))).toBe(
      factoryKeyId(join(root, "real", "dispatch.sqlite")),
    );
    expect(factoryKeyId(join(root, "other", "dispatch.sqlite"))).not.toBe(
      factoryKeyId(join(root, "real", "dispatch.sqlite")),
    );
  });

  it("is created (32 bytes, mode 0600) by the first approval; verification alone never creates it", () => {
    const w = world();
    const { id } = inReview(w.wg);
    // A verification with no key: refused as missing, and no key appears.
    const v = verifyLandingActs(w.wg.db, w.keyring, id, {});
    expect(v.ok).toBe(false);
    expect(existsSync(w.keyPath)).toBe(false);
    w.wg.approveReview(id, human);
    expect(existsSync(w.keyPath)).toBe(true);
    const st = statSync(w.keyPath);
    expect(st.size).toBe(32);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("refuses a key file others can read, and a keys directory inside the data directory", () => {
    const w = world();
    w.keyring.ensure();
    chmodSync(w.keyPath, 0o644);
    expect(() => w.keyring.verifyMac("x")).toThrow(GateKeyError);
    const inside = fileGateKeyring({ dbPath: w.dbPath, keysDir: join(w.data, "keys") });
    expect(() => inside.signMac("x")).toThrow(/inside the factory's data directory/);
  });

  it("the dispatch MCP server opens with the refusing keyring (it never loads the key)", () => {
    const k = mcpGateKeyring();
    expect(() => k.signMac("x")).toThrow(GateKeyError);
    expect(() => k.verifyMac("x")).toThrow(GateKeyError);
    const src = readFileSync(new URL("../src/mcp/server.ts", import.meta.url), "utf8");
    expect(src).toMatch(/gateKeyring: mcpGateKeyring\(\)/);
    // And an approval through a Dispatch opened that way is refused, not silently unsigned.
    const root = mkdtempSync(join(tmpdir(), "gate-seal-mcp-"));
    roots.push(root);
    const dbPath = join(root, "dispatch.sqlite");
    const wg = Dispatch.open(dbPath, systemClock, runner, { gateKeyring: k });
    const { id } = inReview(wg);
    expect(refusal(() => wg.approveReview(id, human))).toMatchObject({ code: "GATE_KEY_REFUSED" });
    expect(wg.view(id).ticket.status).toBe("in_review");
  });

  it("the agent-facing MCP keyring refuses any load, to sign or to verify", () => {
    const k = refusingGateKeyring("the dispatch MCP server");
    expect(() => k.signMac("x")).toThrow(/never loads the factory key/);
    expect(() => k.verifyMac("x")).toThrow(/never loads the factory key/);
  });
});

describe("genuine flows still land", () => {
  it("a person's approval: begin, record and mark merged", () => {
    const w = world();
    const { id } = inReview(w.wg);
    expect(w.wg.approveReview(id, human).ticket.status).toBe("ready_for_merge");
    const approval = w.wg.landingApproval(id)!;
    w.wg.beginLanding(id, { repo: "repoA", commit: FAKE_HEAD, approval, via: "local" }, system);
    onDefault = true;
    w.wg.recordLanding(id, { repo: "repoA", commit: FAKE_HEAD, via: "local" }, system);
    expect(w.wg.markMerged(id, system).ticket.status).toBe("done");
  });

  it("tester first, then a person's approval (both the PASS and the approval are signed)", () => {
    const w = world({ testingEnabled: true });
    const { id } = inReview(w.wg);
    w.wg.setTestable(id, true, human);
    w.wg.routeToTester(id, system);
    w.wg.testerPass(id, { summary: "black-box tests pass", replay: "passed" }, testerAgent);
    expect(w.wg.approveReview(id, human).ticket.status).toBe("ready_for_merge");
    const kinds = (
      w.wg.db.prepare("SELECT kind FROM gate_seals ORDER BY created_at").all() as Array<{
        kind: string;
      }>
    ).map((r) => r.kind);
    expect(kinds).toEqual(["tester_pass", "approval"]);
    onDefault = true; // git shows the approved commit on main
    expect(w.wg.markMerged(id, system).ticket.status).toBe("done");
  });
});

describe("attacks main accepted", () => {
  it("a direct database write of an approval with a recomputed chain: nothing lands", () => {
    const w = world();
    const { id, repoId } = inReview(w.wg);
    w.keyring.ensure(); // the factory has a key; the forger cannot use it
    forgeEvent(w.wg, {
      entity_id: id,
      actor_type: "human",
      event_type: "ticket.transitioned",
      payload: { from: "in_review", to: "ready_for_merge", reason: "review_approved", patch: null },
    });
    w.wg.db.prepare("UPDATE tickets SET status = 'ready_for_merge' WHERE id = ?").run(id);
    w.wg.db
      .prepare(
        `INSERT INTO evidence (id, ticket_id, ac_id, repo_id, decision_id, evidence_type, summary, uri, payload_json, created_by, recorded_by_actor_type, created_at)
         VALUES ('forged-pin', ?, NULL, ?, NULL, 'commit', 'pin', ?, NULL, 'dispatch', 'system', ?)`,
      )
      .run(id, repoId, `gaffer-reviewed-commit:${FAKE_HEAD}`, new Date().toISOString());
    // The forged log verifies as a chain: the chain alone has no key.
    expect(verifyEventChain(w.wg.db).ok).toBe(true);
    expect(
      refusal(() => w.wg.beginLanding(id, { repo: "repoA", commit: FAKE_HEAD }, system)),
    ).toMatchObject({ code: "STATE_CONFLICT", reason: "unsigned_approval" });
    onDefault = true;
    expect(
      refusal(() => w.wg.recordLanding(id, { repo: "repoA", commit: FAKE_HEAD }, system)),
    ).toMatchObject({ reason: "unsigned_approval" });
    expect(refusal(() => w.wg.markMerged(id, system))).toMatchObject({
      reason: "unsigned_approval",
    });
    expect(w.wg.view(id).ticket.status).toBe("ready_for_merge");
  });

  it("an edited approval (its fields changed, the chain fixed after it): refused", () => {
    const w = world();
    const { id } = inReview(w.wg);
    w.wg.approveReview(id, human);
    const approval = w.wg.landingApproval(id)!;
    const row = w.wg.db
      .prepare("SELECT payload_json FROM work_events WHERE id = ?")
      .get(approval) as { payload_json: string };
    const p = JSON.parse(row.payload_json) as Record<string, unknown>;
    w.wg.db
      .prepare("UPDATE work_events SET actor_id = 'someone-else', payload_json = ? WHERE id = ?")
      .run(JSON.stringify({ ...p, reason: "edited" }), approval);
    rechainFrom(w.wg, approval);
    expect(
      refusal(() => w.wg.beginLanding(id, { repo: "repoA", commit: FAKE_HEAD }, system)),
    ).toMatchObject({ reason: "unsigned_approval" });
  });

  it("the approved commit swapped (the review pin rewritten) under a genuine signature: refused", () => {
    const w = world();
    const { id } = inReview(w.wg);
    w.wg.approveReview(id, human);
    const other = "c".repeat(40);
    w.wg.db
      .prepare(
        "UPDATE evidence SET uri = ? WHERE ticket_id = ? AND uri LIKE 'gaffer-reviewed-commit:%'",
      )
      .run(`gaffer-reviewed-commit:${other}`, id);
    const r = refusal(() => w.wg.beginLanding(id, { repo: "repoA", commit: other }, system));
    expect(r).toMatchObject({ reason: "unsigned_approval" });
    expect(r.message).toMatch(/does not cover/);
    expect(refusal(() => w.wg.markMerged(id, system))).toMatchObject({
      reason: "unsigned_approval",
    });
  });

  it("the signature stripped, the key replaced, the key deleted: refused, and no key is created", () => {
    const w = world();
    const { id } = inReview(w.wg);
    w.wg.approveReview(id, human);
    const approval = w.wg.landingApproval(id)!;
    const saved = w.wg.db
      .prepare("SELECT * FROM gate_seals WHERE event_id = ?")
      .get(approval) as Record<string, unknown>;

    w.wg.db.prepare("DELETE FROM gate_seals WHERE event_id = ?").run(approval);
    expect(
      refusal(() => w.wg.beginLanding(id, { repo: "repoA", commit: FAKE_HEAD }, system)),
    ).toMatchObject({ reason: "unsigned_approval" });
    w.wg.db
      .prepare(
        "INSERT INTO gate_seals (event_id, kind, binds_json, key_id, mac, created_at) VALUES (@event_id, @kind, @binds_json, @key_id, @mac, @created_at)",
      )
      .run(saved);

    writeFileSync(w.keyPath, randomBytes(32), { mode: 0o600 });
    expect(
      refusal(() => w.wg.beginLanding(id, { repo: "repoA", commit: FAKE_HEAD }, system)),
    ).toMatchObject({ reason: "unsigned_approval" });

    rmSync(w.keyPath);
    const r = refusal(() => w.wg.beginLanding(id, { repo: "repoA", commit: FAKE_HEAD }, system));
    expect(r).toMatchObject({ reason: "unsigned_approval" });
    expect(r.message).toMatch(/gaffer setup/);
    expect(refusal(() => w.wg.markMerged(id, system))).toMatchObject({
      reason: "unsigned_approval",
    });
    expect(existsSync(w.keyPath)).toBe(false);
  });

  it("a forged tester PASS beside a genuine approval: refused as unsigned_tester_verdict", () => {
    const w = world();
    const { id } = inReview(w.wg);
    w.wg.approveReview(id, human);
    const payload = JSON.stringify({ verdict: "pass", provenance: "human" });
    w.wg.db
      .prepare(
        `INSERT INTO evidence (id, ticket_id, ac_id, repo_id, decision_id, evidence_type, summary, uri, payload_json, created_by, recorded_by_actor_type, created_at)
         VALUES ('forged-pass', ?, NULL, NULL, NULL, 'test_output', 'pass', NULL, ?, 'tom', 'human', ?)`,
      )
      .run(id, payload, new Date(Date.now() + 1000).toISOString());
    forgeEvent(w.wg, {
      entity_id: id,
      actor_type: "human",
      event_type: "ticket.tester_passed",
      payload: { evidence_id: "forged-pass" },
    });
    expect(
      refusal(() => w.wg.beginLanding(id, { repo: "repoA", commit: FAKE_HEAD }, system)),
    ).toMatchObject({ reason: "unsigned_tester_verdict" });
    expect(refusal(() => w.wg.markMerged(id, system))).toMatchObject({
      reason: "unsigned_tester_verdict",
    });
  });

  it("a genuine PASS whose verdict row was edited afterwards: refused", () => {
    const w = world({ testingEnabled: true });
    const { id } = inReview(w.wg);
    w.wg.setTestable(id, true, human);
    w.wg.routeToTester(id, system);
    w.wg.testerPass(id, { summary: "pass", replay: "passed" }, testerAgent);
    w.wg.approveReview(id, human);
    w.wg.db
      .prepare(
        "UPDATE evidence SET payload_json = ? WHERE ticket_id = ? AND evidence_type = 'test_output' AND payload_json LIKE '%\"verdict\":\"pass\"%' AND summary = 'pass'",
      )
      .run(JSON.stringify({ verdict: "pass", provenance: "human" }), id);
    expect(refusal(() => w.wg.markMerged(id, system))).toMatchObject({
      reason: "unsigned_tester_verdict",
    });
  });
});

describe("the hold and the way back", () => {
  it("a ticket held unsigned_approval goes back to review for a person to re-approve, and then lands", () => {
    const w = world();
    const { id } = inReview(w.wg);
    w.wg.approveReview(id, human);
    w.wg.db.prepare("DELETE FROM gate_seals").run(); // an approval from before the upgrade
    w.wg.holdForHuman(id, { reasonCode: "unsigned_approval", reason: "unsigned" }, system);
    expect(w.wg.view(id).ticket.status).toBe("blocked");
    w.wg.reopenForReview(
      id,
      { reason: "unsigned_approval", resolution: "re-approve" },
      {
        type: "admin",
        id: "op",
      },
    );
    expect(w.wg.view(id).ticket.status).toBe("in_review");
    w.wg.approveReview(id, human);
    onDefault = true;
    expect(w.wg.markMerged(id, system).ticket.status).toBe("done");
  });

  it("no other hold reopens from blocked", () => {
    const w = world();
    const { id } = inReview(w.wg);
    w.wg.approveReview(id, human);
    w.wg.holdForHuman(id, { reasonCode: "merge_gate_red", reason: "red" }, system);
    expect(
      refusal(() =>
        w.wg.reopenForReview(id, { reason: "x", resolution: "y" }, { type: "admin", id: "op" }),
      ),
    ).toMatchObject({ code: "ILLEGAL_TRANSITION" });
  });
});

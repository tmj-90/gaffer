// SEALED PRINCIPALS at landing. An approval's seal binds the principal it was made through,
// and the landing check (verifyLandingActs: landing-begin, record-landing, mark-merged and
// the runner's tester-binding.mjs) refuses while that principal is not signed by this
// factory. An approval sealed BEFORE principals were sealed names no principal: the landing
// then checks every principal speaking as the approval's actor, so a forged principal's
// approval that slipped in before the upgrade does not land after it.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { fileGateKeyring, sealMaterial, verifyLandingActs } from "../src/events/gateSeal.js";
import type { GitRunner } from "../src/services/diffService.js";
import { systemClock } from "../src/util/clock.js";
import { asPerson } from "./helpers/principal.js";
import { FAKE_HEAD, giveTicketRealDelivery, nonEmptyDiffRunner } from "./helpers/realDiff.js";

const operator: Actor = { type: "human", id: "tom" };
const system: Actor = { type: "system" };
const agentActor: Actor = { type: "agent", id: "agent-runner" };

const runner: GitRunner = (cwd, args, opts) => {
  if (args[0] === "merge-base" && args[1] === "--is-ancestor")
    return { status: 1, stdout: "", stderr: "" };
  return nonEmptyDiffRunner(cwd, args, opts);
};

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function world(opts: { testingEnabled?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "landing-principal-"));
  roots.push(root);
  const data = join(root, "data");
  mkdirSync(data, { recursive: true });
  const dbPath = join(data, "dispatch.sqlite");
  const keyring = fileGateKeyring({ dbPath, keysDir: join(root, "keys") });
  const wg = Dispatch.open(dbPath, systemClock, runner, {
    gateKeyring: keyring,
    ...(opts.testingEnabled !== undefined ? { testingEnabled: opts.testingEnabled } : {}),
  });
  return { wg, keyring };
}

function inReview(wg: Dispatch): string {
  const t = wg.createTicket(
    { title: "Ship", description: "x", policy_pack: "team_light" },
    operator,
  );
  const { ac } = wg.addAcceptanceCriterion({ ticket_id: t.id, text: "ok" }, operator);
  giveTicketRealDelivery(wg, t.id, operator, { repoName: "repoA" });
  wg.markReady(t.id, operator);
  const agent = wg.registerAgent({ display_name: "a" }, operator);
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
  return t.id;
}

function binds(wg: Dispatch, eventId: string): Record<string, unknown> {
  return JSON.parse(
    (
      wg.db.prepare("SELECT binds_json FROM gate_seals WHERE event_id = ?").get(eventId) as {
        binds_json: string;
      }
    ).binds_json,
  ) as Record<string, unknown>;
}

describe("the landing refuses an approval whose principal is not signed", () => {
  it("binds the principal it was made through; refuses once its seal is gone; a re-sign restores it", () => {
    const w = world();
    const id = inReview(w.wg);
    const alice = w.wg.createPrincipal({ name: "alice" }, operator);
    const res = w.wg.approveReview(
      id,
      { type: "human", id: "alice" },
      { principal: alice.principal },
    );
    expect(binds(w.wg, res.eventId).principal).toBe(alice.principal.id);
    const target = { targets: [{ repoId: null, sha: FAKE_HEAD }] };
    expect(verifyLandingActs(w.wg.db, w.keyring, id, target).ok).toBe(true);

    w.wg.db.prepare("DELETE FROM row_seals WHERE row_id = ?").run(alice.principal.id);
    const v = verifyLandingActs(w.wg.db, w.keyring, id, target);
    expect(v).toMatchObject({
      ok: false,
      code: "unsigned_approval",
      failure: "unsigned_principal",
    });
    expect(v.ok ? "" : v.reason).toMatch(/principal alice is not signed by this factory/);
    const approval = w.wg.landingApproval(id)!;
    expect(() =>
      w.wg.beginLanding(id, { repo: "repoA", commit: FAKE_HEAD, approval, via: "local" }, system),
    ).toThrow(/principal alice is not signed/);

    w.wg.resignPrincipals({ names: ["alice"] }, operator);
    expect(verifyLandingActs(w.wg.db, w.keyring, id, target).ok).toBe(true);
  });

  it("the operator's own approval names no principal and lands whatever the principals are", () => {
    const w = world();
    const id = inReview(w.wg);
    const res = w.wg.approveReview(id, operator);
    expect(binds(w.wg, res.eventId)).toHaveProperty("principal", null);
    w.wg.createPrincipal({ name: "tom-bot", actorId: "tom" }, operator);
    w.wg.db.exec("DELETE FROM row_seals");
    expect(
      verifyLandingActs(w.wg.db, w.keyring, id, { targets: [{ repoId: null, sha: FAKE_HEAD }] }).ok,
    ).toBe(true);
  });

  it("an approval sealed before principals were sealed does not land while a principal speaking as its actor is unsigned", () => {
    const w = world();
    const id = inReview(w.wg);
    const res = w.wg.approveReview(id, { type: "admin", id: "mallory" });
    // Re-seal it in the format from before this change: no `principal` in the binds.
    const old = binds(w.wg, res.eventId);
    const legacy = JSON.stringify({ ticket: old.ticket, pins: old.pins });
    const ev = w.wg.db.prepare("SELECT hash FROM work_events WHERE id = ?").get(res.eventId) as {
      hash: string;
    };
    const { mac } = w.keyring.signMac(sealMaterial("approval", res.eventId, ev.hash, legacy));
    w.wg.db
      .prepare("UPDATE gate_seals SET binds_json = ?, mac = ? WHERE event_id = ?")
      .run(legacy, mac, res.eventId);
    const target = { targets: [{ repoId: null, sha: FAKE_HEAD }] };
    expect(verifyLandingActs(w.wg.db, w.keyring, id, target).ok).toBe(true);
    // The forged principal the approval went through, written into the database.
    w.wg.db
      .prepare(
        "INSERT INTO api_principals (id, name, token_hash, capability, actor_type, actor_id, created_by, created_at) " +
          "VALUES ('forged', 'mallory', ?, 'full', 'admin', 'mallory', 'tom', ?)",
      )
      .run("a".repeat(64), new Date().toISOString());
    const v = verifyLandingActs(w.wg.db, w.keyring, id, target);
    expect(v).toMatchObject({ ok: false, failure: "unsigned_principal" });
    // Revoking the forged row does not hide it.
    w.wg.db.prepare("UPDATE api_principals SET revoked_at = ? WHERE id = 'forged'").run("x");
    expect(verifyLandingActs(w.wg.db, w.keyring, id, target).ok).toBe(false);
  });

  it("a person's waiver relied on at landing needs its principal signed", () => {
    const w = world({ testingEnabled: true });
    const id = inReview(w.wg);
    w.wg.setTestable(id, true, operator);
    w.wg.routeToTester(id, system);
    const person: Actor = { type: "human", id: "carol" };
    const authority = asPerson(w.wg, person);
    w.wg.testerPass(id, { summary: "I checked it by hand" }, person, authority);
    w.wg.approveReview(id, operator);
    const target = { targets: [{ repoId: null, sha: FAKE_HEAD }] };
    expect(verifyLandingActs(w.wg.db, w.keyring, id, target).ok).toBe(true);
    w.wg.db.prepare("DELETE FROM row_seals WHERE row_id = ?").run(authority.principal.id);
    expect(verifyLandingActs(w.wg.db, w.keyring, id, target)).toMatchObject({
      ok: false,
      code: "unsigned_tester_verdict",
      failure: "unsigned_principal",
    });
  });
});

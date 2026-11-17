/**
 * SEALED AUTONOMY (S5 part B), the upgrade and the person's re-sign:
 *
 *  - a database from before this change opens; nothing is signed on open or on a read;
 *    its policy rows grant nothing and its in-flight tickets read as the highest risk;
 *    doctor says what is unsigned and what it costs;
 *  - a person's re-sign signs exactly the rows they reviewed (a row added or changed after
 *    the review is not signed), for policy rows and for ticket risks;
 *  - the re-sign is refused for an agent, the runner, a read-only, scoped, non-admin or
 *    revoked principal, over REST for a principal that is not an admin, and through the
 *    built CLI the same way; MCP has no tool for it.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setPrincipalResolver } from "../src/api/auth.js";
import { createApiServer } from "../src/api/server.js";
import { runDoctor } from "../src/cli/ops.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { fileGateKeyring, refusingGateKeyring } from "../src/events/gateSeal.js";
import { makeHandlers } from "../src/mcp/tools.js";
import { systemClock } from "../src/util/clock.js";
import { repoNamed, ticketOn } from "./helpers/autonomyLadder.js";
import { CLI_BUILT, oneLineError, runBin } from "./helpers/cliBin.js";

const human: Actor = { type: "human", id: "tom" };
const agent: Actor = { type: "agent", id: "gaffer-factory" };
const system: Actor = { type: "system" };
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

function paths() {
  const root = mkdtempSync(join(tmpdir(), "s5b-resign-"));
  roots.push(root);
  const data = join(root, "data");
  mkdirSync(data, { recursive: true });
  const dbPath = join(data, "dispatch.sqlite");
  const keysDir = join(root, "keys");
  fileGateKeyring({ dbPath, keysDir }).ensure();
  return { dbPath, keysDir };
}

function host(p: { dbPath: string; keysDir: string }): Dispatch {
  return Dispatch.open(p.dbPath, systemClock, undefined, {
    gateKeyring: fileGateKeyring(p),
  });
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

/** A policy row as the code before this change wrote it: a plain upsert, no event, no seal. */
function legacyPolicy(wg: Dispatch, id: string, repoId: string, risk: string, gate: string) {
  wg.db
    .prepare(
      "INSERT INTO autonomy_policy (id, repo_id, risk_level, gate, mode, enabled_by, enabled_at, evidence_json, created_at, updated_at) VALUES (?, ?, ?, ?, 'auto', 'tom', '2026-10-01T00:00:00.000Z', NULL, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')",
    )
    .run(id, repoId, risk, gate);
}

/**
 * A factory as it stood before this change: policy rows with no seal and no event, tickets
 * with no recorded risk (made by a process that wrote none), one of them in flight, and no
 * row_seals table at all.
 */
function legacyFactory() {
  const p = paths();
  const old = Dispatch.open(p.dbPath, systemClock, undefined, {
    gateKeyring: refusingGateKeyring("the code before sealed autonomy"),
  });
  const api = repoNamed(old, "api");
  legacyPolicy(old, "pol-low-approve", api, "low", "approve");
  legacyPolicy(old, "pol-low-merge", api, "low", "merge");
  const inFlight = ticketOn(old, "api", "low", "in flight");
  const waiting = ticketOn(old, "api", "medium", "waiting");
  old.addAcceptanceCriterion({ ticket_id: inFlight.id, text: "ok" }, human);
  old.markReady(inFlight.id, human);
  const a = old.registerAgent({ display_name: "a", max_risk: "critical" }, human);
  expect(old.claimNextTicket({ agentId: a.id, ttlSeconds: 600 }, agent)?.ticketId).toBe(
    inFlight.id,
  );
  old.db.exec("DROP TABLE row_seals");
  old.db.close();
  return { p, api, inFlight, waiting };
}

describe("upgrade: nothing is signed automatically", () => {
  it("a database from before opens; its rows grant nothing; doctor says so; a person's re-sign restores exactly the reviewed rows", () => {
    const { p, api, inFlight, waiting } = legacyFactory();
    const wg = host(p);
    try {
      expect(wg.db.prepare("SELECT count(*) AS n FROM row_seals").get()).toEqual({ n: 0 });
      // Autonomy is off for the unsigned rows, and the unsigned risks read as the highest.
      expect(wg.autonomyGateDecision(wg.resolveTicket(inFlight.id), "approve")).toMatchObject({
        decision: "deny",
        held: { kind: "risk_unsigned" },
      });
      const low = ticketOn(wg, "api", "low", "new work"); // made by the host: signed
      expect(wg.autonomyGateDecision(wg.resolveTicket(low.id), "approve").decision).toBe("deny");
      // Reading does not sign anything.
      expect(
        wg.db.prepare("SELECT count(*) AS n FROM row_seals WHERE kind = 'autonomy_policy'").get(),
      ).toEqual({ n: 0 });
      // Doctor names it, with what it costs.
      const report = runDoctor(wg.db, p.dbPath, undefined, wg.gateKeyring);
      const labels = report.checks.map((c) => c.label);
      expect(labels).toContain(
        "Autonomy: 2 automatic policy rows are not signed: they are off until you sign them",
      );
      expect(labels).toContain(
        "Autonomy: 1 open ticket's risk is not signed: decided as the highest risk (a person decides)",
      );
      // The never-claimed ticket is sealed at its first claim; the in-flight one needs a person.
      const risks = wg.reviewUnsignedTicketRisks();
      expect(risks.unsigned.map((u) => [u.id, u.sealed_at_claim])).toEqual([
        [inFlight.id, false],
        [waiting.id, true],
      ]);
      expect(risks.by_risk).toMatchObject({ low: 1, medium: 1 });

      // The person reviews the policy rows. A row written after the review is not signed by
      // the reviewed code: the list changed.
      const review = wg.reviewUnsignedAutonomyPolicies();
      expect(review.unsigned.map((u) => u.id).sort()).toEqual(["pol-low-approve", "pol-low-merge"]);
      legacyPolicy(wg, "pol-forged", api, "medium", "merge");
      expect(
        refusal(() =>
          wg.resignAutonomyPolicies({ all: true, confirm: review.fingerprint }, human, null),
        ),
      ).toMatchObject({ code: "STATE_CONFLICT", reason: "review_stale" });
      // By id with that row's own code: exactly that row.
      const one = review.unsigned.find((u) => u.id === "pol-low-approve")!;
      const res = wg.resignAutonomyPolicies(
        { ids: [one.id], confirm: one.review_code },
        human,
        null,
      );
      expect(res.resigned.map((r) => r.id)).toEqual(["pol-low-approve"]);
      expect(wg.autonomyGateDecision(wg.resolveTicket(low.id), "approve").decision).toBe("allow");
      expect(wg.autonomyGateDecision(wg.resolveTicket(low.id), "merge").decision).toBe("deny");
      expect(
        wg
          .reviewUnsignedAutonomyPolicies()
          .unsigned.map((u) => u.id)
          .sort(),
      ).toEqual(["pol-forged", "pol-low-merge"]);
      // A row changed after the person reviewed it is not signed by its old code.
      const merge = wg
        .reviewUnsignedAutonomyPolicies()
        .unsigned.find((u) => u.id === "pol-low-merge")!;
      wg.db
        .prepare("UPDATE autonomy_policy SET risk_level = 'high' WHERE id = 'pol-low-merge'")
        .run();
      expect(
        refusal(() =>
          wg.resignAutonomyPolicies({ ids: [merge.id], confirm: merge.review_code }, human, null),
        ),
      ).toMatchObject({ code: "STATE_CONFLICT", reason: "review_stale" });

      // Ticket risks: one act over the reviewed list.
      const r2 = wg.reviewUnsignedTicketRisks();
      const signed = wg.resignTicketRisks({ all: true, confirm: r2.fingerprint }, human, null);
      expect(signed.resigned.map((r) => r.id).sort()).toEqual([inFlight.id, waiting.id].sort());
      expect(wg.autonomyRisk(wg.resolveTicket(inFlight.id))).toMatchObject({
        level: "low",
        signed: true,
      });
      expect(wg.autonomyGateDecision(wg.resolveTicket(inFlight.id), "approve").decision).toBe(
        "allow",
      );
    } finally {
      wg.db.close();
    }
  });
});

describe("the re-sign is a person's act", () => {
  it("refused for an agent, the runner, and a read-only, scoped, non-admin or revoked principal; MCP has no tool", () => {
    const p = paths();
    const wg = host(p);
    try {
      const api = repoNamed(wg, "api");
      legacyPolicy(wg, "pol", api, "low", "approve");
      const t = ticketOn(wg, "api", "low");
      wg.db.prepare("UPDATE tickets SET risk_level = 'medium' WHERE id = ?").run(t.id);
      const code = wg.reviewUnsignedAutonomyPolicies().fingerprint;
      const rcode = wg.reviewUnsignedTicketRisks().fingerprint;
      const tryBoth = (
        actor: Actor,
        principal: Parameters<Dispatch["resignAutonomyPolicies"]>[2],
      ) => [
        refusal(() => wg.resignAutonomyPolicies({ all: true, confirm: code }, actor, principal)),
        refusal(() => wg.resignTicketRisks({ all: true, confirm: rcode }, actor, principal)),
      ];
      for (const actor of [agent, system]) {
        for (const r of tryBoth(actor, null)) {
          expect(r).toMatchObject({ code: "ACTOR_NOT_PERMITTED", reason: "person_required" });
        }
      }
      const mk = (name: string, o: Record<string, unknown>) =>
        wg.createPrincipal({ name, actorId: name, ...o }, human).principal;
      const reader = mk("reader", { actorType: "admin", capability: "read" });
      const scoped = mk("scoped", { actorType: "admin", repos: ["api"] });
      const dev = mk("dev", { actorType: "human" });
      const gone = mk("gone", { actorType: "admin" });
      wg.revokePrincipal("gone", human);
      for (const pr of [reader, scoped, dev, gone]) {
        const as: Actor = { type: pr.actor_type, id: pr.actor_id };
        for (const r of tryBoth(as, pr)) {
          expect(r).toMatchObject({ code: "ACTOR_NOT_PERMITTED", reason: "person_required" });
        }
      }
      expect(wg.reviewUnsignedAutonomyPolicies().unsigned).toHaveLength(1);
      // An active, unscoped admin principal with full capability may.
      const ops = mk("ops", { actorType: "admin" });
      expect(
        wg.resignAutonomyPolicies({ all: true, confirm: code }, { type: "admin", id: "ops" }, ops)
          .resigned,
      ).toHaveLength(1);
      // MCP: no tool signs anything.
      const names = Object.keys(makeHandlers(wg, agent));
      expect(names.filter((n) => /sign|autonomy|risk/i.test(n))).toEqual([]);
    } finally {
      wg.db.close();
    }
  });

  describe("REST", () => {
    const FULL = "shared-full-token-for-sealed-autonomy-0123456789abcdef";
    const savedToken = process.env.DISPATCH_API_TOKEN;
    afterEach(() => {
      setPrincipalResolver(null);
      if (savedToken === undefined) delete process.env.DISPATCH_API_TOKEN;
      else process.env.DISPATCH_API_TOKEN = savedToken;
    });

    it("a read-only or non-admin principal is refused; the shared token re-signs the reviewed list", async () => {
      process.env.DISPATCH_AUDIT_OFF = "1";
      process.env.DISPATCH_API_TOKEN = FULL;
      const p = paths();
      const wg = host(p);
      const api = repoNamed(wg, "api");
      legacyPolicy(wg, "pol", api, "low", "merge");
      const { token: readTok } = wg.createPrincipal(
        { name: "reader", capability: "read", actorType: "admin", actorId: "rae" },
        human,
      );
      const { token: devTok } = wg.createPrincipal(
        { name: "dev", actorType: "human", actorId: "dee" },
        human,
      );
      const server = createApiServer(wg);
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const call = async (tok: string, path: string, body?: unknown) => {
        const res = await fetch(`${base}${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: res.status, body: (await res.json()) as Record<string, any> };
      };
      try {
        const review = await call(FULL, "/api/autonomy/signatures");
        expect(review.status).toBe(200);
        expect(review.body.unsigned.map((u: { id: string }) => u.id)).toEqual(["pol"]);
        const body = { all: true, confirm: review.body.fingerprint };
        expect((await call(readTok, "/api/autonomy/signatures/resign", body)).status).toBe(403);
        expect((await call(devTok, "/api/autonomy/signatures/resign", body)).status).toBe(403);
        expect(wg.reviewUnsignedAutonomyPolicies().unsigned).toHaveLength(1);
        const ok = await call(FULL, "/api/autonomy/signatures/resign", body);
        expect(ok.status).toBe(200);
        expect(ok.body.resigned.map((r: { id: string }) => r.id)).toEqual(["pol"]);
        const risks = await call(FULL, "/api/autonomy/risk-signatures");
        expect(risks.status).toBe(200);
        expect(risks.body.unsigned).toEqual([]);
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
        wg.db.close();
      }
    });
  });

  it.skipIf(!CLI_BUILT)(
    "the built CLI: a non-admin principal is refused, the operator re-signs",
    () => {
      // The CLI uses the factory key under XDG_CONFIG_HOME (the test env): open with it.
      const dir = mkdtempSync(join(tmpdir(), "s5b-cli-"));
      roots.push(dir);
      const db = join(dir, "d.db");
      const wg = Dispatch.open(db);
      const api = repoNamed(wg, "api");
      legacyPolicy(wg, "pol", api, "low", "merge");
      wg.db.close();
      const keyed = Dispatch.open(db, undefined, undefined, {
        gateKeyring: fileGateKeyring({ dbPath: db }),
      });
      const { token } = keyed.createPrincipal(
        { name: "dee", actorType: "human", actorId: "dee" },
        human,
      );
      keyed.db.close();
      const listed = runBin(db, ["autonomy", "unsigned"], {
        env: { GAFFER_PRINCIPAL_TOKEN: undefined },
      });
      expect(listed.status).toBe(0);
      const code = JSON.parse(listed.stdout).fingerprint as string;
      const dev = runBin(db, ["autonomy", "resign", "--all", "--confirm", code], {
        env: { GAFFER_PRINCIPAL_TOKEN: token },
      });
      expect(dev.status).not.toBe(0);
      expect(oneLineError(dev.stderr).code).toBe("SCOPE_DENIED");
      const asAgent = runBin(
        db,
        ["autonomy", "resign", "--all", "--confirm", code, "--as", "agent"],
        {
          env: { GAFFER_PRINCIPAL_TOKEN: undefined },
        },
      );
      expect(asAgent.status).not.toBe(0);
      const noCode = runBin(db, ["autonomy", "resign", "--all"], {
        env: { GAFFER_PRINCIPAL_TOKEN: undefined },
      });
      expect(noCode.status).not.toBe(0);
      expect(oneLineError(noCode.stderr).code).toBe("VALIDATION_ERROR");
      const ok = runBin(db, ["autonomy", "resign", "--all", "--confirm", code], {
        env: { GAFFER_PRINCIPAL_TOKEN: undefined },
      });
      expect(ok.status).toBe(0);
      expect(JSON.parse(ok.stdout).resigned.map((r: { id: string }) => r.id)).toEqual(["pol"]);
      const after = runBin(db, ["autonomy", "unsigned"], {
        env: { GAFFER_PRINCIPAL_TOKEN: undefined },
      });
      expect(JSON.parse(after.stdout).unsigned).toEqual([]);
    },
  );
});

// SEALED PRINCIPALS (audit sec-authz finding 2). A row in api_principals used to be a
// person: any active row authenticated by its token hash, so a process that can write the
// sqlite file inserted one (a token it chose, admin, unscoped) and the REST server then
// sealed a real approval for it. A principal is now honoured only with a valid seal under
// the factory key over its identity and authority and the event that last set its state.
//
// Every attack below is one main accepted: a forged row, a revocation flipped back, a
// valid seal copied onto a changed row, a deleted revocation event, a deleted key. Each
// must be refused exactly like an unknown token, and verification must never create a key
// or a seal. The genuine flows (create, use across a restart, revoke, a person's re-sign of
// rows created before signing) still work.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setPrincipalResolver } from "../src/api/auth.js";
import { createApiServer } from "../src/api/server.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { eventHash } from "../src/events/eventChain.js";
import { fileGateKeyring } from "../src/events/gateSeal.js";
import { verifyPrincipal } from "../src/events/principalSeal.js";
import { exportState, importState } from "../src/io/stateExport.js";
import { assertVerdictPrincipal } from "../src/services/reviewGate/waiver.js";
import { systemClock } from "../src/util/clock.js";

const operator: Actor = { type: "human", id: "tom" };

const roots: string[] = [];
afterEach(() => {
  setPrincipalResolver(null);
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function factory() {
  const root = mkdtempSync(join(tmpdir(), "principal-seal-"));
  roots.push(root);
  const data = join(root, "data");
  const keysDir = join(root, "keys");
  const dbPath = join(data, "dispatch.sqlite");
  mkdirSync(data, { recursive: true });
  const keyring = () => fileGateKeyring({ dbPath, keysDir });
  const open = () => Dispatch.open(dbPath, systemClock, undefined, { gateKeyring: keyring() });
  return { root, dbPath, keysDir, keyring, open };
}

function sha(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** A row written straight into the sqlite file: no event, no seal. */
function forgeRow(wg: Dispatch, name: string, over: Record<string, unknown> = {}): string {
  const token = `gfp_${randomBytes(32).toString("base64url")}`;
  const row = {
    id: `forged-${name}`,
    name,
    token_hash: sha(token),
    capability: "full",
    actor_type: "admin",
    actor_id: name,
    created_by: "tom",
    created_at: new Date().toISOString(),
    ...over,
  };
  wg.db
    .prepare(
      "INSERT INTO api_principals (id, name, token_hash, capability, actor_type, actor_id, created_by, created_at) " +
        "VALUES (@id, @name, @token_hash, @capability, @actor_type, @actor_id, @created_by, @created_at)",
    )
    .run(row);
  return token;
}

function sealRowOf(wg: Dispatch, id: string) {
  return wg.db
    .prepare("SELECT * FROM row_seals WHERE kind = 'principal' AND row_id = ?")
    .get(id) as Record<string, unknown> | undefined;
}

describe("a principal row is honoured only with a valid seal", () => {
  it("a normally created principal is signed and resolves across a restart", () => {
    const f = factory();
    const wg = f.open();
    const { principal, token } = wg.createPrincipal({ name: "alice" }, operator);
    expect(sealRowOf(wg, principal.id)).toBeTruthy();
    expect(wg.resolvePrincipalToken(token)?.principal.name).toBe("alice");
    wg.db.close();
    const again = f.open();
    expect(again.resolvePrincipalToken(token)?.actor).toEqual({ type: "human", id: "alice" });
    expect(again.listUnsignedPrincipals()).toEqual([]);
    again.db.close();
  });

  it("a row seeded straight into sqlite is refused, named, and nothing is created for it", () => {
    const f = factory();
    const wg = f.open();
    const token = forgeRow(wg, "mallory");
    expect(existsSync(join(f.keysDir))).toBe(false);
    expect(wg.resolvePrincipalToken(token)).toBeNull();
    // Verification never creates a key or a seal.
    expect(existsSync(f.keysDir)).toBe(false);
    expect(sealRowOf(wg, "forged-mallory")).toBeUndefined();
    const unsigned = wg.listUnsignedPrincipals();
    expect(unsigned.map((u) => u.name)).toEqual(["mallory"]);
    expect(unsigned[0]).toMatchObject({ creation_event: null, actor_type: "admin" });
    wg.db.close();
  });

  it("a revoked principal stays revoked: revoked_at back to NULL, its old seal restored, or the revocation deleted", () => {
    const f = factory();
    const wg = f.open();
    const { principal, token } = wg.createPrincipal({ name: "bob" }, operator);
    const oldSeal = sealRowOf(wg, principal.id)!;
    wg.revokePrincipal("bob", operator);
    expect(sealRowOf(wg, principal.id)).toBeUndefined();

    // 1. flip revoked_at back
    wg.db.prepare("UPDATE api_principals SET revoked_at = NULL WHERE id = ?").run(principal.id);
    expect(wg.resolvePrincipalToken(token)).toBeNull();
    // 2. and put the copy of its old (valid) seal back
    wg.db
      .prepare(
        "INSERT INTO row_seals (kind, row_id, event_id, facts_json, key_id, mac, created_at) VALUES (@kind, @row_id, @event_id, @facts_json, @key_id, @mac, @created_at)",
      )
      .run(oldSeal);
    const v = verifyPrincipal(wg.db, f.keyring(), principal.id);
    expect(v).toMatchObject({ ok: false, failure: "superseded" });
    expect(wg.resolvePrincipalToken(token)).toBeNull();
    // 3. and delete the revocation event, rechaining what follows so the chain is consistent
    wg.db
      .prepare("DELETE FROM work_events WHERE entity_id = ? AND event_type = 'principal.revoked'")
      .run(principal.id);
    rechain(wg);
    const after = verifyPrincipal(wg.db, f.keyring(), principal.id);
    expect(after.ok).toBe(false);
    expect(["truncated", "chain"]).toContain(after.ok ? "" : after.failure);
    expect(wg.resolvePrincipalToken(token)).toBeNull();
    wg.db.close();
  });

  it("a valid seal on a changed row is refused: another token hash, a raised capability, a widened scope, another row", () => {
    const f = factory();
    const wg = f.open();
    const repo = wg.registerRepository({ name: "app", default_branch: "main" }, operator);
    const reader = wg.createPrincipal(
      { name: "reader", capability: "read", repos: [repo.id] },
      operator,
    );
    expect(wg.resolvePrincipalToken(reader.token)).not.toBeNull();
    const cases: Array<[string, string]> = [
      [
        "token_hash",
        `UPDATE api_principals SET token_hash = '${sha("gfp_mine-mine-mine-mine")}' WHERE id = ?`,
      ],
      ["capability", "UPDATE api_principals SET capability = 'full' WHERE id = ?"],
      ["scope_repos", "UPDATE api_principals SET scope_repos = NULL WHERE id = ?"],
      ["actor_type", "UPDATE api_principals SET actor_type = 'admin' WHERE id = ?"],
    ];
    for (const [field, sql] of cases) {
      const before = wg.db
        .prepare("SELECT * FROM api_principals WHERE id = ?")
        .get(reader.principal.id) as Record<string, unknown>;
      wg.db.prepare(sql).run(reader.principal.id);
      const v = verifyPrincipal(wg.db, f.keyring(), reader.principal.id);
      expect(v.ok, field).toBe(false);
      expect(v.ok ? [] : v.changed).toEqual([field]);
      expect(wg.resolvePrincipalToken(reader.token)).toBeNull();
      wg.db
        .prepare(
          "UPDATE api_principals SET token_hash = @token_hash, capability = @capability, scope_repos = @scope_repos, actor_type = @actor_type WHERE id = @id",
        )
        .run(before);
      expect(wg.resolvePrincipalToken(reader.token), `${field} restored`).not.toBeNull();
    }
    // The seal of one row copied onto a forged one.
    const forged = forgeRow(wg, "copycat");
    const s = sealRowOf(wg, reader.principal.id)!;
    wg.db
      .prepare(
        "INSERT INTO row_seals (kind, row_id, event_id, facts_json, key_id, mac, created_at) VALUES ('principal', 'forged-copycat', ?, ?, ?, ?, ?)",
      )
      .run(s.event_id, s.facts_json, s.key_id, s.mac, s.created_at);
    expect(wg.resolvePrincipalToken(forged)).toBeNull();
    wg.db.close();
  });

  it("with the key deleted every principal is refused and nothing is created", () => {
    const f = factory();
    const wg = f.open();
    const a = wg.createPrincipal({ name: "a" }, operator);
    const b = wg.createPrincipal({ name: "b", actorType: "admin" }, operator);
    const kr = f.keyring();
    unlinkSync(kr.keyPath);
    wg.db.close();
    const again = f.open();
    expect(again.resolvePrincipalToken(a.token)).toBeNull();
    expect(again.resolvePrincipalToken(b.token)).toBeNull();
    expect(existsSync(kr.keyPath)).toBe(false);
    expect((again.db.prepare("SELECT COUNT(*) AS n FROM row_seals").get() as { n: number }).n).toBe(
      2,
    );
    expect(again.listUnsignedPrincipals().map((u) => u.failure)).toEqual([
      "missing_key",
      "missing_key",
    ]);
    expect(existsSync(kr.keyPath)).toBe(false);
    again.db.close();
  });

  it("a person's tester verdict re-reads the principal inside the write and refuses an unsigned one", () => {
    const f = factory();
    const wg = f.open();
    const { principal } = wg.createPrincipal({ name: "carol" }, operator);
    const actor: Actor = { type: "human", id: "carol" };
    expect(assertVerdictPrincipal(wg.db, f.keyring(), actor, principal, 1, "pass")?.id).toBe(
      principal.id,
    );
    wg.db.prepare("DELETE FROM row_seals WHERE row_id = ?").run(principal.id);
    expect(() => assertVerdictPrincipal(wg.db, f.keyring(), actor, principal, 1, "pass")).toThrow(
      /not signed by this factory/,
    );
    forgeRow(wg, "dave", { actor_type: "human" });
    expect(() =>
      assertVerdictPrincipal(
        wg.db,
        f.keyring(),
        { type: "human", id: "dave" },
        { id: "forged-dave", name: "dave" } as never,
        1,
        "fail",
      ),
    ).toThrow(/not signed by this factory/);
    wg.db.close();
  });
});

describe("re-signing principals created before signing (a person's act)", () => {
  it("resign --all revives legacy rows, skips a row with no creation on record, and a named re-sign signs it", () => {
    const f = factory();
    const wg = f.open();
    const legacy1 = wg.createPrincipal({ name: "old-1" }, operator);
    const legacy2 = wg.createPrincipal({ name: "old-2", actorType: "admin" }, operator);
    // Rows from before signing: no seal at all.
    wg.db.exec("DELETE FROM row_seals");
    const forged = forgeRow(wg, "intruder");
    expect(wg.resolvePrincipalToken(legacy1.token)).toBeNull();
    expect(
      wg
        .listUnsignedPrincipals()
        .map((u) => u.name)
        .sort(),
    ).toEqual(["intruder", "old-1", "old-2"]);
    const res = wg.resignPrincipals({ all: true }, operator);
    expect(res.resigned.map((r) => r.name).sort()).toEqual(["old-1", "old-2"]);
    expect(res.skipped).toEqual([
      expect.objectContaining({
        name: "intruder",
        reason: expect.stringMatching(/no matching principal.created/),
      }),
    ]);
    expect(wg.resolvePrincipalToken(legacy1.token)?.principal.name).toBe("old-1");
    expect(wg.resolvePrincipalToken(legacy2.token)?.principal.name).toBe("old-2");
    expect(wg.resolvePrincipalToken(forged)).toBeNull();
    const events = wg.db
      .prepare("SELECT event_type FROM work_events WHERE entity_id = ? ORDER BY rowid")
      .all(legacy1.principal.id) as Array<{ event_type: string }>;
    expect(events.map((e) => e.event_type)).toEqual(["principal.created", "principal.resigned"]);
    // Survives a restart.
    wg.db.close();
    const again = f.open();
    expect(again.resolvePrincipalToken(legacy2.token)).not.toBeNull();
    // Named on purpose, after review: signed.
    expect(again.resignPrincipals({ names: ["intruder"] }, operator).resigned).toHaveLength(1);
    expect(again.resolvePrincipalToken(forged)).not.toBeNull();
    // A revoked principal is never re-signed.
    again.revokePrincipal("old-1", operator);
    expect(() => again.resignPrincipals({ names: ["old-1"] }, operator)).toThrow(/revoked/);
    again.db.close();
  });
});

describe("state export and import carry no principal and no row seal", () => {
  it("exports neither, and an import (a restore) drops every row seal", () => {
    const f = factory();
    const wg = f.open();
    const { principal, token } = wg.createPrincipal({ name: "frank" }, operator);
    const bundle = exportState(wg.db);
    expect(Object.keys(bundle.tables)).not.toContain("api_principals");
    expect(Object.keys(bundle.tables)).not.toContain("row_seals");
    // A restore over this factory (force): the principal row stays (it is not carried),
    // but its seal is gone, so a person re-signs it before it signs in again.
    importState(wg.db, bundle, { force: true });
    expect(sealRowOf(wg, principal.id)).toBeUndefined();
    expect(wg.resolvePrincipalToken(token)).toBeNull();
    wg.db.close();
  });
});

describe("REST and the live feed refuse an unsigned principal", () => {
  const FULL = "shared-full-token-for-principal-seal-0123456789";
  const prev = process.env.DISPATCH_API_TOKEN;
  beforeEach(() => {
    process.env.DISPATCH_API_TOKEN = FULL;
    process.env.DISPATCH_AUDIT_OFF = "1";
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.DISPATCH_API_TOKEN;
    else process.env.DISPATCH_API_TOKEN = prev;
  });

  async function serve(wg: Dispatch) {
    const server = createApiServer(wg);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    return {
      base: `http://127.0.0.1:${port}`,
      close: () =>
        new Promise<void>((r) => {
          server.closeAllConnections?.();
          server.close(() => r());
        }),
    };
  }

  it("whoami is 401 and an approval is refused for a forged row; a signed one is 200", async () => {
    const f = factory();
    const wg = f.open();
    const forged = forgeRow(wg, "root");
    const { token } = wg.createPrincipal({ name: "erin" }, operator);
    const s = await serve(wg);
    try {
      const who = await fetch(`${s.base}/api/whoami`, {
        headers: { authorization: `Bearer ${forged}` },
      });
      expect(who.status).toBe(401);
      const ok = await fetch(`${s.base}/api/whoami`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(ok.status).toBe(200);
      const approve = await fetch(`${s.base}/api/tickets/1/review/approve`, {
        method: "POST",
        headers: { authorization: `Bearer ${forged}`, "content-type": "application/json" },
        body: "{}",
      });
      expect(approve.status).toBe(401);
      const mint = await fetch(`${s.base}/api/principals`, {
        method: "POST",
        headers: { authorization: `Bearer ${forged}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "more" }),
      });
      expect(mint.status).toBe(401);
      // The operator sees the unsigned row and may re-sign; a principal may not.
      const list = await fetch(`${s.base}/api/principal-signatures`, {
        headers: { authorization: `Bearer ${FULL}` },
      });
      expect(list.status).toBe(200);
      const body = (await list.json()) as { unsigned: Array<{ name: string }> };
      expect(body.unsigned.map((u) => u.name)).toEqual(["root"]);
      const byPrincipal = await fetch(`${s.base}/api/principal-signatures/resign`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
      expect(byPrincipal.status).toBe(403);
    } finally {
      await s.close();
      wg.db.close();
    }
  });

  it("the live feed's per-write re-resolve drops a principal whose seal is gone", async () => {
    const f = factory();
    const wg = f.open();
    const { principal, token } = wg.createPrincipal(
      { name: "viewer", capability: "read" },
      operator,
    );
    const s = await serve(wg);
    const ctrl = new AbortController();
    try {
      const res = await fetch(`${s.base}/api/events/stream`, {
        headers: { authorization: `Bearer ${token}` },
        signal: ctrl.signal,
      });
      expect(res.status).toBe(200);
      wg.db.prepare("DELETE FROM row_seals WHERE row_id = ?").run(principal.id);
      wg.createTicket({ title: "after the seal went" }, operator);
      const text = await readFor(res, 3000);
      expect(text).toContain("auth_revoked");
      expect(text).not.toContain("after the seal went");
    } finally {
      ctrl.abort();
      await s.close();
      wg.db.close();
    }
  });
});

async function readFor(res: Response, ms: number): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let out = "";
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !out.includes("auth_revoked")) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((r) =>
        setTimeout(() => r({ done: true, value: undefined }), Math.max(1, deadline - Date.now())),
      ),
    ]);
    if (chunk.done) break;
    out += dec.decode(chunk.value, { stream: true });
  }
  return out;
}

/** Recompute every hash after a deletion (what a DB writer with this module can do). */
function rechain(wg: Dispatch): void {
  const rows = wg.db
    .prepare(
      "SELECT rowid AS seq, id, entity_type, entity_id, actor_type, actor_id, event_type, payload_json, correlation_id, created_at FROM work_events ORDER BY rowid",
    )
    .all() as Array<Record<string, unknown> & { seq: number }>;
  let prev = "0".repeat(64);
  const upd = wg.db.prepare("UPDATE work_events SET prev_hash = ?, hash = ? WHERE rowid = ?");
  for (const r of rows) {
    const h = eventHash(prev, r as never);
    upd.run(prev, h, r.seq);
    prev = h;
  }
}

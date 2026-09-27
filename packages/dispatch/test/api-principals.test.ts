/**
 * PER-PRINCIPAL API CREDENTIALS (schema v24).
 *
 *   facade  — createPrincipal mints a `gfp_…` token once and stores only its hash;
 *             names are validated and unique; revoke stamps revoked_at (idempotent
 *             NO_OP on a second call); resolvePrincipalToken maps an ACTIVE token
 *             to its actor and a revoked/unknown one to null; both actions are in
 *             the tamper-evident event log.
 *   REST    — with the shared token configured: POST /api/principals mints; the
 *             new token authenticates; GET /api/whoami names the principal; a write
 *             made with it is attributed to the principal's actor on the ticket
 *             events (not the shared "dispatch-api" actor); a read principal is
 *             refused on mutations (403 READ_ONLY_TOKEN) but may list; a revoked
 *             token is 401; the list never carries a hash; DELETE revokes by name.
 *   export  — api_principals never travels in a state bundle.
 */

import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { setPrincipalResolver } from "../src/api/auth.js";
import { createApiServer } from "../src/api/server.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { listEvents } from "../src/events/eventWriter.js";
import { EXPORT_TABLES } from "../src/io/stateExport.js";
import { PRINCIPAL_TOKEN_PREFIX } from "../src/services/principalService.js";
import { TestClock } from "../src/util/clock.js";

const operator: Actor = { type: "human", id: "tom" };

describe("principals (facade)", () => {
  it("mints a token once, stores only the hash, and records the creation", () => {
    const wg = Dispatch.open(":memory:", new TestClock());
    const { principal, token } = wg.createPrincipal({ name: "alice" }, operator);
    expect(token.startsWith(PRINCIPAL_TOKEN_PREFIX)).toBe(true);
    expect(token.length).toBeGreaterThan(40);
    expect(principal).toMatchObject({
      name: "alice",
      capability: "full",
      actor_type: "human",
      actor_id: "alice",
      created_by: "tom",
      revoked_at: null,
    });
    expect("token_hash" in principal).toBe(false);
    expect(JSON.stringify(wg.listPrincipals())).not.toContain("token_hash");
    const raw = wg.db
      .prepare("SELECT token_hash FROM api_principals WHERE id = ?")
      .get(principal.id) as { token_hash: string };
    expect(raw.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(raw.token_hash).not.toContain(token);
    const events = listEvents(wg.db, "principal", principal.id);
    expect(events.map((e) => e.event_type)).toEqual(["principal.created"]);
    expect(events[0]).toMatchObject({ actor_type: "human", actor_id: "tom" });
    wg.db.close();
  });

  it("validates names, refuses duplicates, honours capability/actor options", () => {
    const wg = Dispatch.open(":memory:", new TestClock());
    expect(() => wg.createPrincipal({ name: "bad name!" }, operator)).toThrow(/Principal name/);
    expect(() => wg.createPrincipal({ name: "" }, operator)).toThrow(/Principal name/);
    wg.createPrincipal({ name: "ci" }, operator);
    expect(() => wg.createPrincipal({ name: "ci" }, operator)).toThrow(/already exists/);
    const { principal } = wg.createPrincipal(
      { name: "viewer", capability: "read", actorType: "admin", actorId: "ops-team" },
      operator,
    );
    expect(principal).toMatchObject({
      capability: "read",
      actor_type: "admin",
      actor_id: "ops-team",
    });
    wg.db.close();
  });

  it("resolves an active token to its actor; revocation is recorded, idempotent, and ends resolution", () => {
    const clock = new TestClock();
    const wg = Dispatch.open(":memory:", clock);
    const { principal, token } = wg.createPrincipal(
      { name: "bob", actorId: "bob@example" },
      operator,
    );
    expect(wg.resolvePrincipalToken(token)).toMatchObject({
      actor: { type: "human", id: "bob@example" },
      principal: { id: principal.id },
    });
    expect(wg.resolvePrincipalToken(`${PRINCIPAL_TOKEN_PREFIX}nope`)).toBeNull();
    expect(wg.listPrincipals()[0]?.last_used_at).not.toBeNull();
    const revoked = wg.revokePrincipal("bob", operator);
    expect(revoked.revoked_at).not.toBeNull();
    expect(wg.resolvePrincipalToken(token)).toBeNull();
    expect(() => wg.revokePrincipal(principal.id, operator)).toThrow(/already revoked/);
    expect(() => wg.revokePrincipal("nobody", operator)).toThrow(/not found/i);
    expect(listEvents(wg.db, "principal", principal.id).map((e) => e.event_type)).toEqual([
      "principal.created",
      "principal.revoked",
    ]);
    expect(wg.verifyEventChain().ok).toBe(true);
    wg.db.close();
  });

  it("credentials never travel in the state bundle", () => {
    expect((EXPORT_TABLES as readonly string[]).includes("api_principals")).toBe(false);
  });
});

describe("principals (REST)", () => {
  const FULL = "shared-full-token-for-principal-tests-0123456789";
  const saved = process.env.DISPATCH_API_TOKEN;
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
    setPrincipalResolver(null);
    if (saved === undefined) delete process.env.DISPATCH_API_TOKEN;
    else process.env.DISPATCH_API_TOKEN = saved;
  });

  async function start(): Promise<{ base: string; wg: Dispatch }> {
    process.env.DISPATCH_AUDIT_OFF = "1";
    process.env.DISPATCH_API_TOKEN = FULL;
    const wg = Dispatch.open(":memory:", new TestClock());
    const server = createApiServer(wg);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    close = () =>
      new Promise<void>((resolve) =>
        server.close(() => {
          wg.db.close();
          resolve();
        }),
      );
    return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, wg };
  }
  const call = (base: string, method: string, path: string, token: string | null, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  it("mints, authenticates, attributes writes to the principal, and revokes", async () => {
    const { base } = await start();

    // Shared token: whoami is the single API actor, no principal.
    const me0 = (await (await call(base, "GET", "/api/whoami", FULL)).json()) as Record<
      string,
      unknown
    >;
    expect(me0).toEqual({
      capability: "full",
      actor: { type: "human", id: "dispatch-api" },
      principal: null,
    });

    // Mint with the shared (full) token.
    const created = await call(base, "POST", "/api/principals", FULL, {
      name: "alice",
      actor_id: "alice@corp",
    });
    expect(created.status).toBe(201);
    expect(created.headers.get("location")).toMatch(/^\/api\/principals\//);
    const { principal, token } = (await created.json()) as {
      principal: { id: string; name: string };
      token: string;
    };
    expect(token.startsWith(PRINCIPAL_TOKEN_PREFIX)).toBe(true);

    // The new token authenticates as alice.
    const me = (await (await call(base, "GET", "/api/whoami", token)).json()) as Record<
      string,
      unknown
    >;
    expect(me).toEqual({
      capability: "full",
      actor: { type: "human", id: "alice@corp" },
      principal: { id: principal.id, name: "alice" },
    });

    // A write made with it is attributed to alice, not to the shared actor.
    const t = await call(base, "POST", "/tickets", token, { title: "Alice's ticket" });
    expect(t.status).toBe(201);
    const { ticket } = (await t.json()) as { ticket: { id: string } };
    const ev = await call(base, "GET", `/tickets/${ticket.id}/events`, FULL);
    const events = (await ev.json()) as
      | { events?: Array<{ actor_id: string | null; actor_type: string }> }
      | Array<{ actor_id: string | null; actor_type: string }>;
    const rows = Array.isArray(events) ? events : (events.events ?? []);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((e) => e.actor_id === "alice@corp" && e.actor_type === "human")).toBe(true);

    // The list never carries token material.
    const list = await call(base, "GET", "/api/principals", token);
    expect(list.status).toBe(200);
    const listText = await list.text();
    expect(listText).toContain('"alice"');
    expect(listText).not.toContain("token_hash");
    expect(listText).not.toContain(token);

    // A read-scoped principal may list but not mutate — and may not mint.
    const r = (await (
      await call(base, "POST", "/api/principals", FULL, { name: "viewer", capability: "read" })
    ).json()) as { token: string };
    expect((await call(base, "GET", "/api/principals", r.token)).status).toBe(200);
    const denied = await call(base, "POST", "/tickets", r.token, { title: "nope" });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe(
      "READ_ONLY_TOKEN",
    );
    expect(
      (await call(base, "POST", "/api/principals", r.token, { name: "escalate" })).status,
    ).toBe(403);
    expect(
      ((await (await call(base, "GET", "/api/whoami", r.token)).json()) as { capability: string })
        .capability,
    ).toBe("read");

    // Duplicate name → 409; bad name → 422; unknown gfp_ token → 401.
    expect((await call(base, "POST", "/api/principals", FULL, { name: "alice" })).status).toBe(409);
    expect((await call(base, "POST", "/api/principals", FULL, { name: "not ok!" })).status).toBe(
      422,
    );
    expect(
      (
        await call(
          base,
          "GET",
          "/api/whoami",
          `${PRINCIPAL_TOKEN_PREFIX}unknown-token-value-0000000000`,
        )
      ).status,
    ).toBe(401);

    // Revoke by name (full tier), then the token is refused everywhere.
    const rev = await call(base, "DELETE", "/api/principals/alice", FULL);
    expect(rev.status).toBe(200);
    expect(
      ((await rev.json()) as { principal: { revoked_at: string | null } }).principal.revoked_at,
    ).not.toBeNull();
    expect((await call(base, "GET", "/api/whoami", token)).status).toBe(401);
    expect((await call(base, "GET", "/tickets", token)).status).toBe(401);
    expect((await call(base, "DELETE", "/api/principals/alice", FULL)).status).toBe(409);
    expect((await call(base, "DELETE", "/api/principals/ghost", FULL)).status).toBe(404);
    // A revoked principal cannot revoke others (its token is dead), and a read one is 403.
    expect((await call(base, "DELETE", "/api/principals/viewer", r.token)).status).toBe(403);
  });
});

// SEALED PRINCIPALS, an independent review's attacks. The attacker is a process that can
// write dispatch.sqlite freely (every table, any row; it can append or rewrite events and
// recompute the unkeyed hash chain) but cannot read the factory key. Its goal: act as a
// person. Each case below is one attack, and each must fail.

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { eventHash, latestEventHash } from "../src/events/eventChain.js";
import { fileGateKeyring } from "../src/events/gateSeal.js";
import { verifyPrincipal } from "../src/events/principalSeal.js";
import { rowSealFullWalks } from "../src/events/rowSeal.js";
import { systemClock } from "../src/util/clock.js";

const operator: Actor = { type: "human", id: "tom" };

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function factory(keysDir?: string) {
  const root = mkdtempSync(join(tmpdir(), "principal-attack-"));
  roots.push(root);
  const data = join(root, "data");
  const keys = keysDir ?? join(root, "keys");
  const dbPath = join(data, "dispatch.sqlite");
  mkdirSync(data, { recursive: true });
  const keyring = () => fileGateKeyring({ dbPath, keysDir: keys });
  const open = () => Dispatch.open(dbPath, systemClock, undefined, { gateKeyring: keyring() });
  return { root, dbPath, keysDir: keys, keyring, open };
}

function sha(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Append one event with a consistent chain hash, as any database writer can. */
function appendEvent(
  wg: Dispatch,
  ev: {
    entity_type: string;
    entity_id: string;
    actor_type: string;
    actor_id: string | null;
    event_type: string;
    payload: unknown;
  },
): string {
  const id = `forged-ev-${randomBytes(6).toString("hex")}`;
  const row = {
    id,
    entity_type: ev.entity_type,
    entity_id: ev.entity_id,
    actor_type: ev.actor_type,
    actor_id: ev.actor_id,
    event_type: ev.event_type,
    payload_json: JSON.stringify(ev.payload),
    correlation_id: null,
    created_at: new Date().toISOString(),
  };
  const prev = latestEventHash(wg.db);
  wg.db
    .prepare(
      "INSERT INTO work_events (id, entity_type, entity_id, actor_type, actor_id, event_type, payload_json, correlation_id, created_at, prev_hash, hash) " +
        "VALUES (@id, @entity_type, @entity_id, @actor_type, @actor_id, @event_type, @payload_json, @correlation_id, @created_at, @prev_hash, @hash)",
    )
    .run({ ...row, prev_hash: prev, hash: eventHash(prev, row as never) });
  return id;
}

/** A forged admin row AND a `principal.created` event for it that matches it. */
function forgeRowWithCreation(wg: Dispatch, name: string): string {
  const token = `gfp_${randomBytes(32).toString("base64url")}`;
  const id = `forged-${name}`;
  wg.db
    .prepare(
      "INSERT INTO api_principals (id, name, token_hash, capability, actor_type, actor_id, created_by, created_at) " +
        "VALUES (?, ?, ?, 'full', 'admin', ?, 'tom', ?)",
    )
    .run(id, name, sha(token), name, new Date().toISOString());
  appendEvent(wg, {
    entity_type: "principal",
    entity_id: id,
    actor_type: "human",
    actor_id: "tom",
    event_type: "principal.created",
    payload: { name, capability: "full", actor_type: "admin", actor_id: name },
  });
  return token;
}

describe("re-sign --all cannot be made to bless a forged row", () => {
  it("a forged row with a forged principal.created event is not signed by the operator's routine --all", () => {
    const f = factory();
    const wg = f.open();
    // A genuine principal from before signing (its seal is what an upgrade lacks).
    const legacy = wg.createPrincipal({ name: "alice" }, operator);
    wg.db.exec("DELETE FROM row_seals");
    // The attacker's row, with a creation event that matches it, appended to the chain.
    const forged = forgeRowWithCreation(wg, "intruder");
    // Some trusted write anchors the head (the forged event included).
    wg.createTicket({ title: "anything", description: "x" }, operator);

    // The operator runs the routine step WITHOUT having reviewed this exact list: refused.
    expect(() => wg.resignPrincipals({ all: true }, operator)).toThrow(/review/i);
    expect(wg.resolvePrincipalToken(forged)).toBeNull();
    expect(wg.resolvePrincipalToken(legacy.token)).toBeNull();

    // The operator reviews the list: it shows the forged row with what it may do.
    const review = wg.reviewUnsignedPrincipals();
    expect(review.unsigned.map((u) => u.name).sort()).toEqual(["alice", "intruder"]);
    const intruder = review.unsigned.find((u) => u.name === "intruder")!;
    expect(intruder).toMatchObject({
      capability: "full",
      actor_type: "admin",
      created_by: "tom",
      scope: null,
    });

    // A row added after the review is not signed by a confirmation of the reviewed list.
    const late = forgeRowWithCreation(wg, "late");
    expect(() => wg.resignPrincipals({ all: true, confirm: review.fingerprint }, operator)).toThrow(
      /changed since/i,
    );
    expect(wg.resolvePrincipalToken(late)).toBeNull();
    expect(wg.resolvePrincipalToken(legacy.token)).toBeNull();
  });
});

describe("other attacks", () => {
  it("a seal does not carry across data directories (the key is per data path)", () => {
    const shared = mkdtempSync(join(tmpdir(), "principal-attack-keys-"));
    roots.push(shared);
    const a = factory(shared);
    const b = factory(shared);
    const wa = a.open();
    const { principal, token } = wa.createPrincipal({ name: "alice" }, operator);
    const row = wa.db.prepare("SELECT * FROM api_principals WHERE id = ?").get(principal.id);
    const seal = wa.db.prepare("SELECT * FROM row_seals WHERE row_id = ?").get(principal.id);
    const evs = wa.db.prepare("SELECT * FROM work_events ORDER BY rowid").all() as Array<
      Record<string, unknown>
    >;
    wa.db.close();
    const wb = b.open();
    wb.db.exec("DELETE FROM work_events");
    const insEv = wb.db.prepare(
      "INSERT INTO work_events (id, entity_type, entity_id, actor_type, actor_id, event_type, payload_json, correlation_id, created_at, prev_hash, hash) " +
        "VALUES (@id, @entity_type, @entity_id, @actor_type, @actor_id, @event_type, @payload_json, @correlation_id, @created_at, @prev_hash, @hash)",
    );
    for (const e of evs) insEv.run(e);
    wb.db
      .prepare(
        "INSERT INTO api_principals (id, name, token_hash, capability, actor_type, actor_id, scope_repos, scope_tickets, created_at, created_by, revoked_at, last_used_at) " +
          "VALUES (@id, @name, @token_hash, @capability, @actor_type, @actor_id, @scope_repos, @scope_tickets, @created_at, @created_by, @revoked_at, @last_used_at)",
      )
      .run(row);
    wb.db
      .prepare(
        "INSERT INTO row_seals (kind, row_id, event_id, facts_json, key_id, mac, created_at) VALUES (@kind, @row_id, @event_id, @facts_json, @key_id, @mac, @created_at)",
      )
      .run(seal);
    expect(wb.resolvePrincipalToken(token)).toBeNull();
    wb.db.close();
  });

  it("the revocation event rewritten in place (id and hash kept, so the anchor row still matches) does not revive", () => {
    const f = factory();
    const wg = f.open();
    const { principal, token } = wg.createPrincipal({ name: "bob" }, operator);
    const oldSeal = wg.db.prepare("SELECT * FROM row_seals WHERE row_id = ?").get(principal.id);
    wg.revokePrincipal("bob", operator);
    wg.db.prepare("UPDATE api_principals SET revoked_at = NULL WHERE id = ?").run(principal.id);
    wg.db
      .prepare(
        "INSERT INTO row_seals (kind, row_id, event_id, facts_json, key_id, mac, created_at) VALUES (@kind, @row_id, @event_id, @facts_json, @key_id, @mac, @created_at)",
      )
      .run(oldSeal);
    wg.db
      .prepare(
        "UPDATE work_events SET event_type = 'principal.noted' WHERE entity_id = ? AND event_type = 'principal.revoked'",
      )
      .run(principal.id);
    const v = verifyPrincipal(wg.db, f.keyring(), principal.id);
    expect(v).toMatchObject({ ok: false, failure: "chain" });
    expect(wg.resolvePrincipalToken(token)).toBeNull();
  });

  it("a revoked principal re-inserted under a new id with its old token hash and its old seal is refused", () => {
    const f = factory();
    const wg = f.open();
    const { principal, token } = wg.createPrincipal({ name: "carl" }, operator);
    const row = wg.db
      .prepare("SELECT * FROM api_principals WHERE id = ?")
      .get(principal.id) as Record<string, unknown>;
    const seal = wg.db
      .prepare("SELECT * FROM row_seals WHERE row_id = ?")
      .get(principal.id) as Record<string, unknown>;
    wg.revokePrincipal("carl", operator);
    // token_hash is UNIQUE: the attacker deletes the revoked row first.
    wg.db.prepare("DELETE FROM api_principals WHERE id = ?").run(principal.id);
    wg.db
      .prepare(
        "INSERT INTO api_principals (id, name, token_hash, capability, actor_type, actor_id, created_at, created_by) VALUES ('carl-2', 'carl-2', ?, ?, ?, ?, ?, ?)",
      )
      .run(
        row.token_hash,
        row.capability,
        row.actor_type,
        row.actor_id,
        row.created_at,
        row.created_by,
      );
    wg.db
      .prepare(
        "INSERT INTO row_seals (kind, row_id, event_id, facts_json, key_id, mac, created_at) VALUES ('principal', 'carl-2', ?, ?, ?, ?, ?)",
      )
      .run(seal.event_id, seal.facts_json, seal.key_id, seal.mac, seal.created_at);
    expect(wg.resolvePrincipalToken(token)).toBeNull();
  });

  // The chain walk is incremental per handle (a full walk costs most of a second on a
  // large log). These attacks come from ANOTHER connection (the attacker is another
  // process) after the server's memo is warm: each must still be caught.
  for (const how of ["rewritten in place", "deleted", "deleted and rechained"] as const) {
    it(`with a warm chain memo, a revocation ${how} by another process does not revive`, () => {
      const f = factory();
      const wg = f.open();
      const live = wg.createPrincipal({ name: "live" }, operator);
      const { principal, token } = wg.createPrincipal({ name: "bob" }, operator);
      const oldSeal = wg.db.prepare("SELECT * FROM row_seals WHERE row_id = ?").get(principal.id);
      wg.revokePrincipal("bob", operator);
      wg.createTicket({ title: "later", description: "x" }, operator);
      expect(wg.resolvePrincipalToken(live.token)).not.toBeNull(); // the memo is warm
      const other = new Database(f.dbPath);
      try {
        other.prepare("UPDATE api_principals SET revoked_at = NULL WHERE id = ?").run(principal.id);
        other
          .prepare(
            "INSERT INTO row_seals (kind, row_id, event_id, facts_json, key_id, mac, created_at) VALUES (@kind, @row_id, @event_id, @facts_json, @key_id, @mac, @created_at)",
          )
          .run(oldSeal);
        if (how === "rewritten in place") {
          other
            .prepare(
              "UPDATE work_events SET event_type = 'principal.noted' WHERE entity_id = ? AND event_type = 'principal.revoked'",
            )
            .run(principal.id);
        } else {
          other
            .prepare(
              "DELETE FROM work_events WHERE entity_id = ? AND event_type = 'principal.revoked'",
            )
            .run(principal.id);
          if (how === "deleted and rechained") rechain(other);
        }
      } finally {
        other.close();
      }
      expect(wg.resolvePrincipalToken(token)).toBeNull();
    });
  }

  it("after the first check, a sign-in walks only what was appended, whoever wrote it", () => {
    const f = factory();
    const wg = f.open();
    const { token } = wg.createPrincipal({ name: "fast" }, operator);
    expect(wg.resolvePrincipalToken(token)).not.toBeNull();
    const walks = rowSealFullWalks();
    for (let i = 0; i < 3; i++) {
      wg.createTicket({ title: `own ${i}`, description: "x" }, operator); // the server's write
      expect(wg.resolvePrincipalToken(token)).not.toBeNull();
      const other = new Database(f.dbPath); // another process appends
      try {
        appendEventTo(other, i);
      } finally {
        other.close();
      }
      expect(wg.resolvePrincipalToken(token)).not.toBeNull();
    }
    expect(rowSealFullWalks()).toBe(walks);
  });

  it("a corrupt event under a warm memo, written by another process, refuses (fails closed)", () => {
    const f = factory();
    const wg = f.open();
    const { token } = wg.createPrincipal({ name: "dora" }, operator);
    expect(wg.resolvePrincipalToken(token)).not.toBeNull();
    const other = new Database(f.dbPath);
    try {
      // Its own creation event, rewritten with a payload that is not text.
      other.exec("UPDATE work_events SET payload_json = x'00ff' WHERE rowid = 1");
    } finally {
      other.close();
    }
    expect(wg.resolvePrincipalToken(token)).toBeNull();
  });

  it("a verification error refuses rather than throws", () => {
    const f = factory();
    const wg = f.open();
    const { principal, token } = wg.createPrincipal({ name: "erin" }, operator);
    wg.db.exec("ALTER TABLE work_events RENAME TO work_events_gone");
    expect(verifyPrincipal(wg.db, f.keyring(), principal.id)).toMatchObject({
      ok: false,
      failure: "unreadable",
    });
    expect(wg.resolvePrincipalToken(token)).toBeNull();
  });
});

/** Append a chained note from another connection. */
function appendEventTo(db: Database.Database, i: number): void {
  const prev = (
    db.prepare("SELECT hash FROM work_events ORDER BY rowid DESC LIMIT 1").get() as { hash: string }
  ).hash;
  const row = {
    id: `other-${i}-${randomBytes(4).toString("hex")}`,
    entity_type: "ticket",
    entity_id: "t",
    actor_type: "agent",
    actor_id: "a",
    event_type: "ticket.note",
    payload_json: "{}",
    correlation_id: null,
    created_at: new Date().toISOString(),
  };
  db.prepare(
    "INSERT INTO work_events (id, entity_type, entity_id, actor_type, actor_id, event_type, payload_json, correlation_id, created_at, prev_hash, hash) " +
      "VALUES (@id, @entity_type, @entity_id, @actor_type, @actor_id, @event_type, @payload_json, @correlation_id, @created_at, @prev_hash, @hash)",
  ).run({ ...row, prev_hash: prev, hash: eventHash(prev, row as never) });
}

/** Recompute every row's chain hash (what a writer does after deleting a row). */
function rechain(db: Database.Database): void {
  const rows = db
    .prepare(
      "SELECT rowid AS seq, id, entity_type, entity_id, actor_type, actor_id, event_type, payload_json, correlation_id, created_at FROM work_events ORDER BY rowid",
    )
    .all() as Array<Record<string, unknown> & { seq: number }>;
  let prev = "0".repeat(64);
  const upd = db.prepare("UPDATE work_events SET prev_hash = ?, hash = ? WHERE rowid = ?");
  for (const r of rows) {
    const h = eventHash(prev, r as never);
    upd.run(prev, h, r.seq);
    prev = h;
  }
}

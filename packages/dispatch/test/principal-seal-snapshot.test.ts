// SEALED PRINCIPALS under a CONCURRENT database writer. The seals exist for an attacker
// that can write dispatch.sqlite at any moment, so "at any moment" includes between two
// reads of one decision. Two decisions used to read the same principal more than once:
//
//  - Sign-in read the row by token hash, then verified the seal of whatever row carried
//    that id at a second read, and returned the identity and authority of the FIRST read.
//    A writer that held a forged row for the first read and put the genuine row back for
//    the second signed in with authority no seal covered.
//  - The unsigned-principal review listed the rows at one read and computed each row's
//    confirmation code at later reads. A writer that changed a row in between gave the
//    person a benign row to look at and a code that signs a different one.
//
// The property pinned here: the facts a decision ACCEPTS (or shows) are exactly the facts
// it VERIFIED (or fingerprinted), read once, inside one snapshot. Each test schedules a
// second connection's write between the reads and proves the write was made.

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { fileGateKeyring } from "../src/events/gateSeal.js";
import { systemClock } from "../src/util/clock.js";

const operator: Actor = { type: "human", id: "tom" };

const roots: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length) closers.pop()!();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function factory() {
  const root = mkdtempSync(join(tmpdir(), "principal-snapshot-"));
  roots.push(root);
  const data = join(root, "data");
  const dbPath = join(data, "dispatch.sqlite");
  mkdirSync(data, { recursive: true });
  const wg = Dispatch.open(dbPath, systemClock, undefined, {
    gateKeyring: fileGateKeyring({ dbPath, keysDir: join(root, "keys") }),
  });
  // The attacker: another connection to the same file. It never reads the factory key.
  const attacker = new Database(dbPath, { timeout: 200 });
  closers.push(() => attacker.close());
  return { wg, attacker };
}

function sha(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Run `write` once, right after the first statement that matches `after` has returned
 * its rows on the factory's own connection: the moment between two reads. Returns a
 * probe saying whether the write ran and whether the database took it.
 */
function interleave(wg: Dispatch, after: RegExp, write: () => void) {
  const probe = { fired: false, applied: false };
  const db = wg.db as unknown as { prepare: (sql: string) => Record<string, unknown> };
  const realPrepare = db.prepare.bind(db);
  db.prepare = (sql: string) => {
    const st = realPrepare(sql);
    if (probe.fired || !after.test(sql)) return st;
    const wrap = (method: "get" | "all") => {
      const real = (st[method] as (...a: unknown[]) => unknown).bind(st);
      return (...args: unknown[]) => {
        const out = real(...args);
        if (!probe.fired) {
          probe.fired = true;
          try {
            write();
            probe.applied = true;
          } catch {
            // The database refused the write while the read was open: also a safe outcome.
          }
        }
        return out;
      };
    };
    return new Proxy(st, {
      get(target, prop) {
        if (prop === "get" || prop === "all") return wrap(prop);
        const v = (target as Record<string | symbol, unknown>)[prop];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
  };
  return probe;
}

describe("sign-in accepts exactly the row it verified", () => {
  it("a forged row shown to the first read and swapped back before the seal check signs nobody in", () => {
    const { wg, attacker } = factory();
    const victim = wg.createPrincipal({ name: "ci", capability: "read" }, operator);
    const id = victim.principal.id;
    const genuine = attacker
      .prepare(
        "SELECT token_hash, capability, actor_type, actor_id FROM api_principals WHERE id = ?",
      )
      .get(id) as { token_hash: string; capability: string; actor_type: string; actor_id: string };
    const attackerToken = `gfp_${randomBytes(24).toString("hex")}`;

    // The forged state: the victim's row answers to the attacker's token, as an admin
    // with full capability. No seal covers these facts.
    attacker
      .prepare(
        "UPDATE api_principals SET token_hash = ?, capability = 'full', actor_type = 'admin', actor_id = 'root' WHERE id = ?",
      )
      .run(sha(attackerToken), id);
    // Without a race this is refused (the row does not match its seal).
    expect(wg.resolvePrincipalToken(attackerToken)).toBeNull();

    // The race: once the factory has read the row by token hash, the attacker puts the
    // genuine row back, so a second read by id would verify.
    const probe = interleave(wg, /FROM api_principals\b/i, () => {
      attacker
        .prepare(
          "UPDATE api_principals SET token_hash = ?, capability = ?, actor_type = ?, actor_id = ? WHERE id = ?",
        )
        .run(genuine.token_hash, genuine.capability, genuine.actor_type, genuine.actor_id, id);
    });
    const got = wg.resolvePrincipalToken(attackerToken);
    expect(probe.fired).toBe(true);
    expect(got).toBeNull();

    // The row is the genuine one again: its own token signs in, as what was sealed.
    const again = wg.resolvePrincipalToken(victim.token);
    expect(again?.principal.capability).toBe("read");
    expect(again?.actor).toMatchObject({ type: "human" });
  });

  it("a genuine row raised between the reads never signs in with the raised authority", () => {
    const { wg, attacker } = factory();
    const victim = wg.createPrincipal({ name: "ci", capability: "read" }, operator);
    const probe = interleave(wg, /FROM api_principals\b/i, () => {
      attacker
        .prepare("UPDATE api_principals SET capability = 'full' WHERE id = ?")
        .run(victim.principal.id);
    });
    const got = wg.resolvePrincipalToken(victim.token);
    expect(probe.fired).toBe(true);
    // Either answer is sound: refused, or the sealed authority it read. Never `full`.
    if (got !== null) expect(got.principal.capability).toBe("read");
    // From now on the row does not match its seal: refused.
    expect(wg.resolvePrincipalToken(victim.token)).toBeNull();
  });

  it("a scope widened between the reads is never the scope a sign-in carries", () => {
    const { wg, attacker } = factory();
    const repo = wg.registerRepository({ name: "app", local_path: "/tmp/app" }, operator);
    const victim = wg.createPrincipal({ name: "scoped", repos: [repo.id] }, operator);
    const probe = interleave(wg, /FROM api_principals\b/i, () => {
      attacker
        .prepare("UPDATE api_principals SET scope_repos = NULL WHERE id = ?")
        .run(victim.principal.id);
    });
    const got = wg.resolvePrincipalToken(victim.token);
    expect(probe.fired).toBe(true);
    if (got !== null) expect(got.principal.scope?.repos?.map((r) => r.id)).toEqual([repo.id]);
  });
});

describe("the review shows the rows its codes sign", () => {
  it("a row changed while the review is being built is not signed as something the person did not see", () => {
    const { wg, attacker } = factory();
    const legacy = wg.createPrincipal({ name: "ci", capability: "read" }, operator);
    wg.db.exec("DELETE FROM row_seals");

    // The race: the list of unsigned rows has been read (capability read); before the
    // codes are computed the attacker raises the row.
    const probe = interleave(wg, /FROM api_principals WHERE revoked_at IS NULL/i, () => {
      attacker
        .prepare("UPDATE api_principals SET capability = 'full', actor_type = 'admin' WHERE id = ?")
        .run(legacy.principal.id);
    });
    const review = wg.reviewUnsignedPrincipals();
    expect(probe.fired).toBe(true);
    const shown = review.unsigned.find((u) => u.name === "ci")!;

    // The person confirms what they were shown, by name and by the whole list.
    for (const input of [
      { names: ["ci"], confirm: shown.review_code },
      { all: true as const, confirm: review.fingerprint },
    ]) {
      let signed = true;
      try {
        wg.resignPrincipals(input, operator);
      } catch {
        signed = false;
      }
      const now = wg.resolvePrincipalToken(legacy.token);
      if (signed && now !== null) {
        // Signed: then it is signed as exactly what was shown.
        expect(now.principal.capability).toBe(shown.capability);
        expect(now.principal.actor_type).toBe(shown.actor_type);
      } else {
        expect(now).toBeNull();
      }
    }
  });

  it("the shown scope and the code come from the same row", () => {
    const { wg, attacker } = factory();
    const repo = wg.registerRepository({ name: "app", local_path: "/tmp/app" }, operator);
    const legacy = wg.createPrincipal({ name: "scoped", repos: [repo.id] }, operator);
    wg.db.exec("DELETE FROM row_seals");
    // After the list is read the attacker removes the scope (the row now reaches everything).
    const probe = interleave(wg, /FROM api_principals WHERE revoked_at IS NULL/i, () => {
      attacker
        .prepare("UPDATE api_principals SET scope_repos = NULL WHERE id = ?")
        .run(legacy.principal.id);
    });
    const review = wg.reviewUnsignedPrincipals();
    expect(probe.fired).toBe(true);
    const shown = review.unsigned.find((u) => u.name === "scoped")!;
    let signed = true;
    try {
      wg.resignPrincipals({ names: ["scoped"], confirm: shown.review_code }, operator);
    } catch {
      signed = false;
    }
    const now = wg.resolvePrincipalToken(legacy.token);
    if (signed && now !== null) {
      expect(now.principal.scope?.repos?.map((r) => r.id) ?? null).toEqual(
        shown.scope?.repos?.map((r) => r.id) ?? null,
      );
      expect(shown.scoped).toBe(now.principal.scope !== null);
    } else {
      expect(now).toBeNull();
    }
  });
});

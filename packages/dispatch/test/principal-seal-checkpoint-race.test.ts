// SEALED PRINCIPALS: the event-log anchor and the verified chain checkpoint are two records
// outside the database, and a sign-in must read them as one consistent pair.
//
// External review 20 reproduced it with two Dispatch connections and one ordinary event:
// the reader captured anchor N, a legitimate writer committed one event, moved the anchor
// to N+1 and recorded the checkpoint at N+1, and the reader then read that checkpoint
// beside its captured anchor: "the chain checkpoint names row N+1, past the anchored head
// N". A genuine principal was refused, and the refusal stayed cached on the handle (keyed
// only on PRAGMA data_version) for the next attempts too.
//
// The invariant pinned here: a writer moves the anchor on only after its commit, and the
// checkpoint only up to a row an anchor it read already named, so a checkpoint read BEFORE
// the anchor can never be past it. The verification reads the checkpoint first, then the
// anchor, both before its read snapshot opens. A writer between the two reads, or between
// the reads and the snapshot, cannot make a genuine principal fail. A checkpoint that is
// really past the anchor (the anchor rolled back under it) is still refused.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import { inTransaction } from "../src/db/connection.js";
import type { Actor } from "../src/domain/types.js";
import { writeEvent } from "../src/events/eventWriter.js";
import { factoryKeyId, fileGateKeyring, type GateKeyring } from "../src/events/gateSeal.js";
import { setUnsignedPrincipalLog } from "../src/services/principalAdminService.js";
import { systemClock } from "../src/util/clock.js";
import { repoNamed, ticketOn } from "./helpers/autonomyLadder.js";

const operator: Actor = { type: "human", id: "tom" };

const roots: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  setUnsignedPrincipalLog(null);
  while (closers.length) closers.pop()!();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

interface World {
  dbPath: string;
  keysDir: string;
  anchorDir: string;
  cpPath: string;
}

function world(): World {
  const root = mkdtempSync(join(tmpdir(), "principal-cp-race-"));
  roots.push(root);
  const data = join(root, "data");
  mkdirSync(data, { recursive: true });
  const dbPath = join(data, "dispatch.sqlite");
  const keysDir = join(root, "keys");
  fileGateKeyring({ dbPath, keysDir }).ensure();
  const anchorDir = join(keysDir, `${factoryKeyId(dbPath)}.anchor`);
  return { dbPath, keysDir, anchorDir, cpPath: join(anchorDir, "chain-checkpoint.json") };
}

/** A process on the factory: a fresh handle, so a fresh chain memory. */
function proc(w: World, keyring?: GateKeyring): Dispatch {
  const wg = Dispatch.open(w.dbPath, systemClock, undefined, {
    gateKeyring: keyring ?? fileGateKeyring({ dbPath: w.dbPath, keysDir: w.keysDir }),
  });
  closers.push(() => wg.db.close());
  return wg;
}

/**
 * The factory key, with a hook that runs once right after the named external record has
 * been read: the moment a concurrent writer can slip in.
 */
function hookedKeyring(w: World) {
  const real = fileGateKeyring({ dbPath: w.dbPath, keysDir: w.keysDir });
  const hook: { on: "anchor" | "checkpoint" | null; run: () => void; fired: boolean } = {
    on: null,
    run: () => {},
    fired: false,
  };
  const fire = (what: "anchor" | "checkpoint") => {
    if (hook.on !== what || hook.fired) return;
    hook.fired = true;
    hook.run();
  };
  const keyring: GateKeyring = {
    ...real,
    readAnchor: () => {
      const a = real.readAnchor!();
      fire("anchor");
      return a;
    },
    readCheckpoint: () => {
      const c = real.readCheckpoint!();
      fire("checkpoint");
      return c;
    },
  };
  return { keyring, hook };
}

function checkpointSeq(w: World): number {
  const file = JSON.parse(readFileSync(w.cpPath, "utf8")) as { body: string };
  return (JSON.parse(file.body) as { seq: number }).seq;
}

function anchorFiles(w: World): string[] {
  return readdirSync(w.anchorDir)
    .filter((n) => /^\d{16}\.json$/.test(n))
    .sort();
}

function anchorSeq(w: World): number {
  return Number(anchorFiles(w).at(-1)!.slice(0, 16));
}

function pad(wg: Dispatch, n: number) {
  if (n <= 0) return;
  inTransaction(wg.db, () => {
    for (let i = 0; i < n; i++) {
      writeEvent(wg.db, {
        entity_type: "note",
        entity_id: "pad",
        actor: operator,
        event_type: "note.added",
        payload: { i },
      });
    }
  });
}

/**
 * A factory with a principal and a recorded checkpoint, padded so that the NEXT single
 * commit brings a verifier exactly one stride past the checkpoint: that verifier records
 * a new checkpoint at the new head.
 */
function setup(w: World) {
  const a = proc(w);
  const p = a.createPrincipal({ name: "ci", capability: "read" }, operator);
  pad(a, 40);
  // The first verification walks from genesis and records the checkpoint at the anchor.
  expect(a.resolvePrincipalToken(p.token)?.principal.id).toBe(p.principal.id);
  const cp = checkpointSeq(w);
  expect(cp).toBe(anchorSeq(w));
  pad(a, cp + 511 - anchorSeq(w));
  expect(anchorSeq(w)).toBe(cp + 511);
  return { token: p.token, id: p.principal.id, cp };
}

/** The legitimate writer: one ordinary event, then a verification that records a checkpoint. */
function legitimateWriter(w: World, token: string) {
  const writer = proc(w);
  return () => {
    pad(writer, 1);
    expect(writer.resolvePrincipalToken(token)).not.toBeNull();
  };
}

describe("a sign-in under a legitimate checkpoint update", () => {
  for (const on of ["anchor", "checkpoint"] as const) {
    it(`a writer moving anchor and checkpoint on right after the ${on} read refuses no one, now or next`, () => {
      const w = world();
      const { token, id, cp } = setup(w);
      const { keyring, hook } = hookedKeyring(w);
      const reader = proc(w, keyring);
      const refusals: string[] = [];
      setUnsignedPrincipalLog((line) => refusals.push(line));

      hook.on = on;
      hook.run = legitimateWriter(w, token);
      const first = reader.resolvePrincipalToken(token);
      // The interleaving happened: one event, the anchor and the checkpoint both moved on.
      expect(hook.fired).toBe(true);
      expect(anchorSeq(w)).toBe(cp + 512);
      expect(checkpointSeq(w)).toBe(cp + 512);

      // The immediately following attempts on the same handle, with nothing else committed.
      const second = reader.resolvePrincipalToken(token);
      const third = reader.resolvePrincipalToken(token);
      expect({
        refusals,
        signedIn: [first, second, third].map((r) => r?.principal.id ?? null),
      }).toEqual({ refusals: [], signedIn: [id, id, id] });
    });
  }

  it("a refusal computed from the external records does not outlive them on the handle", () => {
    const w = world();
    const { token, id } = setup(w);
    const reader = proc(w);
    const genuine = readFileSync(w.cpPath);
    // A checkpoint that does not verify under the key: refused.
    const file = JSON.parse(genuine.toString("utf8")) as { body: string; mac: string };
    writeFileSync(w.cpPath, JSON.stringify({ body: file.body, mac: "ab".repeat(32) }));
    expect(reader.resolvePrincipalToken(token)).toBeNull();
    expect(reader.resolvePrincipalToken(token)).toBeNull();
    // The genuine checkpoint is back; the database did not change. The refusal was about
    // the external record, so it is computed again, and the principal signs in.
    writeFileSync(w.cpPath, genuine);
    expect(reader.resolvePrincipalToken(token)?.principal.id).toBe(id);
  });
});

describe("an autonomy decision under a legitimate checkpoint update", () => {
  // The autonomy decision verifies with the keyring itself (no pinned snapshot): the same
  // order holds there, the checkpoint read before the anchor.
  const FLAGS = ["AUTO_MERGE", "MERGE_ON_AGENT_REVIEW", "DISPATCH_ALLOW_AGENT_APPROVE"];
  for (const on of ["anchor", "checkpoint"] as const) {
    it(`a writer moving anchor and checkpoint on right after the ${on} read leaves a signed row allowed`, () => {
      const saved = FLAGS.map((f) => [f, process.env[f]] as const);
      for (const f of FLAGS) delete process.env[f];
      try {
        const w = world();
        const { token, cp } = setup(w);
        const a = proc(w);
        const api = repoNamed(a, "api");
        a.setAutonomyPolicy(
          { repoId: api, riskLevel: "low", gate: "merge", mode: "auto", confirm: true },
          operator,
        );
        const t = ticketOn(a, "api", "low");
        // Bring the log back to one commit short of a new checkpoint.
        expect(a.autonomyGateDecision(a.resolveTicket(t.id), "merge").decision).toBe("allow");
        const base = checkpointSeq(w);
        expect(base).toBeGreaterThanOrEqual(cp);
        pad(a, base + 511 - anchorSeq(w));
        const { keyring, hook } = hookedKeyring(w);
        const reader = proc(w, keyring);
        hook.on = on;
        hook.run = legitimateWriter(w, token);
        const decisions = [0, 1, 2].map(
          () => reader.autonomyGateDecision(reader.resolveTicket(t.id), "merge").decision,
        );
        expect(hook.fired).toBe(true);
        expect(checkpointSeq(w)).toBeGreaterThan(base);
        expect(decisions).toEqual(["allow", "allow", "allow"]);
      } finally {
        for (const [f, v] of saved) {
          if (v === undefined) delete process.env[f];
          else process.env[f] = v;
        }
      }
    });
  }
});

describe("a checkpoint really past the anchor is still refused", () => {
  it("the anchor rolled back under a newer genuine checkpoint: refused, and refused again", () => {
    const w = world();
    const { token, cp } = setup(w);
    const older = anchorFiles(w).at(-1)!;
    const olderBody = readFileSync(join(w.anchorDir, older));
    legitimateWriter(w, token)();
    expect(checkpointSeq(w)).toBe(cp + 512);
    // The anchor is put back to the earlier head; the checkpoint is not.
    for (const n of anchorFiles(w)) rmSync(join(w.anchorDir, n));
    writeFileSync(join(w.anchorDir, older), olderBody);
    const refusals: string[] = [];
    setUnsignedPrincipalLog((line) => refusals.push(line));
    const reader = proc(w);
    expect(reader.resolvePrincipalToken(token)).toBeNull();
    expect(reader.resolvePrincipalToken(token)).toBeNull();
    expect(refusals.join("\n")).toMatch(/past the anchored head/);
  });
});

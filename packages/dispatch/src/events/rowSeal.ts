import { timingSafeEqual } from "node:crypto";

import { EVENT_CHAIN_GENESIS, eventHash, type ChainedEventFields } from "./eventChain.js";
import {
  anchorRowPresent,
  GateKeyError,
  type AnchorRead,
  type GateKeyring,
  type SealDb,
} from "./gateSeal.js";

/**
 * SEALED CONTROL ROWS. Signed gate events protect the ACTS (an approval, a tester
 * verdict) and the event chain. The rows that decide WHO may act (a principal) and WHAT a
 * trusted key holder may do on its own (part B: an autonomy policy, a ticket's risk level)
 * were plain rows: a process that can write the sqlite file inserted one and a trusted key
 * holder then signed a real approval for it, without anyone forging a MAC.
 *
 * A control row is now honoured only with a valid ROW SEAL: HMAC-SHA256 under the factory
 * key over the row's identity and authority (its FACTS, chosen by the caller), and the
 * event that last set that state (its id and chain hash, so the seal is bound to its place
 * in the log). Verification, every time, at the decision point:
 *  1. the seal row exists and its MAC verifies over the row's facts AS THEY ARE NOW (a
 *     raised capability, a widened scope, a swapped token hash: refused);
 *  2. the bound event is on record, about this row, with the hash the seal signed;
 *  3. the bound event is the LATEST lifecycle event of the row (a later revocation undoes
 *     it, whatever a column says; a copy of the old seal restored after a revocation is
 *     superseded by the revocation event);
 *  4. the event log still holds the head the host anchored outside the database, and the
 *     chain verifies up to it (a revocation event deleted from the log breaks this, as it
 *     does for a landing).
 * Nothing here creates a key or a seal on the verify side.
 *
 * Generic: a caller names its `kind`, the row id, the entity type and lifecycle event
 * types its events use, and the facts. Seals live in `row_seals` (machine-local, never
 * exported, dropped on import, like `gate_seals`). Every read goes through
 * `prepare(sql).get/all/run`, so the runner (node:sqlite) can verify the same way.
 */

export const ROW_SEAL_VERSION = 1;

/** A fact value as a seal binds it: a string or null (numbers are bound as strings). */
export type RowFacts = Readonly<Record<string, string | number | null | undefined>>;

export type RowSealFailure =
  "missing_key" | "unsigned" | "mismatch" | "superseded" | "truncated" | "chain" | "unreadable";

export type RowSealCheck =
  | { ok: true; eventId: string }
  | { ok: false; failure: RowSealFailure; detail: string; changed?: string[] };

/** What identifies a sealed row and the events that move its state. */
export interface RowSealSubject {
  /** The seal kind (e.g. "principal", part B: "autonomy_policy", "ticket_risk"). */
  kind: string;
  rowId: string;
  /** The `work_events.entity_type` of the row's lifecycle events. */
  entityType: string;
  /** The lifecycle event types; the seal's bound event must be the newest of these. */
  lifecycleEvents: readonly string[];
}

/** Canonical JSON of the facts: keys sorted, every value a string or null. */
export function canonicalFacts(facts: RowFacts): string {
  const out: Record<string, string | null> = {};
  for (const k of Object.keys(facts).sort()) {
    const v = facts[k];
    out[k] = v === null || v === undefined ? null : String(v);
  }
  return JSON.stringify(out);
}

/** The exact bytes a row seal's MAC covers. */
export function rowSealMaterial(
  kind: string,
  rowId: string,
  eventId: string,
  chainHash: string,
  factsJson: string,
): string {
  return [
    "gaffer-row-seal",
    String(ROW_SEAL_VERSION),
    kind,
    rowId,
    eventId,
    chainHash,
    factsJson,
  ].join("\n");
}

/**
 * Seal a row (a TRUSTED HOST act: the paths that create or change the row, in the same
 * transaction as the event `eventId` that records the change). Replaces any earlier seal.
 * Throws {@link GateKeyError} where signing is not allowed (the whole act rolls back).
 */
export function sealRow(
  db: SealDb,
  keyring: GateKeyring,
  subject: Pick<RowSealSubject, "kind" | "rowId">,
  eventId: string,
  facts: RowFacts,
  now: string,
): void {
  const ev = db.prepare("SELECT hash FROM work_events WHERE id = ?").get(eventId) as
    { hash: string | null } | undefined;
  if (!ev?.hash) throw new GateKeyError(`event ${eventId} has no chain hash to seal`, "refused");
  const json = canonicalFacts(facts);
  const { mac, keyId } = keyring.signMac(
    rowSealMaterial(subject.kind, subject.rowId, eventId, ev.hash, json),
  );
  db.prepare(
    "INSERT OR REPLACE INTO row_seals (kind, row_id, event_id, facts_json, key_id, mac, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(subject.kind, subject.rowId, eventId, json, keyId, mac, now);
}

/** Retire a row's seal (a revocation, in the transaction that records it). */
export function retireRowSeal(db: SealDb, subject: Pick<RowSealSubject, "kind" | "rowId">): void {
  db.prepare("DELETE FROM row_seals WHERE kind = ? AND row_id = ?").run(
    subject.kind,
    subject.rowId,
  );
}

function macEquals(want: string, got: string): boolean {
  const a = Buffer.from(want, "hex");
  const b = Buffer.from(String(got ?? ""), "hex");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function changedFacts(signedJson: string, liveJson: string): string[] {
  try {
    const a = JSON.parse(signedJson) as Record<string, unknown>;
    const b = JSON.parse(liveJson) as Record<string, unknown>;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort();
  } catch {
    return [];
  }
}

/**
 * The chain verifies up to `seq`, as far as a sealed row's lifecycle depends on it.
 * A REST server checks a principal on every request, and walking a 100k-event log from
 * genesis costs most of a second, so the walk is INCREMENTAL per database handle:
 *  - the first check walks the whole log from genesis (as {@link chainVerifiesUpTo}) and
 *    remembers the verified head and every LIFECYCLE row of the subject's entity type
 *    (its `entityType` and one of its `lifecycleEvents`; rowid and hash), so a part B
 *    subject on `ticket` events remembers its few risk events, not every ticket event;
 *  - a later check walks only the rows appended since, linking from the remembered head;
 *  - when another connection has committed since (PRAGMA data_version moved), it first
 *    re-reads the remembered head and re-hashes every remembered lifecycle row: a
 *    rechain changes the head, and a lifecycle event deleted or rewritten in place (a
 *    revocation removed or turned into something else, without a rechain) is missing or no
 *    longer hashes to what was verified. Any doubt falls back to the full walk.
 * Any other row rewritten in place without a rechain is not re-read here: it decides
 * nothing about a sealed row (turned INTO a lifecycle event, it is newer than the seal's
 * event and supersedes it: refused). The landing check walks the whole log itself.
 */
interface ChainMemo {
  dataVersion: string;
  ok: boolean;
  /** The verified head (ok only). */
  seq: number;
  hash: string;
  /** Every verified lifecycle row: rowid -> hash. */
  rows: Map<number, string>;
}
const CHAIN_MEMO = new WeakMap<object, Map<string, ChainMemo>>();

type ChainRow = ChainedEventFields & { seq: number; prev_hash: string | null; hash: string | null };
const CHAIN_COLUMNS =
  "rowid AS seq, id, entity_type, entity_id, actor_type, actor_id, event_type, " +
  "payload_json, correlation_id, created_at, prev_hash, hash";

function dataVersion(db: SealDb): string {
  const dv = db.prepare("PRAGMA data_version").get() as Record<string, unknown> | undefined;
  return String(dv ? Object.values(dv)[0] : "");
}

/** The lifecycle rows a chain memo remembers. */
type Tracked = Pick<RowSealSubject, "entityType" | "lifecycleEvents">;

/** Walk rows (from, to] linking from `prev`; record the lifecycle rows. Null: broken. */
function walk(
  db: SealDb,
  from: number,
  to: number,
  prev: string,
  track: Tracked,
  rows: Map<number, string>,
): { seq: number; hash: string } | null {
  const list = db
    .prepare(
      `SELECT ${CHAIN_COLUMNS} FROM work_events WHERE rowid > ? AND rowid <= ? ORDER BY rowid ASC`,
    )
    .all(from, to) as ChainRow[];
  let expected = prev;
  let last = from;
  for (const row of list) {
    if (row.hash === null || row.prev_hash === null) return null;
    if (row.prev_hash !== expected || eventHash(row.prev_hash, row) !== row.hash) return null;
    expected = row.hash;
    last = Number(row.seq);
    if (
      String(row.entity_type) === track.entityType &&
      track.lifecycleEvents.includes(String(row.event_type))
    ) {
      rows.set(last, row.hash);
    }
  }
  if (last !== to) return null;
  return { seq: last, hash: expected };
}

/** How many full walks from genesis this process made (a test seam for the cost). */
let fullWalks = 0;
export function rowSealFullWalks(): number {
  return fullWalks;
}

function fullWalk(db: SealDb, seq: number, track: Tracked, dv: string): ChainMemo {
  fullWalks += 1;
  const rows = new Map<number, string>();
  const head = walk(db, 0, seq, EVENT_CHAIN_GENESIS, track, rows);
  return head
    ? { dataVersion: dv, ok: true, seq: head.seq, hash: head.hash, rows }
    : { dataVersion: dv, ok: false, seq: 0, hash: "", rows };
}

/** The remembered head and lifecycle rows are still exactly as verified. */
function memoStillHolds(db: SealDb, memo: ChainMemo, foreignWrite: boolean): boolean {
  const head = db.prepare("SELECT hash FROM work_events WHERE rowid = ?").get(memo.seq) as
    { hash: string | null } | undefined;
  if (!head || head.hash !== memo.hash) return false;
  if (!foreignWrite) return true;
  const one = db.prepare(`SELECT ${CHAIN_COLUMNS} FROM work_events WHERE rowid = ?`);
  for (const [rowid, hash] of memo.rows) {
    const row = one.get(rowid) as ChainRow | undefined;
    if (!row || row.hash !== hash || row.prev_hash === null) return false;
    if (eventHash(row.prev_hash, row) !== hash) return false;
  }
  return true;
}

function chainOkUpTo(db: SealDb, seq: number, track: Tracked): boolean {
  const key = `${track.entityType}\n${[...track.lifecycleEvents].sort().join(",")}`;
  const dv = dataVersion(db);
  let perDb = CHAIN_MEMO.get(db);
  if (!perDb) {
    perDb = new Map();
    CHAIN_MEMO.set(db, perDb);
  }
  const memo = perDb.get(key);
  let next: ChainMemo;
  if (!memo) {
    next = fullWalk(db, seq, track, dv);
  } else if (!memo.ok) {
    // A broken chain stays broken until the file changes under another connection.
    next = memo.dataVersion === dv ? memo : fullWalk(db, seq, track, dv);
  } else if (!memoStillHolds(db, memo, memo.dataVersion !== dv)) {
    next = fullWalk(db, seq, track, dv);
  } else if (seq <= memo.seq) {
    // Already verified: the row at `seq` must still be there (a check that names it).
    const at = db.prepare("SELECT 1 AS x FROM work_events WHERE rowid = ?").get(seq);
    next = at ? { ...memo, dataVersion: dv } : fullWalk(db, seq, track, dv);
  } else {
    const rows = new Map(memo.rows);
    const head = walk(db, memo.seq, seq, memo.hash, track, rows);
    next = head
      ? { dataVersion: dv, ok: true, seq: head.seq, hash: head.hash, rows }
      : fullWalk(db, seq, track, dv);
  }
  perDb.set(key, next);
  return next.ok && next.seq >= seq;
}

/**
 * The keyring `keyring` with its event-log anchor read NOW, once, for a verification that
 * runs inside a read snapshot opened AFTER this call ({@link import("../db/connection.js").inReadSnapshot}).
 *
 * The anchor lives outside the database and a writer moves it on only after its commit,
 * so every row it names is visible to a snapshot that starts after it was read. Read the
 * other way round (the snapshot first, the anchor during the check), a commit by any
 * other connection between the two shows an anchor past the snapshot's last row, which
 * reads exactly like a truncated log: a genuine principal was refused (a 401, a live feed
 * cut off) whenever the factory wrote an event mid sign-in. The landing check reads its
 * anchor before any row for the same reason.
 *
 * Verification only: the result signs nothing new on its own behalf and cannot move or
 * reset the anchor (`anchor` and `reanchor` are left out). An anchor that could not be
 * read fails each check that asks for it, as it would have at the time.
 */
export function anchorReadFirst(keyring: GateKeyring): GateKeyring {
  if (!keyring.readAnchor) return keyring;
  let read: { anchor: AnchorRead } | { error: unknown };
  try {
    read = { anchor: keyring.readAnchor() };
  } catch (e) {
    read = { error: e };
  }
  return {
    description: keyring.description,
    signMac: (material: string) => keyring.signMac(material),
    verifyMac: (material: string) => keyring.verifyMac(material),
    readAnchor: (): AnchorRead => {
      if ("error" in read) throw read.error;
      return read.anchor;
    },
  };
}

/**
 * Verify a row's seal against the row's facts as they are now. Read-only: never creates
 * a key, a seal or an anchor. `facts` null: the row is not on record (refused).
 */
export function verifyRowSeal(
  db: SealDb,
  keyring: GateKeyring,
  subject: RowSealSubject,
  facts: RowFacts | null,
): RowSealCheck {
  try {
    return verifyRowSealInner(db, keyring, subject, facts);
  } catch (e) {
    return {
      ok: false,
      failure: "unreadable",
      detail: `its signature could not be checked (${e instanceof Error ? e.message : String(e)})`,
    };
  }
}

function verifyRowSealInner(
  db: SealDb,
  keyring: GateKeyring,
  subject: RowSealSubject,
  facts: RowFacts | null,
): RowSealCheck {
  if (!facts) return { ok: false, failure: "unsigned", detail: "the row is not on record" };
  let seal: { event_id: string; facts_json: string; mac: string } | undefined;
  try {
    seal = db
      .prepare("SELECT event_id, facts_json, mac FROM row_seals WHERE kind = ? AND row_id = ?")
      .get(subject.kind, subject.rowId) as typeof seal;
  } catch {
    seal = undefined; // a database from before sealed rows: nothing is sealed
  }
  if (!seal) return { ok: false, failure: "unsigned", detail: "it carries no signature" };
  const eventId = String(seal.event_id);
  const ev = db
    .prepare(
      "SELECT rowid AS seq, entity_type, entity_id, event_type, hash FROM work_events WHERE id = ?",
    )
    .get(eventId) as
    | {
        seq: number;
        entity_type: string;
        entity_id: string;
        event_type: string;
        hash: string | null;
      }
    | undefined;
  if (!ev || !ev.hash) {
    return {
      ok: false,
      failure: "unsigned",
      detail: "the event its signature names is not on record",
    };
  }
  if (
    String(ev.entity_type) !== subject.entityType ||
    String(ev.entity_id) !== subject.rowId ||
    !subject.lifecycleEvents.includes(String(ev.event_type))
  ) {
    return {
      ok: false,
      failure: "mismatch",
      detail: "its signature names an event about something else",
    };
  }
  const live = canonicalFacts(facts);
  const want = keyring.verifyMac(
    rowSealMaterial(subject.kind, subject.rowId, eventId, String(ev.hash), live),
  );
  if ("missing" in want) return { ok: false, failure: "missing_key", detail: want.missing };
  if (!macEquals(want.mac, seal.mac)) {
    // Name what changed when the stored facts are the ones that were signed.
    const stored = keyring.verifyMac(
      rowSealMaterial(
        subject.kind,
        subject.rowId,
        eventId,
        String(ev.hash),
        String(seal.facts_json),
      ),
    );
    const signedStored = !("missing" in stored) && macEquals(stored.mac, seal.mac);
    const changed = signedStored ? changedFacts(String(seal.facts_json), live) : [];
    return {
      ok: false,
      failure: "mismatch",
      detail:
        changed.length > 0
          ? `the row was changed after it was signed (${changed.join(", ")})`
          : "its signature does not verify under the factory key",
      ...(changed.length > 0 ? { changed } : {}),
    };
  }
  const marks = subject.lifecycleEvents.map(() => "?").join(", ");
  const latest = db
    .prepare(
      `SELECT id, event_type FROM work_events WHERE entity_type = ? AND entity_id = ? AND event_type IN (${marks}) ` +
        "ORDER BY rowid DESC LIMIT 1",
    )
    .get(subject.entityType, subject.rowId, ...subject.lifecycleEvents) as
    { id: string; event_type: string } | undefined;
  if (!latest || String(latest.id) !== eventId) {
    return {
      ok: false,
      failure: "superseded",
      detail: `a later ${latest ? String(latest.event_type) : "event"} undoes the state it signed`,
    };
  }
  const anchor: AnchorRead = keyring.readAnchor
    ? keyring.readAnchor()
    : { missing: "this keyring records no anchor" };
  if ("missing" in anchor || "broken" in anchor) {
    return {
      ok: false,
      failure: "truncated",
      detail: `this factory has no usable record of its event log outside the database (${"missing" in anchor ? anchor.missing : anchor.broken})`,
    };
  }
  if (!anchorRowPresent(db, anchor)) {
    return {
      ok: false,
      failure: "truncated",
      detail: `the event log no longer holds event ${anchor.seq} as this factory recorded it outside the database (rows were deleted or rewritten; a revocation may have been removed)`,
    };
  }
  if (!chainOkUpTo(db, Math.max(anchor.seq, Number(ev.seq)), subject)) {
    return {
      ok: false,
      failure: "chain",
      detail: "the event log's hash chain does not verify up to the head this factory recorded",
    };
  }
  return { ok: true, eventId };
}

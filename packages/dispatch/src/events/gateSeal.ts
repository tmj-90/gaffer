import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

import { EVENT_CHAIN_GENESIS, eventHash, type ChainedEventFields } from "./eventChain.js";

/**
 * SIGNED GATE EVENTS. The approval a landing acts on (the ticket's latest transition into
 * ready_for_merge) and the tester verdict it relies on (a tester PASS, or a person's
 * waiver) used to be plain rows: anyone who could write the sqlite file could insert an
 * approval and recompute a consistent hash chain (eventChain.ts has no key). Every such
 * event is now SEALED: HMAC-SHA256 under the FACTORY KEY over the event's chain hash
 * (which covers its fields and its place in the chain) and the facts it binds (the
 * commits an approval pinned; the verdict row a PASS names and that row's payload).
 *
 * The key is 32 random bytes in a file of mode 0600 in a directory outside $GAFFER_DATA,
 * outside every worktree and outside every sandbox root:
 *   ${XDG_CONFIG_HOME:-$HOME/.config}/gaffer/keys/<id>.key
 * where <id> is derived from the canonical path of the directory that holds the dispatch
 * database ($GAFFER_DATA by default), never from anything stored where an agent writes.
 * `gaffer setup` creates it (`dispatch gate-key ensure`); so does the first trusted
 * host-side recording of a gate event when it is absent. Verification NEVER creates it.
 *
 * Seals live in their own table (`gate_seals`), so no existing row and no chain hash
 * changes. The table is machine-local, like the key: it is not part of the state export.
 *
 * Every function here reads the database through `prepare(sql).get/all/run` only, so the
 * runner's landing decision (runner/lib/tester-binding.mjs, node:sqlite) applies the very
 * same checks as Dispatch (better-sqlite3).
 */

export const GATE_SEAL_VERSION = 1;
export type GateSealKind = "approval" | "tester_pass";

/** The statement surface both better-sqlite3 and node:sqlite provide. */
export interface SealDb {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  };
}

/** A key that cannot be used here (unreadable, wrong mode, an agent-facing process). */
export class GateKeyError extends Error {
  constructor(
    message: string,
    readonly why: "refused" | "unreadable" | "unsafe" | "uncreatable",
  ) {
    super(message);
    this.name = "GateKeyError";
  }
}

/** The directory that holds factory keys: `${XDG_CONFIG_HOME:-$HOME/.config}/gaffer/keys`. */
export function factoryKeysDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = (env.XDG_CONFIG_HOME ?? "").trim();
  const base = xdg && isAbsolute(xdg) ? xdg : join(env.HOME?.trim() || homedir(), ".config");
  return join(base, "gaffer", "keys");
}

/** The canonical data directory: the directory holding the dispatch DB, symlinks resolved. */
export function canonicalDataDir(dbPath: string): string {
  const dir = dirname(resolve(dbPath));
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

/** The key id for a data directory: a hash of its canonical path. */
export function factoryKeyId(dbPath: string): string {
  return createHash("sha256")
    .update(`gaffer-factory-key\u0000${canonicalDataDir(dbPath)}`)
    .digest("hex")
    .slice(0, 24);
}

/** Where the key for this database lives. */
export function factoryKeyPath(
  dbPath: string,
  opts: { env?: NodeJS.ProcessEnv; keysDir?: string } = {},
): string {
  return join(opts.keysDir ?? factoryKeysDir(opts.env), `${factoryKeyId(dbPath)}.key`);
}

/** HMAC under the key a keyring holds. */
export interface GateKeyring {
  /** What this keyring is, for messages. */
  readonly description: string;
  /**
   * The MAC for a SIGNATURE. A file keyring creates the key when it is absent (a trusted
   * host-side recording). Throws {@link GateKeyError} where signing is not allowed.
   */
  signMac(material: string): { mac: string; keyId: string };
  /**
   * The MAC for a VERIFICATION, or `{ missing }` when there is no key. Never creates one.
   * Throws {@link GateKeyError} where the key may not be loaded at all.
   */
  verifyMac(material: string): { mac: string; keyId: string } | { missing: string };
}

const KEY_BYTES = 32;

function hmacHex(key: Buffer, material: string): string {
  return createHmac("sha256", key).update(material).digest("hex");
}

function isWithin(child: string, parent: string): boolean {
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

function canonicalOrSelf(p: string): string {
  // The deepest existing ancestor, resolved, plus the rest: a not-yet-created keys dir
  // under a symlinked HOME still compares by where it will really be.
  let head = resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(head), ...rest.reverse());
    } catch {
      const parent = dirname(head);
      if (parent === head) return resolve(p);
      rest.push(head.slice(parent.length).replace(/^[/\\]+/, ""));
      head = parent;
    }
  }
}

/**
 * The factory keyring for the database at `dbPath`: the key file under
 * {@link factoryKeysDir}. `keysDir` is a code-level test seam (vitest fixtures); there is
 * no operator knob and no environment variable naming the location.
 */
export function fileGateKeyring(opts: {
  dbPath: string;
  env?: NodeJS.ProcessEnv;
  keysDir?: string;
}): GateKeyring & { readonly keyPath: string; ensure(): { created: boolean; path: string } } {
  if (!opts.dbPath || opts.dbPath === ":memory:") {
    throw new GateKeyError("an in-memory database has no factory key", "refused");
  }
  const keysDir = opts.keysDir ?? factoryKeysDir(opts.env);
  const keyPath = join(keysDir, `${factoryKeyId(opts.dbPath)}.key`);
  const keyId = factoryKeyId(opts.dbPath);

  // The key must never sit where an agent can write: refuse a keys directory inside the
  // data directory (the dispatch DB's directory, $GAFFER_DATA by default).
  const assertOutsideData = (): void => {
    if (isWithin(canonicalOrSelf(keysDir), canonicalDataDir(opts.dbPath))) {
      throw new GateKeyError(
        "the factory key directory is inside the factory's data directory, where agents can write; " +
          "point XDG_CONFIG_HOME / HOME elsewhere",
        "unsafe",
      );
    }
  };

  const load = (): Buffer | null => {
    assertOutsideData();
    let st;
    try {
      st = lstatSync(keyPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new GateKeyError(
        `the factory key cannot be read here (${(e as NodeJS.ErrnoException).code ?? "error"})`,
        "unreadable",
      );
    }
    if (!st.isFile()) throw new GateKeyError("the factory key is not a regular file", "unsafe");
    if ((st.mode & 0o077) !== 0) {
      throw new GateKeyError(
        "the factory key file is readable by others (its mode must be 0600)",
        "unsafe",
      );
    }
    let fd: number;
    try {
      fd = openSync(keyPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    } catch (e) {
      throw new GateKeyError(
        `the factory key cannot be read here (${(e as NodeJS.ErrnoException).code ?? "error"})`,
        "unreadable",
      );
    }
    try {
      const size = fstatSync(fd).size;
      if (size !== KEY_BYTES) {
        throw new GateKeyError(`the factory key is not ${KEY_BYTES} bytes`, "unsafe");
      }
      const buf = Buffer.alloc(KEY_BYTES);
      const n = readSync(fd, buf, 0, KEY_BYTES, 0);
      if (n !== KEY_BYTES)
        throw new GateKeyError("the factory key could not be read", "unreadable");
      return buf;
    } finally {
      closeSync(fd);
    }
  };

  const create = (): Buffer => {
    assertOutsideData();
    try {
      mkdirSync(keysDir, { recursive: true, mode: 0o700 });
      chmodSync(keysDir, 0o700);
    } catch (e) {
      throw new GateKeyError(
        `the factory key directory cannot be created here (${(e as NodeJS.ErrnoException).code ?? "error"})`,
        "uncreatable",
      );
    }
    const key = randomBytes(KEY_BYTES);
    let fd: number;
    try {
      fd = openSync(
        keyPath,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          (fsConstants.O_NOFOLLOW ?? 0),
        0o600,
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        const raced = load();
        if (raced) return raced;
      }
      throw new GateKeyError(
        `the factory key cannot be created here (${(e as NodeJS.ErrnoException).code ?? "error"})`,
        "uncreatable",
      );
    }
    try {
      writeSync(fd, key, 0, KEY_BYTES, 0);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(keyPath, 0o600);
    return key;
  };

  return {
    description: "the factory key",
    keyPath,
    signMac(material: string) {
      const key = load() ?? create();
      return { mac: hmacHex(key, material), keyId };
    },
    verifyMac(material: string) {
      const key = load();
      if (!key) return { missing: "the factory key does not exist (gaffer setup creates it)" };
      return { mac: hmacHex(key, material), keyId };
    },
    ensure() {
      const had = load();
      if (had) return { created: false, path: keyPath };
      create();
      return { created: true, path: keyPath };
    },
  };
}

/**
 * The library default: a random key that lives only in this process. A seal it makes is
 * verified only by the same process and is worthless anywhere else (the landing paths use
 * the factory key), so an embedder that wires nothing can never mint an accepted seal.
 */
export function ephemeralGateKeyring(): GateKeyring {
  const key = randomBytes(KEY_BYTES);
  const keyId = `ephemeral-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
  return {
    description: "a process-local key",
    signMac: (material) => ({ mac: hmacHex(key, material), keyId }),
    verifyMac: (material) => ({ mac: hmacHex(key, material), keyId }),
  };
}

/**
 * The keyring of an agent-facing process (the dispatch MCP server): it never loads the
 * factory key. Any attempt is a refusal, not a silent no.
 */
export function refusingGateKeyring(who: string): GateKeyring {
  const refuse = (): never => {
    throw new GateKeyError(
      `${who} never loads the factory key: approvals and tester verdicts are signed only by ` +
        "the dispatch CLI, the REST server and the runner on the host",
      "refused",
    );
  };
  return { description: `${who} (no key)`, signMac: refuse, verifyMac: refuse };
}

/** The exact bytes a seal's MAC covers. */
export function sealMaterial(
  kind: GateSealKind,
  eventId: string,
  chainHash: string,
  bindsJson: string,
): string {
  return ["gaffer-gate-seal", String(GATE_SEAL_VERSION), kind, eventId, chainHash, bindsJson].join(
    "\n",
  );
}

// ---------------------------------------------------------------------------
// What a seal binds
// ---------------------------------------------------------------------------

export interface ApprovalPin {
  repo_id: string | null;
  sha: string;
}
export interface ApprovalBinds {
  ticket: string;
  pins: ApprovalPin[];
}
export interface TesterPassBinds {
  ticket: string;
  evidence_id: string;
  payload_sha256: string;
}

const SHA_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const REVIEW_PIN = "gaffer-reviewed-commit:";

/**
 * The review pins an approval of `ticketId` carries right now: every SYSTEM
 * `gaffer-reviewed-commit:` row recorded since the ticket last entered in_review (the
 * staleness rule the landing check applies), one entry per repo (the newest), sorted.
 */
export function currentApprovalPins(db: SealDb, ticketId: string): ApprovalPin[] {
  try {
    return readApprovalPins(db, ticketId);
  } catch {
    return []; // a pre-provenance schema records no pins
  }
}

function readApprovalPins(db: SealDb, ticketId: string): ApprovalPin[] {
  const entered = db
    .prepare(
      "SELECT created_at FROM work_events WHERE entity_type = 'ticket' AND entity_id = ? " +
        "AND event_type = 'ticket.transitioned' AND json_extract(payload_json, '$.to') = 'in_review' " +
        "ORDER BY rowid DESC LIMIT 1",
    )
    .get(ticketId) as { created_at: string } | undefined;
  const rows = db
    .prepare(
      "SELECT repo_id, uri, created_at FROM evidence WHERE ticket_id = ? AND evidence_type = 'commit' " +
        "AND recorded_by_actor_type = 'system' AND uri LIKE 'gaffer-reviewed-commit:%' " +
        "ORDER BY created_at DESC, rowid DESC",
    )
    .all(ticketId) as Array<{ repo_id: string | null; uri: string; created_at: string }>;
  const seen = new Set<string>();
  const pins: ApprovalPin[] = [];
  for (const r of rows) {
    if (entered && String(entered.created_at) > String(r.created_at)) continue;
    const key = r.repo_id ?? "\u0000";
    if (seen.has(key)) continue;
    const sha = String(r.uri).slice(REVIEW_PIN.length).toLowerCase();
    if (!SHA_RE.test(sha)) continue;
    seen.add(key);
    pins.push({ repo_id: r.repo_id ?? null, sha });
  }
  return pins.sort((a, b) =>
    `${a.repo_id ?? ""}:${a.sha}` < `${b.repo_id ?? ""}:${b.sha}` ? -1 : 1,
  );
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * The tester verdict a landing relies on: the newest `test_output` PASS row a
 * `ticket.tester_passed` event names (the rule runner/lib/tester-binding.mjs and the
 * review packet apply), or null.
 */
export function reliedTesterPass(
  db: SealDb,
  ticketId: string,
): { evidenceId: string; payloadJson: string } | null {
  let row: { id: string; payload_json: string | null } | undefined;
  try {
    row = readReliedPass(db, ticketId);
  } catch {
    return null; // no evidence or event table: no tester verdict on record (as tester-binding reads it)
  }
  return row ? { evidenceId: String(row.id), payloadJson: String(row.payload_json ?? "") } : null;
}

function readReliedPass(
  db: SealDb,
  ticketId: string,
): { id: string; payload_json: string | null } | undefined {
  return db
    .prepare(
      "SELECT e.id AS id, e.payload_json AS payload_json FROM evidence e WHERE e.ticket_id = ? " +
        "AND e.evidence_type = 'test_output' AND e.payload_json LIKE '%\"verdict\":\"pass\"%' " +
        "AND EXISTS (SELECT 1 FROM work_events w WHERE w.entity_type = 'ticket' " +
        "AND w.entity_id = e.ticket_id AND w.event_type = 'ticket.tester_passed' " +
        "AND json_extract(w.payload_json, '$.evidence_id') = e.id) " +
        "ORDER BY e.created_at DESC, e.rowid DESC LIMIT 1",
    )
    .get(ticketId) as { id: string; payload_json: string | null } | undefined;
}

// ---------------------------------------------------------------------------
// Sealing (trusted host processes only)
// ---------------------------------------------------------------------------

/** Canonical JSON for binds (keys in a fixed order). */
function bindsJson(binds: ApprovalBinds | TesterPassBinds): string {
  if ("pins" in binds) {
    return JSON.stringify({
      ticket: binds.ticket,
      pins: binds.pins.map((p) => ({ repo_id: p.repo_id, sha: p.sha })),
    });
  }
  return JSON.stringify({
    ticket: binds.ticket,
    evidence_id: binds.evidence_id,
    payload_sha256: binds.payload_sha256,
  });
}

function sealEvent(
  db: SealDb,
  keyring: GateKeyring,
  eventId: string,
  kind: GateSealKind,
  binds: ApprovalBinds | TesterPassBinds,
  now: string,
): void {
  const ev = db.prepare("SELECT hash FROM work_events WHERE id = ?").get(eventId) as
    { hash: string | null } | undefined;
  if (!ev?.hash) throw new GateKeyError(`event ${eventId} has no chain hash to seal`, "refused");
  const json = bindsJson(binds);
  const { mac, keyId } = keyring.signMac(sealMaterial(kind, eventId, ev.hash, json));
  db.prepare(
    "INSERT INTO gate_seals (event_id, kind, binds_json, key_id, mac, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(eventId, kind, json, keyId, mac, now);
}

/** Seal an approval event (a transition into ready_for_merge) with the pins it carries. */
export function sealApproval(
  db: SealDb,
  keyring: GateKeyring,
  eventId: string,
  ticketId: string,
  now: string,
): void {
  sealEvent(
    db,
    keyring,
    eventId,
    "approval",
    { ticket: ticketId, pins: currentApprovalPins(db, ticketId) },
    now,
  );
}

/** Seal a `ticket.tester_passed` event with the verdict row it names. */
export function sealTesterPass(
  db: SealDb,
  keyring: GateKeyring,
  eventId: string,
  ticketId: string,
  evidenceId: string,
  now: string,
): void {
  const row = db.prepare("SELECT payload_json FROM evidence WHERE id = ?").get(evidenceId) as
    { payload_json: string | null } | undefined;
  if (!row) throw new GateKeyError(`verdict row ${evidenceId} is missing`, "refused");
  sealEvent(
    db,
    keyring,
    eventId,
    "tester_pass",
    {
      ticket: ticketId,
      evidence_id: evidenceId,
      payload_sha256: sha256Hex(String(row.payload_json ?? "")),
    },
    now,
  );
}

// ---------------------------------------------------------------------------
// Verification (never creates a key)
// ---------------------------------------------------------------------------

export type SealFailure = "missing_key" | "unsigned" | "mismatch" | "chain" | "unreadable";
export type SealCheck =
  | { ok: true; binds: Record<string, unknown> }
  | { ok: false; failure: SealFailure; detail: string };

type ChainRow = ChainedEventFields & { seq: number; prev_hash: string | null; hash: string | null };

/** The chain from genesis up to and including rowid `seq` verifies. */
export function chainVerifiesUpTo(
  db: SealDb,
  seq: number,
): { ok: true } | { ok: false; at: string } {
  const rows = db
    .prepare(
      `SELECT rowid AS seq, id, entity_type, entity_id, actor_type, actor_id, event_type,
              payload_json, correlation_id, created_at, prev_hash, hash
         FROM work_events WHERE rowid <= ? ORDER BY rowid ASC`,
    )
    .all(seq) as ChainRow[];
  let expected = EVENT_CHAIN_GENESIS;
  for (const row of rows) {
    if (row.hash === null || row.prev_hash === null) return { ok: false, at: row.id };
    if (row.prev_hash !== expected) return { ok: false, at: row.id };
    if (eventHash(row.prev_hash, row) !== row.hash) return { ok: false, at: row.id };
    expected = row.hash;
  }
  if (rows.length === 0 || Number(rows[rows.length - 1]!.seq) !== Number(seq)) {
    return { ok: false, at: String(seq) };
  }
  return { ok: true };
}

/** Verify one sealed event of `kind`: chain, seal row, MAC. Read-only. */
export function verifyGateSeal(
  db: SealDb,
  keyring: GateKeyring,
  eventId: string,
  kind: GateSealKind,
): SealCheck {
  let ev: { seq: number; hash: string | null } | undefined;
  try {
    ev = db.prepare("SELECT rowid AS seq, hash FROM work_events WHERE id = ?").get(eventId) as
      { seq: number; hash: string | null } | undefined;
  } catch (e) {
    return { ok: false, failure: "unreadable", detail: String((e as Error).message ?? e) };
  }
  if (!ev) return { ok: false, failure: "unsigned", detail: "the event is not on record" };
  const chain = chainVerifiesUpTo(db, Number(ev.seq));
  if (!chain.ok) {
    return {
      ok: false,
      failure: "chain",
      detail: `the event log's hash chain does not verify up to it (first bad row ${chain.at})`,
    };
  }
  let seal: { kind: string; binds_json: string; mac: string } | undefined;
  try {
    seal = db
      .prepare("SELECT kind, binds_json, mac FROM gate_seals WHERE event_id = ?")
      .get(eventId) as { kind: string; binds_json: string; mac: string } | undefined;
  } catch {
    seal = undefined; // a database from before signed acts: nothing is sealed
  }
  if (!seal) return { ok: false, failure: "unsigned", detail: "it carries no signature" };
  if (seal.kind !== kind) {
    return { ok: false, failure: "mismatch", detail: `its signature is for a ${seal.kind}` };
  }
  const want = keyring.verifyMac(sealMaterial(kind, eventId, String(ev.hash), seal.binds_json));
  if ("missing" in want) return { ok: false, failure: "missing_key", detail: want.missing };
  const a = Buffer.from(want.mac, "hex");
  const b = Buffer.from(String(seal.mac), "hex");
  if (a.length !== b.length || a.length === 0 || !timingSafeEqual(a, b)) {
    return {
      ok: false,
      failure: "mismatch",
      detail: "its signature does not verify under the factory key",
    };
  }
  let binds: Record<string, unknown>;
  try {
    binds = JSON.parse(seal.binds_json) as Record<string, unknown>;
  } catch {
    return { ok: false, failure: "mismatch", detail: "its signed facts do not parse" };
  }
  return { ok: true, binds };
}

/** What a landing is about to merge or record: a commit, in a repo (id; null = any). */
export interface LandingTarget {
  repoId: string | null;
  sha: string;
}

export type LandingActsCheck =
  | { ok: true; approval: string }
  | {
      ok: false;
      code: "unsigned_approval" | "unsigned_tester_verdict";
      reason: string;
      failure: SealFailure | "no_approval" | "not_covered";
    };

/** The latest transition into ready_for_merge (the approval every landing acts on). */
export function latestApprovalEvent(db: SealDb, ticketId: string): string | null {
  const row = db
    .prepare(
      "SELECT id FROM work_events WHERE entity_type = 'ticket' AND entity_id = ? " +
        "AND event_type = 'ticket.transitioned' AND json_extract(payload_json, '$.to') = 'ready_for_merge' " +
        "ORDER BY rowid DESC LIMIT 1",
    )
    .get(ticketId) as { id: string } | undefined;
  return row?.id ?? null;
}

function remedy(failure: SealFailure | "no_approval" | "not_covered", verdict: boolean): string {
  if (failure === "missing_key") {
    return (
      "The factory key is missing: run `gaffer setup` to create one, then re-approve the ticket " +
      "(every signature made under a lost key must be made again)."
    );
  }
  return verdict
    ? "Record the verdict again through the tester (or a person's waiver: wg ticket tester-pass --as human), then re-approve."
    : "A person re-approves it: gaffer wg ticket reopen-for-review <n> --as admin --reason unsigned_approval --resolution re-approve, then gaffer approve <n>.";
}

/**
 * THE LANDING CHECK every path that merges or records a landing applies. Fail closed: the
 * approval the landing acts on must carry a valid seal under the factory key, the chain
 * must verify up to it, every commit about to land must be one the sealed approval pinned
 * for that repo, and the tester verdict the landing relies on (if any) must be sealed too
 * and still be the row it signed. Read-only; never creates a key.
 */
export function verifyLandingActs(
  db: SealDb,
  keyring: GateKeyring,
  ticketId: string,
  opts: {
    targets?: readonly LandingTarget[];
    approvalId?: string | null;
    ticketNumber?: number | string | null;
  } = {},
): LandingActsCheck {
  const n =
    opts.ticketNumber === null || opts.ticketNumber === undefined
      ? "<n>"
      : String(opts.ticketNumber);
  const fail = (
    code: "unsigned_approval" | "unsigned_tester_verdict",
    failure: SealFailure | "no_approval" | "not_covered",
    what: string,
  ): LandingActsCheck => ({
    ok: false,
    code,
    failure,
    reason: `${what} ${remedy(failure, code === "unsigned_tester_verdict")
      .split("<n>")
      .join(n)}`,
  });
  const guard = (fn: () => LandingActsCheck): LandingActsCheck => {
    try {
      return fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return fail(
        "unsigned_approval",
        "unreadable",
        `The approval could not be verified (${msg}).`,
      );
    }
  };
  return guard(() => {
    const approval = opts.approvalId ?? latestApprovalEvent(db, ticketId);
    if (!approval) return fail("unsigned_approval", "no_approval", "No approval is on record.");
    const a = verifyGateSeal(db, keyring, approval, "approval");
    if (!a.ok) {
      return fail(
        "unsigned_approval",
        a.failure,
        `Nothing lands on this approval: ${a.detail}.` +
          (a.failure === "unsigned"
            ? " An approval recorded before signed approvals existed, or written into the database directly, has no signature."
            : ""),
      );
    }
    if (a.binds.ticket !== ticketId) {
      return fail("unsigned_approval", "mismatch", "Its signature is for another ticket.");
    }
    const pins = Array.isArray(a.binds.pins) ? (a.binds.pins as ApprovalPin[]) : [];
    for (const t of opts.targets ?? []) {
      const sha = String(t.sha ?? "").toLowerCase();
      if (!sha) continue;
      // An approval that pinned nothing (a legacy, pin-less approval) has no commit list
      // to hold the landing to; the branch-head checks of the landing decision apply.
      if (pins.length === 0) continue;
      const covered = pins.some(
        (p) => p.sha === sha && (t.repoId === null || p.repo_id === null || p.repo_id === t.repoId),
      );
      if (!covered) {
        return fail(
          "unsigned_approval",
          "not_covered",
          `The signed approval does not cover ${sha.slice(0, 12)}${t.repoId ? ` in ${t.repoId}` : ""}: the approved commit on record is not the one it signed.`,
        );
      }
    }
    const pass = reliedTesterPass(db, ticketId);
    if (pass) {
      const events = db
        .prepare(
          "SELECT id FROM work_events WHERE entity_type = 'ticket' AND entity_id = ? " +
            "AND event_type = 'ticket.tester_passed' AND json_extract(payload_json, '$.evidence_id') = ? " +
            "ORDER BY rowid DESC",
        )
        .all(ticketId, pass.evidenceId) as Array<{ id: string }>;
      let last: SealCheck | null = null;
      let good = false;
      for (const ev of events) {
        const v = verifyGateSeal(db, keyring, ev.id, "tester_pass");
        last = v;
        if (!v.ok) continue;
        if (
          v.binds.ticket === ticketId &&
          v.binds.evidence_id === pass.evidenceId &&
          v.binds.payload_sha256 === sha256Hex(pass.payloadJson)
        ) {
          good = true;
          break;
        }
        last = {
          ok: false,
          failure: "mismatch",
          detail: "the verdict row is not the one its signature covers",
        };
      }
      if (!good) {
        const failure: SealFailure = last && !last.ok ? last.failure : "unsigned";
        const detail = last && !last.ok ? last.detail : "it carries no signature";
        return fail(
          "unsigned_tester_verdict",
          failure,
          `The tester verdict this landing relies on cannot be trusted: ${detail}.`,
        );
      }
    }
    return { ok: true, approval };
  });
}

/**
 * The keyring a TRUSTED HOST entry point (the dispatch CLI, the REST server) opens a
 * database with: the factory key for a database file; a process-local key for an
 * in-memory one (which no other process can land from anyway).
 */
export function hostGateKeyring(dbPath: string, env: NodeJS.ProcessEnv = process.env): GateKeyring {
  if (!dbPath || dbPath === ":memory:") return ephemeralGateKeyring();
  return fileGateKeyring({ dbPath, env });
}

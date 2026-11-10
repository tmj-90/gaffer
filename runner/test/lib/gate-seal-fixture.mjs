#!/usr/bin/env node
// =====================================================================
// TEST FIXTURE: record hand-written gate rows the way a trusted host records them.
//
// Some landing tests build their dispatch rows with sqlite directly (a reduced schema, or
// a tester PASS the fixture cannot reach through `ticket tester-pass`). Landing now
// verifies a signature on the approval and on the tester verdict it relies on
// (packages/dispatch/src/events/gateSeal.ts), and a row written into the database
// directly carries none: exactly what an attacker's row looks like. This helper is the
// fixture's stand-in for the host: it hash-chains every unchained row (in rowid order) and
// seals the named events under the factory key of the CURRENT HOME (each runner test has
// a private one), as dispatch's approve / tester-pass paths do, then anchors the log's head
// outside the database as the host does after each write.
//   node gate-seal-fixture.mjs <db> chain                    (every command first re-chains the log
//                                                             and re-makes every existing seal over
//                                                             its event's new hash, then re-anchors)
//   node gate-seal-fixture.mjs <db> approval <event-id>      (seal a transition into ready_for_merge
//                                                             that has no seal yet)
//   node gate-seal-fixture.mjs <db> tester-pass <event-id>   (a ticket.tester_passed event)
//   node gate-seal-fixture.mjs <db> approve <ticket-number> [<sha>|<repo-id>=<sha>]...
//                                                            (insert + chain + seal an approval of
//                                                             those commits; none named: the heads
//                                                             of the ticket's delivery branches)
// =====================================================================
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(HERE, "../../../packages/dispatch/dist/events");
const seal = await import(resolve(DIST, "gateSeal.js"));
const chain = await import(resolve(DIST, "eventChain.js"));
const { DatabaseSync } = require("node:sqlite");

const [dbPath, cmd, arg] = process.argv.slice(2);
if (!dbPath || !cmd) {
  process.stderr.write(
    "usage: gate-seal-fixture.mjs <db> chain|approval|tester-pass|approve [arg]\n",
  );
  process.exit(2);
}
const db = new DatabaseSync(dbPath);
const now = () => new Date().toISOString();

function ensureTable() {
  db.exec(`CREATE TABLE IF NOT EXISTS gate_seals (event_id TEXT PRIMARY KEY, kind TEXT NOT NULL,
    binds_json TEXT NOT NULL, key_id TEXT NOT NULL, mac TEXT NOT NULL, created_at TEXT NOT NULL)`);
}
function chainAll() {
  const cols = new Set(
    db
      .prepare("PRAGMA table_info(work_events)")
      .all()
      .map((c) => c.name),
  );
  if (!cols.has("prev_hash")) db.exec("ALTER TABLE work_events ADD COLUMN prev_hash TEXT");
  if (!cols.has("hash")) db.exec("ALTER TABLE work_events ADD COLUMN hash TEXT");
  const hasCorr = cols.has("correlation_id");
  const hasActorId = cols.has("actor_id");
  const rows = db
    .prepare(
      `SELECT rowid AS seq, id, entity_type, entity_id, actor_type, ${hasActorId ? "actor_id" : "NULL AS actor_id"},
              event_type, payload_json, ${hasCorr ? "correlation_id" : "NULL AS correlation_id"}, created_at, prev_hash, hash
         FROM work_events ORDER BY rowid ASC`,
    )
    .all();
  let prev = chain.EVENT_CHAIN_GENESIS;
  let broken = false;
  const upd = db.prepare("UPDATE work_events SET prev_hash = ?, hash = ? WHERE rowid = ?");
  for (const r of rows) {
    // Keep a row that is already correctly chained; re-chain from the first that is not.
    if (!broken && r.hash && r.prev_hash === prev && chain.eventHash(prev, r) === r.hash) {
      prev = r.hash;
      continue;
    }
    broken = true;
    const h = chain.eventHash(prev, r);
    upd.run(prev, h, r.seq);
    prev = h;
  }
}
function ticketOf(eventId) {
  const r = db.prepare("SELECT entity_id, payload_json FROM work_events WHERE id = ?").get(eventId);
  if (!r) throw new Error(`no event ${eventId}`);
  return r;
}
/** The head of each write repo's delivery branch for ticket `ticketId` (reduced schemas too). */
function branchHeads(ticketId) {
  const out = [];
  let rows;
  try {
    rows = db
      .prepare(
        `SELECT tr.repo_id AS repo_id, COALESCE(tr.branch_name, t.branch_name) AS branch, r.local_path AS path
           FROM ticket_repos tr JOIN repositories r ON r.id = tr.repo_id JOIN tickets t ON t.id = tr.ticket_id
          WHERE tr.ticket_id = ? AND COALESCE(tr.access, 'write') = 'write'`,
      )
      .all(ticketId);
  } catch {
    return out; // no repo tables: nothing to pin
  }
  for (const r of rows) {
    if (!r.branch || !r.path) continue;
    const g = spawnSync(
      "git",
      ["-C", r.path, "rev-parse", "--verify", "-q", `${r.branch}^{commit}`],
      {
        encoding: "utf8",
      },
    );
    if (g.status === 0) out.push({ repo_id: r.repo_id, sha: g.stdout.trim() });
  }
  return out;
}
const keyring = seal.hostGateKeyring(dbPath);
ensureTable();
chainAll();
// The host stand-in re-records: a seal whose event was re-chained above is made again over
// the event's new chain hash, with the facts it bound (a log that always looked like this).
for (const r of db
  .prepare(
    "SELECT g.event_id AS id, g.kind AS kind, g.binds_json AS binds, w.hash AS hash FROM gate_seals g JOIN work_events w ON w.id = g.event_id",
  )
  .all()) {
  const { mac } = keyring.signMac(seal.sealMaterial(r.kind, r.id, r.hash, r.binds));
  db.prepare("UPDATE gate_seals SET mac = ? WHERE event_id = ?").run(mac, r.id);
}
// A fixture re-records: a seal made before a re-chain no longer matches the row's hash.
const unseal = (id) => db.prepare("DELETE FROM gate_seals WHERE event_id = ?").run(id);
if (cmd === "approval") {
  const r = ticketOf(arg);
  // Already sealed: re-made above over its current hash, with the commits it bound.
  const had = db.prepare("SELECT 1 FROM gate_seals WHERE event_id = ?").get(arg);
  if (!had) seal.sealApproval(db, keyring, arg, r.entity_id, now());
} else if (cmd === "tester-pass") {
  const r = ticketOf(arg);
  unseal(arg);
  const ev = JSON.parse(r.payload_json || "{}").evidence_id;
  seal.sealTesterPass(db, keyring, arg, r.entity_id, String(ev), now());
} else if (cmd === "approve") {
  const t = db.prepare("SELECT id FROM tickets WHERE number = ?").get(Number(arg));
  if (!t) throw new Error(`no ticket #${arg}`);
  // A host approval names the commits it approved (approveReview seals exactly those):
  // the commits given after the ticket number (<sha> or <repo-id>=<sha>), else the current
  // head of each write repo's delivery branch, as a person approving it now would.
  const pins = process.argv.slice(5).map((a) => {
    const i = a.indexOf("=");
    return i < 0 ? { repo_id: null, sha: a } : { repo_id: a.slice(0, i), sha: a.slice(i + 1) };
  });
  if (pins.length === 0) pins.push(...branchHeads(t.id));
  const id = `fixture-approval-${randomUUID()}`;
  const cols = new Set(
    db
      .prepare("PRAGMA table_info(work_events)")
      .all()
      .map((c) => c.name),
  );
  db.prepare(
    `INSERT INTO work_events (id, entity_type, entity_id, actor_type, ${cols.has("actor_id") ? "actor_id, " : ""}event_type, payload_json, created_at)
     VALUES (?, 'ticket', ?, 'human', ${cols.has("actor_id") ? "'fixture', " : ""}'ticket.transitioned', ?, ?)`,
  ).run(
    id,
    t.id,
    JSON.stringify({
      from: "in_review",
      to: "ready_for_merge",
      reason: "review_approved",
      patch: null,
    }),
    now(),
  );
  chainAll();
  seal.sealApproval(db, keyring, id, t.id, now(), pins);
  process.stdout.write(`${id}\n`);
} else if (cmd !== "chain") {
  process.stderr.write(`unknown command ${cmd}\n`);
  process.exit(2);
}
// The host records the event log's head outside the database after every write it makes
// (the event-log anchor every landing checks); a fixture that re-chains history re-anchors.
try {
  keyring.reanchor(db);
} catch (e) {
  if (!(e instanceof seal.GateKeyError)) throw e; // no factory key yet: nothing is sealed
}
db.close();

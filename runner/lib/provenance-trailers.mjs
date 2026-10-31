#!/usr/bin/env node
// =====================================================================
// lib/provenance-trailers.mjs — the git trailers a landed delivery's merge commit
// carries, so the history says which ticket it was, who approved it and what the
// gates said, without the dashboard:
//
//   Gaffer-Ticket: #12
//   Gaffer-Reviewed-By: human:tom            (or agent:<id>; "none recorded")
//   Gaffer-Gates: DoD PASS (tests pass, lint pass, typecheck skip); AC 3/3 satisfied; tester PASS
//
// Read from the dispatch DB, never from agent text: the reviewer is the actor of the
// ticket's latest approval (`ticket.transitioned` with reason review_approved /
// review_approved_to_testing), the gates are the latest runner DoD checklist evidence,
// the acceptance criteria and the latest tester verdict. No model name is written here:
// the usage ledger is where a call's model is recorded.
//
// Both landing paths use it: lib/land.sh (the merge lane and the AFK review pass, via
// gaffer_auto_merge / gaffer_pr_merge) and bin/merge-ticket.mjs (the dashboard's Merge
// button, `gaffer merge`). GAFFER_PROVENANCE_TRAILERS=0 turns them off (the merge is then
// exactly what it was before: the plain message, a fast-forward when one is possible).
// Fail-soft: a DB that cannot be read gives the ticket line alone, never a failed merge.
//
// CLI: node lib/provenance-trailers.mjs --db <dispatch.sqlite> --ticket <n>
//      → the trailer lines (nothing at all when turned off); always exit 0.
// =====================================================================
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/** GAFFER_PROVENANCE_TRAILERS: on unless 0 / off / false / no. */
export function trailersEnabled(env = process.env) {
  return !/^(0|off|false|no)$/i.test(String(env.GAFFER_PROVENANCE_TRAILERS ?? "").trim());
}

/** A trailer value: one line, printable, bounded. */
function clean(v, max = 200) {
  return String(v ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[^\x20-\x7e]/g, "")
    .trim()
    .slice(0, max);
}
function actorLabel(type, id) {
  const t = clean(type, 20).toLowerCase() || "unknown";
  const i = clean(id, 80).replace(/[^A-Za-z0-9._@:-]/g, "");
  return i && i !== t ? `${t}:${i}` : t;
}

/** "DoD PASS (tests pass, lint skip)" from the runner's DoD checklist summary. */
export function dodLine(summary) {
  const lines = String(summary || "").split("\n");
  const head = lines[0] || "";
  const m = head.match(/^DoD:\s*(PASS|FAIL)/);
  if (!m) return null;
  let gates = [];
  try {
    const j = JSON.parse(lines[1] || "{}");
    if (Array.isArray(j.gates)) gates = j.gates;
  } catch {
    gates = [];
  }
  // One verdict per gate across repos: a FAIL anywhere wins, then PASS, then SKIP.
  const rank = { FAIL: 3, PASS: 2, SKIP: 1 };
  const byGate = new Map();
  for (const g of gates) {
    const name = clean(g && g.gate, 30);
    const st = clean(g && g.status, 10).toUpperCase();
    if (!name || !rank[st]) continue;
    const prev = byGate.get(name);
    if (!prev || rank[st] > rank[prev]) byGate.set(name, st);
  }
  const parts = [...byGate].map(([g, s]) => `${g} ${s.toLowerCase()}`);
  return `DoD ${m[1]}${parts.length ? ` (${parts.join(", ")})` : ""}`;
}

function readFacts(dbPath, ticketNumber) {
  const num = parseInt(String(ticketNumber ?? "").replace(/^#/, ""), 10);
  if (!Number.isInteger(num) || num <= 0) return { num: null };
  const facts = { num, reviewer: null, dod: null, ac: null, tester: null };
  if (!dbPath || !existsSync(dbPath)) return facts;
  let db;
  try {
    const { DatabaseSync } = require("node:sqlite");
    db = new DatabaseSync(dbPath, { readOnly: true });
    const t = db.prepare("SELECT id FROM tickets WHERE number = ?").get(num);
    if (!t) return facts;
    const one = (sql, ...args) => {
      try {
        return db.prepare(sql).get(...args);
      } catch {
        return undefined;
      }
    };
    const rev = one(
      "SELECT actor_type, actor_id FROM work_events WHERE entity_type = 'ticket' AND entity_id = ? " +
        "AND event_type = 'ticket.transitioned' " +
        "AND json_extract(payload_json, '$.reason') IN ('review_approved', 'review_approved_to_testing') " +
        "ORDER BY created_at DESC, rowid DESC LIMIT 1",
      t.id,
    );
    if (rev) facts.reviewer = actorLabel(rev.actor_type, rev.actor_id);
    const dod = one(
      "SELECT summary FROM evidence WHERE ticket_id = ? AND evidence_type = 'test_output' " +
        "AND recorded_by_actor_type = 'system' AND summary LIKE 'DoD:%' " +
        "ORDER BY created_at DESC, rowid DESC LIMIT 1",
      t.id,
    );
    if (dod) facts.dod = dodLine(dod.summary);
    const ac = one(
      "SELECT COUNT(*) AS n, SUM(CASE WHEN status IN ('satisfied','waived') THEN 1 ELSE 0 END) AS ok " +
        "FROM acceptance_criteria WHERE ticket_id = ?",
      t.id,
    );
    if (ac && Number(ac.n) > 0) facts.ac = `AC ${Number(ac.ok) || 0}/${Number(ac.n)} satisfied`;
    const tv = one(
      "SELECT payload_json FROM evidence WHERE ticket_id = ? AND evidence_type = 'test_output' " +
        "AND payload_json LIKE '%\"verdict\":%' ORDER BY created_at DESC, rowid DESC LIMIT 1",
      t.id,
    );
    if (tv) {
      try {
        const p = JSON.parse(tv.payload_json);
        const v = clean(p && p.verdict, 10).toUpperCase();
        if (v === "PASS" || v === "FAIL")
          facts.tester = `tester ${v}${p.provenance === "human" ? " (human)" : ""}`;
      } catch {
        /* no readable tester verdict */
      }
    }
  } catch {
    /* fail-soft: the ticket line alone */
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
  }
  return facts;
}

/** The trailer lines for a ticket's merge commit ([] when off or the ticket is unknown). */
export function provenanceTrailers({ dbPath, ticketNumber, env = process.env }) {
  if (!trailersEnabled(env)) return [];
  const f = readFacts(dbPath, ticketNumber);
  if (!f.num) return [];
  const gates = [f.dod, f.ac, f.tester].filter(Boolean).join("; ");
  return [
    `Gaffer-Ticket: #${f.num}`,
    `Gaffer-Reviewed-By: ${f.reviewer || "none recorded"}`,
    `Gaffer-Gates: ${gates || "none recorded"}`,
  ];
}

/** The merge commit message: the subject, a blank line, the trailers (or the subject alone). */
export function mergeMessage(subject, trailers) {
  return trailers && trailers.length ? `${subject}\n\n${trailers.join("\n")}` : subject;
}

function main(argv) {
  const opt = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const lines = provenanceTrailers({
    dbPath: opt("db") || process.env.DISPATCH_DB,
    ticketNumber: opt("ticket"),
  });
  if (lines.length) process.stdout.write(lines.join("\n") + "\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main(process.argv.slice(2));

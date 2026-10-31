#!/usr/bin/env node
// =====================================================================
// lib/tester-binding.mjs — the ONE landing decision both merge paths apply.
//
// ACCEPTANCE GATE: an independent tester's PASS is evidence about ONE commit (the
// evidence payload's `tested_commit`, recorded by bin/tester-run.mjs). Landing a branch
// whose head is no longer that commit would merge code the tester never ran. Two
// implementations land deliveries — lib/land.sh (the merge lane / AFK review pass) and
// bin/merge-ticket.mjs (the dashboard's Merge button, `gaffer merge`) — so the decision
// lives here and both call it, and both then merge the PINNED commit it returns (never
// "whatever the branch points at by the time the merge runs"; a PR merge passes it as
// `gh pr merge --match-head-commit`).
//
// Decision (`landingDecision`), read from the dispatch DB, never from agent text. A
// "tester PASS" is only the row a `ticket.tester_passed` event names (the tester pass
// path); a verdict-shaped row the delivery agent recorded itself is not one.
//   no tester PASS recorded   → an ordinary ticket lands (no tester involved);
//                               an ACCEPTANCE ticket is HELD (nothing certifies it)
//   a HUMAN PASS (waiver)     → lands, pinned to the branch head, logged as a waiver
//   an agent PASS, no commit  → an ordinary ticket lands (legacy, logged);
//                               an ACCEPTANCE ticket is HELD (unverified)
//   bound PASS, head == tested → lands, pinned to the tested commit
//   bound PASS, head moved     → HELD (names both commits)
// REVIEW PIN: every approval records the commit it approved as a SYSTEM `commit` evidence
// row (uri gaffer-reviewed-commit:<sha>): the runner's agent review pins the commit the
// reviewer saw (lib/review.sh), and dispatch pins the branch head a HUMAN approved
// (reviewGateService.approveReview). Every decision above that would otherwise land "the
// branch head" (no tester, a human waiver, a legacy unbound PASS) then lands ONLY that
// commit and HOLDS (kind moved-since-review) when the head moved past it, and a bound
// tester PASS of a commit other than the reviewed one holds the same way — on every
// landing path, the merge lane's later landing of a ready_for_merge ticket included. A pin
// recorded before the ticket last (re)entered in_review describes an older candidate and
// is ignored.
// Fail CLOSED: an unreadable DB, an unknown ticket or an unresolvable branch head HOLD.
//
// CLI: node lib/tester-binding.mjs landing --db <dispatch.sqlite> --ticket <n>
//        --repo <path> --branch <name>
//      → one JSON line { ok, pin, kind, reason, tested, reviewed, head }; exit 0 land · 4 hold.
// =====================================================================
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

function hold(kind, reason, extra = {}) {
  return { ok: false, pin: null, kind, reason, ...extra };
}

/** The branch head as a full commit id, or null. */
export function branchHead(repoPath, branch) {
  const r = spawnSync(
    "git",
    ["-C", repoPath, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`],
    {
      encoding: "utf8",
    },
  );
  const sha = (r.stdout || "").trim();
  return r.status === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

/** Read the ticket's acceptance flag and its latest tester PASS evidence payload. */
/**
 * The commit the ticket's current approval pinned (REVIEW PIN — the runner's agent review
 * or a human approve), or null. Only a SYSTEM row
 * counts (agents record evidence as `agent` through the MCP and cannot forge one), and
 * only one recorded after the ticket's latest entry into in_review: a rework or a
 * conflict resolution re-enters review, which makes the old pin stale.
 */
function readReviewPin(db, ticketId) {
  let row;
  try {
    row = db
      .prepare(
        "SELECT uri, created_at FROM evidence WHERE ticket_id = ? AND evidence_type = 'commit' " +
          "AND recorded_by_actor_type = 'system' AND uri LIKE 'gaffer-reviewed-commit:%' " +
          "ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get(ticketId);
  } catch {
    return null; // pre-provenance schema / minimal fixture: no pin was ever recorded
  }
  const sha = String(row?.uri ?? "")
    .slice("gaffer-reviewed-commit:".length)
    .toLowerCase();
  if (!/^[0-9a-f]{40,64}$/.test(sha)) return null;
  try {
    const entered = db
      .prepare(
        "SELECT created_at FROM work_events WHERE entity_type = 'ticket' AND entity_id = ? " +
          "AND event_type = 'ticket.transitioned' AND json_extract(payload_json, '$.to') = 'in_review' " +
          "ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get(ticketId);
    if (entered && String(entered.created_at) > String(row.created_at)) return null;
  } catch {
    // no event log to date the pin against: keep it (the stricter reading)
  }
  return sha;
}

export function readTesterEvidence(dbPath, ticketNumber) {
  if (!dbPath || !existsSync(dbPath))
    return { error: `dispatch DB not found (${dbPath || "unset"})` };
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    return { error: "node:sqlite is unavailable" };
  }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const num = parseInt(String(ticketNumber ?? "").replace(/^#/, ""), 10);
    if (!Number.isInteger(num) || num <= 0)
      return { error: `invalid ticket number "${ticketNumber}"` };
    let t;
    try {
      t = db.prepare("SELECT id, acceptance FROM tickets WHERE number = ?").get(num);
    } catch {
      t = db.prepare("SELECT id FROM tickets WHERE number = ?").get(num); // pre-v26 schema
    }
    if (!t || !t.id) return { error: `ticket #${num} not found` };
    // TESTER VERDICT: only the row the tester pass path recorded counts, i.e. a row a
    // `ticket.tester_passed` event on this ticket names (dispatch's testerPass writes the
    // row and the event in one transaction; nothing else writes that event). A
    // verdict-shaped row anyone else recorded is not a tester PASS: the delivery agent's
    // record_ac_evidence accepts any payload, so {verdict:"pass", provenance:"human"} from
    // it must not land as a waiver. The same rule as the Review view's packet
    // (packages/dispatch/src/services/reviewPacketService.ts readTester).
    let pass = null;
    try {
      const row = db
        .prepare(
          "SELECT e.payload_json FROM evidence e WHERE e.ticket_id = ? AND e.evidence_type = 'test_output' " +
            'AND e.payload_json LIKE \'%"verdict":"pass"%\' ' +
            "AND EXISTS (SELECT 1 FROM work_events w WHERE w.entity_type = 'ticket' " +
            "AND w.entity_id = e.ticket_id AND w.event_type = 'ticket.tester_passed' " +
            "AND json_extract(w.payload_json, '$.evidence_id') = e.id) " +
            "ORDER BY e.created_at DESC, e.rowid DESC LIMIT 1",
        )
        .get(t.id);
      if (row && typeof row.payload_json === "string") pass = JSON.parse(row.payload_json);
    } catch {
      // No evidence or event table (a minimal fixture): no tester verdict on record. That
      // fails closed: an acceptance ticket holds, an ordinary one is a head landing.
      pass = null;
    }
    return {
      ticketId: String(t.id),
      acceptance: Number(t.acceptance || 0) === 1,
      pass,
      reviewed: readReviewPin(db, t.id),
    };
  } catch (e) {
    return { error: `could not read the dispatch DB: ${e?.message ?? e}` };
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
  }
}

/**
 * REQUIRED CI: the CI results the runner recorded for this ticket (`ticket.ci_result`
 * events, newest first) → { required, state } for `commit`. No result ever recorded ⇒ CI
 * is not required for this ticket. Unreadable ⇒ null (the caller holds).
 */
export function readCiState(dbPath, ticketNumber, commit) {
  let db;
  try {
    const { DatabaseSync } = require("node:sqlite");
    db = new DatabaseSync(dbPath, { readOnly: true });
    const num = parseInt(String(ticketNumber ?? "").replace(/^#/, ""), 10);
    const t = db.prepare("SELECT id FROM tickets WHERE number = ?").get(num);
    if (!t) return null;
    let rows;
    try {
      rows = db
        .prepare(
          "SELECT json_extract(payload_json, '$.commit') AS c, json_extract(payload_json, '$.state') AS s " +
            "FROM work_events WHERE entity_type = 'ticket' AND entity_id = ? AND event_type = 'ticket.ci_result' " +
            "ORDER BY rowid DESC",
        )
        .all(t.id);
    } catch {
      return { required: false, state: null }; // no event log (minimal fixture)
    }
    if (!rows.length) return { required: false, state: null };
    const want = String(commit ?? "").toLowerCase();
    const hit = rows.find((r) => {
      const c = String(r.c ?? "").toLowerCase();
      return c !== "" && want !== "" && (want.startsWith(c) || c.startsWith(want));
    });
    return { required: true, state: hit ? String(hit.s ?? "") : null };
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
  }
}

export function landingDecision(args) {
  const d = testerLandingDecision(args);
  if (!d.ok) return d;
  // REQUIRED CI: the commit about to land must have a recorded CI PASS when the runner
  // has been recording CI for this ticket — every landing path asks this, not only the
  // approve that preceded it.
  const ci = readCiState(args.dbPath, args.ticketNumber, d.pin);
  if (ci === null) return hold("unreadable", "the ticket's CI results could not be read");
  if (ci.required && ci.state !== "pass")
    return hold(
      "ci-not-passed",
      `required CI has ${ci.state === "fail" ? "FAILED" : "not passed"} for ${String(d.pin).slice(0, 12)} (${ci.state || "no result for this commit"})`,
      { head: d.head },
    );
  return d;
}

function testerLandingDecision({ dbPath, ticketNumber, repoPath, branch }) {
  const ev = readTesterEvidence(dbPath, ticketNumber);
  if (ev.error) return hold("unreadable", ev.error);
  const head = branchHead(repoPath, branch);
  if (!head) return hold("no-head", `cannot resolve the head of ${branch} in ${repoPath}`);
  const pass = ev.pass;
  const reviewed = ev.reviewed ?? null;
  // A head landing (no tester / waiver / legacy) is bound to the reviewed commit when the
  // approval recorded one (the agent review or a human approve): the head must still BE it.
  const headLanding = (kind, reason) => {
    if (reviewed && head !== reviewed)
      return hold("moved-since-review", `${branch} moved since the review approved it`, {
        reviewed,
        head,
      });
    return { ok: true, pin: head, kind, reason, head, ...(reviewed ? { reviewed } : {}) };
  };
  if (!pass) {
    if (ev.acceptance)
      return hold("unverified", "acceptance ticket has no tester PASS on record", { head });
    return headLanding("no-tester", "no tester involved");
  }
  if (pass.provenance === "human") return headLanding("waived", "human tester-pass (waiver)");
  const tested = typeof pass.tested_commit === "string" ? pass.tested_commit.toLowerCase() : "";
  if (!/^[0-9a-f]{40,64}$/.test(tested)) {
    if (ev.acceptance)
      return hold("unverified", "acceptance PASS is not bound to a tested commit", { head });
    return headLanding("legacy-unbound", "tester PASS predates commit binding");
  }
  if (head !== tested)
    return hold("moved", `${branch} moved since the tester's PASS`, { tested, head });
  // The tester certified a commit nobody reviewed: the branch moved after the approval
  // (agent review or human approve) and before the tester ran.
  if (reviewed && tested !== reviewed)
    return hold("moved-since-review", `${branch} moved since the review approved it`, {
      reviewed,
      tested,
      head,
    });
  return {
    ok: true,
    pin: tested,
    kind: "bound",
    reason: "head is the tested commit",
    tested,
    head,
  };
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const opt = (name) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  if (cmd !== "landing") {
    process.stderr.write(
      "usage: tester-binding.mjs landing --db <db> --ticket <n> --repo <path> --branch <name>\n",
    );
    process.exit(2);
  }
  const d = landingDecision({
    dbPath: opt("db") || process.env.DISPATCH_DB,
    ticketNumber: opt("ticket"),
    repoPath: opt("repo"),
    branch: opt("branch"),
  });
  process.stdout.write(JSON.stringify(d) + "\n");
  process.exit(d.ok ? 0 : 4);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main(process.argv.slice(2));

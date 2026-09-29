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
// Decision (`landingDecision`), read from the dispatch DB, never from agent text:
//   no tester PASS recorded   → an ordinary ticket lands (no tester involved);
//                               an ACCEPTANCE ticket is HELD (nothing certifies it)
//   a HUMAN PASS (waiver)     → lands, pinned to the branch head, logged as a waiver
//   an agent PASS, no commit  → an ordinary ticket lands (legacy, logged);
//                               an ACCEPTANCE ticket is HELD (unverified)
//   bound PASS, head == tested → lands, pinned to the tested commit
//   bound PASS, head moved     → HELD (names both commits)
// Fail CLOSED: an unreadable DB, an unknown ticket or an unresolvable branch head HOLD.
//
// CLI: node lib/tester-binding.mjs landing --db <dispatch.sqlite> --ticket <n>
//        --repo <path> --branch <name>
//      → one JSON line { ok, pin, kind, reason, tested, head }; exit 0 land · 4 hold.
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
    let pass = null;
    try {
      const row = db
        .prepare(
          "SELECT payload_json FROM evidence WHERE ticket_id = ? AND evidence_type = 'test_output' " +
            'AND payload_json LIKE \'%"verdict":"pass"%\' ORDER BY created_at DESC, rowid DESC LIMIT 1',
        )
        .get(t.id);
      if (row && typeof row.payload_json === "string") pass = JSON.parse(row.payload_json);
    } catch {
      pass = null; // no evidence table (minimal fixture) = no tester verdict
    }
    return { ticketId: String(t.id), acceptance: Number(t.acceptance || 0) === 1, pass };
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

export function landingDecision({ dbPath, ticketNumber, repoPath, branch }) {
  const ev = readTesterEvidence(dbPath, ticketNumber);
  if (ev.error) return hold("unreadable", ev.error);
  const head = branchHead(repoPath, branch);
  if (!head) return hold("no-head", `cannot resolve the head of ${branch} in ${repoPath}`);
  const pass = ev.pass;
  if (!pass) {
    if (ev.acceptance)
      return hold("unverified", "acceptance ticket has no tester PASS on record", { head });
    return { ok: true, pin: head, kind: "no-tester", reason: "no tester involved", head };
  }
  if (pass.provenance === "human")
    return { ok: true, pin: head, kind: "waived", reason: "human tester-pass (waiver)", head };
  const tested = typeof pass.tested_commit === "string" ? pass.tested_commit.toLowerCase() : "";
  if (!/^[0-9a-f]{40,64}$/.test(tested)) {
    if (ev.acceptance)
      return hold("unverified", "acceptance PASS is not bound to a tested commit", { head });
    return {
      ok: true,
      pin: head,
      kind: "legacy-unbound",
      reason: "tester PASS predates commit binding",
      head,
    };
  }
  if (head !== tested)
    return hold("moved", `${branch} moved since the tester's PASS`, { tested, head });
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

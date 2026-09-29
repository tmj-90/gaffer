import { existsSync, statSync } from "node:fs";

import type { Db } from "../db/connection.js";
import { SCHEMA_VERSION } from "../db/schema.js";
import { verifyEventChain } from "../events/eventChain.js";
import { contractHash } from "../util/contractHash.js";
import type { HumanQueue } from "../services/humanQueueService.js";
import { VERSION } from "../version.js";

/**
 * Operational introspection backing `dispatch doctor` and `dispatch stats`.
 * Pure read-only aggregates against the live DB — no mutation, no telemetry.
 */

export interface DoctorCheck {
  readonly label: string;
  /** 'ok' is healthy; 'warn' is non-fatal; 'fail' sets a non-zero exit. */
  readonly level: "ok" | "warn" | "fail";
  readonly detail?: string;
  readonly fix?: string;
}

export interface DoctorReport {
  readonly exitCode: number;
  readonly checks: ReadonlyArray<DoctorCheck>;
}

function tableExists(db: Db, name: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
  return row !== undefined;
}

function count(db: Db, sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).get(...params) as { n: number } | undefined;
  return row?.n ?? 0;
}

/**
 * Run the doctor checks against an already-open DB. The caller owns the
 * handle (the act of opening it successfully is itself the first health
 * signal, surfaced by the entry point). `dbPath` is used only for the file
 * permission/existence checks; pass `:memory:` to skip them.
 */
export function runDoctor(db: Db, dbPath: string, nowIso = new Date().toISOString()): DoctorReport {
  const checks: DoctorCheck[] = [];
  const onDisk = dbPath !== ":memory:";

  // 0. Build version — first line so an operator filing an issue (or reading a
  //    --json health probe) always has the running version to hand.
  checks.push({ label: `Dispatch version: ${VERSION}`, level: "ok" });

  // 1. Schema version stamp matches this build.
  const schemaRow = db
    .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;
  const found = schemaRow ? Number(schemaRow.value) : undefined;
  if (found === SCHEMA_VERSION) {
    checks.push({ label: `Schema version: ${found}`, level: "ok" });
  } else if (found === undefined) {
    checks.push({
      label: "Schema version: not stamped",
      level: "fail",
      fix: "Run `dispatch init` to apply the schema.",
    });
  } else if (found < SCHEMA_VERSION) {
    checks.push({
      label: `Schema version: ${found} (build supports ${SCHEMA_VERSION})`,
      level: "warn",
      detail: "DB will be migrated forward on next open.",
    });
  } else {
    checks.push({
      label: `Schema version: ${found} is NEWER than this build (${SCHEMA_VERSION})`,
      level: "fail",
      detail: "Database was written by a newer Dispatch.",
      fix: "Upgrade Dispatch: npm i -g dispatch@latest",
    });
  }

  // 2. Core tables reachable.
  for (const t of ["tickets", "ticket_claims", "decisions", "work_events"]) {
    if (tableExists(db, t)) {
      checks.push({ label: `Table ${t}: present`, level: "ok" });
    } else {
      checks.push({
        label: `Table ${t}: MISSING`,
        level: "fail",
        fix: "Run `dispatch init` to apply the schema.",
      });
    }
  }

  // 3. Counts.
  const tickets = count(db, "SELECT COUNT(*) AS n FROM tickets");
  const claimsActive = count(db, "SELECT COUNT(*) AS n FROM ticket_claims WHERE status = 'active'");
  checks.push({
    label: `Tickets: ${tickets}, active claims: ${claimsActive}`,
    level: "ok",
  });

  // 4. Stale active claims — active but past their expiry. These are stuck
  //    leases an agent never released or heartbeated; recover with
  //    `dispatch expire-claims`.
  const stale = count(
    db,
    "SELECT COUNT(*) AS n FROM ticket_claims WHERE status = 'active' AND expires_at < ?",
    nowIso,
  );
  if (stale === 0) {
    checks.push({ label: "Stale active claims: 0", level: "ok" });
  } else {
    checks.push({
      label: `Stale active claims: ${stale}`,
      level: "warn",
      detail: "Active claims whose lease has expired without release/heartbeat.",
      fix: "Run `dispatch expire-claims` to return them to the pool.",
    });
  }

  // 5. Integrity: tickets in a 'claimed'/'in_progress' status with NO active
  //    claim — an inconsistency between ticket state and the claim ledger.
  const orphanWorking = count(
    db,
    `SELECT COUNT(*) AS n FROM tickets t
     WHERE t.status IN ('claimed','in_progress')
       AND NOT EXISTS (
         SELECT 1 FROM ticket_claims c
         WHERE c.ticket_id = t.id AND c.status = 'active'
       )`,
  );
  if (orphanWorking === 0) {
    checks.push({ label: "Working tickets with active claim: consistent", level: "ok" });
  } else {
    checks.push({
      label: `Integrity: ${orphanWorking} working ticket(s) with no active claim`,
      level: "warn",
      detail: "Ticket status says claimed/in_progress but no active claim exists.",
      fix: "Run `dispatch expire-claims`, or inspect with `dispatch ticket show <ref>`.",
    });
  }

  // 6. SQLite quick integrity check.
  try {
    const integrity = db.prepare("PRAGMA integrity_check").get() as
      { integrity_check: string } | undefined;
    if (integrity?.integrity_check === "ok") {
      checks.push({ label: "SQLite integrity_check: ok", level: "ok" });
    } else {
      checks.push({
        label: "SQLite integrity_check: FAILED",
        level: "fail",
        detail: integrity?.integrity_check ?? "unknown",
      });
    }
  } catch {
    // Non-fatal: integrity_check is unavailable on some builds.
  }

  // 7. File permissions (on-disk only).
  if (onDisk && existsSync(dbPath)) {
    const mode = statSync(dbPath).mode & 0o777;
    if (mode === 0o600) {
      checks.push({ label: "DB permissions: 0600", level: "ok" });
    } else {
      checks.push({
        label: `DB permissions: ${mode.toString(8).padStart(4, "0")}`,
        level: "warn",
        detail: "Recommended 0600 (owner read/write only).",
        fix: `chmod 600 ${dbPath}`,
      });
    }
  }

  // 8. Event-log hash chain (tamper evidence). A broken link means a work_events
  //    row was rewritten, deleted or re-ordered after it was written.
  if (tableExists(db, "work_events")) {
    const chain = verifyEventChain(db);
    if (chain.ok) {
      checks.push({ label: `Event log hash chain: intact (${chain.checked} events)`, level: "ok" });
    } else {
      checks.push({
        label: `Event log hash chain: BROKEN at seq ${chain.brokenAtSeq} (${chain.reason})`,
        level: "fail",
        detail: `event ${chain.brokenEventId}; ${chain.checked} rows checked before the break`,
        fix: "The log was altered after it was written. Restore from a trusted export bundle; `dispatch events verify --json` names the row.",
      });
    }
  }

  const hasFail = checks.some((c) => c.level === "fail");
  return { exitCode: hasFail ? 1 : 0, checks };
}

export function renderDoctor(report: DoctorReport): string {
  const lines: string[] = ["dispatch doctor", ""];
  for (const c of report.checks) {
    const glyph = c.level === "ok" ? "ok " : c.level === "warn" ? " ! " : "FAIL";
    lines.push(`[${glyph}] ${c.label}`);
    if (c.detail) lines.push(`       ${c.detail}`);
    if (c.fix) lines.push(`       fix: ${c.fix}`);
  }
  lines.push("");
  const hasFail = report.checks.some((c) => c.level === "fail");
  const hasWarn = report.checks.some((c) => c.level === "warn");
  if (hasFail) lines.push("Not healthy. Address the FAIL items above.");
  else if (hasWarn) lines.push("Healthy (with warnings).");
  else lines.push("Healthy.");
  return lines.join("\n");
}

// ── stats ────────────────────────────────────────────────────────────────

/** ACCEPTANCE GATE: one epic's build-acceptance state, derived from its acceptance ticket. */
export interface EpicAcceptance {
  readonly epic_node_id: string;
  readonly epic_name: string;
  readonly acceptance_ticket: number | null;
  readonly acceptance_status: string;
  /** Implementation (non-acceptance) tickets of the epic: done / total (cancelled excluded). */
  readonly implementation_done: number;
  readonly implementation_total: number;
  /**
   * accepted   — VERIFIED: done, and the latest PASS is an agent/system verdict bound to a
   *              tested commit, the contract on record (hash matches) and a clean replay;
   * waived     — done on a HUMAN tester-pass (an explicit decision, shown as such — never
   *              the same evidence as a revision-bound test);
   * stale      — done, but the contract changed after the bound PASS;
   * unverified — done without a bound PASS (no PASS evidence, a legacy PASS with no commit /
   *              hash, or no clean replay): nothing certifies what was accepted;
   * testing    — in the tester's hands (in_testing);
   * failed     — the tester failed it or it was parked (refining / blocked / failed);
   * pending    — not yet reached (draft / ready / claimed / in_progress / in_review / paused).
   */
  readonly result:
    "accepted" | "waived" | "stale" | "unverified" | "testing" | "failed" | "pending";
  /** True when every implementation ticket is done and the build is neither accepted nor waived. */
  readonly unaccepted: boolean;
  /** Provenance of the latest PASS (agent / system / human), or null when none was recorded. */
  readonly pass_provenance: string | null;
  /** Replay outcome recorded on the latest PASS (passed / failed / skipped), or null. */
  readonly replay: string | null;
  /** The exact commit the tester's PASS ran against (from its evidence), when recorded. */
  readonly accepted_commit: string | null;
  /** The contract hash the tester's PASS recorded, and whether the ticket's contract still matches it. */
  readonly accepted_contract_hash: string | null;
  readonly contract_changed: boolean;
  /** Where the build lives, so a status pane can tell whether the default branch has moved past accepted_commit. */
  readonly repo_path: string | null;
  readonly default_branch: string | null;
}

export { contractHash } from "../util/contractHash.js";

export interface AcceptanceSummary {
  /** Epics whose implementation has fully merged but whose build is neither accepted nor waived — human attention. */
  readonly unaccepted: number;
  readonly testing: number;
  /** VERIFIED acceptances only (bound, current contract, clean replay). */
  readonly accepted: number;
  /** Human waivers — accepted by decision, not by a revision-bound test. */
  readonly waived: number;
  readonly stale: number;
  readonly unverified: number;
  readonly failed: number;
  readonly epics: readonly EpicAcceptance[];
}

export interface StatsReport {
  readonly ticketsByStatus: Readonly<Record<string, number>>;
  readonly openDecisions: number;
  readonly activeClaims: number;
  readonly staleClaims: number;
  /** ACCEPTANCE GATE: "implementation merged" vs "build accepted", per epic. */
  readonly acceptance: AcceptanceSummary;
}

/**
 * ACCEPTANCE GATE: derive every epic's acceptance state from its acceptance ticket
 * (tickets.acceptance = 1) and its implementation siblings. Fail-soft: a DB without
 * the column (a hand-rolled fixture) reports an empty summary.
 */
export function computeAcceptance(db: Db): AcceptanceSummary {
  const empty: AcceptanceSummary = {
    unaccepted: 0,
    testing: 0,
    accepted: 0,
    waived: 0,
    stale: 0,
    unverified: 0,
    failed: 0,
    epics: [],
  };
  let rows: Array<{
    id: string;
    number: number | null;
    status: string;
    epic_id: string;
    epic_name: string;
    impl_total: number;
    impl_done: number;
    repo_path: string | null;
    default_branch: string | null;
  }>;
  try {
    rows = db
      .prepare(
        `SELECT t.id AS id, t.number AS number, t.status AS status, sn.id AS epic_id, sn.name AS epic_name,
                (SELECT r.local_path FROM ticket_repos tr JOIN repositories r ON r.id = tr.repo_id
                  WHERE tr.ticket_id = t.id ORDER BY tr.role = 'primary' DESC LIMIT 1) AS repo_path,
                (SELECT r.default_branch FROM ticket_repos tr JOIN repositories r ON r.id = tr.repo_id
                  WHERE tr.ticket_id = t.id ORDER BY tr.role = 'primary' DESC LIMIT 1) AS default_branch,
                (SELECT COUNT(*) FROM ticket_scope_nodes s2 JOIN tickets t2 ON t2.id = s2.ticket_id
                  WHERE s2.scope_node_id = sn.id AND t2.acceptance = 0 AND t2.status <> 'cancelled') AS impl_total,
                (SELECT COUNT(*) FROM ticket_scope_nodes s2 JOIN tickets t2 ON t2.id = s2.ticket_id
                  WHERE s2.scope_node_id = sn.id AND t2.acceptance = 0 AND t2.status = 'done') AS impl_done
           FROM tickets t
           JOIN ticket_scope_nodes tsn ON tsn.ticket_id = t.id
           JOIN scope_nodes sn ON sn.id = tsn.scope_node_id AND sn.type = 'epic'
          WHERE t.acceptance = 1
          ORDER BY t.number ASC`,
      )
      .all() as typeof rows;
  } catch {
    return empty;
  }
  const epics: EpicAcceptance[] = rows.map((r) => {
    // The tester's latest PASS evidence carries the binding (commit, contract hash, replay)
    // and the provenance of whoever recorded it.
    let acceptedCommit: string | null = null;
    let acceptedHash: string | null = null;
    let provenance: string | null = null;
    let replay: string | null = null;
    try {
      const ev = db
        .prepare(
          `SELECT payload_json FROM evidence WHERE ticket_id = ? AND evidence_type = 'test_output'
             AND payload_json LIKE '%"verdict":"pass"%' ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        )
        .get(r.id) as { payload_json: string | null } | undefined;
      if (ev?.payload_json) {
        const p = JSON.parse(ev.payload_json) as {
          tested_commit?: unknown;
          contract_hash?: unknown;
          provenance?: unknown;
          replay?: unknown;
        };
        if (typeof p.tested_commit === "string") acceptedCommit = p.tested_commit;
        if (typeof p.contract_hash === "string") acceptedHash = p.contract_hash;
        if (typeof p.provenance === "string") provenance = p.provenance;
        if (typeof p.replay === "string") replay = p.replay;
      }
    } catch {
      /* no binding recorded */
    }
    const currentHash = contractHash(db, r.id);
    const contractChanged =
      acceptedHash !== null && currentHash !== null && acceptedHash !== currentHash;
    let result: EpicAcceptance["result"];
    if (r.status === "done") {
      if (provenance === "human") result = "waived";
      else if (contractChanged) result = "stale";
      else if (acceptedCommit !== null && acceptedHash !== null && replay === "passed")
        result = "accepted";
      else result = "unverified";
    } else if (r.status === "in_testing") result = "testing";
    else if (r.status === "refining" || r.status === "blocked" || r.status === "failed")
      result = "failed";
    else result = "pending";
    const unaccepted =
      r.impl_total > 0 &&
      r.impl_done === r.impl_total &&
      result !== "accepted" &&
      result !== "waived";
    return {
      epic_node_id: r.epic_id,
      epic_name: r.epic_name,
      acceptance_ticket: r.number,
      acceptance_status: r.status,
      implementation_done: r.impl_done,
      implementation_total: r.impl_total,
      result,
      unaccepted,
      pass_provenance: provenance,
      replay,
      accepted_commit: acceptedCommit,
      accepted_contract_hash: acceptedHash,
      contract_changed: contractChanged,
      repo_path: r.repo_path ?? null,
      default_branch: r.default_branch ?? null,
    };
  });
  return {
    unaccepted: epics.filter((e) => e.unaccepted).length,
    testing: epics.filter((e) => e.result === "testing").length,
    accepted: epics.filter((e) => e.result === "accepted").length,
    waived: epics.filter((e) => e.result === "waived").length,
    stale: epics.filter((e) => e.result === "stale").length,
    unverified: epics.filter((e) => e.result === "unverified").length,
    failed: epics.filter((e) => e.result === "failed").length,
    epics,
  };
}

export function computeStats(db: Db, nowIso = new Date().toISOString()): StatsReport {
  const statusRows = db
    .prepare("SELECT status, COUNT(*) AS n FROM tickets GROUP BY status ORDER BY status")
    .all() as Array<{ status: string; n: number }>;
  const ticketsByStatus: Record<string, number> = {};
  for (const r of statusRows) ticketsByStatus[r.status] = r.n;

  const openDecisions = count(
    db,
    "SELECT COUNT(*) AS n FROM decisions WHERE status NOT IN ('accepted','rejected','superseded')",
  );
  const activeClaims = count(db, "SELECT COUNT(*) AS n FROM ticket_claims WHERE status = 'active'");
  const staleClaims = count(
    db,
    "SELECT COUNT(*) AS n FROM ticket_claims WHERE status = 'active' AND expires_at < ?",
    nowIso,
  );

  return {
    ticketsByStatus,
    openDecisions,
    activeClaims,
    staleClaims,
    acceptance: computeAcceptance(db),
  };
}

export function renderStats(stats: StatsReport): string {
  const lines: string[] = ["dispatch stats", "", "Tickets by status:"];
  const statuses = Object.keys(stats.ticketsByStatus);
  if (statuses.length === 0) {
    lines.push("  (no tickets yet)");
  } else {
    for (const s of statuses) {
      lines.push(`  ${String(stats.ticketsByStatus[s]).padStart(4)}  ${s}`);
    }
  }
  lines.push("");
  lines.push(`Open decisions:  ${stats.openDecisions}`);
  lines.push(`Active claims:   ${stats.activeClaims}`);
  lines.push(`Stale claims:    ${stats.staleClaims}`);
  // ACCEPTANCE GATE: implementation merged is not build accepted.
  const a = stats.acceptance;
  if (a && a.epics.length > 0) {
    lines.push("");
    lines.push(
      `Builds:  ${a.accepted} accepted (verified) · ${a.waived} waived by a human · ${a.unverified} unverified · ${a.stale} stale · ${a.testing} in acceptance testing · ${a.failed} failed acceptance · ${a.unaccepted} NOT accepted with implementation merged`,
    );
    for (const e of a.epics) {
      lines.push(
        `  ${e.epic_name}: implementation ${e.implementation_done}/${e.implementation_total} done · acceptance #${e.acceptance_ticket ?? "?"} ${e.acceptance_status} → ${e.result}${e.accepted_commit ? ` @ ${e.accepted_commit.slice(0, 12)}` : ""}${e.result === "stale" ? "  ← the contract changed after the tester's PASS; re-test" : e.result === "unverified" ? "  ← no revision-bound PASS (commit + contract + clean replay); re-test, or waive: tester-pass --as human" : e.result === "waived" ? "  (human waiver — not a revision-bound test)" : e.unaccepted ? "  ← needs the tester or a human tester-pass" : ""}`,
      );
    }
  }
  return lines.join("\n");
}

// ── human queue ────────────────────────────────────────────────────────────

/** Round a millisecond wait to a compact age string (e.g. "3h", "2d", "5m"). */
function humanAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/**
 * Render the human-owned queue for the terminal — the operator's "What I own":
 * each pending decision/review/approval WITH its reason and how long it's waited.
 * The reason is the whole point (why the agent needs a human), so it is always
 * shown, not just a count.
 */
export function renderHumanQueue(queue: HumanQueue): string {
  const lines: string[] = ["what you own"];
  if (queue.items.length === 0) {
    lines.push("  (nothing waiting on you)");
    return lines.join("\n");
  }
  for (const item of queue.items) {
    const ref =
      item.ticket && item.ticket.number !== null
        ? `#${item.ticket.number}`
        : item.ticket
          ? item.ticket.id.slice(0, 8)
          : "—";
    lines.push(`  [${item.label}] ${ref}  (${humanAge(item.waitedMs)})`);
    lines.push(`     why: ${item.reason}`);
  }
  return lines.join("\n");
}

import { existsSync, statSync } from "node:fs";

import type { Db } from "../db/connection.js";
import { SCHEMA_VERSION } from "../db/schema.js";
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
      | { integrity_check: string }
      | undefined;
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

export interface StatsReport {
  readonly ticketsByStatus: Readonly<Record<string, number>>;
  readonly openDecisions: number;
  readonly activeClaims: number;
  readonly staleClaims: number;
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

  return { ticketsByStatus, openDecisions, activeClaims, staleClaims };
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
  return lines.join("\n");
}

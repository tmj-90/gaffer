import type { Db } from "../db/connection.js";
import { LANE_VERDICT_EVENT } from "./reviewTelemetry.js";

/**
 * TESTER HOLDS (`wg stats`, `gaffer status`): the in_testing tickets the independent tester
 * could not decide during their current stay, read from the runner's own `ticket.lane_verdict`
 * records (system or admin only: an agent cannot write one), and the tester lane's verdicts
 * counted by kind. A hold coded `tester_unprovable` ("cannot be proven on this host") is
 * listed and counted apart from the other holds, so a tester that says it too often is
 * visible. Read-only; nothing gates on it (the hold itself is the ticket staying in_testing).
 */
export interface TesterHold {
  readonly number: number | null;
  readonly title: string;
  /** `tester_unprovable`, or null for any other hold. */
  readonly code: string | null;
  /** With tester_unprovable: the criterion numbers not proven on this host. */
  readonly criteria: number[];
  readonly reason: string;
  /** The commit the tester ran on, when recorded. */
  readonly commit: string | null;
  readonly at: string;
}

export interface TesterHoldsReport {
  /** Tickets in_testing whose latest tester verdict this stay is a hold. */
  readonly held: TesterHold[];
  /** Every tester lane verdict on record: pass, fail, unprovable, other holds. */
  readonly counts: { pass: number; fail: number; unprovable: number; held: number };
}

function obj(raw: string | null): Record<string, unknown> {
  try {
    const v = JSON.parse(raw ?? "{}") as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function readTesterHolds(db: Db): TesterHoldsReport {
  const counts = { pass: 0, fail: 0, unprovable: 0, held: 0 };
  const held: TesterHold[] = [];
  try {
    const rows = db
      .prepare(
        `SELECT json_extract(payload_json, '$.verdict') AS verdict,
                json_extract(payload_json, '$.held_code') AS code,
                COUNT(*) AS n
           FROM work_events
          WHERE entity_type = 'ticket' AND event_type = ?
            AND json_extract(payload_json, '$.lane') = 'tester'
          GROUP BY verdict, code`,
      )
      .all(LANE_VERDICT_EVENT) as Array<{ verdict: string | null; code: string | null; n: number }>;
    for (const r of rows) {
      if (r.verdict === "pass") counts.pass += r.n;
      else if (r.verdict === "fail") counts.fail += r.n;
      else if (r.verdict === "held" && r.code === "tester_unprovable") counts.unprovable += r.n;
      else if (r.verdict === "held") counts.held += r.n;
    }
    const tickets = db
      .prepare("SELECT id, number, title FROM tickets WHERE status = 'in_testing' ORDER BY number")
      .all() as Array<{ id: string; number: number | null; title: string | null }>;
    const entered = db.prepare(
      `SELECT rowid AS r FROM work_events
        WHERE entity_type = 'ticket' AND entity_id = ? AND event_type = 'ticket.transitioned'
          AND json_extract(payload_json, '$.to') = 'in_testing'
        ORDER BY rowid DESC LIMIT 1`,
    );
    const latest = db.prepare(
      `SELECT payload_json AS p, created_at AS at FROM work_events
        WHERE entity_type = 'ticket' AND entity_id = ? AND event_type = ?
          AND json_extract(payload_json, '$.lane') = 'tester' AND rowid > ?
        ORDER BY rowid DESC LIMIT 1`,
    );
    for (const t of tickets) {
      const e = entered.get(t.id) as { r: number } | undefined;
      const v = latest.get(t.id, LANE_VERDICT_EVENT, e ? e.r : 0) as
        { p: string | null; at: string } | undefined;
      if (!v) continue;
      const p = obj(v.p);
      if (p.verdict !== "held") continue;
      held.push({
        number: t.number,
        title: String(t.title ?? ""),
        code: typeof p.held_code === "string" ? p.held_code : null,
        criteria: Array.isArray(p.criteria)
          ? p.criteria.filter((c): c is number => Number.isInteger(c))
          : [],
        reason: typeof p.held_reason === "string" ? p.held_reason : "",
        commit: typeof p.commit === "string" ? p.commit : null,
        at: v.at,
      });
    }
  } catch {
    /* a minimal or older schema: report nothing */
  }
  return { held, counts };
}

/**
 * The review and acceptance measures, read from the event log in one place, for
 * GET /api/health and `wg stats` (Release A metrics package):
 *
 *   review_time     human review time per accepted ticket (health/reviewTime.ts)
 *   first_pass      first-pass acceptance (health/firstPass.ts)
 *   lane_verdicts   `ticket.lane_verdict` counts per lane and verdict
 *   escaped_defects escaped accepted changes over accepted changes, from the regression
 *                   links a person filed (health/escapedDefects.ts)
 *   lane_value      what each judging lane changed: verdicts against the person's decision,
 *                   unique catches, ledger cost per attempt (health/laneValue.ts)
 *
 * Read-only; deterministic over the recorded events.
 */
import type { Db } from "../db/connection.js";
import {
  LANE_VERDICT_EVENT,
  REVIEW_OPENED_EVENT,
  REVIEW_RAW_OPENED_EVENT,
} from "../services/reviewTelemetry.js";
import {
  currentRegressionLinks,
  DEFECT_ESCAPED_EVENT,
  DEFECT_ESCAPED_WITHDRAWN_EVENT,
  type RegressionEventRow,
} from "../services/escapedDefects.js";
import { escapedDefectReport, type EscapedDefects } from "./escapedDefects.js";
import { firstPassAcceptance, type FirstPassReport } from "./firstPass.js";
import type { HealthRow } from "./healthAggregator.js";
import { laneValueReport, type LaneValueReport } from "./laneValue.js";
import { reviewTimeReport, type ReviewOpen, type ReviewTimeReport } from "./reviewTime.js";

export interface LaneVerdictCounts {
  readonly recorded: number;
  readonly by_lane: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

export interface ReviewMeasures {
  readonly review_time: ReviewTimeReport;
  readonly first_pass: FirstPassReport;
  readonly lane_verdicts: LaneVerdictCounts;
  readonly escaped_defects: EscapedDefects;
  readonly lane_value: LaneValueReport;
}

/** The window the escaped-defect rate counts accepted changes over (Health's default). */
export const DEFAULT_WINDOW_DAYS = 30;

export interface ReviewMeasureOptions {
  /** Now, for the windowed figures (default: the wall clock). */
  readonly nowMs?: number;
  /** Accepted in the last N days (default 30, Health's governance window). */
  readonly windowDays?: number;
  /** The usage ledger's rows, for each lane's cost per attempt (none: no spend). */
  readonly ledger?: readonly HealthRow[];
}

const ms = (iso: string): number => Date.parse(iso) || 0;
// Every read is in insertion order (rowid): created_at ties at millisecond resolution, and
// the read models sort stably by time, so an entry into review and the exit that follows
// it in the same millisecond stay in the order they were written.

/** Every measure above from the database. */
export function readReviewMeasures(db: Db, opts: ReviewMeasureOptions = {}): ReviewMeasures {
  const tickets = db.prepare("SELECT id, status FROM tickets").all() as Array<{
    id: string;
    status: string;
  }>;
  const transitions = (
    db
      .prepare(
        `SELECT entity_id AS ticketId, actor_type AS actorType,
                json_extract(payload_json, '$.from')   AS fromStatus,
                json_extract(payload_json, '$.to')     AS toStatus,
                json_extract(payload_json, '$.reason') AS reason,
                created_at AS at
           FROM work_events
          WHERE entity_type = 'ticket' AND event_type = 'ticket.transitioned'
          ORDER BY rowid`,
      )
      .all() as Array<{
      ticketId: string;
      actorType: string;
      fromStatus: string | null;
      toStatus: string | null;
      reason: string | null;
      at: string;
    }>
  ).map((r) => ({ ...r, atMs: ms(r.at) }));
  const opensOf = (type: string): ReviewOpen[] =>
    (
      db
        .prepare(
          `SELECT entity_id AS ticketId, created_at AS at,
                  json_extract(payload_json, '$.what') AS what
             FROM work_events
            WHERE entity_type = 'ticket' AND event_type = ?
            ORDER BY rowid`,
        )
        .all(type) as Array<{ ticketId: string; at: string; what: string | null }>
    ).map((r) => ({
      ticketId: r.ticketId,
      atMs: ms(r.at),
      ...(r.what ? { what: r.what } : {}),
    }));
  const retries = db
    .prepare(`SELECT ticket_id AS ticketId, created_at AS at FROM rework_attempts`)
    .all() as Array<{ ticketId: string; at: string }>;
  const laneRows = db
    .prepare(
      `SELECT json_extract(payload_json, '$.lane') AS lane,
              json_extract(payload_json, '$.verdict') AS verdict,
              COUNT(*) AS n
         FROM work_events
        WHERE entity_type = 'ticket' AND event_type = ?
        GROUP BY lane, verdict
        ORDER BY lane, verdict`,
    )
    .all(LANE_VERDICT_EVENT) as Array<{ lane: string | null; verdict: string | null; n: number }>;
  const byLane: Record<string, Record<string, number>> = {};
  let recorded = 0;
  for (const r of laneRows) {
    const lane = r.lane ?? "unknown";
    (byLane[lane] ??= {})[r.verdict ?? "unknown"] = r.n;
    recorded += r.n;
  }
  const regressionRows = db
    .prepare(
      `SELECT entity_id AS ticketId, event_type AS eventType, actor_type AS actorType,
              actor_id AS actorId, created_at AS at,
              json_extract(payload_json, '$.regression_of') AS regressionOf,
              json_extract(payload_json, '$.note') AS note
         FROM work_events
        WHERE entity_type = 'ticket' AND event_type IN (?, ?)
        ORDER BY rowid`,
    )
    .all(DEFECT_ESCAPED_EVENT, DEFECT_ESCAPED_WITHDRAWN_EVENT) as RegressionEventRow[];
  const verdictRows = db
    .prepare(
      `SELECT entity_id AS ticketId, created_at AS at,
              json_extract(payload_json, '$.lane') AS lane,
              json_extract(payload_json, '$.verdict') AS verdict
         FROM work_events
        WHERE entity_type = 'ticket' AND event_type = ?
        ORDER BY rowid`,
    )
    .all(LANE_VERDICT_EVENT) as Array<{
    ticketId: string;
    at: string;
    lane: string | null;
    verdict: string | null;
  }>;
  return {
    review_time: reviewTimeReport({
      transitions,
      opens: opensOf(REVIEW_OPENED_EVENT),
      rawOpens: opensOf(REVIEW_RAW_OPENED_EVENT),
      tickets,
    }),
    first_pass: firstPassAcceptance({ transitions, retries, tickets }),
    lane_verdicts: { recorded, by_lane: byLane },
    escaped_defects: escapedDefectReport({
      links: currentRegressionLinks(regressionRows),
      transitions,
      tickets,
      nowMs: opts.nowMs ?? Date.now(),
      windowDays: opts.windowDays ?? DEFAULT_WINDOW_DAYS,
    }),
    lane_value: laneValueReport({
      transitions,
      verdicts: verdictRows.map((r) => ({
        ticketId: r.ticketId,
        lane: r.lane ?? "unknown",
        verdict: r.verdict ?? "unknown",
        atMs: ms(r.at),
      })),
      ledger: opts.ledger ?? [],
    }),
  };
}

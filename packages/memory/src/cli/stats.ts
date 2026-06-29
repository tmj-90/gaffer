/**
 * `memory stats` — local read-tracking view.
 *
 * Answers "is memory earning its keep?" without sending anything
 * off-box. Reads aggregate-only against the existing `events` table
 * (no new schema): 'read' events are emitted by core/lore.ts on each
 * search hit and each `getLore` fetch, gated by env vars
 * (MEMORY_NO_TELEMETRY / MEMORY_AUDIT_OFF).
 *
 * Three views the CLI renders:
 *
 *   - topCitedRecords — what's pulling weight in the recent window
 *   - retireCandidates — active records with zero reads in a longer
 *     window (the dead-weight signal)
 *   - recentActivity — event-kind histogram over a window
 */
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";

import type { Database } from "better-sqlite3";

export interface TopCitedRecord {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly readCount: number;
}

export interface RetireCandidate {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly lastReadAt: string | null;
  readonly confidence: string;
  readonly hasSource: boolean;
  readonly updatedAt: string;
}

export interface RecentActivity {
  readonly suggested: number;
  readonly approved: number;
  readonly rejected: number;
  readonly deprecated: number;
  readonly superseded: number;
  readonly updated: number;
  readonly reads: number;
  readonly imports: number;
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400_000).toISOString();
}

/**
 * Most-cited records in the window. `readCount` is the number of
 * 'read' events for that lore_id with `ts >= sinceDays-ago`. Default
 * window 90 days, default limit 10.
 *
 * INNER JOINs against `lore` so a record that was hard-deleted (its
 * events stay, the row is gone) doesn't show up as a phantom hit.
 */
export function topCitedRecords(
  db: Database,
  opts: { sinceDays?: number; limit?: number } = {},
): TopCitedRecord[] {
  const since = isoDaysAgo(opts.sinceDays ?? 90);
  const limit = opts.limit ?? 10;
  const rows = db
    .prepare(
      `SELECT l.id AS id, l.title AS title, l.status AS status,
              COUNT(e.rowid) AS readCount
       FROM events e
       INNER JOIN lore l ON l.id = e.lore_id
       WHERE e.kind = 'read' AND e.ts >= ? AND l.restricted = 0
       GROUP BY l.id
       ORDER BY readCount DESC, l.updated_at DESC
       LIMIT ?`,
    )
    .all(since, limit) as Array<{
    id: string;
    title: string;
    status: string;
    readCount: number;
  }>;
  return rows;
}

/**
 * Active records with no reads in the past `quietForDays` days
 * (default 180). Sort key prioritises records the team is least
 * attached to: no-source first, then ascending confidence
 * (low → medium → high), then oldest updated_at.
 */
export function retireCandidates(
  db: Database,
  opts: { quietForDays?: number } = {},
): RetireCandidate[] {
  const cutoff = isoDaysAgo(opts.quietForDays ?? 180);
  const rows = db
    .prepare(
      `WITH last_reads AS (
         SELECT lore_id, MAX(ts) AS last_read_at
         FROM events WHERE kind = 'read'
         GROUP BY lore_id
       )
       SELECT l.id AS id, l.title AS title, l.status AS status,
              lr.last_read_at AS lastReadAt,
              l.confidence AS confidence,
              CASE WHEN l.source IS NULL OR l.source = '' THEN 0 ELSE 1 END AS hasSource,
              l.updated_at AS updatedAt
       FROM lore l
       LEFT JOIN last_reads lr ON lr.lore_id = l.id
       WHERE l.status = 'active'
         AND l.restricted = 0
         AND (lr.last_read_at IS NULL OR lr.last_read_at < ?)
       ORDER BY hasSource ASC,
                CASE l.confidence
                  WHEN 'low' THEN 0
                  WHEN 'medium' THEN 1
                  WHEN 'high' THEN 2
                  ELSE 1
                END ASC,
                l.updated_at ASC`,
    )
    .all(cutoff) as Array<{
    id: string;
    title: string;
    status: string;
    lastReadAt: string | null;
    confidence: string;
    hasSource: 0 | 1;
    updatedAt: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    lastReadAt: r.lastReadAt,
    confidence: r.confidence,
    hasSource: r.hasSource === 1,
    updatedAt: r.updatedAt,
  }));
}

const KNOWN_KINDS = new Set([
  "suggested",
  "approved",
  "rejected",
  "deprecated",
  "superseded",
  "updated",
  "read",
  "imported",
]);

export function recentActivity(db: Database, opts: { days?: number } = {}): RecentActivity {
  const since = isoDaysAgo(opts.days ?? 30);
  const rows = db
    .prepare("SELECT kind, COUNT(*) AS n FROM events WHERE ts >= ? GROUP BY kind")
    .all(since) as Array<{ kind: string; n: number }>;
  const totals: Record<string, number> = {};
  for (const r of rows) {
    if (KNOWN_KINDS.has(r.kind)) totals[r.kind] = r.n;
  }
  return {
    suggested: totals["suggested"] ?? 0,
    approved: totals["approved"] ?? 0,
    rejected: totals["rejected"] ?? 0,
    deprecated: totals["deprecated"] ?? 0,
    superseded: totals["superseded"] ?? 0,
    updated: totals["updated"] ?? 0,
    reads: totals["read"] ?? 0,
    imports: totals["imported"] ?? 0,
  };
}

/**
 * Render the default three-section human report. Pass the windows used
 * to compute each section so the header labels can't lie when the
 * caller overrides the defaults via `--since-days` / `--quiet-for-days`.
 */
export function renderStatsReport(
  top: TopCitedRecord[],
  retire: RetireCandidate[],
  activity: RecentActivity,
  windows: {
    /** Window used for top-cited + recent activity. */
    sinceDays: number;
    /** Window used for retire-candidate quiet-period. */
    quietForDays: number;
  } = { sinceDays: 90, quietForDays: 180 },
): string {
  const lines: string[] = [];
  lines.push(`Top-cited records (last ${windows.sinceDays} days):`);
  if (top.length === 0) {
    lines.push("  (no reads recorded yet — run a search or two)");
  } else {
    for (const r of top.slice(0, 10)) {
      lines.push(`  ${r.readCount.toString().padStart(4)}× ${r.id}  ${r.title}`);
    }
  }
  lines.push("");
  lines.push(
    `Retirement candidates (active + no reads in ${windows.quietForDays} days): ${retire.length}`,
  );
  for (const r of retire.slice(0, 5)) {
    const lastSeen = r.lastReadAt ? `last read ${r.lastReadAt.slice(0, 10)}` : "never read";
    const src = r.hasSource ? "sourced" : "no source";
    lines.push(`  ${r.id}  ${r.title}  [${r.confidence}, ${src}, ${lastSeen}]`);
  }
  if (retire.length > 5) {
    lines.push(`  ... and ${retire.length - 5} more (run with --retire to see all)`);
  }
  lines.push("");
  lines.push(`Recent activity (last ${windows.sinceDays} days):`);
  lines.push(
    `  suggested ${activity.suggested}  approved ${activity.approved}  rejected ${activity.rejected}  deprecated ${activity.deprecated}`,
  );
  lines.push(
    `  superseded ${activity.superseded}  updated ${activity.updated}  reads ${activity.reads}  imports ${activity.imports}`,
  );
  return lines.join("\n");
}

// ── Evidence: which queries actually hit each top-cited record? ──────

/**
 * One grouped query/count pair from the audit log, attached to a
 * top-cited record by `evidenceForRecord` and rendered alongside its
 * citation count. Answers the team's day-20 question: "show me the
 * actual queries that hit this record".
 */
export interface EvidenceRow {
  /** Either a search query string, or the sentinel "direct fetch by id"
   *  for `get_lore` calls (which have no query text). */
  readonly query: string;
  /** Which MCP tool the audit row came from. */
  readonly tool: "search_lore" | "get_lore";
  /** Number of distinct audit rows that resulted in a read of this id. */
  readonly count: number;
}

/**
 * Stream-parse `~/.memory/audit.jsonl` and return the queries that
 * resulted in a read of `recordId` within the last `sinceDays`. Grouped
 * by (query, tool) and sorted by count desc. Top `limit` returned; the
 * caller stitches an "N other queries" tail row if there are more.
 *
 * Streamed because audit logs can grow large; we read line-by-line so
 * memory stays bounded.
 */
export async function evidenceForRecord(
  auditPath: string,
  recordId: string,
  options: { sinceDays?: number; limit?: number } = {},
): Promise<{ rows: EvidenceRow[]; truncated: number }> {
  const sinceDays = options.sinceDays ?? 30;
  const limit = options.limit ?? 5;
  const sinceMs = Date.now() - sinceDays * 86_400_000;
  if (!existsSync(auditPath)) return { rows: [], truncated: 0 };

  // Group key: `${tool}\x00${query}` (NUL-separated; query may be anything).
  const counts = new Map<string, { query: string; tool: EvidenceRow["tool"]; count: number }>();
  const stream = createReadStream(auditPath, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) continue;
    let entry: AuditLine;
    try {
      entry = JSON.parse(line) as AuditLine;
    } catch {
      continue; // skip malformed rows
    }
    if (!entry.ts || Date.parse(entry.ts) < sinceMs) continue;
    if (!entry.resultIds || !entry.resultIds.includes(recordId)) continue;
    const tool: EvidenceRow["tool"] | undefined =
      entry.tool === "search_lore"
        ? "search_lore"
        : entry.tool === "get_lore"
          ? "get_lore"
          : undefined;
    if (!tool) continue;
    let query: string;
    if (tool === "get_lore") {
      query = "direct fetch by id";
    } else if (typeof entry.request?.query === "string" && entry.request.query.length > 0) {
      query = entry.request.query;
    } else {
      query = "(no query — list recent)";
    }
    const key = `${tool}\x00${query}`;
    const existing = counts.get(key);
    if (existing) {
      existing.count++;
    } else {
      counts.set(key, { query, tool, count: 1 });
    }
  }
  const sorted = Array.from(counts.values()).sort((a, b) => b.count - a.count);
  const head = sorted.slice(0, limit);
  const truncated = sorted.length > limit ? sorted.length - limit : 0;
  return { rows: head, truncated };
}

interface AuditLine {
  ts?: string;
  tool?: string;
  request?: { query?: unknown };
  resultIds?: ReadonlyArray<string>;
}

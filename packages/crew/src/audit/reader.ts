import { existsSync, readFileSync } from "node:fs";

import { resolveAuditPath, type AuditOptions, type AuditRecord } from "./audit.js";

/**
 * Read-side of the audit log: parse the JSONL written by {@link import("./audit.js").audit}
 * back into records for `crew stats`. Tolerant of partial/torn lines (a
 * crash mid-append leaves at most one unparseable trailing line) — bad lines are
 * skipped, never thrown.
 */

/** Aggregate view of recent audited tool calls, for `crew stats`. */
export interface RecentRunSummary {
  /** Total parseable audit records considered (after the optional limit). */
  readonly total: number;
  /** How many of those recorded an error. */
  readonly errors: number;
  /** Count of calls per tool name, highest first. */
  readonly byTool: ReadonlyArray<{ readonly tool: string; readonly count: number }>;
  /** The most recent records (newest first), capped for a compact report. */
  readonly recent: ReadonlyArray<AuditRecord>;
}

const RECORD_SHAPE_KEYS = ["ts", "tool"] as const;

function isAuditRecord(value: unknown): value is AuditRecord {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Record<string, unknown>;
  return RECORD_SHAPE_KEYS.every((k) => typeof rec[k] === "string");
}

/**
 * Read and parse audit records (oldest first). Returns `[]` when the log does
 * not exist yet — a fresh factory has simply never been audited.
 */
export function readAuditRecords(opts: AuditOptions = {}): AuditRecord[] {
  const path = resolveAuditPath(opts);
  if (!existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const records: AuditRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isAuditRecord(parsed)) records.push(parsed);
    } catch {
      // Torn/partial trailing line — skip it.
    }
  }
  return records;
}

/**
 * Summarise the most recent audited tool calls. `recentLimit` caps how many
 * individual records are echoed back (newest first); the counts span all
 * records read.
 */
export function summariseRecentRuns(
  opts: AuditOptions & { readonly recentLimit?: number } = {},
): RecentRunSummary {
  const records = readAuditRecords(opts);
  const errors = records.filter((r) => r.error !== undefined).length;

  const counts = new Map<string, number>();
  for (const r of records) counts.set(r.tool, (counts.get(r.tool) ?? 0) + 1);
  const byTool = [...counts.entries()]
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool));

  const recentLimit = opts.recentLimit ?? 10;
  const recent = [...records].reverse().slice(0, recentLimit);

  return { total: records.length, errors, byTool, recent };
}

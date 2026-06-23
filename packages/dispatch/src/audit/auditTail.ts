import { existsSync, readFileSync } from "node:fs";

import { resolveAuditPath } from "./audit.js";

/**
 * One audit line projected to the fields safe to render in the UI. The audit
 * log is already content-redacted at write time (see redact.ts): it carries
 * tool name, actor, sanitised request shape, result counts/ids and error/blocked
 * markers — never tokens or free-text bodies. This reader re-projects to an
 * allow-list of safe fields so even a hand-edited or legacy line cannot leak an
 * unexpected key into the response.
 */
export interface AuditTailEntry {
  ts: string | null;
  tool: string | null;
  actor: { type: string | null; id: string | null };
  resultCount: number | null;
  error: string | null;
  blocked: string | null;
}

/** Maximum lines the tail endpoint will ever return. */
export const AUDIT_TAIL_MAX = 200;

/** The shape returned to the API: whether the log exists + the tail. */
export interface AuditTail {
  available: boolean;
  path: string | null;
  entries: AuditTailEntry[];
}

function pickString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function pickNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Project a parsed JSONL record to the safe allow-list shape. */
function projectEntry(record: Record<string, unknown>): AuditTailEntry {
  const actor =
    typeof record.actor === "object" && record.actor !== null
      ? (record.actor as Record<string, unknown>)
      : {};
  return {
    ts: pickString(record.ts),
    tool: pickString(record.tool),
    actor: { type: pickString(actor.type), id: pickString(actor.id) },
    resultCount: pickNumber(record.resultCount),
    error: pickString(record.error),
    blocked: pickString(record.blocked),
  };
}

/**
 * Read the last `limit` redacted audit lines, newest first. If the log file is
 * absent the panel is signalled as unavailable (`available: false`) so the UI
 * can hide it entirely. `limit` is clamped to [1, AUDIT_TAIL_MAX].
 *
 * Malformed lines (non-JSON, or JSON that isn't an object) are skipped rather
 * than surfaced — the tail is best-effort triage, not a parser.
 */
export function readAuditTail(limit: number): AuditTail {
  const clamped = Math.max(1, Math.min(AUDIT_TAIL_MAX, Math.floor(limit)));
  const path = resolveAuditPath();
  if (!existsSync(path)) {
    return { available: false, path: null, entries: [] };
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    // An unreadable log behaves like an absent one for the UI's purposes.
    return { available: false, path: null, entries: [] };
  }

  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const tail = lines.slice(-clamped).reverse(); // newest first

  const entries: AuditTailEntry[] = [];
  for (const line of tail) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // skip malformed lines
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    entries.push(projectEntry(parsed as Record<string, unknown>));
  }

  return { available: true, path, entries };
}

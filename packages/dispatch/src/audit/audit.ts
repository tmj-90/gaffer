import { appendFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { resolveDbPath } from "../util/paths.js";

/**
 * Append-only audit log of MCP tool calls. Each line is one JSON record:
 *   { ts, tool, actor, request, resultCount?, resultIds?, error?, blocked? }
 *
 * The audit log is the operator's answer to "what did the agent do at 14:32?"
 * It DELIBERATELY records only metadata: the tool name, the actor, the entity
 * ids touched and counts. It NEVER records ticket descriptions, AC text,
 * evidence bodies, decision questions, or — most importantly — claim tokens.
 * Those live (or are hashed) in the SQLite database; the audit log must be
 * safe to grep, tail, or paste into an incident channel without leaking the
 * content of the work or any secret that would let an actor impersonate a
 * claim. See `redact.ts` for the request-sanitising boundary.
 */

/** The actor on whose behalf an MCP tool ran. */
export interface AuditActor {
  readonly type: string;
  readonly id?: string;
}

export interface AuditRecord {
  readonly ts: string;
  readonly tool: string;
  readonly actor: AuditActor;
  /** Sanitised request shape — never the raw args (see redact.ts). */
  readonly request: Record<string, unknown>;
  readonly resultCount?: number;
  readonly resultIds?: ReadonlyArray<string>;
  readonly error?: string;
  /**
   * Set when a tool call was deliberately refused by a policy/trust gate
   * (distinct from an unexpected `error`). Records that the gate fired.
   */
  readonly blocked?: string;
}

/**
 * Resolve the audit-log path. Precedence: explicit `DISPATCH_AUDIT` env →
 * `audit.jsonl` beside the resolved database file. Keeping it next to the DB
 * means the audit trail travels with the data it describes.
 */
export function resolveAuditPath(): string {
  const explicit = process.env.DISPATCH_AUDIT;
  if (explicit) return explicit;
  return join(dirname(resolveDbPath()), "audit.jsonl");
}

let ensuredPath: string | undefined;

function ensureFile(path: string): void {
  if (ensuredPath === path) return;
  const dir = dirname(path);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!existsSync(path)) {
    appendFileSync(path, "");
    try {
      chmodSync(path, 0o600);
    } catch {
      // chmod is best-effort on platforms that support it.
    }
  }
  ensuredPath = path;
}

/**
 * Append one audit record. Honours `DISPATCH_AUDIT_OFF` (skips entirely) and
 * `DISPATCH_AUDIT` (path override). An audit-write failure must NEVER break a
 * tool call, so I/O errors are swallowed deliberately.
 */
export function audit(record: Omit<AuditRecord, "ts">): void {
  if (process.env.DISPATCH_AUDIT_OFF) return;
  const path = resolveAuditPath();
  try {
    ensureFile(path);
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`;
    appendFileSync(path, line);
  } catch {
    // Swallow: the audit log is best-effort and must not fail the tool.
  }
}

/** Reset the memoised path guard. Test-only — lets a temp path be re-ensured. */
export function resetAuditPathCache(): void {
  ensuredPath = undefined;
}

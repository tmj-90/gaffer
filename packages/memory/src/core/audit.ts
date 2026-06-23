import { appendFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Append-only audit log of MCP tool calls. Lives next to the DB at
 * `~/.memory/audit.jsonl` (mode 0600). Each line is a JSON record:
 *   { ts, tool, request, resultCount?, resultIds?, error? }
 *
 * Deliberately doesn't store full result bodies — those are sensitive.
 * Just enough to answer "what did Claude see at 14:32?".
 */

export interface AuditRecord {
  readonly ts: string;
  readonly tool: string;
  readonly request: Record<string, unknown>;
  readonly resultCount?: number;
  readonly resultIds?: ReadonlyArray<string>;
  readonly error?: string;
  /**
   * Set when a tool call's response was deliberately suppressed by a
   * trust gate (e.g. `get_lore` returning a refusal for a restricted
   * record while `MEMORY_ALLOW_RESTRICTED_MCP` is off). The audit row
   * still records the request and the resolved id so a human can see
   * the gate fired, but distinct from an `error`.
   */
  readonly blocked?: string;
}

function defaultAuditPath(): string {
  if (process.env["MEMORY_AUDIT_LOG"]) return process.env["MEMORY_AUDIT_LOG"];
  return join(homedir(), ".memory", "audit.jsonl");
}

let initialised = false;
function ensureFile(path: string): void {
  if (initialised) return;
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!existsSync(path)) {
    appendFileSync(path, "");
    try {
      chmodSync(path, 0o600);
    } catch {
      // best-effort
    }
  }
  initialised = true;
}

export function audit(record: Omit<AuditRecord, "ts">): void {
  if (process.env["MEMORY_AUDIT_OFF"]) return;
  const path = defaultAuditPath();
  ensureFile(path);
  const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n";
  try {
    appendFileSync(path, line);
  } catch {
    // Audit write failure must never break a tool call. Swallow.
  }
}

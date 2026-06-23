import { appendFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Append-only, content-redacted audit of Crew MCP tool calls.
 *
 * The audit log records THAT a tool ran and the *shape* of what it touched —
 * the tool name, the repo/skill/ticket ids and counts involved, and whether the
 * call errored. It NEVER records prompts, file contents, lore/ticket bodies, or
 * secrets. The records are designed to be safe to ship to a teammate or attach
 * to an incident: they answer "what did the agent do?" without leaking "with
 * what content?".
 *
 * Storage is JSONL (one self-contained JSON object per line) so the log is
 * append-only, crash-safe (a torn write loses at most the last line), and
 * stream-parseable by `crew stats` without loading the whole file.
 *
 * Path resolution (first match wins):
 *   1. `GAFFER_AUDIT` env var (explicit override; honoured even if empty-string
 *      disable is requested via `GAFFER_AUDIT_OFF`).
 *   2. `<factory data dir>/audit.jsonl` when a data dir is supplied by the caller.
 *   3. `~/.crew/audit.jsonl` (default).
 *
 * Auditing is best-effort: a write failure (read-only disk, full volume) must
 * NEVER break the tool call it was recording. Set `GAFFER_AUDIT_OFF=1` to disable.
 */

/** One audit line. `ts` is added by {@link audit}; callers supply the rest. */
export interface AuditRecord {
  /** ISO-8601 timestamp (added by the writer). */
  readonly ts: string;
  /** MCP tool name, e.g. "get_context_packet". */
  readonly tool: string;
  /**
   * Redacted argument summary — ids, flags, lengths, counts ONLY. Never raw
   * prompts/bodies/secrets. Callers must pre-redact (see {@link summariseArgs}).
   */
  readonly args: Readonly<Record<string, unknown>>;
  /** How many results the call produced (records, drafts, repos…), when known. */
  readonly resultCount?: number;
  /** The ids the call touched/returned (ticket/repo/skill/draft ids), when known. */
  readonly resultIds?: ReadonlyArray<string>;
  /** Machine-readable error code when the call failed (never the message body). */
  readonly error?: string;
}

/** The audit payload a caller supplies — everything except the timestamp. */
export type AuditEntry = Omit<AuditRecord, "ts">;

/** Where audit lines are written and whether writing is enabled. */
export interface AuditOptions {
  /** Explicit log path. Overrides env + data-dir resolution. */
  readonly path?: string;
  /** Factory data dir; `audit.jsonl` is written beside it when no path/env set. */
  readonly dataDir?: string;
  /** Environment for resolution + the off-switch. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

const AUDIT_OFF_ENV = "GAFFER_AUDIT_OFF";
const AUDIT_PATH_ENV = "GAFFER_AUDIT";
const DEFAULT_DIR = ".crew";
const DEFAULT_FILE = "audit.jsonl";

/** True when the audit log is disabled via `GAFFER_AUDIT_OFF`. */
export function isAuditDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env[AUDIT_OFF_ENV];
  return flag === "1" || flag === "true";
}

/**
 * Resolve the audit log path. Pure (no I/O) so `crew doctor`/`stats` can
 * report and read the same path the MCP handlers write to.
 */
export function resolveAuditPath(opts: AuditOptions = {}): string {
  const env = opts.env ?? process.env;
  const fromEnv = env[AUDIT_PATH_ENV];
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv;
  if (opts.path && opts.path.trim().length > 0) return opts.path;
  if (opts.dataDir && opts.dataDir.trim().length > 0) return join(opts.dataDir, DEFAULT_FILE);
  return join(homedir(), DEFAULT_DIR, DEFAULT_FILE);
}

/**
 * Redact a raw MCP arg object down to an audit-safe summary. Strings are
 * reduced to their length (so a prompt/body never lands in the log); ids,
 * booleans, numbers and short scalar values pass through. This is the single
 * choke point that guarantees no free-text content reaches the audit file.
 *
 * `idKeys` lists arg names whose string values ARE safe to keep verbatim
 * (ticket refs, repo ids) — these are identifiers, not content.
 */
export function summariseArgs(
  args: Readonly<Record<string, unknown>>,
  idKeys: readonly string[] = [],
): Record<string, unknown> {
  const ids = new Set(idKeys);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    if (typeof value === "string") {
      // Identifiers are safe verbatim; everything else is reduced to a length so
      // free-text (commands, paths, prompts) never leaks into the audit log.
      out[key] = ids.has(key) ? value : { chars: value.length };
    } else if (typeof value === "boolean" || typeof value === "number" || value === null) {
      out[key] = value;
    } else if (Array.isArray(value)) {
      out[key] = { count: value.length };
    } else {
      out[key] = { redacted: true };
    }
  }
  return out;
}

/** Lazily ensure the parent dir + file exist with owner-only permissions. */
function ensureFile(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!existsSync(path)) {
    appendFileSync(path, "");
    try {
      chmodSync(path, 0o600);
    } catch {
      // chmod is best-effort (e.g. on filesystems without POSIX modes).
    }
  }
}

/**
 * Append one audit line. Returns the path written to, or `null` when auditing
 * is disabled or the write failed (so callers can surface a diagnostic without
 * the failure ever propagating into the tool result).
 */
export function audit(entry: AuditEntry, opts: AuditOptions = {}): string | null {
  const env = opts.env ?? process.env;
  if (isAuditDisabled(env)) return null;
  const path = resolveAuditPath(opts);
  const record: AuditRecord = { ts: new Date().toISOString(), ...entry };
  try {
    ensureFile(path);
    appendFileSync(path, `${JSON.stringify(record)}\n`);
    return path;
  } catch {
    // Auditing must never break a tool call. Swallow.
    return null;
  }
}

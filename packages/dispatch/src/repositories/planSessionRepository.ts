import { inTransaction } from "../db/connection.js";
import type { Db } from "../db/connection.js";
import { planMessageSchema } from "../domain/schemas.js";
import type { PlanMessage, PlanSession, PlanSessionStatus } from "../domain/types.js";

/**
 * Parse a persisted `messages_json` blob into a typed history. Defensive on
 * read (H5): a non-JSON or non-array value yields an empty history, and any
 * individual entry that is not a structurally-valid {@link PlanMessage} is
 * dropped rather than trusted via a blind cast. A partially-corrupt row thus
 * keeps its still-valid turns instead of silently discarding the whole history.
 */
function parsePersistedMessages(raw: string): PlanMessage[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const messages: PlanMessage[] = [];
  for (const entry of parsed) {
    const result = planMessageSchema.safeParse(entry);
    if (result.success) messages.push(result.data);
  }
  return messages;
}

/** Default cap on the list of recent sessions returned to the UI. */
export const DEFAULT_SESSION_LIST_LIMIT = 20;

/** Input for creating a new plan session. */
export interface PlanSessionCreateInput {
  id: string;
  created_at: string;
  updated_at: string;
}

/** Input for appending a message and optionally updating the plan/brief. */
export interface PlanSessionAppendInput {
  id: string;
  message: PlanMessage;
  /** Updated brief — only set when the user sends their first message. */
  brief?: string | null;
  /** Updated plan JSON — set when the decompose helper returns a plan phase. */
  plan_json?: string | null;
  updated_at: string;
}

/** Input for archiving a session (setting status to confirmed or abandoned). */
export interface PlanSessionArchiveInput {
  id: string;
  status: "confirmed" | "abandoned";
  updated_at: string;
}

/** Options for listing sessions. */
export interface PlanSessionListOptions {
  /** When set, only sessions with this status are returned. */
  status?: PlanSessionStatus;
  /** Maximum number of sessions to return. Defaults to {@link DEFAULT_SESSION_LIST_LIMIT}. */
  limit?: number;
}

/** Raw DB row shape for a plan_sessions row. */
interface PlanSessionRow {
  id: string;
  status: string;
  brief: string | null;
  messages_json: string;
  plan_json: string | null;
  target_repo: string | null;
  target_scope: string | null;
  created_at: string;
  updated_at: string;
}

function rowToSession(row: PlanSessionRow): PlanSession {
  return {
    id: row.id,
    status: row.status as PlanSessionStatus,
    brief: row.brief,
    messages_json: row.messages_json,
    plan_json: row.plan_json,
    target_repo: row.target_repo,
    target_scope: row.target_scope,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Repository for durable plan-build chat sessions (H9).
 *
 * Each method is a thin, synchronous wrapper around a single SQLite statement.
 * The session's message history is stored as a JSON array in `messages_json`;
 * appending a message deserialises, pushes, and re-serialises. This keeps the
 * table simple (no separate messages table) at the cost of a read-modify-write
 * per turn — acceptable given the low turn frequency of a single-user tool.
 */
export class PlanSessionRepository {
  constructor(private readonly db: Db) {}

  /** Create a new active session with an empty history. */
  create(input: PlanSessionCreateInput): PlanSession {
    this.db
      .prepare(
        `INSERT INTO plan_sessions (id, status, messages_json, created_at, updated_at)
         VALUES (?, 'active', '[]', ?, ?)`,
      )
      .run(input.id, input.created_at, input.updated_at);
    return this.getById(input.id)!;
  }

  /** Fetch a session by id, or null if not found. */
  getById(id: string): PlanSession | null {
    const row = this.db.prepare("SELECT * FROM plan_sessions WHERE id = ?").get(id) as
      | PlanSessionRow
      | undefined;
    return row ? rowToSession(row) : null;
  }

  /**
   * Append a message to the session's history and optionally update brief /
   * plan_json. Returns the updated session, or null when the id is unknown.
   *
   * The read-modify-write is wrapped in a SQLite transaction so concurrent
   * callers (e.g. two browser tabs posting turns simultaneously) cannot
   * interleave their reads and writes, which would cause one turn to be lost.
   * better-sqlite3 transactions are synchronous and hold an immediate write lock,
   * so the append is atomic. Behaviour for the single-writer case is unchanged.
   */
  appendMessage(input: PlanSessionAppendInput): PlanSession | null {
    return inTransaction(this.db, () => {
      const session = this.getById(input.id);
      if (!session) return null;

      // Parse existing messages, push new one, re-serialise. The read is
      // structurally validated (H5) so a corrupt row can't inject untyped data.
      const messages = parsePersistedMessages(session.messages_json);
      messages.push(input.message);
      const newMessagesJson = JSON.stringify(messages);

      const updates: string[] = ["messages_json = ?", "updated_at = ?"];
      const params: unknown[] = [newMessagesJson, input.updated_at];

      if (input.brief !== undefined) {
        updates.push("brief = ?");
        params.push(input.brief ?? null);
      }
      if (input.plan_json !== undefined) {
        updates.push("plan_json = ?");
        params.push(input.plan_json ?? null);
      }

      params.push(input.id);
      this.db.prepare(`UPDATE plan_sessions SET ${updates.join(", ")} WHERE id = ?`).run(...params);

      return this.getById(input.id)!;
    });
  }

  /**
   * Archive a session by setting its status to 'confirmed' or 'abandoned'.
   * Only transitions an 'active' session; a no-op on an already-archived row.
   */
  archive(input: PlanSessionArchiveInput): void {
    this.db
      .prepare(
        `UPDATE plan_sessions SET status = ?, updated_at = ?
         WHERE id = ? AND status = 'active'`,
      )
      .run(input.status, input.updated_at, input.id);
  }

  /**
   * Archive all currently active sessions (called before starting a fresh one).
   * Returns the count of sessions archived.
   */
  archiveAllActive(archivedAt: string): number {
    const result = this.db
      .prepare(
        `UPDATE plan_sessions SET status = 'abandoned', updated_at = ?
         WHERE status = 'active'`,
      )
      .run(archivedAt) as { changes: number };
    return result.changes;
  }

  /**
   * List sessions, most-recently-created first. Capped at
   * {@link DEFAULT_SESSION_LIST_LIMIT} by default. When `status` is given, only
   * rows with that status are returned.
   */
  list(options: PlanSessionListOptions = {}): PlanSession[] {
    const limit = Math.min(options.limit ?? DEFAULT_SESSION_LIST_LIMIT, 100);
    if (options.status !== undefined) {
      const rows = this.db
        .prepare(
          `SELECT * FROM plan_sessions WHERE status = ?
           ORDER BY created_at DESC LIMIT ?`,
        )
        .all(options.status, limit) as PlanSessionRow[];
      return rows.map(rowToSession);
    }
    const rows = this.db
      .prepare("SELECT * FROM plan_sessions ORDER BY created_at DESC LIMIT ?")
      .all(limit) as PlanSessionRow[];
    return rows.map(rowToSession);
  }

  /**
   * Return the most-recently-created active session, or null when none exists.
   * Used by the panel to restore an in-progress conversation on reload.
   */
  getActive(): PlanSession | null {
    const row = this.db
      .prepare(
        `SELECT * FROM plan_sessions WHERE status = 'active'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get() as PlanSessionRow | undefined;
    return row ? rowToSession(row) : null;
  }
}

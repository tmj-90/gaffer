/**
 * Memory Feedback Loop — make memory smarter, not just bigger.
 *
 * The problem this closes: a lore/card's confidence is set at write time and
 * only ever changed by hand. Nothing learns which knowledge actually HELPED.
 *
 * The loop, in three moves:
 *   1. RECALL LOG (`logRecall`)  — when the runner primes a ticket's context,
 *      memory records which items it SERVED, keyed by (repo, ticket). This is
 *      the read-event EDGE (migration 008 `recall_event`).
 *   2. OUTCOME FEEDBACK (`recallFeedback`) — when the runner learns the ticket
 *      outcome, it PASSES it back. Memory looks up what it served for that
 *      ticket (its OWN read-event log) and adjusts its OWN items:
 *        - clean            → bounded confidence BUMP + verify + clear any flag
 *        - reworked/blocked → bounded confidence DEMOTE + flag_for_review
 *   3. SURFACE (`listFlaggedForReview`) — flagged items become queryable so a
 *      human can see "this knowledge led to rework."
 *
 * BOUNDED: one outcome moves confidence at most ONE step (low↔medium↔high),
 * so a single ticket can never flip a strong signal end to end.
 *
 * IDEMPOTENT: applying the same (repo, ticket, outcome) twice is a no-op —
 * guarded by the `recall_feedback` UNIQUE ledger, so a retried runner call
 * (or a re-run) never double-adjusts.
 *
 * ISOLATION (non-negotiable): this NEVER reads the dispatch or crew DB. Memory
 * learns from its OWN read-event log plus the outcome the runner passes in. The
 * runner knows the outcome; memory owns the adjustment. No import from dispatch.
 */
import type { Database } from "better-sqlite3";

import { newLoreId } from "./ids.js";
import type { LoreConfidence } from "../db/types.js";

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Delivery outcome the runner passes back for a ticket:
 *   - clean    — shipped for review with no rework (first attempt, no prior
 *                rejection). The served knowledge helped → reward it.
 *   - reworked — shipped eventually, but only after ≥1 rework/rejection. The
 *                served knowledge did not fully prevent churn → demote + flag.
 *   - blocked  — parked to `blocked` (rework exhausted). The served knowledge
 *                failed to unblock the ticket → demote + flag.
 */
export type RecallOutcome = "clean" | "reworked" | "blocked";

export type RecallItemType = "lore" | "card";

/** Ordered confidence ladder — the step function is bounded to one rung. */
const CONFIDENCE_LADDER: readonly LoreConfidence[] = ["low", "medium", "high"];

function stepConfidence(current: LoreConfidence, direction: 1 | -1): LoreConfidence {
  const idx = CONFIDENCE_LADDER.indexOf(current);
  // Unknown value (shouldn't happen given the CHECK) → leave untouched.
  if (idx < 0) return current;
  const next = Math.min(CONFIDENCE_LADDER.length - 1, Math.max(0, idx + direction));
  return CONFIDENCE_LADDER[next]!;
}

// ── Recall logging (the read-event edge) ──────────────────────────────

export interface LogRecallInput {
  readonly repo: string;
  readonly ticket: string;
  /** Lore record ids served into this ticket's context. */
  readonly loreIds?: ReadonlyArray<string>;
  /** File-card ids served into this ticket's context. */
  readonly cardIds?: ReadonlyArray<string>;
}

export interface LogRecallResult {
  /** Distinct served edges written (existing edges are ignored, not re-counted). */
  readonly logged: number;
}

/**
 * Record that a set of memory items was served into a ticket's context.
 * The served edge is a SET: re-logging the same item for the same ticket is a
 * no-op (INSERT OR IGNORE against the UNIQUE constraint), so priming a ticket
 * twice doesn't inflate the signal. Empty ids are skipped.
 */
export function logRecall(db: Database, input: LogRecallInput): LogRecallResult {
  const repo = input.repo.trim();
  const ticket = input.ticket.trim();
  if (!repo || !ticket) return { logged: 0 };

  const rows: Array<{ type: RecallItemType; id: string }> = [];
  for (const id of input.loreIds ?? []) {
    const v = id.trim();
    if (v) rows.push({ type: "lore", id: v });
  }
  for (const id of input.cardIds ?? []) {
    const v = id.trim();
    if (v) rows.push({ type: "card", id: v });
  }
  if (rows.length === 0) return { logged: 0 };

  const ts = nowIso();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO recall_event (id, repo, ticket, item_type, item_id, served_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  let logged = 0;
  const tx = db.transaction((items: typeof rows) => {
    for (const it of items) {
      const info = stmt.run(newLoreId(), repo, ticket, it.type, it.id, ts);
      if (info.changes > 0) logged += 1;
    }
  });
  tx(rows);
  return { logged };
}

// ── Outcome feedback (the adjustment) ─────────────────────────────────

export interface RecallFeedbackInput {
  readonly repo: string;
  readonly ticket: string;
  readonly outcome: RecallOutcome;
}

export interface RecallFeedbackResult {
  readonly repo: string;
  readonly ticket: string;
  readonly outcome: RecallOutcome;
  /**
   * True when this exact (repo, ticket, outcome) had already been applied —
   * nothing was changed on this call. The idempotency guarantee.
   */
  readonly alreadyApplied: boolean;
  /** Lore ids whose confidence/flag was adjusted on this call. */
  readonly loreAdjusted: ReadonlyArray<string>;
  /** File-card ids whose flag was adjusted on this call. */
  readonly cardsAdjusted: ReadonlyArray<string>;
  /** Total served items considered (from the recall log). */
  readonly served: number;
}

/**
 * Apply outcome feedback to the memory items served into a ticket's context.
 *
 * Confidence model:
 *   - clean            → each served lore bumps confidence ONE rung (capped at
 *                        `high`), refreshes `last_verified_at`, and clears
 *                        `flagged_for_review`. Served cards clear their flag.
 *   - reworked/blocked → each served lore drops confidence ONE rung (floored at
 *                        `low`) and is flagged for review. Served cards are
 *                        flagged too (cards carry no confidence rung — the flag
 *                        IS their signal).
 *
 * Bounded (one rung per outcome) and idempotent (per repo+ticket+outcome). A
 * ticket with no recall log is a harmless no-op (served=0). Emits an audit
 * event per adjusted item plus a summary event.
 */
export function recallFeedback(db: Database, input: RecallFeedbackInput): RecallFeedbackResult {
  const repo = input.repo.trim();
  const ticket = input.ticket.trim();
  const { outcome } = input;

  const base = {
    repo,
    ticket,
    outcome,
    loreAdjusted: [] as string[],
    cardsAdjusted: [] as string[],
    served: 0,
  };

  if (!repo || !ticket) {
    return { ...base, alreadyApplied: false };
  }

  // Idempotency gate: has this exact outcome already been applied?
  const prior = db
    .prepare("SELECT 1 FROM recall_feedback WHERE repo = ? AND ticket = ? AND outcome = ?")
    .get(repo, ticket, outcome);
  if (prior) {
    return { ...base, alreadyApplied: true };
  }

  const served = db
    .prepare(
      "SELECT item_type, item_id FROM recall_event WHERE repo = ? AND ticket = ? ORDER BY served_at, id",
    )
    .all(repo, ticket) as Array<{ item_type: RecallItemType; item_id: string }>;

  const loreIds = served.filter((r) => r.item_type === "lore").map((r) => r.item_id);
  const cardIds = served.filter((r) => r.item_type === "card").map((r) => r.item_id);

  const ts = nowIso();
  const isReward = outcome === "clean";
  const direction: 1 | -1 = isReward ? 1 : -1;
  const flag = isReward ? 0 : 1;

  const loreAdjusted: string[] = [];
  const cardsAdjusted: string[] = [];

  const readLore = db.prepare("SELECT confidence FROM lore WHERE id = ?");
  const updateLoreReward = db.prepare(
    `UPDATE lore
       SET confidence = ?, flagged_for_review = 0, last_verified_at = ?, updated_at = ?
     WHERE id = ?`,
  );
  const updateLoreDemote = db.prepare(
    `UPDATE lore
       SET confidence = ?, flagged_for_review = 1, updated_at = ?
     WHERE id = ?`,
  );
  const updateCard = db.prepare(
    "UPDATE file_card SET flagged_for_review = ?, updated_at = ? WHERE id = ?",
  );
  const itemEvent = db.prepare(
    "INSERT INTO events (lore_id, kind, ts, payload) VALUES (?, 'recall_feedback_applied', ?, ?)",
  );

  const tx = db.transaction(() => {
    for (const id of loreIds) {
      const row = readLore.get(id) as { confidence: LoreConfidence } | undefined;
      if (!row) continue; // served item since deleted — skip, don't fabricate
      const from = row.confidence;
      const to = stepConfidence(from, direction);
      if (isReward) {
        updateLoreReward.run(to, ts, ts, id);
      } else {
        updateLoreDemote.run(to, ts, id);
      }
      loreAdjusted.push(id);
      itemEvent.run(
        id,
        ts,
        JSON.stringify({ ticket, outcome, itemType: "lore", from, to, flagged: flag === 1 }),
      );
    }

    for (const id of cardIds) {
      const info = updateCard.run(flag, ts, id);
      if (info.changes === 0) continue; // card gone — skip
      cardsAdjusted.push(id);
      itemEvent.run(
        id,
        ts,
        JSON.stringify({ ticket, outcome, itemType: "card", flagged: flag === 1 }),
      );
    }

    // Idempotency ledger + summary audit event. The UNIQUE (repo, ticket,
    // outcome) makes a concurrent/retried second apply throw — but we've
    // already short-circuited above, so within one process this is the sole
    // writer. The ledger row is what future calls read to no-op.
    db.prepare(
      `INSERT INTO recall_feedback (id, repo, ticket, outcome, items_adjusted, applied_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(newLoreId(), repo, ticket, outcome, loreAdjusted.length + cardsAdjusted.length, ts);

    db.prepare(
      "INSERT INTO events (lore_id, kind, ts, payload) VALUES (NULL, 'recall_feedback', ?, ?)",
    ).run(
      ts,
      JSON.stringify({
        repo,
        ticket,
        outcome,
        served: served.length,
        loreAdjusted: loreAdjusted.length,
        cardsAdjusted: cardsAdjusted.length,
      }),
    );
  });
  tx();

  return {
    ...base,
    served: served.length,
    alreadyApplied: false,
    loreAdjusted,
    cardsAdjusted,
  };
}

// ── Flagged surface ───────────────────────────────────────────────────

export interface FlaggedLore {
  readonly type: "lore";
  readonly id: string;
  readonly title: string;
  readonly confidence: LoreConfidence;
  readonly status: string;
  readonly updatedAt: string;
}

export interface FlaggedCard {
  readonly type: "card";
  readonly id: string;
  readonly repo: string;
  readonly path: string;
  readonly updatedAt: string;
}

export type FlaggedItem = FlaggedLore | FlaggedCard;

export interface ListFlaggedOptions {
  /** Restrict cards to this repo display name, and lore to records tagged to it. */
  readonly repo?: string;
  readonly limit?: number;
}

/**
 * List lore + file cards currently flagged for review (i.e. served into a
 * ticket that reworked/blocked). The minimal human surface for "which knowledge
 * led to rework." Ordered most-recently-flagged first.
 */
export function listFlaggedForReview(db: Database, opts: ListFlaggedOptions = {}): FlaggedItem[] {
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 100;
  const repo = opts.repo?.trim();

  const loreRows = repo
    ? (db
        .prepare(
          `SELECT DISTINCT l.id, l.title, l.confidence, l.status, l.updated_at
             FROM lore l
             JOIN lore_repos lr ON lr.lore_id = l.id
            WHERE l.flagged_for_review = 1 AND lr.repo = ?
            ORDER BY l.updated_at DESC
            LIMIT ?`,
        )
        .all(repo, limit) as Array<{
        id: string;
        title: string;
        confidence: LoreConfidence;
        status: string;
        updated_at: string;
      }>)
    : (db
        .prepare(
          `SELECT id, title, confidence, status, updated_at
             FROM lore
            WHERE flagged_for_review = 1
            ORDER BY updated_at DESC
            LIMIT ?`,
        )
        .all(limit) as Array<{
        id: string;
        title: string;
        confidence: LoreConfidence;
        status: string;
        updated_at: string;
      }>);

  const cardRows = repo
    ? (db
        .prepare(
          `SELECT id, repo, path, updated_at
             FROM file_card
            WHERE flagged_for_review = 1 AND repo = ?
            ORDER BY updated_at DESC
            LIMIT ?`,
        )
        .all(repo, limit) as Array<{ id: string; repo: string; path: string; updated_at: string }>)
    : (db
        .prepare(
          `SELECT id, repo, path, updated_at
             FROM file_card
            WHERE flagged_for_review = 1
            ORDER BY updated_at DESC
            LIMIT ?`,
        )
        .all(limit) as Array<{ id: string; repo: string; path: string; updated_at: string }>);

  const lore: FlaggedItem[] = loreRows.map((r) => ({
    type: "lore",
    id: r.id,
    title: r.title,
    confidence: r.confidence,
    status: r.status,
    updatedAt: r.updated_at,
  }));
  const cards: FlaggedItem[] = cardRows.map((r) => ({
    type: "card",
    id: r.id,
    repo: r.repo,
    path: r.path,
    updatedAt: r.updated_at,
  }));

  return [...lore, ...cards];
}

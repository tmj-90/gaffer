import type { Actor } from "../domain/types.js";
import { DispatchError } from "../util/errors.js";

/**
 * ESCAPED-DEFECT ATTRIBUTION (delta roadmap gap 5, gap-specialists MF5): a person says
 * that a later ticket (a defect report or its fix) is a regression of an accepted change.
 *
 *  - `ticket.defect_escaped` {regression_of, regression_of_number, note}: recorded on the
 *    later ticket; the work_events actor columns say who filed it.
 *  - `ticket.defect_escaped_withdrawn` {regression_of}: the same person (or another) takes
 *    back a link filed in error. The current links are, per (ticket, accepted change), the
 *    last of the two.
 *
 * Human or admin only: an agent never files or clears a link (it would let a delivery
 * agent hide the defects it shipped or blame another change), and the runner does not
 * either, since a link is a person's judgement that the change caused the defect. The
 * safety hook denies `wg ticket regression-of` to an agent shell. Nothing gates on a link:
 * it is a measurement, read by Health's escaped-defect rate (health/escapedDefects.ts).
 */
export const DEFECT_ESCAPED_EVENT = "ticket.defect_escaped" as const;
export const DEFECT_ESCAPED_WITHDRAWN_EVENT = "ticket.defect_escaped_withdrawn" as const;

/** Only a person (a human or admin principal) files or withdraws a regression link. */
export function assertMayFileRegression(actor: Actor): void {
  if (actor.type !== "human" && actor.type !== "admin")
    throw new DispatchError(
      "ACTOR_NOT_PERMITTED",
      "Only a person (a human or admin principal) links a ticket to the accepted change it regresses.",
      { actor_type: actor.type },
    );
}

/** One `ticket.defect_escaped` or `..._withdrawn` row, projected. */
export interface RegressionEventRow {
  readonly ticketId: string;
  readonly eventType: string;
  readonly regressionOf: string | null;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly note: string | null;
  readonly at: string;
}

/** A current (not withdrawn) link. */
export interface RegressionLink {
  /** The later ticket (the defect or the fix). */
  readonly ticketId: string;
  /** The accepted change it regresses. */
  readonly regressionOf: string;
  readonly filedBy: { readonly type: string; readonly id: string | null };
  readonly filedAt: string;
  readonly note: string | null;
}

/** Fold the events (insertion order) into the links standing now. */
export function currentRegressionLinks(rows: readonly RegressionEventRow[]): RegressionLink[] {
  const byPair = new Map<string, RegressionLink | null>();
  for (const r of rows) {
    if (!r.regressionOf) continue;
    const key = `${r.ticketId}\u0000${r.regressionOf}`;
    if (r.eventType === DEFECT_ESCAPED_EVENT) {
      byPair.set(key, {
        ticketId: r.ticketId,
        regressionOf: r.regressionOf,
        filedBy: { type: r.actorType, id: r.actorId },
        filedAt: r.at,
        note: r.note,
      });
    } else if (r.eventType === DEFECT_ESCAPED_WITHDRAWN_EVENT) {
      byPair.set(key, null);
    }
  }
  return [...byPair.values()].filter((l): l is RegressionLink => l !== null);
}

/** A note: one line, at most 300 characters, or null. */
export function regressionNote(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s ? s.slice(0, 300) : null;
}

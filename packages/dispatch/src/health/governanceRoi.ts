/**
 * Governance-ROI analytics — does the factory's oversight machinery EARN its cost?
 *
 * Gaffer's whole thesis (and its stated honesty value) is that the gates + review
 * loop + opt-in autonomy pay for their overhead versus a raw agent loop. Nothing in
 * the product measured that. This is the ONE server-side definition of the three
 * governance rates the Overview surfaces, all from REAL `work_events` transitions +
 * the `rework_attempts` table — never the demo dataset, never zero-filled.
 *
 * Every rate is honest about its denominator: when there is no eligible history in
 * the window the rate is `null` (the UI renders an explicit empty state), NOT 0 —
 * "we shipped 0% of nothing" is a lie the panel must not tell.
 *
 * Definitions (window-scoped to the last `windowDays`, keyed off transition time):
 *   - merge rate         = merged / (merged + rejected)         over tickets that
 *                          reached a terminal review decision in the window.
 *   - rework rate        = (merged tickets that needed ≥1 rework) / merged.
 *   - unattended-safe    = (unattended merges that stayed merged) / unattended merges,
 *                          where "unattended" = the review was APPROVED by an `agent`
 *                          actor (no human crossed the gate) and "stayed merged" =
 *                          it was not later reopened. This is the honest "when the
 *                          factory shipped without a human, did it not burn us?".
 */

const DAY_MS = 86_400_000;
const DEFAULT_WINDOW_DAYS = 30;

/** One `ticket.transitioned` work-event, projected to the fields the maths needs. */
export interface GovTransition {
  /** The ticket's entity id (work_events.entity_id). */
  readonly ticketId: string;
  /** Who caused the transition: human | agent | admin | system. */
  readonly actorType: string;
  readonly fromStatus: string | null;
  readonly toStatus: string | null;
  /** The transition reason (payload `$.reason`), e.g. review_approved / merge_completed. */
  readonly reason: string | null;
  /** Transition time in epoch millis. */
  readonly atMs: number;
}

/** A rate that is null-honest about an empty denominator. */
export interface GovRate {
  /** Fraction 0..1, or null when the denominator is 0 (no eligible history). */
  readonly rate: number | null;
  readonly numerator: number;
  readonly denominator: number;
}

export interface GovernanceRoi {
  readonly windowDays: number;
  /** True when NO ticket reached a terminal review decision in the window. */
  readonly empty: boolean;
  readonly mergeRate: GovRate;
  readonly reworkRate: GovRate;
  readonly unattendedSafeRate: GovRate;
  /** Raw tallies the UI shows next to each rate (never a rate without its counts). */
  readonly counts: {
    readonly merged: number;
    readonly rejected: number;
    readonly reworked: number;
    readonly unattendedMerges: number;
    readonly unattendedReopened: number;
  };
}

const REJECT_TARGETS = new Set(["refining", "ready", "cancelled"]);
const APPROVE_REASONS = new Set(["review_approved", "review_approved_to_testing"]);

function rate(numerator: number, denominator: number): GovRate {
  return { rate: denominator === 0 ? null : numerator / denominator, numerator, denominator };
}

/**
 * Compute the three governance rates as of `nowMs` over the trailing `windowDays`.
 *
 * @param transitions        every `ticket.transitioned` event (any age; windowed here).
 * @param reworkByTicketId   ticket entity id → rework-attempt count (from rework_attempts).
 * @param nowMs              "now" in epoch millis — the window ends here.
 * @param windowDays         trailing window length in days (default 30).
 */
export function governanceRoi(
  transitions: readonly GovTransition[],
  reworkByTicketId: ReadonlyMap<string, number>,
  nowMs: number,
  windowDays: number = DEFAULT_WINDOW_DAYS,
): GovernanceRoi {
  const windowStart = nowMs - windowDays * DAY_MS;
  // Group the in-window transitions per ticket, oldest → newest.
  const byTicket = new Map<string, GovTransition[]>();
  for (const t of transitions) {
    if (t.atMs < windowStart || t.atMs > nowMs) continue;
    const list = byTicket.get(t.ticketId);
    if (list) list.push(t);
    else byTicket.set(t.ticketId, [t]);
  }

  let merged = 0;
  let rejected = 0;
  let reworked = 0;
  let unattendedMerges = 0;
  let unattendedReopened = 0;

  for (const [ticketId, evs] of byTicket) {
    evs.sort((a, b) => a.atMs - b.atMs);
    const mergeEv = [...evs].reverse().find((e) => e.reason === "merge_completed");
    if (mergeEv) {
      merged += 1;
      if ((reworkByTicketId.get(ticketId) ?? 0) > 0) reworked += 1;
      // Unattended ⇔ the last approve BEFORE the merge was by an `agent` actor (no human
      // crossed the gate). markMerged is system-only, so the autonomy signal is the
      // APPROVE actor, not the merge actor.
      const approve = [...evs]
        .filter((e) => APPROVE_REASONS.has(e.reason ?? "") && e.atMs <= mergeEv.atMs)
        .pop();
      if (approve && approve.actorType === "agent") {
        unattendedMerges += 1;
        // "Unsafe" ⇔ it was reopened after merging (came back out of `done`).
        const reopened = evs.some((e) => e.fromStatus === "done" && e.atMs > mergeEv.atMs);
        if (reopened) unattendedReopened += 1;
      }
      continue;
    }
    // Not merged: a terminal REJECT ⇔ it left in_review back to rework/ready or was cancelled.
    if (evs.some((e) => e.fromStatus === "in_review" && REJECT_TARGETS.has(e.toStatus ?? ""))) {
      rejected += 1;
    }
  }

  return {
    windowDays,
    empty: merged + rejected === 0,
    mergeRate: rate(merged, merged + rejected),
    reworkRate: rate(reworked, merged),
    unattendedSafeRate: rate(unattendedMerges - unattendedReopened, unattendedMerges),
    counts: { merged, rejected, reworked, unattendedMerges, unattendedReopened },
  };
}

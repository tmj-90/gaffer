/**
 * FIRST-PASS ACCEPTANCE (Release A metrics, gap-specialists MF1; gap-review A0 "% approved
 * without rework").
 *
 *   first-pass = tickets that reached done with no send-back after they first entered
 *                review, and never reopened out of done, over tickets that reached done.
 *
 * A send-back is a transition out of in_review, in_testing or ready_for_merge back to
 * work (refining, ready, in_progress, claimed, or the retry cap's park to blocked),
 * whoever made it: a person, the reviewer agent or the tester. It is the one definition
 * the rework rate uses (health/sendBacks.ts isReviewSendBack), so a ticket is never
 * first-pass while Health counts a send-back on it, or the other way round. The strict
 * reading also excludes a ticket the runner retried after a failed gate (a
 * `rework_attempts` row), even before it reached review.
 *
 * Split by who made the approving transition (the last move out of in_review that was
 * not a send-back): `human` (human or admin), `agent`, or `system`. Agent approvals under
 * REVIEW_MODE=agent pass more easily, so the overall figure must never be read as the
 * human one. Null-honest: a rate is null with nothing done. Pure.
 *
 * Period (health/measurePeriods.ts): with `windowDays` the figures count the tickets
 * accepted (last moved to done) in the last N days, `previous` the N days before, and
 * `by_week` the last 12 ISO weeks by acceptance time; without it the figures are all
 * time, as before, and there is no previous.
 */
import { isApprovingRound, reviewRounds, type ReviewTimeTransition } from "./reviewTime.js";
import {
  inRange,
  pct1,
  previousRange,
  rangeIso,
  weekGrid,
  windowRange,
  type WeekBucket,
} from "./measurePeriods.js";
import { isReviewSendBack } from "./sendBacks.js";

/** One `rework_attempts` row, projected. */
export interface FirstPassRetry {
  readonly ticketId: string;
  readonly at: string;
}

export interface FirstPassCount {
  readonly done: number;
  readonly first_pass: number;
  readonly rate_pct: number | null;
}

export interface FirstPassStrict {
  readonly first_pass: number;
  readonly rate_pct: number | null;
}

/** The same measure over the equal window before this one. */
export interface FirstPassPrevious extends FirstPassCount {
  readonly since: string;
  readonly until: string;
  readonly strict: FirstPassStrict;
}

/** One ISO week, by acceptance time (the ticket's last move to done). */
export interface FirstPassWeek extends WeekBucket, FirstPassCount {}

export interface FirstPassReport extends FirstPassCount {
  readonly measure: "first_pass_acceptance";
  /** The window the figures above cover, in days; null is all time. */
  readonly window_days: number | null;
  readonly strict: FirstPassStrict;
  readonly by_approver: {
    readonly human: FirstPassCount;
    readonly agent: FirstPassCount;
    readonly system: FirstPassCount;
  };
  /** Every done ticket, whatever the window. */
  readonly all_time: FirstPassCount;
  /** The equal window before; null when the window is all time. */
  readonly previous: FirstPassPrevious | null;
  /** The last 12 ISO weeks by acceptance time; an empty week has done 0 and a null rate. */
  readonly by_week: readonly FirstPassWeek[];
  readonly limits: readonly string[];
}

const pct = pct1;

export const FIRST_PASS_LIMITS: readonly string[] = [
  "a send-back is any move from review, testing or the merge queue back to work, by a person, the reviewer agent or the tester",
  "the strict figure also counts the runner's own retries after a failed gate",
  "split by who approved: an agent approval is not a human acceptance",
  "a window, the previous window and the weekly history count tickets by when they were accepted (their last move to done); a done ticket with no recorded move to done counts in all time only",
];

/** The report (see the module comment). Transitions in any order. */
export function firstPassAcceptance(
  input: {
    transitions: readonly (ReviewTimeTransition & { reason?: string | null })[];
    retries: readonly FirstPassRetry[];
    tickets: readonly { id: string; status: string }[];
  },
  period: { readonly nowMs?: number; readonly windowDays?: number | null } = {},
): FirstPassReport {
  const done = input.tickets.filter((t) => t.status === "done").map((t) => t.id);
  const doneSet = new Set(done);
  const firstReview = new Map<string, number>();
  const reworked = new Set<string>();
  // When each done ticket was accepted: its last move to done.
  const acceptedAt = new Map<string, number>();
  const sorted = [...input.transitions].sort((a, b) => a.atMs - b.atMs);
  for (const t of sorted) {
    if (!doneSet.has(t.ticketId)) continue;
    if (t.toStatus === "done") acceptedAt.set(t.ticketId, t.atMs);
    if (t.toStatus === "in_review" && !firstReview.has(t.ticketId))
      firstReview.set(t.ticketId, t.atMs);
    const since = firstReview.get(t.ticketId);
    const sendBack = isReviewSendBack({
      ticketId: t.ticketId,
      fromStatus: t.fromStatus,
      toStatus: t.toStatus,
      reason: t.reason ?? null,
      at: "",
    });
    if (since !== undefined && t.atMs >= since && sendBack) reworked.add(t.ticketId);
    // Reopened after it was accepted: the first acceptance did not hold.
    if (t.fromStatus === "done") reworked.add(t.ticketId);
  }
  const retried = new Set(input.retries.map((r) => r.ticketId));

  const approver = new Map<string, "human" | "agent" | "system">();
  for (const r of reviewRounds(input.transitions)) {
    if (!doneSet.has(r.ticketId) || !isApprovingRound(r)) continue;
    approver.set(
      r.ticketId,
      r.exitActor === "human" || r.exitActor === "admin"
        ? "human"
        : r.exitActor === "agent"
          ? "agent"
          : "system",
    );
  }

  const count = (ids: readonly string[]): FirstPassCount => {
    const fp = ids.filter((id) => !reworked.has(id)).length;
    return { done: ids.length, first_pass: fp, rate_pct: pct(fp, ids.length) };
  };
  const strictOf = (ids: readonly string[]): FirstPassStrict => {
    const k = ids.filter((id) => !reworked.has(id) && !retried.has(id)).length;
    return { first_pass: k, rate_pct: pct(k, ids.length) };
  };

  const nowMs = period.nowMs ?? Date.now();
  const windowDays = period.windowDays ?? null;
  const win = windowRange(nowMs, windowDays);
  const at = (id: string): number => acceptedAt.get(id) ?? Number.NaN;
  // All time counts every done ticket, a recorded acceptance time or not.
  const inWindow = windowDays === null ? done : done.filter((id) => inRange(win, at(id)));
  const prev = previousRange(nowMs, windowDays);
  const previous: FirstPassPrevious | null = prev
    ? (() => {
        const ids = done.filter((id) => inRange(prev, at(id)));
        return { ...rangeIso(prev), ...count(ids), strict: strictOf(ids) };
      })()
    : null;

  // Weekly history: one pass, each done ticket into the week it was accepted.
  const grid = weekGrid(nowMs);
  const weekDone = new Array<number>(grid.buckets.length).fill(0);
  const weekFirst = new Array<number>(grid.buckets.length).fill(0);
  for (const id of done) {
    const i = grid.indexOf(at(id));
    if (i < 0) continue;
    weekDone[i]! += 1;
    if (!reworked.has(id)) weekFirst[i]! += 1;
  }

  const of = (who: "human" | "agent" | "system"): FirstPassCount =>
    count(inWindow.filter((id) => (approver.get(id) ?? "system") === who));
  return {
    measure: "first_pass_acceptance",
    ...count(inWindow),
    window_days: windowDays,
    strict: strictOf(inWindow),
    by_approver: { human: of("human"), agent: of("agent"), system: of("system") },
    all_time: count(done),
    previous,
    by_week: grid.buckets.map((b, i) => ({
      ...b,
      done: weekDone[i]!,
      first_pass: weekFirst[i]!,
      rate_pct: pct(weekFirst[i]!, weekDone[i]!),
    })),
    limits: FIRST_PASS_LIMITS,
  };
}

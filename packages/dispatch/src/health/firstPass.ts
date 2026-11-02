/**
 * FIRST-PASS ACCEPTANCE (Release A metrics, gap-specialists MF1; gap-review A0 "% approved
 * without rework").
 *
 *   first-pass = tickets that reached done with no send-back after they first entered
 *                review, and never reopened out of done, over tickets that reached done.
 *
 * A send-back is a transition out of in_review, in_testing or ready_for_merge back to
 * refining, ready, in_progress, claimed or blocked, whoever made it: a person, the
 * reviewer agent or the tester. The strict reading also excludes a ticket the runner
 * retried after a failed gate (a `rework_attempts` row), even before it reached review.
 *
 * Split by who made the approving transition (the last move out of in_review that was
 * not a send-back): `human` (human or admin), `agent`, or `system`. Agent approvals under
 * REVIEW_MODE=agent pass more easily, so the overall figure must never be read as the
 * human one. Null-honest: a rate is null with nothing done. Pure.
 */
import { isApprovingRound, reviewRounds, type ReviewTimeTransition } from "./reviewTime.js";

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

export interface FirstPassReport extends FirstPassCount {
  readonly measure: "first_pass_acceptance";
  readonly strict: { readonly first_pass: number; readonly rate_pct: number | null };
  readonly by_approver: {
    readonly human: FirstPassCount;
    readonly agent: FirstPassCount;
    readonly system: FirstPassCount;
  };
  readonly limits: readonly string[];
}

const REVIEW_STATES = new Set(["in_review", "in_testing", "ready_for_merge"]);
const BACK_TO_WORK = new Set(["refining", "ready", "in_progress", "claimed", "blocked"]);

const pct = (n: number, d: number): number | null =>
  d > 0 ? Math.round((n / d) * 1000) / 10 : null;

export const FIRST_PASS_LIMITS: readonly string[] = [
  "a send-back is any move from review, testing or the merge queue back to work, by a person, the reviewer agent or the tester",
  "the strict figure also counts the runner's own retries after a failed gate",
  "split by who approved: an agent approval is not a human acceptance",
];

/** The report (see the module comment). Transitions in any order. */
export function firstPassAcceptance(input: {
  transitions: readonly (ReviewTimeTransition & { reason?: string | null })[];
  retries: readonly FirstPassRetry[];
  tickets: readonly { id: string; status: string }[];
}): FirstPassReport {
  const done = input.tickets.filter((t) => t.status === "done").map((t) => t.id);
  const doneSet = new Set(done);
  const firstReview = new Map<string, number>();
  const reworked = new Set<string>();
  const sorted = [...input.transitions].sort((a, b) => a.atMs - b.atMs);
  for (const t of sorted) {
    if (!doneSet.has(t.ticketId)) continue;
    if (t.toStatus === "in_review" && !firstReview.has(t.ticketId))
      firstReview.set(t.ticketId, t.atMs);
    const since = firstReview.get(t.ticketId);
    const sendBack = REVIEW_STATES.has(t.fromStatus ?? "") && BACK_TO_WORK.has(t.toStatus ?? "");
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
  const overall = count(done);
  const strict = done.filter((id) => !reworked.has(id) && !retried.has(id)).length;
  const of = (who: "human" | "agent" | "system"): FirstPassCount =>
    count(done.filter((id) => (approver.get(id) ?? "system") === who));
  return {
    measure: "first_pass_acceptance",
    ...overall,
    strict: { first_pass: strict, rate_pct: pct(strict, done.length) },
    by_approver: { human: of("human"), agent: of("agent"), system: of("system") },
    limits: FIRST_PASS_LIMITS,
  };
}

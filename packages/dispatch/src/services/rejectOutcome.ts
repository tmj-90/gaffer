/**
 * WHAT HAPPENS ON "FIX THESE" (review comments A2) — the reject twin of approveOutcome.ts.
 *
 * A send-back from review re-queues the ticket, but the same click can do four different
 * things, and the button must say which before the reviewer presses it:
 *
 *   to_refining          back to Refining (the default, and the rule for a human
 *                        send-back: the human looks at it there before an agent delivers it
 *                        again);
 *   to_ready             back to Ready (only when the caller asked for it explicitly);
 *   parked_retry_cap     the send-back reaches DISPATCH_MAX_ATTEMPTS: the ticket is parked
 *                        for a person (blocked) instead of re-queued;
 *   held_partly_landed   part of the change already reached a default branch: the ticket
 *                        is held for a person (blocked, partly_landed) instead.
 *
 * Every one resets the ticket's acceptance criteria to not met (rejectReview does that on
 * every send-back), and the outcome says so. Pure: the inputs are the facts rejectReview
 * itself acts on (attempt_count, the cap, the recorded landings).
 */

export const REJECT_OUTCOME_KINDS = [
  "to_refining",
  "to_ready",
  "parked_retry_cap",
  "held_partly_landed",
] as const;
export type RejectOutcomeKind = (typeof REJECT_OUTCOME_KINDS)[number];

export interface RejectOutcomeFacts {
  ticketNumber: number | null;
  to: "refining" | "ready";
  /** The ticket's attempt_count now (before the send-back). */
  attemptCount: number;
  maxAttempts: number;
  /** Repos whose change already landed (recordedLandingRepos). */
  landedRepos: readonly string[];
  /** How many numbered requirements the send-back carries. */
  requirements: number;
}

export interface RejectOutcome {
  kind: RejectOutcomeKind;
  /** The button's label: "Fix these (3)". */
  label: string;
  /** One sentence: where the ticket goes, what the agent gets, the AC reset. */
  sentence: string;
  /** Where the ticket ends up. */
  to_status: "refining" | "ready" | "blocked";
  /** attempt_count after the send-back (the next delivery is shown as attempt + 1). */
  attempt: number;
  max_attempts: number;
  /** Always true: a send-back resets the acceptance criteria to not met. */
  ac_reset: true;
  requirements: number;
}

export function rejectOutcome(f: RejectOutcomeFacts): RejectOutcome {
  const ref = f.ticketNumber != null ? `#${f.ticketNumber}` : "This ticket";
  const n = f.requirements;
  const reqs = `${n} numbered requirement${n === 1 ? "" : "s"}`;
  const attempt = f.attemptCount + 1;
  const reset = "Its acceptance criteria reset to not met.";
  const base = {
    label: `Fix these (${n})`,
    attempt,
    max_attempts: f.maxAttempts,
    ac_reset: true as const,
    requirements: n,
  };
  if (f.landedRepos.length > 0) {
    return {
      ...base,
      kind: "held_partly_landed",
      to_status: "blocked",
      sentence: `Part of this change already landed (${f.landedRepos.join(", ")}), so ${ref} is held for a person (blocked) with your ${reqs} instead of going back to the queue. ${reset}`,
    };
  }
  if (attempt >= f.maxAttempts) {
    return {
      ...base,
      kind: "parked_retry_cap",
      to_status: "blocked",
      sentence: `This was attempt ${attempt} of ${f.maxAttempts}, the last the cap allows, so ${ref} is parked for a person (blocked) with your ${reqs} instead of going back to the queue. ${reset}`,
    };
  }
  if (f.to === "ready") {
    return {
      ...base,
      kind: "to_ready",
      to_status: "ready",
      sentence: `${ref} goes back to Ready with your ${reqs}; the next delivery (attempt ${attempt + 1} of ${f.maxAttempts}) gets them in its prompt. ${reset}`,
    };
  }
  return {
    ...base,
    kind: "to_refining",
    to_status: "refining",
    sentence: `${ref} goes back to Refining with your ${reqs}; you look at it there, and the next delivery (attempt ${attempt + 1} of ${f.maxAttempts}) gets them in its prompt. ${reset}`,
  };
}

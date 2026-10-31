/**
 * WHERE AN APPROVED CHANGE IS — the truthful status label for `ready_for_merge`.
 *
 * The dashboard said "Approved · merging" for every approved ticket, also when nothing
 * would merge it until someone pressed Merge now (external UI review, fix 1 follow-up).
 * This decides, from the same facts the approve outcome and the runner's merge lane use,
 * which of these is true now:
 *
 *   held               the landing is held for a human: the branch moved since the review
 *                      approved it (the review pin is not the head), the merge gate failed
 *                      on the combination (merge_gate_red) or required CI is red (ci_red).
 *                      A ticket already parked as blocked for one of the last two says so.
 *   landing            a merge run the API started for this approval is still running.
 *   partly_landed      some of its write repos are recorded landed, not all.
 *   lands_next_tick    the runner's merge lane will land it: an earned merge grant, or
 *                      AUTO_MERGE on and the approval was a human's (the lane's own rule).
 *   waiting_for_merge  nothing lands it until someone presses Merge now.
 *
 * Pure: Dispatch.landingFacts reads the facts.
 */

export const LANDING_KINDS = [
  "held",
  "landing",
  "partly_landed",
  "lands_next_tick",
  "waiting_for_merge",
] as const;
export type LandingKind = (typeof LANDING_KINDS)[number];

export const LANDING_HOLDS = ["moved_since_review", "merge_gate_red", "ci_red"] as const;
export type LandingHold = (typeof LANDING_HOLDS)[number];

export interface LandingFacts {
  status: string;
  /** The hold on the landing, if any (blocked tickets only ever carry their hold code). */
  hold: LandingHold | null;
  /** A merge run the API started for the current approval is still running. */
  mergeRunning: boolean;
  /** Write repos recorded landed (repo delivery status done) of all write repos. */
  landedRepos: string[];
  writeRepos: string[];
  autoMerge: boolean;
  mergeLane: boolean;
  mergeGateEarned: boolean;
  /** The actor type of the approval on the ticket's current path to merge ("" unknown). */
  approver: string;
}

export interface LandingState {
  kind: LandingKind;
  /** The status label, e.g. "Approved · waiting for Merge now". */
  label: string;
  /** One sentence saying why. */
  detail: string;
  hold: LandingHold | null;
}

const HOLD_WORDS: Record<LandingHold, { label: string; detail: string }> = {
  moved_since_review: {
    label: "Held · moved since review",
    detail:
      "The branch moved since the review approved it; no landing path merges commits nobody reviewed. Move it back to review.",
  },
  merge_gate_red: {
    label: "Held · merge gate failed",
    detail:
      "The merge onto the current default branch failed its gates; the default branch was not touched.",
  },
  ci_red: {
    label: "Held · CI red",
    detail: "Required CI failed for the commit that would land.",
  },
};

/** Where an approved (or held) change is now; null for any other status. */
export function decideLandingState(f: LandingFacts): LandingState | null {
  if (f.hold && (f.status === "ready_for_merge" || f.status === "blocked"))
    return { kind: "held", hold: f.hold, ...HOLD_WORDS[f.hold] };
  if (f.status !== "ready_for_merge") return null;
  if (f.mergeRunning)
    return {
      kind: "landing",
      hold: null,
      label: "Approved · landing",
      detail: "The merge runner is landing it now.",
    };
  if (f.landedRepos.length > 0 && f.landedRepos.length < f.writeRepos.length) {
    const rest = f.writeRepos.filter((r) => !f.landedRepos.includes(r));
    return {
      kind: "partly_landed",
      hold: null,
      label: "Approved · partly landed",
      detail: `${f.landedRepos.join(", ")} landed; ${rest.join(", ")} not yet.`,
    };
  }
  const human = f.approver === "human" || f.approver === "admin";
  if (f.mergeLane && (f.mergeGateEarned || (f.autoMerge && human)))
    return {
      kind: "lands_next_tick",
      hold: null,
      label: "Approved · lands next tick",
      detail: f.mergeGateEarned
        ? "An earned merge grant covers it: the runner's merge lane lands it on its next tick."
        : "Auto-merge on approval is on: the runner's merge lane lands this human approval on its next tick.",
    };
  return {
    kind: "waiting_for_merge",
    hold: null,
    label: "Approved · waiting for Merge now",
    detail: f.autoMerge
      ? "Nothing lands it on its own (an agent's approval needs an earned merge grant, or the merge lane is off): press Merge now."
      : "Auto-merge on approval is off: it lands when someone presses Merge now.",
  };
}

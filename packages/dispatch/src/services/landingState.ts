/**
 * WHERE AN APPROVED CHANGE IS — the truthful status label for `ready_for_merge`.
 *
 * The dashboard said "Approved · merging" for every approved ticket, also when nothing
 * would merge it until someone pressed Merge now (external UI review, fix 1 follow-up).
 * This decides, from the same facts the approve outcome and the runner's merge lane use,
 * which of these is true now:
 *
 *   held               the landing is held for a human: a write repo's branch moved since
 *                      the review approved it (its per-repo review pin is not its head), the
 *                      merge gate failed on the combination (merge_gate_red) or required CI
 *                      is red (ci_red), or a write repo has no approved commit at all
 *                      (unpinned_repo: the approval did not cover it — approveReview now
 *                      refuses that, see approveOutcome.ts held_repo_unavailable — so the
 *                      ticket can never be done until every write repo is approved and
 *                      lands). A ticket already parked as blocked for merge_gate_red or
 *                      ci_red says so (and which repos had already landed).
 *   landing            a merge run the API started for this approval is still running.
 *   partly_landed      some of its approved revisions have a landing on record
 *                      (`gaffer-landed-commit:` system rows, services/landingStatus.ts), not
 *                      all: every write repo lands through the same path, so Merge now (or
 *                      the merge lane's retry) lands the rest and never re-merges one.
 *   lands_next_tick    the runner's merge lane will land it: an earned merge grant, or
 *                      AUTO_MERGE on and the approval was a human's (the lane's own rule).
 *                      While the usage-window pause is active (the runner's pause file,
 *                      health/usagePause.ts) no tick runs, so it says "paused: usage limit"
 *                      and when the pause ends.
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

export const LANDING_HOLDS = [
  "moved_since_review",
  "unpinned_repo",
  "merge_gate_red",
  "ci_red",
] as const;
export type LandingHold = (typeof LANDING_HOLDS)[number];

export interface LandingFacts {
  status: string;
  /** The hold on the landing, if any (blocked tickets only ever carry their hold code). */
  hold: LandingHold | null;
  /** A merge run the API started for the current approval is still running. */
  mergeRunning: boolean;
  /**
   * The approved revisions recorded landed (computeLandingStatus: a system
   * `gaffer-landed-commit:<sha>` row per repo), of all the ticket's approved revisions.
   */
  landedRepos: string[];
  writeRepos: string[];
  /** The repos still to land whose branch head moved off their review pin. */
  movedRepos?: string[];
  /** Write repos the approval did not pin (computeLandingStatus `unpinned`). */
  unpinnedRepos?: string[];
  /** The runner's usage-window pause, while active (readUsagePause): no tick runs. */
  pause?: { until: string; kind: "usage_limit" | "rate_limit" } | null;
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
  /** lands_next_tick only: the usage-window pause the next tick waits for, until when. */
  paused_until?: string;
}

const HOLD_WORDS: Record<LandingHold, { label: string; detail: string }> = {
  moved_since_review: {
    label: "Held · moved since review",
    detail:
      "The branch moved since the review approved it; no landing path merges commits nobody reviewed. Send it back to review (Back to review on its ticket page, or `gaffer wg ticket reopen-for-review <n> --reason … --resolution … --as admin`) and approve the new commits.",
  },
  unpinned_repo: {
    label: "Held · approval does not cover every repository",
    detail:
      "A write repository on this ticket has no approved commit (its delivery head could not be read when the ticket was approved), so no landing path can land it and the ticket can never be done as approved. Send it back to review (Back to review on its ticket page, or `gaffer wg ticket reopen-for-review <n> --reason … --resolution … --as admin`) and approve every repository together.",
  },
  merge_gate_red: {
    label: "Held · merge gate failed",
    detail:
      "The merge onto the current default branch failed its gates; the default branch was not touched. The merge gate runs on every landing path (the merge lane, Merge now, gaffer merge), so none lands it until a person looks.",
  },
  ci_red: {
    label: "Held · CI red",
    detail:
      "Required CI failed for the commit that would land; no landing path merges it until CI passes or a person looks.",
  },
};

/** A held multi-repo landing: which repos already landed (they stay landed). */
function partWords(f: LandingFacts): string {
  if (f.landedRepos.length === 0 || f.landedRepos.length >= f.writeRepos.length) return "";
  const rest = f.writeRepos.filter((r) => !f.landedRepos.includes(r));
  return ` Partly landed: ${f.landedRepos.join(", ")} landed; ${rest.join(", ")} held.`;
}

/** Where an approved (or held) change is now; null for any other status. */
export function decideLandingState(f: LandingFacts): LandingState | null {
  if (f.hold && (f.status === "ready_for_merge" || f.status === "blocked")) {
    const words = HOLD_WORDS[f.hold];
    const moved =
      f.hold === "moved_since_review" && f.movedRepos && f.movedRepos.length > 0
        ? ` Moved: ${f.movedRepos.join(", ")}.`
        : f.hold === "unpinned_repo" && f.unpinnedRepos && f.unpinnedRepos.length > 0
          ? ` Not approved: ${f.unpinnedRepos.join(", ")}.`
          : "";
    return {
      kind: "held",
      hold: f.hold,
      label: words.label,
      detail: words.detail + moved + partWords(f),
    };
  }
  if (f.status !== "ready_for_merge") return null;
  if (f.mergeRunning)
    return {
      kind: "landing",
      hold: null,
      label: "Approved · landing",
      detail: "The merge runner is landing it now.",
    };
  const human = f.approver === "human" || f.approver === "admin";
  const laneLands = f.mergeLane && (f.mergeGateEarned || (f.autoMerge && human));
  if (f.landedRepos.length > 0 && f.landedRepos.length < f.writeRepos.length) {
    const rest = f.writeRepos.filter((r) => !f.landedRepos.includes(r));
    // The merge lane finishes it only under the SAME policy that lets it land any approval
    // (external review #7): otherwise it stays partly landed until a person presses Merge now.
    const who = laneLands
      ? "The runner's merge lane lands the rest on its next tick (the merge gate and the tester replay run per repository), or Merge now lands the rest at once"
      : "Nothing lands the rest on its own (the merge policy holds this approval now): Merge now lands the rest";
    return {
      kind: "partly_landed",
      hold: null,
      label: "Approved · partly landed",
      detail:
        `${f.landedRepos.join(", ")} landed; ${rest.join(", ")} not yet landed (pending, still on the delivery branch). ` +
        `${who}; a landed repo is never merged again, and the ticket is done when every repository has landed.`,
    };
  }
  if (laneLands) {
    const why = f.mergeGateEarned
      ? "An earned merge grant covers it: the runner's merge lane lands it on its next tick."
      : "Auto-merge on approval is on: the runner's merge lane lands this human approval on its next tick.";
    if (f.pause) {
      const what = f.pause.kind === "rate_limit" ? "rate limit" : "usage limit";
      return {
        kind: "lands_next_tick",
        hold: null,
        label: `Approved · lands next tick (paused: ${what})`,
        detail: `${why} The runner is paused for the ${what} until ${f.pause.until} and runs no tick before then; it lands on the first tick after.`,
        paused_until: f.pause.until,
      };
    }
    return {
      kind: "lands_next_tick",
      hold: null,
      label: "Approved · lands next tick",
      detail: why,
    };
  }
  return {
    kind: "waiting_for_merge",
    hold: null,
    label: "Approved · waiting for Merge now",
    detail: f.autoMerge
      ? "Nothing lands it on its own (an agent's approval needs an earned merge grant, or the merge lane is off): press Merge now."
      : "Auto-merge on approval is off: it lands when someone presses Merge now.",
  };
}

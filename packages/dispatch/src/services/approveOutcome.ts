/**
 * WHAT HAPPENS ON APPROVE — the one sentence the Review view's sign-off button names.
 *
 * A human Approve (POST /tickets/:id/review/approve) can do five different things, and
 * the button used to promise a merge ("Confirm merge") whatever the settings said. This
 * module turns the facts the approve path itself acts on into the FIRST step that will
 * certainly happen, so the button, the line under it and the done band say exactly that:
 *
 *   held_ci          GAFFER_REQUIRE_CI has recorded CI for this ticket and the candidate
 *                    commit has no PASS: approveReview refuses (POLICY_DENIED).
 *   to_tester        an epic's acceptance ticket, or GAFFER_TESTING on and the ticket is
 *                    testable: approveReview routes it in_review → in_testing.
 *   land_now         AUTO_MERGE on and DISPATCH_MERGE_CMD set: the route fires the merge
 *                    runner the moment the ticket reaches ready_for_merge.
 *   land_next_tick   AUTO_MERGE on (or an earned merge gate) but no merge command on this
 *                    server: the runner's merge lane lands it at the start of its next tick.
 *   waits_for_merge  nothing lands it: it waits at ready_for_merge for Merge now.
 *
 * Later steps that MAY hold the landing (the tester's verdict, the landing check, the
 * merge gate on the combination, CI re-read before landing, a PR merge gh refuses) are
 * not certain at approve time, so they are said as what runs next, never as an outcome.
 *
 * A multi-repo ticket lands EVERY write repo with a checkout (PER-REPOSITORY LANDING,
 * services/landingStatus.ts): the approval pins each repo's head, and the merge lane and
 * Merge now land them primary first, each through the merge gate on its own default
 * branch. A repo that fails is held with the landed ones recorded (partly landed), and
 * the next landing lands only the rest.
 *
 * Pure: every input is a fact the caller read from the same predicates approveReview,
 * the approve route and the merge lane use (see Dispatch.approveOutcomeFacts).
 */

export const APPROVE_OUTCOME_KINDS = [
  "held_ci",
  "to_tester",
  "land_now",
  "land_next_tick",
  "waits_for_merge",
] as const;
export type ApproveOutcomeKind = (typeof APPROVE_OUTCOME_KINDS)[number];

export type ReviewMode = "human" | "agent" | "both";

/** The facts the decision is made from (all read server-side, never from the client). */
export interface ApproveOutcomeFacts {
  /** The required-CI hold approveReview would raise now, or null (no CI recorded / PASS). */
  ciHold: { state: string | null; commit: string | null } | null;
  /** approveReview routes this ticket to the independent tester (in_testing). */
  toTester: boolean;
  /** …because it is an epic's acceptance ticket (the toggle does not apply). */
  acceptance: boolean;
  /** AUTO_MERGE ("Auto-merge on approval"): the route fires the merge runner. */
  autoMerge: boolean;
  /** DISPATCH_MERGE_CMD is set, so the merge runner can actually start. */
  mergeCommand: boolean;
  /** The runner's merge lane is on (GAFFER_MERGE_LANE, default on). */
  mergeLane: boolean;
  /** An earned merge gate (agent floor or a mode='auto' merge policy) covers the ticket. */
  mergeGateEarned: boolean;
  /** REVIEW_MODE: under `both` this click is the human confirmation of the agent screen. */
  reviewMode: ReviewMode;
  /** GAFFER_CREATE_PR: deliveries open a pull request. */
  prMode: boolean;
  /** The PR the landing goes through (per-repo pr_url, else the ticket's), or null. */
  prUrl: string | null;
  /** GAFFER_PR_MERGE_METHOD (merge · squash · rebase). */
  prMergeMethod: string;
  /** The PRIMARY write repo the landing paths merge first (the first with a local path). */
  landsRepo: string | null;
  /** That repo's default branch. */
  baseBranch: string | null;
  /** The other write repos with a checkout: each lands after the primary, the same way. */
  alsoLandsRepos: string[];
  /** Write repos with no checkout on this machine: no landing path can merge them. */
  noCheckoutRepos: string[];
}

export interface ApproveOutcome {
  kind: ApproveOutcomeKind;
  /** False only when the server would refuse the approval (held_ci). */
  approvable: boolean;
  /** Where the click moves the ticket (null when it is refused). */
  to_status: "in_testing" | "ready_for_merge" | null;
  /** The primary button, e.g. "Approve and send to tester". */
  label: string;
  /** The armed button (second press approves), e.g. "Confirm: send to tester". */
  confirm_label: string;
  /** The button once approved, e.g. "Sent to tester". */
  done_label: string;
  /** One line under the button: what follows the click. */
  sentence: string;
  /** How a landing merges: through the PR, locally, or no landing follows directly. */
  via: "pr" | "local" | null;
  pr_url: string | null;
  /** The primary write repo a landing merges first; null when no landing follows. */
  lands_repo: string | null;
  /** The other write repos the same landing merges after it (one merge per repo). */
  also_lands_repos: string[];
  /** Write repos with no checkout here: no landing path can merge them. */
  not_landed_repos: string[];
  review_mode: ReviewMode;
}

function andList(xs: readonly string[]): string {
  if (xs.length <= 1) return xs.join("");
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

/** Where a landing goes and how, said once for land_now / land_next_tick. */
function landingClause(f: ApproveOutcomeFacts): string {
  const onto = f.baseBranch ? ` onto ${f.baseBranch}` : "";
  const repo = f.landsRepo ? `${f.landsRepo}${onto}` : `the default branch`;
  if (f.prUrl)
    return `it merges ${repo} through its pull request (gh pr merge, ${f.prMergeMethod})`;
  if (f.prMode) return `it merges ${repo} locally (no pull request was recorded for this delivery)`;
  return `it merges ${repo} locally`;
}

/** A multi-repo landing: every repo with a checkout lands, one merge each. */
function partialClause(f: ApproveOutcomeFacts): string {
  if (!f.landsRepo) return "";
  let out = "";
  if (f.alsoLandsRepos.length > 0)
    out +=
      ` ${andList(f.alsoLandsRepos)} ${f.alsoLandsRepos.length === 1 ? "lands" : "land"} after it the same way, each through the merge gate on its own default branch.` +
      " A repo that fails is held with the landed ones recorded (Approved · partly landed), and the next landing merges only the rest.";
  if (f.noCheckoutRepos.length > 0)
    out += ` ${andList(f.noCheckoutRepos)} ${f.noCheckoutRepos.length === 1 ? "has" : "have"} no checkout on this machine, so no landing path can merge ${f.noCheckoutRepos.length === 1 ? "it" : "them"}.`;
  return out;
}

function bothClause(f: ApproveOutcomeFacts): string {
  return f.reviewMode === "both"
    ? " Review mode is both: this click is the human confirmation; the reviewer agent's screen never approves on its own."
    : "";
}

/** After the tester's PASS (ready_for_merge): who lands it. */
function afterPass(f: ApproveOutcomeFacts): string {
  if ((f.autoMerge || f.mergeGateEarned) && f.mergeLane) return "the runner's merge lane lands it";
  return "it waits for Merge now";
}

/** The first step that will certainly happen when a human approves now. */
export function decideApproveOutcome(f: ApproveOutcomeFacts): ApproveOutcome {
  const base = {
    pr_url: f.prUrl,
    review_mode: f.reviewMode,
  };
  if (f.ciHold) {
    const at = f.ciHold.commit ? ` for ${f.ciHold.commit.slice(0, 12)}` : "";
    const state = f.ciHold.state ?? "no result for this commit";
    return {
      ...base,
      kind: "held_ci",
      approvable: false,
      to_status: null,
      label: "Approve held: CI not passed",
      confirm_label: "Approve held: CI not passed",
      done_label: "Approve held",
      sentence: `Required CI has not passed${at} (${state}). The server refuses approval until a passing result is recorded for this commit.`,
      via: null,
      lands_repo: null,
      also_lands_repos: [],
      not_landed_repos: [],
    };
  }
  if (f.toTester) {
    const why = f.acceptance
      ? "An epic's acceptance ticket always goes to the independent tester."
      : "Independent testing is on and this ticket is testable.";
    return {
      ...base,
      kind: "to_tester",
      approvable: true,
      to_status: "in_testing",
      label: "Approve and send to tester",
      confirm_label: "Confirm: send to tester",
      done_label: "Sent to tester",
      sentence: `It moves to In testing, not to merge. ${why} A PASS takes it to Ready for merge, where ${afterPass(f)}.${bothClause(f)}`,
      via: null,
      lands_repo: null,
      also_lands_repos: [],
      not_landed_repos: [],
    };
  }
  const landed = {
    via: (f.prUrl ? "pr" : "local") as "pr" | "local",
    lands_repo: f.landsRepo,
    also_lands_repos: f.landsRepo ? [...f.alsoLandsRepos] : [],
    not_landed_repos: [...f.noCheckoutRepos],
  };
  if (f.autoMerge && f.mergeCommand) {
    return {
      ...base,
      ...landed,
      kind: "land_now",
      approvable: true,
      to_status: "ready_for_merge",
      label: "Approve and land now",
      confirm_label: "Confirm and land now",
      done_label: "Landing now",
      sentence: `Auto-merge on approval is on: the merge runner starts now, runs the landing check and the merge gate, then ${landingClause(f)}.${partialClause(f)}${bothClause(f)}`,
    };
  }
  if ((f.autoMerge || f.mergeGateEarned) && f.mergeLane) {
    const why = f.autoMerge
      ? "Auto-merge on approval is on but this server has no merge command"
      : "An earned merge grant covers this ticket";
    return {
      ...base,
      ...landed,
      kind: "land_next_tick",
      approvable: true,
      to_status: "ready_for_merge",
      label: "Approve, lands on next tick",
      confirm_label: "Confirm: lands on next tick",
      done_label: "Waits for the merge lane",
      sentence: `It moves to Ready for merge. ${why}, so the runner's merge lane lands it at the start of its next tick (while the runner is running): ${landingClause(f)}.${partialClause(f)}${bothClause(f)}`,
    };
  }
  const why = f.autoMerge
    ? "Auto-merge on approval is on, but there is no merge command and the runner's merge lane is off"
    : "Auto-merge on approval is off";
  return {
    ...base,
    kind: "waits_for_merge",
    approvable: true,
    to_status: "ready_for_merge",
    label: "Approve, waits for Merge now",
    confirm_label: "Confirm approval",
    done_label: "Waits for Merge now",
    sentence: `It waits in Ready for merge: ${why}, so it lands only when someone presses Merge now.${bothClause(f)}`,
    via: null,
    lands_repo: null,
    also_lands_repos: [],
    not_landed_repos: [],
  };
}

/**
 * The outcome as it actually went, from the approve response: the predicted outcome
 * unless the route's real result says otherwise (the ticket went to the tester, or the
 * merge runner was skipped or failed to start).
 */
export function settleApproveOutcome(
  facts: ApproveOutcomeFacts,
  actual: {
    toStatus: string;
    merge?: { triggered: boolean; skipped?: string | undefined } | undefined;
  },
): ApproveOutcome {
  const free = { ...facts, ciHold: null };
  if (actual.toStatus === "in_testing") return decideApproveOutcome({ ...free, toTester: true });
  const predicted = decideApproveOutcome({ ...free, toTester: false });
  const m = actual.merge;
  if (!m) return predicted;
  if (m.triggered)
    return decideApproveOutcome({ ...free, toTester: false, autoMerge: true, mergeCommand: true });
  if (m.skipped === "auto_merge_off")
    return decideApproveOutcome({ ...free, toTester: false, autoMerge: false });
  if (m.skipped === "not_configured")
    return decideApproveOutcome({ ...free, toTester: false, mergeCommand: false });
  if (m.skipped === "spawn_error") {
    const fallback = decideApproveOutcome({ ...free, toTester: false, mergeCommand: false });
    return {
      ...fallback,
      sentence: `The merge runner could not start. ${fallback.sentence}`,
    };
  }
  return predicted;
}

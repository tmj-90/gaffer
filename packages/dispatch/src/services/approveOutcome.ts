/**
 * WHAT HAPPENS ON APPROVE — the one sentence the Review view's sign-off button names.
 *
 * A human Approve (POST /tickets/:id/review/approve) can do five different things, and
 * the button used to promise a merge ("Confirm merge") whatever the settings said. This
 * module turns the facts the approve path itself acts on into the FIRST step that will
 * certainly happen, so the button, the line under it and the done band say exactly that:
 *
 *   held_ci          GAFFER_REQUIRE_CI has recorded CI (a result, or the requirement
 *                    itself, recorded before review) for this ticket and the candidate
 *                    commit has no PASS: approveReview refuses (POLICY_DENIED).
 *   held_repo_unavailable
 *                    a write repo's delivery head cannot be read now (no checkout here, an
 *                    unreadable path, a missing delivery branch): approveReview refuses
 *                    (STATE_CONFLICT, repo_unavailable) for every approver, because an
 *                    approval pins every write repo and the ticket is done only when each
 *                    one landed. The button names the repo; it never says "land now".
 *   held_test_modified
 *                    GATE INTEGRITY, for an AGENT or auto approval only: the delivery
 *                    changed the tests that gate it (an unallowed `test-modified` finding,
 *                    or the runner's integrity FLAG), so the auto-ship gate refuses
 *                    (OBSERVED_RISK_ESCALATED) until a person approves or allows test
 *                    changes. A HUMAN approval is not held by it: the human's outcome is
 *                    the usual one, its line says the tests changed and that the
 *                    Flags below the button name them, and `agent_hold` names the hold.
 *   held_untested    TESTER FIRST, a HUMAN approval: the independent tester gates this
 *                    ticket (an epic's acceptance ticket, or a testable one whose lane is
 *                    on) and has not passed the commit under review (not tested yet, a
 *                    push after its PASS, a FAIL, a contract edited since): approveReview
 *                    refuses (STATE_CONFLICT, not_tested) and the runner sends that commit
 *                    to the tester; it returns to review after a PASS.
 *   to_tester        an AGENT or auto approval of a ticket the tester gates whose commit it
 *                    has not passed: approveReview routes it in_review → in_testing, and the
 *                    PASS takes it to ready_for_merge (no person in that loop).
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
  "held_repo_unavailable",
  "held_untested",
  "held_test_modified",
  "to_tester",
  "land_now",
  "land_next_tick",
  "waits_for_merge",
] as const;
export type ApproveOutcomeKind = (typeof APPROVE_OUTCOME_KINDS)[number];

export type ReviewMode = "human" | "agent" | "both";

/** The facts the decision is made from (all read server-side, never from the client). */
export interface ApproveOutcomeFacts {
  /** Whose approval this is: the human sign-off (default) or an agent / auto approval. */
  approver?: "human" | "agent";
  /**
   * GATE INTEGRITY: the hard holds the auto-ship gate raises now (observedRisk `holds`:
   * an unallowed test-modified finding, the runner's integrity FLAG); empty when none or
   * a person allowed test changes. Hold an agent approval; never a human one.
   */
  testModifiedHolds?: string[];
  /** The required-CI hold approveReview would raise now, or null (no CI recorded / PASS). */
  ciHold: { state: string | null; commit: string | null } | null;
  /**
   * EVERY WRITE REPO: the write repos whose delivery head cannot be read now — the same
   * list approveReview refuses on (repo_unavailable). Empty or absent when all resolve.
   */
  unavailableRepos?: Array<{ repo: string; why: string; fix?: string }>;
  /**
   * An AGENT or auto approval of this ticket would route it to the independent tester
   * (in_testing): the tester gates it and has not passed the commit under review.
   */
  toTester: boolean;
  /**
   * TESTER FIRST: a HUMAN approval is refused because the tester gates this ticket and has
   * not passed the commit under review (why, the commit it tested, the head now). Null
   * when the tester does not gate it or its PASS covers the head.
   */
  untested?: {
    why: "no_verdict" | "failed" | "other_commit" | "contract_changed" | null;
    tested: string | null;
    head: string | null;
  } | null;
  /** The commit the tester passed when that PASS covers the head (the commit you approve). */
  testedCommit?: string | null;
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
  /**
   * USAGE-WINDOW PAUSE: while the runner's pause file holds a pause no tick runs, so the
   * merge lane's "next tick" is the first one after it ends (health/usagePause.ts, the
   * same read landing_state uses). Null or absent when no pause is active.
   */
  pause?: { until: string; kind: "usage_limit" | "rate_limit" } | null;
}

export interface ApproveOutcome {
  kind: ApproveOutcomeKind;
  /** False only when the server would refuse the approval (a held_* kind). */
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
  /**
   * A human outcome only: the hold an agent or auto approval of this ticket would hit
   * now (held_test_modified), so the line can say the human's approval is not held by it.
   */
  agent_hold: AgentHold | null;
}

/** The gate-integrity hold on an agent or auto approval, carried on the human's outcome. */
export interface AgentHold {
  kind: "held_test_modified";
  label: string;
  sentence: string;
  holds: string[];
}

const TEST_HOLD_LABEL = "Approve held: tests changed, a person must allow it";

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

/** The merge lane's next tick waits for an active usage-window pause: say until when. */
function pauseClause(f: ApproveOutcomeFacts): string {
  if (!f.pause) return "";
  const what = f.pause.kind === "rate_limit" ? "rate limit" : "usage limit";
  return ` The runner is paused for the ${what} until ${f.pause.until} and runs no tick before then, so the merge lane lands it on the first tick after.`;
}

function bothClause(f: ApproveOutcomeFacts): string {
  return f.reviewMode === "both"
    ? " Review mode is both: this click is the human confirmation; the reviewer agent's screen never approves on its own."
    : "";
}

/** "You approve tested commit X", when the tester's PASS covers the commit under review. */
function testedClause(f: ApproveOutcomeFacts): string {
  return f.testedCommit
    ? ` You approve tested commit ${f.testedCommit.slice(0, 12)}: the independent tester passed it before your review.`
    : "";
}

/** After the tester's PASS (ready_for_merge): who lands it. */
function afterPass(f: ApproveOutcomeFacts): string {
  if ((f.autoMerge || f.mergeGateEarned) && f.mergeLane) return "the runner's merge lane lands it";
  return "it waits for Merge now";
}

/** The gate-integrity hold on an agent or auto approval, or null when none applies. */
function agentHold(f: ApproveOutcomeFacts): AgentHold | null {
  const holds = f.testModifiedHolds ?? [];
  if (holds.length === 0) return null;
  return {
    kind: "held_test_modified",
    label: TEST_HOLD_LABEL,
    sentence: `The delivery changed the tests that gate it (${holds.join("; ")}). An agent's or auto approval is refused until a person approves it or allows test changes on the ticket.`,
    holds: [...holds],
  };
}

/** The human's line when the tests changed: not held, but read the banner first. */
function testChangesClause(hold: AgentHold | null): string {
  return hold
    ? " The tests that gate it changed: your approval is not held by that (only an agent's or auto approval is), and the Flags below the button name what changed."
    : "";
}

/**
 * The first step that will certainly happen when this approval is made now: a human's
 * sign-off by default, or (approver "agent") an agent or auto approval, which the
 * gate-integrity hold refuses where a human's goes through.
 */
export function decideApproveOutcome(f: ApproveOutcomeFacts): ApproveOutcome {
  const hold = agentHold(f);
  const agent = f.approver === "agent";
  const base = {
    pr_url: f.prUrl,
    review_mode: f.reviewMode,
    agent_hold: agent ? null : hold,
  };
  if (f.ciHold) {
    const at = f.ciHold.commit ? ` for ${f.ciHold.commit.slice(0, 12)}` : "";
    // No result at all for the commit under review: CI is required but has not reported.
    const notReported = f.ciHold.state === null;
    const label = notReported
      ? "Approve held: CI required, not reported"
      : "Approve held: CI not passed";
    return {
      ...base,
      kind: "held_ci",
      approvable: false,
      to_status: null,
      label,
      confirm_label: label,
      done_label: "Approve held",
      sentence: notReported
        ? `CI required: not reported${at}. The server refuses approval until a passing result is recorded for this commit.`
        : `Required CI has not passed${at} (${f.ciHold.state}). The server refuses approval until a passing result is recorded for this commit.`,
      via: null,
      lands_repo: null,
      also_lands_repos: [],
      not_landed_repos: [],
    };
  }
  const missing = f.unavailableRepos ?? [];
  if (missing.length > 0) {
    const names = missing.map((m) => m.repo);
    const label = `Approve held: ${andList(names)} unavailable`;
    return {
      ...base,
      kind: "held_repo_unavailable",
      approvable: false,
      to_status: null,
      label,
      confirm_label: label,
      done_label: "Approve held",
      sentence:
        `${missing.map((m) => `${m.repo}: ${m.why}`).join("; ")}. An approval covers every repository this ticket writes to ` +
        `(one approved commit each, and the ticket is done only when every one has landed), so the server refuses it until ` +
        `${names.length === 1 ? "that repository's" : "each repository's"} delivery head can be read. ` +
        (missing.every((m) => m.fix)
          ? `To approve: ${missing.map((m) => m.fix).join("; ")}; then review again.`
          : "Restore the checkout or the delivery branch and review again, or make the repository read-only on the ticket."),
      via: null,
      lands_repo: null,
      also_lands_repos: [],
      not_landed_repos: [],
    };
  }
  if (!agent && f.untested) {
    const u = f.untested;
    const head = u.head ? ` ${u.head.slice(0, 12)}` : "";
    const label = "Approve held: not tested on this commit";
    return {
      ...base,
      kind: "held_untested",
      approvable: false,
      to_status: null,
      label,
      confirm_label: label,
      done_label: "Approve held",
      sentence:
        (u.why === "other_commit"
          ? `Not tested on this commit: the independent tester passed ${u.tested ? u.tested.slice(0, 12) : "another commit"}, and the branch is now at${head}.`
          : u.why === "failed"
            ? "Not tested on this commit: the independent tester's latest verdict is a FAIL."
            : u.why === "contract_changed"
              ? "Not tested on this contract: the ticket's title, description, criteria or test contract changed after the tester passed it."
              : `Not tested on this commit yet: the independent tester has not passed${head || " it"}.`) +
        " The server refuses approval of a commit the tester did not pass; the runner sends it to the tester, and it comes back here after a PASS.",
      via: null,
      lands_repo: null,
      also_lands_repos: [],
      not_landed_repos: [],
    };
  }
  if (agent && hold) {
    return {
      ...base,
      kind: "held_test_modified",
      approvable: false,
      to_status: null,
      label: TEST_HOLD_LABEL,
      confirm_label: TEST_HOLD_LABEL,
      done_label: "Approve held",
      sentence: hold.sentence,
      via: null,
      lands_repo: null,
      also_lands_repos: [],
      not_landed_repos: [],
    };
  }
  const tests = (agent ? "" : testChangesClause(hold)) + (agent ? "" : testedClause(f));
  if (f.toTester) {
    const why = f.acceptance
      ? "An epic's acceptance ticket always goes to the independent tester."
      : "The independent tester gates this ticket and has not passed this commit.";
    return {
      ...base,
      kind: "to_tester",
      approvable: true,
      to_status: "in_testing",
      label: "Approve and send to tester",
      confirm_label: "Confirm: send to tester",
      done_label: "Sent to tester",
      sentence: `It moves to In testing, not to merge. ${why} A PASS takes it to Ready for merge, where ${afterPass(f)}.${bothClause(f)}${tests}`,
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
      sentence: `Auto-merge on approval is on: the merge runner starts now, runs the landing check and the merge gate, then ${landingClause(f)}.${partialClause(f)}${bothClause(f)}${tests}`,
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
      sentence: `It moves to Ready for merge. ${why}, so the runner's merge lane lands it at the start of its next tick (while the runner is running): ${landingClause(f)}.${pauseClause(f)}${partialClause(f)}${bothClause(f)}${tests}`,
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
    label: "Approve, merge is a separate click",
    confirm_label: "Confirm approval",
    done_label: "Waits for Merge now",
    sentence: `It waits in Ready for merge: ${why}, so it lands only when someone presses Merge now.${bothClause(f)}${tests}`,
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
  const free = { ...facts, ciHold: null, unavailableRepos: [], untested: null };
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

/**
 * Approval and reviewer identity (security invariant 1: approveReview is human-only by
 * default): the approve path with its agent-approve policy, observed-risk ceiling,
 * reviewer-not-author and self-approval refusals, and the refusal while a write repo's
 * delivery head cannot be read.
 */
import { inTransaction } from "../../db/connection.js";
import { type Actor, type Ticket } from "../../domain/types.js";
import { type ObservedRisk, shouldEscalate } from "../observedRisk.js";
import { envFlagOn } from "../autonomyPolicyService.js";
import { writeEvent } from "../../events/eventWriter.js";
import type { TransitionResult } from "../transitionService.js";
import { DispatchError } from "../../util/errors.js";
import type { ReviewGateInternals } from "./internals.js";
import { reviewerPatch } from "./shared.js";
import { notTestedMessage, runnerLaneSafe } from "./tester.js";
import type {
  ReviewGateService,
  ApproveReviewOptions,
  UnavailableWriteRepo,
} from "../reviewGateService.js";
import { assertCiPassed, approveCiCandidate } from "./ci.js";
import {
  computeApprovedUnchanged,
  resolveReviewedHeads,
  checkShownCommits,
  recordApprovalPins,
} from "./staleness.js";

/** What these functions read from the {@link ReviewGateService} facade they are handed. */
export type ApprovalHost = Pick<
  ReviewGateService,
  "ciStatus" | "laneApplies" | "testerCoverage" | "unavailableWriteRepos"
>;
/** The facade's private state these functions read. */
export type ApprovalInternals = Pick<
  ReviewGateInternals,
  | "agents"
  | "approvalShaResolver"
  | "clock"
  | "db"
  | "evidence"
  | "observedRiskResolver"
  | "policyAllowsAgentApprove"
  | "requireRegisteredAgentApprover"
  | "reviewedHeadsResolver"
  | "runnerTesterLaneFn"
  | "ticketSvc"
  | "transitions"
  | "unavailableWriteReposResolver"
>;

/**
 * What the human can do about an unavailable write repo (the refusal and the Review
 * button say it): attach the checkout / restore the branch, or — when this ticket should
 * not change that repository — take its write access away (a read-only repo never blocks).
 */
export function unavailableRepoRemedy(
  m: UnavailableWriteRepo,
  ticketNumber: number | null,
): string {
  const n = ticketNumber ?? "<ticket>";
  const readOnly = `or, if this ticket should not change ${m.repo}, make it read-only on the ticket (\`runner/gaffer wg ticket repo-access set ${n} ${m.repo} --access read\`)`;
  switch (m.kind) {
    case "no_checkout":
      return `attach ${m.repo}'s checkout on this machine (register the repository with its local path, \`runner/gaffer wg repo add -n ${m.repo} --path <dir>\`), ${readOnly}`;
    case "unreadable_checkout":
      return `restore ${m.repo}'s checkout at its registered path (or register the path it lives at now), ${readOnly}`;
    case "no_branch":
    case "branch_missing":
      return `restore ${m.repo}'s delivery branch (or deliver to it again), ${readOnly}`;
    default:
      return `make ${m.repo}'s delivery head readable again, ${readOnly}`;
  }
}

/**
 * Human review approval: `in_review -> ready_for_merge` (NOT `done`). The human
 * has approved the diff; the merge runner now does the git merge.
 *
 * SECURITY: By DEFAULT only a human/admin may approve — an `agent`-type actor
 * can never approve its own work. Operator opt-in via `DISPATCH_ALLOW_AGENT_APPROVE=1`
 * removes this gate (their machine, their call).
 */
export function approveReview(
  host: ApprovalHost,
  internals: ApprovalInternals,
  ticketRef: string,
  actor: Actor,
  opts: ApproveReviewOptions = {},
): TransitionResult {
  // P0 authz — do NOT weaken or remove this check. An agent may approve ONLY when
  // the operator opted in via DISPATCH_ALLOW_AGENT_APPROVE=1 (the pre-Phase-3 flag,
  // FIRST and unchanged) OR — Graduated Autonomy (Spec 2, Phase 3) — an EXPLICIT
  // mode='auto' approve policy covers this ticket's risk × every write repo. The
  // policy is only ever an ADDITIONAL allow-path: with no policy row this reduces to
  // exactly the pure env-flag gate (byte-identical to today). system is never permitted.
  const agentApproveAllowed =
    actor.type === "agent" &&
    (envFlagOn(process.env.DISPATCH_ALLOW_AGENT_APPROVE) ||
      policyGrantsAgentApprove(internals, ticketRef));
  if (actor.type !== "human" && actor.type !== "admin" && !agentApproveAllowed) {
    throw new DispatchError(
      "ACTOR_NOT_PERMITTED",
      "Only a human or admin may approve a review (set DISPATCH_ALLOW_AGENT_APPROVE=1 to allow autonomous agent approval).",
      { actor_type: actor.type },
    );
  }
  // OBSERVED-RISK ESCALATION (Trust & Autonomy, security-critical): this runs ONLY on
  // the AUTO-SHIP path — an agent whose approve+merge was permitted WITHOUT a human
  // because an autonomy flag (DISPATCH_ALLOW_AGENT_APPROVE) or a mode='auto' approve
  // policy is on (`agentApproveAllowed === true`). Human/admin never reach here (their
  // approve is byte-identical to today), and an agent already denied by the P0 throw
  // above never reaches here either. When the ticket's OBSERVED risk (from the real
  // diff) exceeds its DECLARED `risk_level` (or a configured ceiling), we HOLD for a
  // human: throw before any transition runs, so the ticket stays `in_review` — the
  // identical mechanism as the P0 deny above. This can ONLY convert an auto-ship into a
  // human-hold; it never grants an approval and never weakens the manual gate.
  // APPROVAL COVERS EVERY WRITE REPO (external review #7), for every actor: an approval
  // pins one head per write repo, so while a write repo's head cannot be read the
  // approval is refused (repo_unavailable, naming it) — never approved as a subset. The
  // read runs git, so it is taken here, outside the write lock. An agent's auto-ship
  // gate reads the diff, which an unavailable repo cannot show, so for an agent the
  // refusal comes first; a human's approval keeps its policy refusals (unresolved ACs,
  // no delivery diff) and the coverage refusal is the last gate before the pins.
  const covered = internals.ticketSvc.resolveTicket(ticketRef);
  const unavailable = host.unavailableWriteRepos(covered);
  if (agentApproveAllowed) {
    assertWriteReposAvailable(covered, unavailable);
    enforceObservedRiskCeiling(internals, ticketRef, actor);
  }
  const ticket = internals.ticketSvc.resolveTicket(ticketRef);
  // REQUIRED CI (server-side, like the other holds): when the runner has recorded CI
  // results for this ticket (GAFFER_REQUIRE_CI), approval needs a PASS for the
  // CANDIDATE commit — the head being approved. A CLI approve used to go through while
  // the CI poll was still open, and the late red result could no longer stop it.
  assertCiPassed(host, ticket, approveCiCandidate(host, internals, ticket));
  // REVIEWER ≠ AUTHOR (server-side, not by convention). Even on an autonomy-permitted
  // agent approve, the approving principal must not be the agent that DELIVERED the
  // ticket: the id on the ticket's most recent claim. Before this the "agent cannot
  // approve its own work" guarantee rested on the runner's bash hook denying the CLI;
  // any process that could open the DB (or a runner passing its own agent id as the
  // reviewer) could self-approve. The runner's reviewer pass now presents a distinct
  // reviewer principal (`<agent>/reviewer`), so the autonomous path is unaffected.
  if (actor.type === "agent") {
    // The approving agent must be a REGISTERED principal (production entry points): a
    // bare string like "<agent>/reviewer" trivially differs from the author id and
    // would otherwise pass the not-author rule below on string inequality alone.
    if (
      internals.requireRegisteredAgentApprover &&
      (actor.id === undefined || !internals.agents || !internals.agents.findById(actor.id))
    ) {
      throw new DispatchError(
        "ACTOR_NOT_PERMITTED",
        "An agent may approve only as a REGISTERED agent principal: the approving actor id is not a registered agent (register a distinct reviewer agent and approve as its id, or approve as a human).",
        { actor_type: actor.type, actor_id: actor.id ?? null },
      );
    }
  }
  // REVIEWER ≠ AUTHOR by id, whatever the actor type (exploratory finding api/F8): a
  // human or admin principal whose actor_id is the delivering agent's id is that agent
  // speaking under another type, and its approval would read as the agent approving
  // its own work.
  const author = deliveringAgentId(internals, ticket.id);
  if (
    author !== null &&
    actor.id !== undefined &&
    actor.id.trim().toLowerCase() === author.toLowerCase()
  ) {
    throw new DispatchError(
      "ACTOR_NOT_PERMITTED",
      actor.type === "agent"
        ? "An agent may not approve its own delivery: the approving actor id matches the agent that claimed and delivered this ticket. Approve as a distinct reviewer principal (or a human)."
        : `The approving ${actor.type} id '${actor.id}' is the id of the agent that claimed and delivered this ticket; nobody may approve a delivery under its author's id. Approve under your own identity.`,
      { actor_type: actor.type, actor_id: actor.id, delivering_agent_id: author },
    );
  }
  // GRADUATED-AUTONOMY (Spec 2, Phase 1): capture whether this delivery is being
  // approved UNCHANGED vs edited, emitted on the transition below. Best-effort — a
  // resolver throw or absence yields `null` (unknown) and never blocks the approve.
  const approvedUnchanged = computeApprovedUnchanged(internals, ticket);
  // REVIEW PIN + STALE REVISION (external review #2). The heads are resolved before the
  // transition (git runs outside the write lock). When the approver names the commits
  // they saw, every write repo's head must still BE that commit — a branch that moved
  // between the render and the click is refused (409 stale_revision), never approved.
  // The pins recorded below are the commits the approver saw, one per repo, written in
  // the SAME transaction as the transition. Without named commits (library callers) a
  // HUMAN approval pins the current heads, as before; an agent approval without commits
  // is pinned by the runner (lib/review.sh) only.
  const heads = resolveReviewedHeads(internals, ticket);
  const pins = checkShownCommits(ticket, heads, actor, opts, unavailable);
  // TESTER FIRST: when the independent tester gates this ticket (an epic's acceptance
  // ticket always; a testable one while its lane is on), it tests the candidate BEFORE
  // a person reviews it (the runner routes in_review -> in_testing, see routeToTester,
  // and a PASS returns it to in_review). A person approves only the commit the tester
  // passed: an approval of any other commit (none tested yet, a push after the PASS, a
  // contract edited since) is REFUSED here (STATE_CONFLICT, reason not_tested), and the
  // runner sends that commit to the tester. An agent's approval (the runner's earned
  // autonomy; no person in the loop) of an untested commit routes it to the tester, as
  // the lane always has: its PASS then goes straight to ready_for_merge. A covered
  // commit goes to ready_for_merge below: there is no second testing pass.
  const coverage = host.laneApplies(ticket) ? host.testerCoverage(ticket, heads) : null;
  if (coverage && !coverage.covered && (actor.type === "human" || actor.type === "admin")) {
    const runner = runnerLaneSafe(internals, ticket);
    const split = runner && !runner.gates ? runner : null;
    throw new DispatchError("STATE_CONFLICT", notTestedMessage(ticket, coverage, split), {
      reason: "not_tested",
      why: coverage.why,
      tested: coverage.tested,
      head: coverage.head,
      ...(split ? { runner_tester_lane: split.mode, runner_lane_at: split.at } : {}),
    });
  }
  if (coverage && !coverage.covered) {
    return inTransaction(internals.db, () => {
      const result = internals.transitions.transition({
        ticketId: ticket.id,
        actor,
        toStatus: "in_testing",
        reason: "review_approved_to_testing",
        expectedFromStatus: "in_review",
        testerVerdict: true,
        approvedUnchanged,
        ...reviewerPatch(ticket, actor),
      });
      assertWriteReposAvailable(ticket, unavailable); // rolls the transition back
      writeEvent(internals.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ticket.routed_to_testing",
        payload: { from: "in_review", ...(ticket.acceptance === 1 ? { acceptance: true } : {}) },
      });
      recordApprovalPins(internals, ticket, actor, pins);
      return result;
    });
  }
  // The done gate's git runs HERE, before transition() takes the write lock.
  const deliveryDiff = internals.transitions.deliveryDiffProof(ticket.id);
  return inTransaction(internals.db, () => {
    const result = internals.transitions.transition({
      ticketId: ticket.id,
      actor,
      toStatus: "ready_for_merge",
      reason: "review_approved",
      expectedFromStatus: "in_review",
      approvedUnchanged,
      reviewApprove: true, // reached the merge-ready state through the guarded approve path
      deliveryDiff,
      ...reviewerPatch(ticket, actor),
    });
    assertWriteReposAvailable(ticket, unavailable); // rolls the transition back
    recordApprovalPins(internals, ticket, actor, pins);
    return result;
  });
}

/**
 * APPROVAL COVERS EVERY WRITE REPO: the write repos whose delivery head cannot be read
 * now (the same read the Review button's outcome names). A resolver throw is read as
 * "unknown", and an unknown cannot be approved either: it fails toward the human.
 */
export function unavailableWriteRepos(
  internals: Pick<ApprovalInternals, "unavailableWriteReposResolver">,
  ticket: Ticket,
): readonly UnavailableWriteRepo[] {
  if (!internals.unavailableWriteReposResolver) return [];
  try {
    return internals.unavailableWriteReposResolver(ticket);
  } catch (e) {
    return [
      {
        repoId: "",
        repo: "(unknown)",
        why: `the ticket's write repositories could not be read (${e instanceof Error ? e.message : String(e)})`,
      },
    ];
  }
}

/** Refuse an approval that would leave a write repo without a pin (repo_unavailable). */
export function assertWriteReposAvailable(
  ticket: Ticket,
  missing: readonly UnavailableWriteRepo[],
): void {
  if (missing.length === 0) return;
  const names = missing.map((m) => m.repo);
  throw new DispatchError(
    "STATE_CONFLICT",
    `Approve held: ${names.join(", ")} ${names.length === 1 ? "is" : "are"} unavailable — ` +
      missing.map((m) => `${m.repo}: ${m.why}`).join("; ") +
      ". An approval covers every repository this ticket writes to, and nothing was approved. To approve: " +
      missing.map((m) => unavailableRepoRemedy(m, ticket.number)).join("; ") +
      "; then review again.",
    {
      reason: "repo_unavailable",
      ticket_number: ticket.number,
      repos: missing.map((m) => ({
        repo: m.repo,
        repo_id: m.repoId,
        why: m.why,
        remedy: unavailableRepoRemedy(m, ticket.number),
      })),
    },
  );
}

/**
 * The agent id on the ticket's MOST RECENT claim (active or released) — the principal
 * that delivered the work now under review. `null` when the ticket was never claimed
 * (e.g. a human-driven delivery), in which case the reviewer≠author rule is inert.
 */
export function deliveringAgentId(
  internals: Pick<ApprovalInternals, "db">,
  ticketId: string,
): string | null {
  const row = internals.db
    .prepare(
      "SELECT agent_id FROM ticket_claims WHERE ticket_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
    )
    .get(ticketId) as { agent_id: string } | undefined;
  return row?.agent_id ?? null;
}

/**
 * GRADUATED-AUTONOMY (Spec 2, Phase 3): does an explicit mode='auto' approve policy
 * cover this ticket (its risk × ALL its write repos)? Pure policy check — NO env
 * read (the P0 gate ORs this with the env flag). FAIL-CLOSED: an absent predicate,
 * an unresolvable ticket, or ANY throw yields false, so a policy-probe failure can
 * never grant an approval it shouldn't.
 */
export function policyGrantsAgentApprove(
  internals: Pick<ApprovalInternals, "policyAllowsAgentApprove" | "ticketSvc">,
  ticketRef: string,
): boolean {
  if (!internals.policyAllowsAgentApprove) return false;
  try {
    const ticket = internals.ticketSvc.resolveTicket(ticketRef);
    return internals.policyAllowsAgentApprove(ticket);
  } catch {
    return false;
  }
}

/**
 * OBSERVED-RISK ESCALATION (Trust & Autonomy, security-critical). Called ONLY on the
 * AUTO-SHIP path (see approveReview). Compares the OBSERVED risk derived from the real
 * server-computed diff against the ticket's DECLARED `risk_level`. When observed exceeds
 * declared (or crosses a configured ceiling), or the diff cannot be observed
 * (indeterminate ⇒ fail toward human), it records an `autoship_escalated` event and
 * throws `OBSERVED_RISK_ESCALATED` — held BEFORE any transition, so the ticket stays
 * `in_review` for a human, exactly like the P0 deny above.
 *
 * FAIL-SAFE by construction:
 *  - No resolver wired ⇒ returns immediately (inert; autonomy-off parity unaffected).
 *  - Resolver throws ⇒ treated as indeterminate ⇒ HOLD (never silently auto-ships).
 *  - Observed ≤ declared and no ceiling ⇒ returns; the ticket auto-ships exactly as
 *    before (no false-escalation of a genuinely-low-risk change).
 * It can only ever THROW (deny) — it never calls `transition`, so it can never turn a
 * hold into a ship, never newly-allow, and never weakens the manual human gate.
 */
export function enforceObservedRiskCeiling(
  internals: Pick<ApprovalInternals, "db" | "observedRiskResolver" | "ticketSvc">,
  ticketRef: string,
  actor: Actor,
): void {
  if (!internals.observedRiskResolver) return;
  const ticket = internals.ticketSvc.resolveTicket(ticketRef);
  let observed: ObservedRisk | null;
  try {
    observed = internals.observedRiskResolver(ticket);
  } catch {
    observed = null; // a probe failure must fail toward a human, never silently ship.
  }
  // A missing observation is indeterminate ⇒ escalate (hold for a human).
  const escalate = !observed || shouldEscalate(observed, ticket.risk_level);
  if (!escalate) return;
  const observedLevel = observed?.level ?? "unknown";
  const reasons = observed?.reasons.length ? observed.reasons : ["diff unavailable to observe"];
  // Record the reason on the EXISTING append-only event log (no new mutation surface).
  writeEvent(internals.db, {
    entity_type: "ticket",
    entity_id: ticket.id,
    actor,
    event_type: "ticket.autoship_escalated",
    payload: {
      declared: ticket.risk_level,
      observed: observedLevel,
      determinate: observed?.determinate ?? false,
      reasons,
      files: observed?.files ?? null,
      lines: observed?.lines ?? null,
      ...(observed?.holds?.length ? { holds: observed.holds } : {}),
    },
  });
  // GATE INTEGRITY: a hard hold (the delivery weakened its own tests) is named as such —
  // the declared level does not matter for it, so "exceeds declared" would mislead.
  const message = observed?.holds?.length
    ? `Auto-approve held for human review: the delivery modified the tests that gate it (${observed.holds.join("; ")}). A human can approve, or allow test changes on the ticket.`
    : `Auto-approve held for human review: observed risk '${observedLevel}' exceeds declared '${ticket.risk_level}'.`;
  throw new DispatchError("OBSERVED_RISK_ESCALATED", message, {
    declared: ticket.risk_level,
    observed: observedLevel,
    reasons,
    ...(observed?.holds?.length ? { holds: observed.holds } : {}),
  });
}

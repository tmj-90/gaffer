/**
 * Tester verdicts (security invariants 2 and 4): the tester's PASS and FAIL with the
 * binding they carry (tested commit, contract hash, clean replay), the acceptance evidence a
 * PASS needs, and a trusted acceptance-criterion check.
 */
import { inTransaction } from "../../db/connection.js";
import {
  type AcStatus,
  type Actor,
  type ReviewFeedback,
  type Ticket,
  type TicketStatus,
  parseTestContract,
} from "../../domain/types.js";
import { writeEvent } from "../../events/eventWriter.js";
import type { TransitionResult } from "../transitionService.js";
import { recordAcCheckInput } from "../../domain/schemas.js";
import { AC_CHECK_VERIFIER } from "../../policy/policy.js";
import { DispatchError, notFound } from "../../util/errors.js";
import { newId } from "../../util/id.js";
import { recordedLandingRepos } from "../landingStatus.js";
import { testerProvenance } from "../../util/testingLane.js";
import {
  parseTesterAgent,
  parseTesterIdentities,
  type TesterTestIdentity,
} from "../testerReplay.js";
import {
  ACCEPTANCE_EVIDENCE_PREFIX,
  contractProfile,
  EXECUTABLE_PROFILES,
  type AcceptanceProfile,
} from "../../domain/acceptanceProfile.js";
import {
  contractHash,
  REPLAY_STATES,
  type ReplayState,
  type VerdictBinding,
} from "../../util/contractHash.js";
import type { ReviewGateInternals } from "./internals.js";
import { capRetry } from "./shared.js";
import type { ReviewGateService } from "../reviewGateService.js";
import { enteredTestingBeforeReview } from "./tester.js";
import { ciCandidateHead, assertCiPassed } from "./ci.js";
import { partlyLandedHold } from "./landing.js";

/** What these functions read from the {@link ReviewGateService} facade they are handed. */
export type TesterVerdictHost = Pick<ReviewGateService, "ciStatus">;
/** The facade's private state these functions read. */
export type TesterVerdictInternals = Pick<
  ReviewGateInternals,
  | "acs"
  | "clock"
  | "db"
  | "evidence"
  | "maxAttempts"
  | "reviewedHeadsResolver"
  | "ticketSvc"
  | "tickets"
  | "transitions"
>;

/**
 * ACCEPTANCE GATE: validate the structured binding a tester verdict carries — the exact
 * commit the tester ran against, the hash of the contract it tested (see
 * util/contractHash) and the runner's clean-replay outcome. A binding that is PRESENT but
 * malformed is refused (never silently dropped: a verdict must not look bound when it is
 * not). For an epic's ACCEPTANCE ticket, a non-human PASS must carry all three, the hash
 * must be the contract on record, and the replay must have passed — anything less could be
 * reported as a verified build. A human verdict is a waiver: allowed without a binding and
 * reported as `waived`, never as verified.
 */
export function validatedBinding(
  input: { tested_commit?: string; contract_hash?: string; replay?: string; tests_commit?: string },
  opts: {
    strict: boolean;
    currentHash: string | null;
    verdict: "pass" | "fail";
    /** A human (or admin) verdict: a waiver, never refused for a missing replay. */
    human?: boolean;
  },
): VerdictBinding {
  const out: VerdictBinding = {};
  if (input.tested_commit !== undefined) {
    const sha = input.tested_commit.trim();
    if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(sha)) {
      throw new DispatchError(
        "VALIDATION_ERROR",
        "tested_commit must be a full git commit id (40 or 64 hex characters).",
      );
    }
    out.tested_commit = sha.toLowerCase();
  }
  if (input.contract_hash !== undefined) {
    const h = input.contract_hash.trim();
    if (!/^[0-9a-f]{64}$/i.test(h)) {
      throw new DispatchError("VALIDATION_ERROR", "contract_hash must be a sha256 hex digest.");
    }
    out.contract_hash = h.toLowerCase();
  }
  if (input.replay !== undefined) {
    if (!(REPLAY_STATES as readonly string[]).includes(input.replay)) {
      throw new DispatchError(
        "VALIDATION_ERROR",
        `replay must be one of ${REPLAY_STATES.join(", ")}.`,
      );
    }
    out.replay = input.replay as ReplayState;
  }
  if (input.tests_commit !== undefined) {
    const t = input.tests_commit.trim().toLowerCase();
    if (t !== "none" && !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(t)) {
      throw new DispatchError(
        "VALIDATION_ERROR",
        'tests_commit must be a full git commit id (40 or 64 hex characters) or "none".',
      );
    }
    out.tests_commit = t;
  }
  if (out.contract_hash && opts.currentHash && out.contract_hash !== opts.currentHash) {
    throw new DispatchError(
      "CONTRACT_MISMATCH",
      "The verdict was recorded against a different contract than the one on record (the ticket's title, description, criteria or test contract changed since the tester started). Re-test.",
      { recorded: out.contract_hash, current: opts.currentHash },
    );
  }
  if (opts.strict && opts.verdict === "pass") {
    const missing = [
      ...(out.tested_commit ? [] : ["tested_commit"]),
      ...(out.contract_hash ? [] : ["contract_hash"]),
      ...(out.replay === "passed" ? [] : ["replay=passed"]),
    ];
    if (missing.length > 0) {
      throw new DispatchError(
        "BINDING_REQUIRED",
        `An automated PASS on an acceptance ticket must be bound to what was tested; missing: ${missing.join(", ")}. A human can waive instead (tester-pass --as human), which is reported as waived, not verified.`,
        { missing },
      );
    }
  }
  // FALSE GREEN, on every ticket (not only an acceptance ticket): a non-human PASS is
  // recorded only when it carries the runner's clean replay as PASSED. A replay that was
  // skipped (no registered test command, the replay switched off) or failed proves
  // nothing about the candidate, and neither does a PASS with no replay at all (the
  // `wg ticket tester-pass` default is `--as agent`, so an unbound PASS typed by hand used
  // to record as an automated tester PASS). The runner's tester always sends the replay.
  // A human PASS is a waiver and is never refused here.
  if (opts.verdict === "pass" && !opts.human && out.replay !== "passed") {
    const state = out.replay ?? "absent";
    throw new DispatchError(
      "BINDING_REQUIRED",
      out.replay
        ? `An automated PASS whose clean replay is '${out.replay}' is not a verified PASS: the runner did not show the candidate passes the tester's tests (register the repo's test command and re-test). A human can record the verdict instead (tester-pass --as human), which is reported as a waiver.`
        : "An automated PASS must carry the runner's clean replay (replay=passed): without it nothing shows the candidate passes the tester's tests. A human can record the verdict instead (tester-pass --as human), which is reported as a waiver.",
      { missing: ["replay=passed"], replay: state },
    );
  }
  return out;
}

/**
 * The independent black-box tester PASSED. TESTER FIRST: a ticket the runner sent to
 * the tester before review (routeToTester) returns to `in_review` for a person, with
 * the commit it tested recorded on the `ticket.tester_passed` event (`tested_head`);
 * a ticket an approval sent (an agent's approval, or a person's before tester-first)
 * goes on to `ready_for_merge` as before. testerVerdict:true guards both transitions.
 */
export function testerPass(
  host: TesterVerdictHost,
  internals: TesterVerdictInternals,
  ticketRef: string,
  input: {
    summary: string;
    uri?: string;
    tested_commit?: string;
    contract_hash?: string;
    replay?: string;
    tests_commit?: string;
    /** The runner's acceptance evidence row for a profiled ticket (cli, api, ...). */
    acceptance_evidence?: string;
    /** TEST IDENTITIES the runner's clean replay saw pass (system only, see testerReplay.ts). */
    tests?: unknown;
    /** The tester agent (and run) whose verdict the runner records (system only). */
    tester_agent?: unknown;
  },
  actor: Actor,
): TransitionResult {
  const summary = input.summary.trim();
  if (summary.length === 0) {
    throw new DispatchError("VALIDATION_ERROR", "A test-result summary is required.");
  }
  // TEST IDENTITIES (external review 10): the tests the landing replay must see pass. Only
  // the runner's tester lane measures them (its own clean replay), so only the system
  // actor records them: an agent, a person or an admin naming a narrower list would
  // choose what the landing requires.
  let tests: TesterTestIdentity[] | undefined;
  if (input.tests !== undefined) {
    if (actor.type !== "system") {
      throw new DispatchError(
        "ACTOR_NOT_PERMITTED",
        "Only the runner (the system actor) may record the test identities a tester PASS binds.",
        { actor_type: actor.type },
      );
    }
    const parsed = parseTesterIdentities(input.tests);
    if (parsed === null) {
      throw new DispatchError(
        "VALIDATION_ERROR",
        "tests must be a JSON array of at most 5000 { file, name, line?, column? } test identities.",
      );
    }
    if (parsed.length > 0 && !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(input.tests_commit ?? "")) {
      throw new DispatchError(
        "VALIDATION_ERROR",
        "test identities need the commit holding the tester's tests (tests_commit).",
      );
    }
    tests = parsed;
  }
  // WHO TESTED: a PASS the runner records as the system names the tester agent whose run
  // produced the verdict, so the record never reads as the system's own judgement. The
  // runner's measurement, so the system actor only, like the identities.
  let testerAgent: { id: string; run?: string } | undefined;
  if (input.tester_agent !== undefined) {
    if (actor.type !== "system") {
      throw new DispatchError(
        "ACTOR_NOT_PERMITTED",
        "Only the runner (the system actor) may record which tester agent's run a PASS comes from.",
        { actor_type: actor.type },
      );
    }
    const parsed = parseTesterAgent(input.tester_agent);
    if (parsed === null) {
      throw new DispatchError(
        "VALIDATION_ERROR",
        "tester_agent must be { id, run? } with a plain agent id and run id.",
      );
    }
    testerAgent = parsed;
  }
  // The done gate needs real git; run it BEFORE the outer write transaction (a
  // nested transition() is only a savepoint inside it, so "before transition()" is
  // not enough). The gate re-checks the proof's fingerprint inside the transaction.
  const pre = internals.ticketSvc.resolveTicket(ticketRef);
  const toReview = pre.status === "in_testing" && enteredTestingBeforeReview(internals, pre.id);
  const target: TicketStatus = toReview ? "in_review" : "ready_for_merge";
  const deliveryDiff =
    pre.status === "in_testing" && !toReview
      ? internals.transitions.deliveryDiffProof(pre.id)
      : undefined;
  // REQUIRED CI's candidate: the tested commit, else the branch head — resolved (git)
  // here, outside the write transaction, and only when CI results exist at all. A PASS
  // that returns the ticket to review approves nothing: approval reads CI itself.
  const ciCandidate = toReview
    ? null
    : (input.tested_commit ??
      (host.ciStatus(pre.id, null).required
        ? (ciCandidateHead(internals, pre)?.sha ?? null)
        : null));
  // The commit this PASS is about, for the approval's same-commit check: the tested
  // commit the runner's tester names, else (a person's waiver) the head now.
  const headNow = toReview ? (ciCandidateHead(internals, pre)?.sha ?? null) : null;
  return inTransaction(internals.db, () => {
    const ticket = internals.ticketSvc.resolveTicket(ticketRef);
    if (ticket.status !== "in_testing") {
      throw new DispatchError(
        "ILLEGAL_TRANSITION",
        "Only a ticket in testing can be passed by the tester.",
        { from: ticket.status, to: target },
      );
    }
    const contractNow = contractHash(internals.db, ticket.id);
    const binding = validatedBinding(input, {
      strict: ticket.acceptance === 1 && testerProvenance(actor) !== "human",
      currentHash: contractNow,
      verdict: "pass",
      human: testerProvenance(actor) === "human",
    });
    // ACCEPTANCE PROFILE: on a ticket whose contract names a profile, an automated PASS
    // also needs the runner's own evidence of the running change (the CLI transcript,
    // the API probes) for the tested commit and the current contract.
    const acceptanceEvidence =
      testerProvenance(actor) === "human"
        ? null
        : assertAcceptanceEvidence(
            internals,
            ticket,
            input.acceptance_evidence,
            binding,
            contractNow,
          );
    // REQUIRED CI: the tester's PASS is the other way into ready_for_merge.
    if (!toReview) assertCiPassed(host, ticket, ciCandidate);
    // Record the passing test result as evidence so it is visible in review.
    const evidenceId = newId();
    const now = internals.clock.now();
    internals.evidence.insert({
      id: evidenceId,
      ticket_id: ticket.id,
      ac_id: null,
      repo_id: null,
      decision_id: null,
      evidence_type: "test_output",
      summary,
      uri: input.uri ?? null,
      // ACCEPTANCE GATE: a verdict is evidence about ONE commit and ONE contract. The
      // runner's tester records both; the merge lane refuses to land a branch whose head
      // is not the tested commit, and stats flag an acceptance whose contract changed.
      payload_json: JSON.stringify({
        verdict: "pass",
        provenance: testerProvenance(actor),
        ...binding,
        ...(acceptanceEvidence ? { acceptance: acceptanceEvidence } : {}),
        ...(tests !== undefined ? { tests } : {}),
        ...(testerAgent !== undefined ? { tester_agent: testerAgent } : {}),
      }),
      created_by: actor.id ?? actor.type,
      recorded_by_actor_type: actor.type,
      created_at: now,
    });
    const result = internals.transitions.transition({
      ticketId: ticket.id,
      actor,
      toStatus: target,
      reason: "tester_passed",
      expectedFromStatus: "in_testing",
      testerVerdict: true,
      ...(deliveryDiff ? { deliveryDiff } : {}),
    });
    const testedHead = binding.tested_commit ?? headNow?.toLowerCase() ?? null;
    writeEvent(internals.db, {
      entity_type: "ticket",
      entity_id: ticket.id,
      actor,
      event_type: "ticket.tester_passed",
      payload: {
        evidence_id: evidenceId,
        ...(toReview ? { to: "in_review", before_review: true } : {}),
        ...(testedHead ? { tested_head: testedHead } : {}),
        // The contract a PASS before review was about, when its binding names none (a
        // person's waiver): a contract edited after it then needs the tester again.
        ...(toReview && !binding.contract_hash && contractNow
          ? { contract_hash: contractNow }
          : {}),
      },
    });
    return result;
  });
}

/**
 * The independent black-box tester FAILED (`in_testing -> refining`).
 * Reuses the reject machinery: AC reset, attempt bump, retry-cap park.
 */
export function testerFail(
  internals: TesterVerdictInternals,
  ticketRef: string,
  input: {
    summary: string;
    uri?: string;
    to?: "refining" | "ready";
    tested_commit?: string;
    contract_hash?: string;
    replay?: string;
    tests_commit?: string;
  },
  actor: Actor,
): TransitionResult {
  const summary = input.summary.trim();
  if (summary.length === 0) {
    throw new DispatchError("VALIDATION_ERROR", "A failing-test summary is required.");
  }
  // Where a FAIL lands (below the retry cap): `refining` holds the ticket for a human
  // (the default, unchanged); `ready` re-queues it for REWORK with the failing
  // observation as feedback — the autonomous runner's choice, mirroring
  // `review reject --to ready`, so a tester FAIL is a bounded retry, not a stall.
  const failTo: TicketStatus = input.to === "ready" ? "ready" : "refining";
  return inTransaction(internals.db, () => {
    const ticket = internals.ticketSvc.resolveTicket(ticketRef);
    if (ticket.status !== "in_testing") {
      throw new DispatchError(
        "ILLEGAL_TRANSITION",
        "Only a ticket in testing can be failed by the tester.",
        { from: ticket.status, to: failTo },
      );
    }
    const binding = validatedBinding(input, {
      strict: false, // a FAIL never certifies anything; a present binding is still validated
      currentHash: contractHash(internals.db, ticket.id),
      verdict: "fail",
    });
    // Record the failing test as evidence BEFORE the AC reset / transition.
    const evidenceId = newId();
    const now = internals.clock.now();
    internals.evidence.insert({
      id: evidenceId,
      ticket_id: ticket.id,
      ac_id: null,
      repo_id: null,
      decision_id: null,
      evidence_type: "test_output",
      summary,
      uri: input.uri ?? null,
      payload_json: JSON.stringify({
        verdict: "fail",
        provenance: testerProvenance(actor),
        ...binding,
      }),
      created_by: actor.id ?? actor.type,
      recorded_by_actor_type: actor.type,
      created_at: now,
    });

    // PARTLY LANDED: a tester FAIL of a ticket whose change already reached a default
    // branch holds it for a person instead of re-queueing it (as rejectReview does).
    const landedRepos = recordedLandingRepos(internals.db, ticket.id);
    const holdLanded = landedRepos.length > 0;
    const { nextAttempt, capReached } = holdLanded
      ? { nextAttempt: ticket.attempt_count, capReached: false }
      : capRetry(ticket.attempt_count, internals.maxAttempts);
    const target: TicketStatus = capReached || holdLanded ? "blocked" : failTo;
    const reason = `tester_failed:${summary}`;
    const result = internals.transitions.transition({
      ticketId: ticket.id,
      actor,
      toStatus: target,
      reason: holdLanded
        ? `partly_landed:${reason}`
        : capReached
          ? `retry_cap_reached:${reason}`
          : reason,
      expectedFromStatus: "in_testing",
      patch: { attempt_count: nextAttempt },
      ...(capReached || holdLanded ? { park: true } : { testerVerdict: true }),
    });
    if (holdLanded) partlyLandedHold(internals, ticket, landedRepos, failTo, reason, actor);
    if (capReached) {
      writeEvent(internals.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ticket.parked_retry_cap",
        payload: { attempt_count: nextAttempt, max_attempts: internals.maxAttempts, reason },
      });
    }
    internals.ticketSvc.resetAcceptanceCriteria(ticket.id, actor);
    const feedback: ReviewFeedback = {
      reason,
      reviewer: actor.id ?? null,
      at: now,
    };
    internals.tickets.setReviewFeedback(ticket.id, JSON.stringify(feedback));
    writeEvent(internals.db, {
      entity_type: "ticket",
      entity_id: ticket.id,
      actor,
      event_type: "ticket.tester_failed",
      payload: { evidence_id: evidenceId },
    });
    return result;
  });
}

/**
 * MACHINE-CHECKABLE AC — record the RUNNER's execution of an AC's `check_command`.
 *
 * Trusted-actor only: the runner (`system`) or a human/admin. An `agent` actor is
 * refused — this is the verification the done gate TRUSTS precisely because the
 * agent cannot author it (the agent's own `record_ac_evidence` still marks an AC
 * satisfied, but with `verified_by = <agent>`, which the gate does not accept for
 * a checked AC). Exit 0 ⇒ `satisfied`, else `failed`; either way a `test_output`
 * evidence row carries the command, exit code and bounded output tail so the
 * reviewer (and the next rework attempt) sees exactly what ran.
 */
export function recordAcCheck(
  internals: TesterVerdictInternals,
  raw: unknown,
  actor: Actor,
): { status: AcStatus; evidenceId: string; eventId: string } {
  const input = recordAcCheckInput.parse(raw);
  if (actor.type === "agent") {
    throw new DispatchError(
      "ACTOR_NOT_PERMITTED",
      "An agent may not record an acceptance-criterion check result; the runner (system) executes and records checks.",
      { actor_type: actor.type },
    );
  }
  const now = internals.clock.now();
  return inTransaction(internals.db, () => {
    const ticket = internals.tickets.resolveRef(input.ticket_id);
    const ac = internals.acs.findById(input.ac_id);
    if (!ac || ac.ticket_id !== ticket.id) throw notFound("acceptance_criterion", input.ac_id);
    if (!ac.check_command) {
      throw new DispatchError(
        "VALIDATION_ERROR",
        "This acceptance criterion has no check_command; a check result can only be recorded for a machine-checkable AC.",
        { ac_id: ac.id },
      );
    }
    // BYTE-EXACT: a result is evidence about the command that RAN. One that differs
    // from the stored check (a TAB rewritten to a space, a trimmed line) is about a
    // different criterion and is refused, never recorded against this one.
    if (input.command !== ac.check_command) {
      throw new DispatchError(
        "VALIDATION_ERROR",
        "The executed command does not match this criterion's stored check_command byte for byte; the result was not recorded.",
        { ac_id: ac.id },
      );
    }
    const passed = input.exit_code === 0;
    const status: AcStatus = passed ? "satisfied" : "failed";
    internals.acs.setStatus(ac.id, status, AC_CHECK_VERIFIER, now);
    const evidenceId = newId();
    internals.evidence.insert({
      id: evidenceId,
      ticket_id: ticket.id,
      ac_id: ac.id,
      repo_id: null,
      decision_id: null,
      evidence_type: "test_output",
      summary: `AC check ${passed ? "PASSED" : "FAILED"} (exit ${input.exit_code}): ${input.command}`,
      uri: null,
      payload_json: JSON.stringify({
        kind: "ac_check",
        passed,
        exit_code: input.exit_code,
        command: input.command,
        ...(input.output_tail !== undefined ? { output_tail: input.output_tail } : {}),
        ...(input.duration_s !== undefined ? { duration_s: input.duration_s } : {}),
      }),
      created_by: actor.id ?? actor.type,
      recorded_by_actor_type: actor.type,
      created_at: now,
    });
    const eventId = writeEvent(internals.db, {
      entity_type: "ticket",
      entity_id: ticket.id,
      actor,
      event_type: "ac.checked",
      payload: { ac_id: ac.id, passed, exit_code: input.exit_code, evidence_id: evidenceId },
    });
    return { status, evidenceId, eventId };
  });
}

/**
 * ACCEPTANCE PROFILE guard (C1/C2, like BINDING_REQUIRED): an automated PASS on a ticket
 * whose test contract names a profile other than unit must point at a runner-recorded
 * (system) acceptance evidence row on this ticket that passed, for the same profile, the
 * tested commit and the current contract. A profile the runner cannot run yet (web,
 * migration, performance) can never meet this: a person records the verdict. Returns the
 * binding to store with the PASS, or null for a unit ticket.
 */
export function assertAcceptanceEvidence(
  internals: Pick<TesterVerdictInternals, "evidence">,
  ticket: Ticket,
  evidenceId: string | undefined,
  binding: VerdictBinding,
  contractNow: string | null,
): { profile: AcceptanceProfile; evidence_id: string } | null {
  const profile = contractProfile(parseTestContract(ticket.test_contract));
  if (profile === "unit") return null;
  const refuse = (why: string): never => {
    throw new DispatchError(
      "ACCEPTANCE_EVIDENCE_REQUIRED",
      `An automated PASS on a ticket with the ${profile} acceptance profile needs the runner's passed ${profile} evidence for the tested commit: ${why}. A human can record the verdict instead (tester-pass --as human), which is reported as a waiver.`,
      { profile, ...(evidenceId ? { acceptance_evidence: evidenceId } : {}) },
    );
  };
  if (!EXECUTABLE_PROFILES.includes(profile))
    refuse(`the runner cannot run the ${profile} profile yet`);
  if (!evidenceId) refuse("no acceptance evidence was named");
  const row = internals.evidence.listForTicket(ticket.id).find((e) => e.id === evidenceId);
  if (!row) refuse(`evidence ${evidenceId} is not on this ticket`);
  const r = row as NonNullable<typeof row>;
  if (
    r.recorded_by_actor_type !== "system" ||
    !String(r.uri ?? "").startsWith(ACCEPTANCE_EVIDENCE_PREFIX)
  )
    refuse("the named evidence is not the runner's acceptance record");
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(r.payload_json ?? "{}") as Record<string, unknown>;
  } catch {
    refuse("the acceptance record cannot be read");
  }
  if (payload.profile !== profile)
    refuse(`the record is for the ${String(payload.profile)} profile`);
  if (payload.passed !== true) refuse("the runner's acceptance run did not pass");
  // The record must agree with itself: a pass names at least one case, and every case held.
  const cases = Array.isArray(payload.cases) ? (payload.cases as Array<{ held?: unknown }>) : [];
  if (cases.length === 0 || cases.some((c) => !c || c.held !== true))
    refuse("the record's cases do not all hold");
  if (!binding.tested_commit || String(payload.tested_commit) !== binding.tested_commit)
    refuse("the record is for a different commit than the one tested");
  if (contractNow && payload.contract_hash !== contractNow)
    refuse("the record was made against a different contract");
  return { profile, evidence_id: r.id };
}

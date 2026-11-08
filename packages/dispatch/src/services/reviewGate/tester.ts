/**
 * The independent tester lane (security invariant 2): whether the lane gates a ticket,
 * the tester's coverage of the reviewed heads, routing a reviewed ticket to the tester, and
 * the runner's clean-replay record of the tester's tests.
 */
import { inTransaction } from "../../db/connection.js";
import { type Actor, type Ticket } from "../../domain/types.js";
import { writeEvent } from "../../events/eventWriter.js";
import { DispatchError, notFound } from "../../util/errors.js";
import { newId } from "../../util/id.js";
import { computeLandingStatus } from "../landingStatus.js";
import { isTestingEnabled } from "../../util/testingLane.js";
import {
  parseTesterIdentities,
  readBoundTesterPass,
  sameTesterIdentity,
  TESTER_REPLAY_PREFIX,
  type TesterTestIdentity,
} from "../testerReplay.js";
import { contractHash } from "../../util/contractHash.js";
import type { ReviewGateInternals } from "./internals.js";
import type {
  ReviewGateService,
  ReviewedHead,
  TesterCoverage,
  TesterRoute,
} from "../reviewGateService.js";
import { resolveReviewedHeads } from "./staleness.js";

/** What these functions read from the {@link ReviewGateService} facade they are handed. */
export type TesterHost = Pick<
  ReviewGateService,
  | "ciStatus"
  | "laneApplies"
  | "routeToTester"
  | "testerCoverage"
  | "testerRoutePlan"
  | "unavailableWriteRepos"
>;
/** The facade's private state these functions read. */
export type TesterInternals = Pick<
  ReviewGateInternals,
  | "clock"
  | "db"
  | "evidence"
  | "landedOnDefaultResolver"
  | "reviewedHeadsResolver"
  | "runnerTesterLaneFn"
  | "testerLaneAppliesFn"
  | "ticketSvc"
  | "transitions"
>;

/** The refusal a person's approval of a commit the tester did not pass gets. */
export function notTestedMessage(
  ticket: Ticket,
  c: TesterCoverage,
  split: { mode: string; at: string } | null = null,
): string {
  const n = ticket.number !== null ? `#${ticket.number}` : "This ticket";
  const head = c.head ? ` ${c.head.slice(0, 12)}` : "";
  const what =
    c.why === "other_commit"
      ? `the independent tester passed ${c.tested ? c.tested.slice(0, 12) : "another commit"}, but the branch is now at${head}`
      : c.why === "failed"
        ? "the independent tester's latest verdict is a FAIL"
        : c.why === "contract_changed"
          ? "the ticket's contract changed after the tester passed it"
          : `the independent tester has not passed this commit${head} yet`;
  // LANE-SETTING CONSISTENCY: the runner last routed under a lane that does not gate this
  // ticket, so it will not send it to the tester. Say so instead of promising a route.
  if (split) {
    return `${n} is not tested on this commit: ${what}. A person approves only the commit the tester passed, but the runner last routed with GAFFER_TESTING ${split.mode} (recorded ${split.at.slice(0, 16).replace("T", " ")} UTC), which does not send this ticket to the tester, while this dashboard's setting does. Set GAFFER_TESTING the same for the dashboard and the runner (Settings, with neither environment overriding it); the runner then sends it to the tester.`;
  }
  return `${n} is not tested on this commit: ${what}. A person approves only the commit the tester passed; the runner sends this one to the tester, and it returns to review after a PASS.`;
}

/**
 * Does the independent tester gate this ticket at all: an epic's acceptance ticket
 * (always), or a testable one whose lane is on (see util/testingLane.ts)?
 */
export function laneApplies(internals: TesterInternals, ticket: Ticket): boolean {
  if (ticket.acceptance === 1) return true;
  if (ticket.can_be_tested !== 1) return false;
  return internals.testerLaneAppliesFn ? internals.testerLaneAppliesFn(ticket) : isTestingEnabled();
}

/**
 * BBT-001 + ACCEPTANCE GATE: does an approve of this ticket go to the independent
 * tester (in_review -> in_testing) rather than to merge? The ONE predicate approveReview
 * routes on, public so the Review view's "what happens on approve" names the same route.
 */
export function approveRoutesToTesting(host: TesterHost, ticket: Ticket): boolean {
  return host.laneApplies(ticket) && !host.testerCoverage(ticket).covered;
}

/** The runner's differing lane for a ticket (see the dep), or null; never throws. */
export function runnerLaneSafe(
  internals: Pick<TesterInternals, "runnerTesterLaneFn">,
  ticket: Ticket,
): { mode: string; at: string; gates: boolean } | null {
  try {
    return internals.runnerTesterLaneFn?.(ticket) ?? null;
  } catch {
    return null;
  }
}

/**
 * TESTER FIRST: does a tester PASS cover the candidate a person would approve now?
 * Covered when the latest tester verdict since this round began (the latest entry into
 * in_review that was not a tester PASS returning it) is a PASS, the commit it tested is
 * the primary write repo's head now (compared when both are known: the tester runs in
 * the primary repo), and the contract it tested is the one on record (when it recorded
 * one). `heads` reuses a read the caller already made (git).
 */
export function testerCoverage(
  internals: TesterInternals,
  ticket: Ticket,
  heads?: readonly ReviewedHead[],
): TesterCoverage {
  // The tester runs in one write repo (runner/bin/merge-ticket.mjs resolveTicket's pick,
  // the first write link); its tested commit must be that repo's head now, so it is
  // compared with every write repo's head (a commit id names one commit).
  const allHeads = (heads ?? resolveReviewedHeads(internals, ticket))
    .map((h) => h.sha?.toLowerCase())
    .filter((h): h is string => Boolean(h));
  const head = allHeads[0] ?? null;
  const round = internals.db
    .prepare(
      `SELECT rowid AS rid FROM work_events
          WHERE entity_type = 'ticket' AND entity_id = ? AND event_type = 'ticket.transitioned'
            AND json_extract(payload_json, '$.to') = 'in_review'
            AND COALESCE(json_extract(payload_json, '$.from'), '') <> 'in_testing'
          ORDER BY rowid DESC LIMIT 1`,
    )
    .get(ticket.id) as { rid: number } | undefined;
  const verdict = internals.db
    .prepare(
      `SELECT rowid AS rid, event_type, payload_json FROM work_events
          WHERE entity_type = 'ticket' AND entity_id = ?
            AND event_type IN ('ticket.tester_passed', 'ticket.tester_failed')
          ORDER BY rowid DESC LIMIT 1`,
    )
    .get(ticket.id) as { rid: number; event_type: string; payload_json: string | null } | undefined;
  if (!verdict || (round && verdict.rid < round.rid)) {
    return { covered: false, why: "no_verdict", tested: null, head };
  }
  const parse = (raw: string | null | undefined): Record<string, unknown> => {
    try {
      const v: unknown = JSON.parse(raw ?? "{}");
      return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  const p = parse(verdict.payload_json);
  const row =
    typeof p.evidence_id === "string"
      ? (internals.db
          .prepare("SELECT payload_json FROM evidence WHERE id = ? AND ticket_id = ?")
          .get(p.evidence_id, ticket.id) as { payload_json: string | null } | undefined)
      : undefined;
  const binding = parse(row?.payload_json);
  const asSha = (v: unknown): string | null =>
    typeof v === "string" && /^[0-9a-f]{7,64}$/i.test(v.trim()) ? v.trim().toLowerCase() : null;
  const tested = asSha(p.tested_head) ?? asSha(binding.tested_commit);
  if (verdict.event_type !== "ticket.tester_passed") {
    return { covered: false, why: "failed", tested, head };
  }
  const same = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);
  if (allHeads.length > 0 && (tested === null || !allHeads.some((h) => same(h, tested)))) {
    return { covered: false, why: "other_commit", tested, head };
  }
  // The contract the PASS was about: the tester's binding, else (a person's waiver
  // before review) the hash recorded on the PASS event.
  const recorded =
    typeof binding.contract_hash === "string"
      ? binding.contract_hash
      : typeof p.contract_hash === "string"
        ? p.contract_hash
        : null;
  if (recorded && recorded !== contractHash(internals.db, ticket.id)) {
    return { covered: false, why: "contract_changed", tested, head };
  }
  return {
    covered: true,
    why: null,
    tested,
    head: (tested && allHeads.find((h) => same(h, tested))) ?? head,
  };
}

/**
 * TESTER FIRST: send an in_review ticket to the independent tester before a person
 * reviews it (`in_review -> in_testing`, reason tester_before_review). The runner's
 * call (system) or an admin's; anyone else is refused. Not an error when nothing is to
 * do: a ticket that is not in review, that the tester does not gate, whose write repo
 * cannot be read, or whose head a PASS already covers comes back `routed: false` with
 * why, so the runner can ask for every in_review ticket.
 */
export function routeToTester(
  host: TesterHost,
  internals: TesterInternals,
  ref: string,
  actor: Actor,
): TesterRoute {
  if (actor.type !== "system" && actor.type !== "admin") {
    throw new DispatchError(
      "ACTOR_NOT_PERMITTED",
      "Only the runner (system) or an admin may send a ticket to the independent tester.",
      { actor_type: actor.type },
    );
  }
  const pre = internals.ticketSvc.resolveTicket(ref);
  const out = (routed: boolean, why: string | null, head: string | null = null): TesterRoute => ({
    ticketId: pre.id,
    number: pre.number,
    routed,
    why,
    head,
  });
  // git runs here, before the write transaction.
  const plan = host.testerRoutePlan(pre);
  if (!plan.route) return out(false, plan.why, plan.coverage?.head ?? null);
  const coverage = plan.coverage;
  return inTransaction(internals.db, () => {
    const ticket = internals.ticketSvc.resolveTicket(ref);
    if (ticket.status !== "in_review") return out(false, `not in review (${ticket.status})`);
    internals.transitions.transition({
      ticketId: ticket.id,
      actor,
      toStatus: "in_testing",
      reason: "tester_before_review",
      expectedFromStatus: "in_review",
      testerVerdict: true,
    });
    writeEvent(internals.db, {
      entity_type: "ticket",
      entity_id: ticket.id,
      actor,
      event_type: "ticket.routed_to_testing",
      payload: {
        from: "in_review",
        before_review: true,
        head: coverage.head,
        ...(coverage.why === "other_commit" && coverage.tested ? { tested: coverage.tested } : {}),
        ...(ticket.acceptance === 1 ? { acceptance: true } : {}),
      },
    });
    return out(true, null, coverage.head);
  });
}

/**
 * TESTER FIRST: would routeToTester send this ticket to the tester now, and if not, why?
 * The one decision behind the route and Poll for work's count (Dispatch.pendingTesterRoutes),
 * so Poll never counts a ticket the route would leave. Not when: it is not in review, the
 * tester does not gate it, a write repo's head cannot be read, a PASS covers its head, or
 * CI is required and has not passed on its head (the tester runs after the gates: a red or
 * pending CI is the delivery tick's to settle, and a red one goes back to rework). Reads git.
 */
export function testerRoutePlan(
  host: TesterHost,
  internals: TesterInternals,
  ticket: Ticket,
):
  | { route: true; why: null; coverage: TesterCoverage }
  | { route: false; why: string; coverage: TesterCoverage | null } {
  if (ticket.status !== "in_review") {
    return { route: false, why: `not in review (${ticket.status})`, coverage: null };
  }
  if (!host.laneApplies(ticket)) {
    return {
      route: false,
      why: "the independent tester does not gate this ticket",
      coverage: null,
    };
  }
  const unavailable = host.unavailableWriteRepos(ticket);
  if (unavailable.length > 0) {
    return {
      route: false,
      why: `the delivery head of ${unavailable.map((m) => m.repo).join(", ")} cannot be read: ${unavailable[0]!.why}`,
      coverage: null,
    };
  }
  const coverage = host.testerCoverage(ticket, resolveReviewedHeads(internals, ticket));
  if (coverage.covered) {
    return {
      route: false,
      why: `the tester already passed ${coverage.tested ? coverage.tested.slice(0, 12) : "this candidate"}`,
      coverage,
    };
  }
  const ci = host.ciStatus(ticket.id, coverage.head);
  if (ci.required && ci.state !== "pass") {
    return {
      route: false,
      why: `CI has not passed on ${coverage.head ? coverage.head.slice(0, 12) : "the candidate"} yet (${ci.state ?? "no result"}): the tester runs after the gates`,
      coverage,
    };
  }
  return { route: true, why: null, coverage };
}

/** Every in_review ticket the tester gates and has not passed, sent to it (see routeToTester). */
export function routeAllToTester(
  host: TesterHost,
  internals: TesterInternals,
  actor: Actor,
): TesterRoute[] {
  if (actor.type !== "system" && actor.type !== "admin") {
    throw new DispatchError(
      "ACTOR_NOT_PERMITTED",
      "Only the runner (system) or an admin may send a ticket to the independent tester.",
      { actor_type: actor.type },
    );
  }
  const ids = (
    internals.db
      .prepare("SELECT id FROM tickets WHERE status = 'in_review' ORDER BY number ASC")
      .all() as Array<{ id: string }>
  ).map((r) => r.id);
  const out: TesterRoute[] = [];
  for (const id of ids) {
    try {
      out.push(host.routeToTester(id, actor));
    } catch (err) {
      // One ticket's failure (a concurrent move) never stops the others.
      out.push({
        ticketId: id,
        number: null,
        routed: false,
        why: err instanceof Error ? err.message : String(err),
        head: null,
      });
    }
  }
  return out;
}

/** The latest entry into in_testing was the runner's tester-first route (not an approval). */
export function enteredTestingBeforeReview(
  internals: Pick<TesterInternals, "db">,
  ticketId: string,
): boolean {
  const row = internals.db
    .prepare(
      `SELECT json_extract(payload_json, '$.before_review') AS before_review FROM work_events
          WHERE entity_type = 'ticket' AND entity_id = ? AND event_type = 'ticket.routed_to_testing'
          ORDER BY rowid DESC LIMIT 1`,
    )
    .get(ticketId) as { before_review: number | null } | undefined;
  return row?.before_review === 1;
}

/**
 * TESTER REPLAY ON THE LANDED REVISION (external review #4): record that the
 * independent tester's test files passed on the exact revision that landed (see
 * testerReplay.ts). SYSTEM only — the runner's landing path, after the merge gate
 * replayed the tester's tests on the merge candidate and that candidate landed; not an
 * admin, a human or an agent (the epic is counted as accepted on this record, so nobody
 * but the landing path may assert it). Idempotent per landed revision. Refused unless:
 * the ticket is approved (ready_for_merge — recorded before mark-merged, like a landing);
 * its tester PASS (the row a `ticket.tester_passed` event names, from an agent/system
 * tester) is bound to exactly `pin`; `pin` is the approved revision when the repo has a
 * review pin; and, for a local landing, git shows `commit` on the repo's default branch.
 */
export function recordTesterReplay(
  internals: TesterInternals,
  ref: string,
  input: {
    commit: string;
    pin: string;
    files: readonly string[];
    /** The test identities proven to have run and passed on `commit`. */
    tests?: unknown;
    /** What the runner proved: "identities" or "files" (checked against the bound PASS). */
    evidence?: string | undefined;
    repo?: string | undefined;
    via?: string | undefined;
    note?: string | undefined;
  },
  actor: Actor,
): {
  ticketId: string;
  commit: string;
  tested: string;
  files: string[];
  tests: TesterTestIdentity[];
  evidence: "identities" | "files";
  recorded: boolean;
} {
  if (actor.type !== "system") {
    throw new DispatchError(
      "ACTOR_NOT_PERMITTED",
      "Only the runner's landing path (the system actor) may record a tester replay.",
      { actor_type: actor.type },
    );
  }
  const sha = (v: string, what: string): string => {
    const s = String(v ?? "")
      .trim()
      .toLowerCase();
    if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(s)) {
      throw new DispatchError(
        "VALIDATION_ERROR",
        `${what} must be a full git commit id (40 or 64 hex characters).`,
      );
    }
    return s;
  };
  const commit = sha(input.commit, "commit");
  const pin = sha(input.pin, "pin");
  const files = [...new Set((input.files ?? []).map((f) => String(f).trim()).filter(Boolean))];
  if (files.length > 500 || files.some((f) => f.length > 1000 || /[\n\r\0]/.test(f))) {
    throw new DispatchError(
      "VALIDATION_ERROR",
      "files must be at most 500 single-line paths of at most 1000 characters.",
    );
  }
  const note = String(input.note ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, 500);
  const tests = parseTesterIdentities(input.tests ?? []);
  if (tests === null) {
    throw new DispatchError(
      "VALIDATION_ERROR",
      "tests must be a JSON array of at most 5000 { file, name, line?, column? } test identities.",
    );
  }
  if (
    input.evidence !== undefined &&
    input.evidence !== "identities" &&
    input.evidence !== "files"
  ) {
    throw new DispatchError("VALIDATION_ERROR", 'evidence must be "identities" or "files".');
  }
  // PR-STALE: the PR merged upstream but the local default branch was not fast-forwarded,
  // so nothing here can show which revision landed. No record: never accepted on a guess.
  if (input.via === "pr-stale") {
    throw new DispatchError(
      "STATE_CONFLICT",
      "the landed revision of a PR merge whose local default branch was not fast-forwarded cannot be verified; no tester replay is recorded for it.",
      { reason: "unverifiable_landing" },
    );
  }
  return inTransaction(internals.db, () => {
    const ticket = internals.ticketSvc.resolveTicket(ref);
    if (ticket.status !== "ready_for_merge") {
      throw new DispatchError(
        "ILLEGAL_TRANSITION",
        "A tester replay can only be recorded for an approved ticket (ready_for_merge).",
        { status: ticket.status },
      );
    }
    const bound = readBoundTesterPass(internals.db, ticket.id);
    if (!bound || bound.provenance === "human" || bound.testedCommit !== pin) {
      throw new DispatchError(
        "STATE_CONFLICT",
        `#${ticket.number} has no tester PASS bound to ${pin.slice(0, 12)}; a replay is recorded only for the tested commit that landed.`,
        { reason: "not_tested_commit", tested: bound?.testedCommit ?? null },
      );
    }
    // TEST IDENTITIES: the PASS decides what the record must prove. One that bound
    // identities is satisfied only by a record in which EVERY one of them passed (a hold
    // never becomes a green here); an older PASS without them is file-level evidence only.
    const evidence: "identities" | "files" = bound.tests !== null ? "identities" : "files";
    if (input.evidence !== undefined && input.evidence !== evidence) {
      throw new DispatchError(
        "STATE_CONFLICT",
        `the replay proved ${input.evidence}, but #${ticket.number}'s tester PASS ${evidence === "identities" ? "bound test identities" : "bound no test identities"}; nothing is recorded.`,
        { reason: "evidence_mismatch", evidence },
      );
    }
    if (bound.tests !== null) {
      const unproven = bound.tests.filter((b) => !tests.some((t) => sameTesterIdentity(t, b)));
      if (unproven.length > 0) {
        throw new DispatchError(
          "STATE_CONFLICT",
          `${unproven.length} test(s) #${ticket.number}'s tester PASS bound are not proven by this replay (${unproven
            .slice(0, 3)
            .map((t) => `${t.file} :: ${t.name}`)
            .join(
              "; ",
            )}${unproven.length > 3 ? "; ..." : ""}); a replay is recorded only when every one passed.`,
          { reason: "identities_not_proven", unproven: unproven.slice(0, 20) },
        );
      }
    }
    // The repo: the one named, else the ticket's primary repo.
    const landing = computeLandingStatus(internals.db, ticket.id);
    let repoId: string | null = null;
    if (input.repo) {
      const named = internals.db
        .prepare("SELECT id FROM repositories WHERE id = ? OR name = ? LIMIT 1")
        .get(input.repo, input.repo) as { id: string } | undefined;
      if (!named) throw notFound("repository", input.repo);
      repoId = named.id;
    } else {
      const primary = internals.db
        .prepare(
          "SELECT repo_id FROM ticket_repos WHERE ticket_id = ? ORDER BY role = 'primary' DESC LIMIT 1",
        )
        .get(ticket.id) as { repo_id: string } | undefined;
      repoId = primary?.repo_id ?? null;
    }
    const approved = repoId ? landing.repos.find((r) => r.repoId === repoId) : undefined;
    if (approved && approved.sha !== pin) {
      throw new DispatchError(
        "STATE_CONFLICT",
        `${pin.slice(0, 12)} is not the approved revision of #${ticket.number} (approved ${approved.sha.slice(0, 12)}).`,
        { reason: "not_approved_revision" },
      );
    }
    const uri = `${TESTER_REPLAY_PREFIX}${commit}`;
    const existing = internals.db
      .prepare(
        "SELECT 1 FROM evidence WHERE ticket_id = ? AND evidence_type = 'commit' AND recorded_by_actor_type = 'system' AND uri = ? LIMIT 1",
      )
      .get(ticket.id, uri);
    if (existing)
      return {
        ticketId: ticket.id,
        commit,
        tested: pin,
        files,
        tests,
        evidence,
        recorded: false,
      };
    // The landed revision must be on the default branch for EVERY landing path: a PR
    // landing records the local default's head after the fast-forward (whose tree the
    // runner checked equals the candidate it replayed on), never the scratch candidate.
    if (repoId && internals.landedOnDefaultResolver) {
      let onDefault: boolean;
      try {
        onDefault = internals.landedOnDefaultResolver(repoId, commit);
      } catch {
        onDefault = false;
      }
      if (!onDefault) {
        throw new DispatchError(
          "STATE_CONFLICT",
          `the default branch does not contain ${commit.slice(0, 12)}; a replay is recorded only for the revision that landed.`,
          { reason: "not_on_default_branch", commit },
        );
      }
    }
    // MULTI-REPO: the tester ran in (and saved tests for) the replayed repo only; say which
    // other write repos of the ticket its assertions did not cover.
    const repoName = repoId
      ? ((
          internals.db.prepare("SELECT name FROM repositories WHERE id = ?").get(repoId) as
            { name: string } | undefined
        )?.name ?? null)
      : null;
    const notReplayed = (
      internals.db
        .prepare(
          `SELECT r.name AS name FROM ticket_repos tr JOIN repositories r ON r.id = tr.repo_id
              WHERE tr.ticket_id = ? AND tr.access = 'write' AND tr.repo_id IS NOT ?
              ORDER BY r.name`,
        )
        .all(ticket.id, repoId) as Array<{ name: string }>
    ).map((r) => r.name);
    internals.evidence.insert({
      id: newId(),
      ticket_id: ticket.id,
      ac_id: null,
      repo_id: repoId,
      decision_id: null,
      evidence_type: "commit",
      summary:
        (files.length
          ? `the independent tester's ${files.length} test file(s) (${files.slice(0, 5).join(", ")}${files.length > 5 ? ", …" : ""}) passed` +
            (evidence === "identities"
              ? `, every one of the ${tests.length} test(s) its PASS bound`
              : " (file-level evidence only: the PASS recorded no test identities)")
          : "NO tester test file was replayed (the repository's own suite passed)") +
        ` on the landed revision ${commit} (the merge of tested commit ${pin.slice(0, 12)})${input.via ? ` via ${input.via}` : ""}` +
        (notReplayed.length ? `; not replayed in ${notReplayed.join(", ")}` : "") +
        (note ? ` — ${note}` : ""),
      uri,
      payload_json: JSON.stringify({
        kind: "tester_replay",
        tested: pin,
        pin,
        files,
        tests,
        evidence,
        via: input.via ?? null,
        repo: repoName,
        not_replayed_repos: notReplayed,
        ...(note ? { note } : {}),
        tester_evidence_id: bound.evidenceId,
      }),
      created_by: "dispatch",
      recorded_by_actor_type: "system",
      created_at: internals.clock.now(),
    });
    writeEvent(internals.db, {
      entity_type: "ticket",
      entity_id: ticket.id,
      actor,
      event_type: "ticket.tester_replayed",
      payload: {
        commit,
        tested: pin,
        files,
        tests: tests.length,
        evidence,
        via: input.via ?? null,
      },
    });
    return { ticketId: ticket.id, commit, tested: pin, files, tests, evidence, recorded: true };
  });
}

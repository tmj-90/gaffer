/**
 * Required CI: the per-commit CI results the gate reads (ciStatus), the CI candidate an
 * approval or a tester PASS is held on, recording a result or the requirement, and the
 * refusal when required CI has not passed.
 */
import { type Actor, type Ticket } from "../../domain/types.js";
import { writeEvent } from "../../events/eventWriter.js";
import { DispatchError } from "../../util/errors.js";
import { REVIEW_PIN_PREFIX } from "../landingStatus.js";
import type { ReviewGateInternals } from "./internals.js";
import type { ReviewGateService, ReviewedHead } from "../reviewGateService.js";
import { resolveReviewedHeads } from "./staleness.js";

/** What these functions read from the {@link ReviewGateService} facade they are handed. */
export type CiHost = Pick<ReviewGateService, "ciStatus" | "holdForHuman">;
/** The facade's private state these functions read. */
export type CiInternals = Pick<ReviewGateInternals, "db" | "reviewedHeadsResolver" | "ticketSvc">;

/** The candidate commit REQUIRED CI is read for on approve (null when no CI is recorded). */
export function approveCiCandidate(
  host: Pick<CiHost, "ciStatus">,
  internals: Pick<CiInternals, "reviewedHeadsResolver">,
  ticket: Ticket,
): string | null {
  return host.ciStatus(ticket.id, null).required
    ? (ciCandidateHead(internals, ticket)?.sha ?? null)
    : null;
}

/**
 * REQUIRED CI: the hold an approve of this ticket would hit right now (the same check
 * approveReview's assertCiPassed raises), or null when approval is not held by CI.
 */
export function approveCiHold(
  host: CiHost,
  internals: CiInternals,
  ticket: Ticket,
): { state: string | null; commit: string | null } | null {
  const candidate = approveCiCandidate(host, internals, ticket);
  const ci = host.ciStatus(ticket.id, candidate);
  if (!ci.required || (candidate !== null && ci.state === "pass")) return null;
  return { state: ci.state, commit: ci.commit };
}

/**
 * REQUIRED CI's candidate: the delivery head of the ticket's PRIMARY write repo (the
 * first write repo in role order — the repo whose PR the runner's CI gate polls), or
 * null when it does not resolve.
 */
export function ciCandidateHead(
  internals: Pick<CiInternals, "reviewedHeadsResolver">,
  ticket: Ticket,
): ReviewedHead | null {
  return resolveReviewedHeads(internals, ticket)[0] ?? null;
}

/**
 * REQUIRED CI: record a CI result for a ticket's candidate commit (SYSTEM/admin only —
 * the runner's CI gate; an admin may record a human override, which is auditable).
 * A FAIL on a ticket that is already approved (`ready_for_merge` / `in_testing`)
 * HOLDS it for a human with the failing check as the reason: the rejection path only
 * acted on `in_review`, so a late red result left an approved ticket landable.
 */
export function recordCiResult(
  host: CiHost,
  internals: CiInternals,
  ticketRef: string,
  input: { commit: string; state: "pending" | "pass" | "fail"; detail?: string },
  actor: Actor,
): { state: string; held: boolean; status: string; eventId: string } {
  if (actor.type !== "system" && actor.type !== "admin") {
    throw new DispatchError(
      "ACTOR_NOT_PERMITTED",
      "Only the runner (system) or an admin may record a CI result.",
      { actor_type: actor.type },
    );
  }
  const commit = input.commit.trim().toLowerCase();
  if (!/^[0-9a-f]{7,64}$/.test(commit)) {
    throw new DispatchError("VALIDATION_ERROR", "commit must be a git commit id.", {
      commit: input.commit,
    });
  }
  if (!["pending", "pass", "fail"].includes(input.state)) {
    throw new DispatchError("VALIDATION_ERROR", "state must be pending, pass or fail.", {
      state: input.state,
    });
  }
  const detail = (input.detail ?? "").trim().slice(0, 2_000);
  const ticket = internals.ticketSvc.resolveTicket(ticketRef);
  // THE TICKET'S COMMITS ONLY (exploratory finding cli-wg/F-11): a result for a commit
  // that is not one of the ticket's candidates was recorded anyway, and `ci-status` then
  // reported that unrelated PASS while the real head was red.
  const candidates = ciCandidateCommits(internals, ticket);
  const known = candidates.some((c) => c.startsWith(commit) || commit.startsWith(c));
  if (!known) {
    throw new DispatchError(
      "STATE_CONFLICT",
      `${commit.slice(0, 12)} is not a commit of #${ticket.number ?? "?"}: a CI result is recorded only for the ticket's candidate commit (a write repo's delivery head, a recorded delivery commit, or an approved revision).`,
      {
        reason: "not_ticket_commit",
        commit,
        candidates: candidates.map((c) => c.slice(0, 12)),
      },
    );
  }
  const eventId = writeEvent(internals.db, {
    entity_type: "ticket",
    entity_id: ticket.id,
    actor,
    event_type: "ticket.ci_result",
    payload: { commit, state: input.state, ...(detail ? { detail } : {}) },
  });
  let held = false;
  let status: string = ticket.status;
  if (
    input.state === "fail" &&
    (ticket.status === "ready_for_merge" || ticket.status === "in_testing")
  ) {
    const r = host.holdForHuman(
      ticket.id,
      {
        reasonCode: "ci_red",
        reason: `Required CI failed for ${commit.slice(0, 12)}${detail ? `: ${detail}` : ""}`,
      },
      actor,
    );
    held = true;
    status = r.ticket.status;
  }
  return { state: input.state, held, status, eventId };
}

/**
 * REQUIRED CI, recorded BEFORE any result (external review #9, finding 4): the runner
 * marks the ticket as needing CI when it submits a delivery that CI will gate
 * (GAFFER_REQUIRE_CI with PR creation on), so the requirement exists before the ticket
 * is exposed for review. Until a PASS is recorded for the candidate commit, approval
 * and a tester PASS are refused ("CI required: not reported"), whether the gate then
 * runs, fails, or never reports (no gh, no GitHub remote). System/admin only;
 * idempotent (one requirement per ticket is enough, later calls record nothing new).
 */
export function recordCiRequired(
  internals: CiInternals,
  ticketRef: string,
  input: { detail?: string },
  actor: Actor,
): { required: true; eventId: string | null } {
  if (actor.type !== "system" && actor.type !== "admin") {
    throw new DispatchError(
      "ACTOR_NOT_PERMITTED",
      "Only the runner (system) or an admin may record that a ticket requires CI.",
      { actor_type: actor.type },
    );
  }
  const ticket = internals.ticketSvc.resolveTicket(ticketRef);
  const already = internals.db
    .prepare(
      `SELECT 1 FROM work_events
          WHERE entity_type = 'ticket' AND entity_id = ? AND event_type = 'ticket.ci_required' LIMIT 1`,
    )
    .get(ticket.id);
  if (already) return { required: true, eventId: null };
  const detail = (input.detail ?? "").trim().slice(0, 2_000);
  const eventId = writeEvent(internals.db, {
    entity_type: "ticket",
    entity_id: ticket.id,
    actor,
    event_type: "ticket.ci_required",
    payload: detail ? { detail } : {},
  });
  return { required: true, eventId };
}

/**
 * REQUIRED CI: every commit a CI result may be recorded for: each write repo's current
 * delivery head (git), each recorded per-repo delivery commit, and each review pin
 * (an approved revision). Lower-case full or abbreviated ids, deduplicated.
 */
export function ciCandidateCommits(
  internals: Pick<CiInternals, "db" | "reviewedHeadsResolver">,
  ticket: Ticket,
): string[] {
  const out = new Set<string>();
  for (const h of resolveReviewedHeads(internals, ticket)) if (h.sha) out.add(h.sha.toLowerCase());
  const rows = internals.db
    .prepare(
      `SELECT commit_sha AS sha FROM ticket_repo_delivery
          WHERE ticket_id = ? AND commit_sha IS NOT NULL AND commit_sha <> ''
         UNION ALL
         SELECT substr(uri, ${REVIEW_PIN_PREFIX.length + 1}) AS sha FROM evidence
          WHERE ticket_id = ? AND evidence_type = 'commit' AND recorded_by_actor_type = 'system'
            AND uri LIKE '${REVIEW_PIN_PREFIX}%'`,
    )
    .all(ticket.id, ticket.id) as Array<{ sha: string }>;
  for (const r of rows) {
    const sha = String(r.sha).trim().toLowerCase();
    if (/^[0-9a-f]{7,64}$/.test(sha)) out.add(sha);
  }
  return [...out];
}

/**
 * The latest recorded CI state for `commit` (or, with no candidate commit known, the
 * latest result overall), and whether any CI result was ever recorded for the ticket.
 */
export function ciStatus(
  internals: CiInternals,
  ticketId: string,
  commit: string | null,
): { required: boolean; state: string | null; commit: string | null } {
  const rows = internals.db
    .prepare(
      `SELECT json_extract(payload_json, '$.commit') AS commit_sha,
                json_extract(payload_json, '$.state')  AS state
           FROM work_events
          WHERE entity_type = 'ticket' AND entity_id = ? AND event_type = 'ticket.ci_result'
          ORDER BY rowid DESC`,
    )
    .all(ticketId) as Array<{ commit_sha: string | null; state: string | null }>;
  // A recorded requirement (recordCiRequired) makes CI required before any result.
  const requiredMark =
    rows.length > 0 ||
    internals.db
      .prepare(
        `SELECT 1 FROM work_events
            WHERE entity_type = 'ticket' AND entity_id = ? AND event_type = 'ticket.ci_required' LIMIT 1`,
      )
      .get(ticketId) !== undefined;
  if (!requiredMark) return { required: false, state: null, commit };
  if (rows.length === 0) return { required: true, state: null, commit };
  const c = commit ? commit.toLowerCase() : null;
  const hit = c
    ? rows.find((r) => {
        const rc = String(r.commit_sha ?? "").toLowerCase();
        return rc !== "" && (c.startsWith(rc) || rc.startsWith(c));
      })
    : rows[0];
  return { required: true, state: hit?.state ?? null, commit: c ?? rows[0]?.commit_sha ?? null };
}

/**
 * REQUIRED CI: refuse (POLICY_DENIED) unless the candidate commit's CI passed. A
 * candidate that cannot be resolved has no result of its own, so it is held too (the
 * latest result overall may be another commit's PASS).
 */
export function assertCiPassed(
  host: Pick<CiHost, "ciStatus">,
  ticket: Ticket,
  candidate: string | null,
): void {
  const ci = host.ciStatus(ticket.id, candidate);
  if (!ci.required || (candidate !== null && ci.state === "pass")) return;
  const at = ci.commit ? ` for ${String(ci.commit).slice(0, 12)}` : "";
  throw new DispatchError(
    "POLICY_DENIED",
    ci.state === "fail"
      ? `Required CI failed${at}; the ticket cannot advance to merge.`
      : ci.state === null
        ? `CI required: not reported${at}; approval waits for a passing CI result for the candidate commit.`
        : `Required CI has not passed${at} (${ci.state}); approval waits for a passing CI result for the candidate commit.`,
    { ci_state: ci.state, commit: ci.commit, reason: "ci_required" },
  );
}

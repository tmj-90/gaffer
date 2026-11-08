/**
 * Landing state: the per-repository landing record and status, beginning a landing on
 * the current approval (REVOCATION-SAFE LANDING), the landings started on it, PR landing
 * checks, markMerged (security invariant 3: system/admin only through the markMerged guard
 * flag), and the guards that keep a landed or partly landed ticket from being cancelled or
 * re-queued.
 */
import { inTransaction } from "../../db/connection.js";
import { type Actor, type Ticket } from "../../domain/types.js";
import { writeEvent } from "../../events/eventWriter.js";
import type { TransitionResult } from "../transitionService.js";
import { DispatchError } from "../../util/errors.js";
import { newId } from "../../util/id.js";
import {
  computeLandingStatus,
  recordedLandingRepos,
  LANDING_PREFIX,
  type LandingStatus,
} from "../landingStatus.js";
import type { ReviewGateInternals } from "./internals.js";
import type { ReviewGateService, LandingStarted } from "../reviewGateService.js";
import { computeApprovedUnchanged } from "./staleness.js";

/** What these functions read from the {@link ReviewGateService} facade they are handed. */
export type LandingHost = Pick<
  ReviewGateService,
  "approvalRef" | "ciStatus" | "landingsStarted" | "recordLanding"
>;
/** The facade's private state these functions read. */
export type LandingInternals = Pick<
  ReviewGateInternals,
  | "approvalShaResolver"
  | "changeOnRefsResolver"
  | "clock"
  | "db"
  | "evidence"
  | "landedOnDefaultResolver"
  | "ticketSvc"
  | "transitions"
>;

/**
 * PER-REPOSITORY LANDING: the `via` values whose landing happened upstream (a merged PR,
 * possibly squashed), so ancestry of the local default branch alone cannot confirm it:
 * assertPrLanding checks them (a PR on record, the change carried by the default branch or
 * its remote-tracking copy). Every other landing is checked by ancestry before it is
 * recorded.
 */
export const UNVERIFIABLE_LANDING_VIAS: ReadonlySet<string> = new Set(["pr", "pr-stale"]);

/** PER-REPOSITORY LANDING: which approved revisions have landed (see landingStatus.ts). */
export function landingStatus(internals: LandingInternals, ref: string): LandingStatus {
  const ticket = internals.ticketSvc.resolveTicket(ref);
  return computeLandingStatus(internals.db, ticket.id);
}

/**
 * PER-REPOSITORY LANDING: record that one write repo's approved commit reached its
 * default branch. SYSTEM/admin only (the landing paths run as the runner). Idempotent:
 * recording the same (repo, commit) again returns the existing row. The commit must be
 * that repo's current review pin — landing something nobody approved is refused.
 */
export function recordLanding(
  host: LandingHost,
  internals: LandingInternals,
  ref: string,
  input: { repo: string; commit: string; via?: string | undefined },
  actor: Actor,
): { ticketId: string; repo: string; commit: string; recorded: boolean; status: LandingStatus } {
  if (actor.type !== "system" && actor.type !== "admin") {
    throw new DispatchError(
      "ACTOR_NOT_PERMITTED",
      "Only a system or admin actor may record a landing.",
      { actor_type: actor.type },
    );
  }
  const sha = input.commit.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(sha)) {
    throw new DispatchError(
      "VALIDATION_ERROR",
      "commit must be a full git commit id (40 or 64 hex characters).",
    );
  }
  return inTransaction(internals.db, () => {
    const ticket = internals.ticketSvc.resolveTicket(ref);
    // REVOCATION-SAFE LANDING: a landing that STARTED (landing-begin) on the approval the
    // ticket had, before a revocation moved it off ready_for_merge, cannot be stopped by
    // it; once git shows it, it is recorded all the same, so the ticket's record says
    // what its default branches carry (and the partly-landed guards see it).
    const startedBefore =
      ticket.status === "ready_for_merge"
        ? null
        : startedOnApproval(host, internals, ticket.id, input.repo, sha);
    if (ticket.status !== "ready_for_merge" && !startedBefore) {
      throw new DispatchError(
        "ILLEGAL_TRANSITION",
        "A landing can only be recorded for an approved ticket (ready_for_merge), or for a landing that started before its approval was revoked.",
        { status: ticket.status },
      );
    }
    const before = computeLandingStatus(internals.db, ticket.id);
    if (startedBefore) {
      const already = internals.db
        .prepare(
          `SELECT 1 AS hit FROM evidence WHERE ticket_id = ? AND repo_id = ? AND uri = ?
               AND evidence_type = 'commit' AND recorded_by_actor_type = 'system' LIMIT 1`,
        )
        .get(ticket.id, startedBefore.repoId, `${LANDING_PREFIX}${sha}`);
      if (already) {
        return {
          ticketId: ticket.id,
          repo: startedBefore.repo,
          commit: sha,
          recorded: false,
          status: before,
        };
      }
    }
    const target = startedBefore
      ? { ...startedBefore, sha, landed: false }
      : before.repos.find((r) => r.repoId === input.repo || r.repo === input.repo);
    if (!target || target.sha !== sha) {
      throw new DispatchError(
        "STATE_CONFLICT",
        `${input.repo} has no approved revision ${sha.slice(0, 12)} on #${ticket.number}; only an approved commit can be recorded as landed.`,
        {
          reason: "not_approved_revision",
          approved: before.repos.map((r) => ({ repo: r.repo, sha: r.sha })),
        },
      );
    }
    if (target.landed) {
      return {
        ticketId: ticket.id,
        repo: target.repo,
        commit: sha,
        recorded: false,
        status: before,
      };
    }
    if (UNVERIFIABLE_LANDING_VIAS.has(input.via ?? ""))
      assertPrLanding(internals, ticket, target, sha, input.via as "pr" | "pr-stale");
    // A LOCAL landing is checkable: the merge paths merge the pinned commit itself, so
    // it must be contained in the repo's default branch. Fail closed — a commit git
    // cannot show there (or a check that errors) is not recorded, so a forged or
    // mistaken row can never let markMerged close a ticket whose repo never landed.
    // A PR landing (`pr`, `pr-stale`) happens upstream and may be squashed, so the
    // local branch is no evidence either way; only the merge lane records one.
    if (internals.landedOnDefaultResolver && !UNVERIFIABLE_LANDING_VIAS.has(input.via ?? "")) {
      let onDefault: boolean;
      try {
        onDefault = internals.landedOnDefaultResolver(target.repoId, sha);
      } catch {
        onDefault = false;
      }
      if (!onDefault) {
        throw new DispatchError(
          "STATE_CONFLICT",
          `${target.repo}'s default branch does not contain ${sha.slice(0, 12)}; a local landing is recorded only once git shows the approved commit there.`,
          { reason: "not_on_default_branch", repo: target.repo, commit: sha },
        );
      }
    }
    internals.evidence.insert({
      id: newId(),
      ticket_id: ticket.id,
      ac_id: null,
      repo_id: target.repoId,
      decision_id: null,
      evidence_type: "commit",
      summary: `landed ${sha} of #${ticket.number} on ${target.repo}'s default branch${input.via ? ` (via ${input.via})` : ""}`,
      uri: `${LANDING_PREFIX}${sha}`,
      payload_json: JSON.stringify({
        kind: "landing",
        repo: target.repo,
        via: input.via ?? null,
      }),
      created_by: "dispatch",
      recorded_by_actor_type: "system",
      created_at: internals.clock.now(),
    });
    writeEvent(internals.db, {
      entity_type: "ticket",
      entity_id: ticket.id,
      actor,
      event_type: "ticket.repo_landed",
      payload: { repo: target.repo, commit: sha, via: input.via ?? null },
    });
    return {
      ticketId: ticket.id,
      repo: target.repo,
      commit: sha,
      recorded: true,
      status: computeLandingStatus(internals.db, ticket.id),
    };
  });
}

/**
 * REVOCATION-SAFE LANDING (external review #8): the approval a landing is acting on —
 * the id of the ticket's latest transition into ready_for_merge (a human/agent approve,
 * a tester PASS), or null when it never got there. The merge runner reads it before its
 * gates run and hands it back to beginLanding, so a re-approval while the gates ran
 * (even of the same commit) is a different approval and nothing lands on the old one.
 */
export function approvalRef(internals: LandingInternals, ticketId: string): string | null {
  const row = internals.db
    .prepare(
      `SELECT id FROM work_events
          WHERE entity_type = 'ticket' AND entity_id = ? AND event_type = 'ticket.transitioned'
            AND json_extract(payload_json, '$.to') = 'ready_for_merge'
          ORDER BY rowid DESC LIMIT 1`,
    )
    .get(ticketId) as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * REVOCATION-SAFE LANDING (external review #8). A cancellation or a red required check
 * recorded while the merge gate ran used to be acknowledged by Dispatch and then
 * overridden by the landing that followed: both default branches advanced, the merge
 * exited 0, and the ticket still read cancelled. The landing paths now call this
 * IMMEDIATELY before they advance a default branch (or ask the provider to merge a PR),
 * once per repository. In ONE immediate transaction it re-checks that the ticket is
 * still ready_for_merge, on the same approval (`approval`, from approvalRef), that
 * `commit` is still that repo's approved revision, and that required CI for the
 * approved commits is still green — and records the landing as STARTED
 * (`ticket.landing_started`). A refusal (STATE_CONFLICT, `details.reason` revoked |
 * approval_changed | ci_not_green) means: land nothing. Because the check and the
 * record are one transaction, a revocation is either committed first (this refuses) or
 * sees the started landing (rejectReview / recordCiResult then report it). System/admin.
 */
export function beginLanding(
  host: LandingHost,
  internals: LandingInternals,
  ref: string,
  input: {
    repo: string;
    commit: string;
    approval?: string | undefined;
    via?: string | undefined;
  },
  actor: Actor,
): {
  ticketId: string;
  repo: string;
  repoId: string;
  commit: string;
  approval: string | null;
  eventId: string;
} {
  if (actor.type !== "system" && actor.type !== "admin") {
    throw new DispatchError(
      "ACTOR_NOT_PERMITTED",
      "Only a system or admin actor may start a landing.",
      { actor_type: actor.type },
    );
  }
  const sha = input.commit.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(sha)) {
    throw new DispatchError(
      "VALIDATION_ERROR",
      "commit must be a full git commit id (40 or 64 hex characters).",
    );
  }
  return inTransaction(internals.db, () => {
    const ticket = internals.ticketSvc.resolveTicket(ref);
    if (ticket.status !== "ready_for_merge") {
      throw new DispatchError(
        "STATE_CONFLICT",
        `#${ticket.number} is ${ticket.status}, no longer ready_for_merge: its approval was revoked while the landing was being prepared.`,
        { reason: "revoked", status: ticket.status },
      );
    }
    const approval = host.approvalRef(ticket.id);
    if (input.approval && approval !== input.approval) {
      throw new DispatchError(
        "STATE_CONFLICT",
        `#${ticket.number} was re-approved while the landing was being prepared; the approval it started on is no longer current.`,
        { reason: "approval_changed", started_on: input.approval, current: approval },
      );
    }
    const landing = computeLandingStatus(internals.db, ticket.id);
    const target = landing.repos.find((r) => r.repoId === input.repo || r.repo === input.repo);
    // A legacy approval (no per-repo pins) has no plan: the status/approval/CI checks
    // still apply; with a plan, the commit must be the repo's current approved revision.
    if (landing.repos.length > 0 && (!target || target.sha !== sha)) {
      throw new DispatchError(
        "STATE_CONFLICT",
        `${input.repo} has no approved revision ${sha.slice(0, 12)} on #${ticket.number} any more; the approval changed while the landing was being prepared.`,
        {
          reason: "approval_changed",
          approved: landing.repos.map((r) => ({ repo: r.repo, sha: r.sha })),
        },
      );
    }
    // REQUIRED CI for the approved commits must still be green.
    if (host.ciStatus(ticket.id, null).required) {
      const pins = landing.repos.filter((r) => r.pinned).map((r) => r.sha);
      const states = (pins.length > 0 ? pins : [sha]).map((c) => ({
        state: host.ciStatus(ticket.id, c).state,
        commit: c,
      }));
      const red = states.find((x) => x.state !== null && x.state !== "pass");
      const anyPass = states.some((x) => x.state === "pass");
      if (red || !anyPass) {
        const at = red ? red.commit : (pins[0] ?? sha);
        throw new DispatchError(
          "STATE_CONFLICT",
          `Required CI for ${String(at).slice(0, 12)} on #${ticket.number} is ${red?.state ?? "not passed"}; nothing may land on it.`,
          { reason: "ci_not_green", commit: at, ci_state: red?.state ?? null },
        );
      }
    }
    const repoId = target?.repoId ?? input.repo;
    const eventId = writeEvent(internals.db, {
      entity_type: "ticket",
      entity_id: ticket.id,
      actor,
      event_type: "ticket.landing_started",
      payload: {
        repo: target?.repo ?? input.repo,
        repo_id: repoId,
        commit: sha,
        via: input.via ?? null,
        approval,
      },
    });
    return {
      ticketId: ticket.id,
      repo: target?.repo ?? input.repo,
      repoId,
      commit: sha,
      approval,
      eventId,
    };
  });
}

/**
 * REVOCATION-SAFE LANDING: the `ticket.landing_started` of `sha` in `repo` (id or name)
 * on the ticket's current approval (approvalRef), as { repoId, repo }, or null.
 */
export function startedOnApproval(
  host: Pick<LandingHost, "approvalRef">,
  internals: Pick<LandingInternals, "db">,
  ticketId: string,
  repo: string,
  sha: string,
): { repoId: string; repo: string } | null {
  const approval = host.approvalRef(ticketId);
  if (!approval) return null;
  const row = internals.db
    .prepare(
      `SELECT json_extract(payload_json, '$.repo_id') AS repo_id,
                json_extract(payload_json, '$.repo') AS repo
           FROM work_events
          WHERE entity_type = 'ticket' AND entity_id = ? AND event_type = 'ticket.landing_started'
            AND json_extract(payload_json, '$.approval') = ?
            AND lower(json_extract(payload_json, '$.commit')) = ?
            AND (json_extract(payload_json, '$.repo_id') = ? OR json_extract(payload_json, '$.repo') = ?)
          ORDER BY rowid DESC LIMIT 1`,
    )
    .get(ticketId, approval, sha, repo, repo) as
    { repo_id: string | null; repo: string | null } | undefined;
  if (!row?.repo_id) return null;
  const known = internals.db
    .prepare(`SELECT id, name FROM repositories WHERE id = ?`)
    .get(row.repo_id) as { id: string; name: string } | undefined;
  return known ? { repoId: known.id, repo: known.name } : null;
}

/**
 * REVOCATION-SAFE LANDING: the landings already started or committed on the ticket's
 * current approval (since it last entered in_review): every `ticket.landing_started`
 * and every recorded landing, one row per repo and commit. `landed` is true when the
 * landing is on record or git shows the approved commit on that repo's default branch;
 * false means the landing had started (the default branch may be moving right now).
 * A revocation (rejectReview, a failed CI result) reports these: it cannot undo them.
 */
export function landingsStarted(internals: LandingInternals, ticketId: string): LandingStarted[] {
  const entered = internals.db
    .prepare(
      `SELECT created_at AS at FROM work_events
          WHERE entity_type = 'ticket' AND entity_id = ? AND event_type = 'ticket.transitioned'
            AND json_extract(payload_json, '$.to') = 'in_review'
          ORDER BY rowid DESC LIMIT 1`,
    )
    .get(ticketId) as { at: string } | undefined;
  const since = entered?.at ?? "";
  const started = internals.db
    .prepare(
      `SELECT payload_json, created_at FROM work_events
          WHERE entity_type = 'ticket' AND entity_id = ? AND created_at >= ?
            AND event_type IN ('ticket.landing_started', 'ticket.repo_landed')
          ORDER BY rowid ASC`,
    )
    .all(ticketId, since) as Array<{ payload_json: string | null; created_at: string }>;
  const status = computeLandingStatus(internals.db, ticketId);
  const out = new Map<string, LandingStarted>();
  for (const row of started) {
    let p: Record<string, unknown> = {};
    try {
      p = JSON.parse(row.payload_json ?? "{}") as Record<string, unknown>;
    } catch {
      p = {};
    }
    const commit = String(p.commit ?? "").toLowerCase();
    const repo = String(p.repo ?? "");
    const st = status.repos.find((r) => r.repoId === String(p.repo_id ?? "") || r.repo === repo);
    if (!commit) continue;
    const key = `${st?.repoId ?? repo}\u0000${commit}`;
    const prev = out.get(key);
    out.set(key, {
      repo: st?.repo ?? repo,
      repoId: st?.repoId ?? String(p.repo_id ?? repo),
      commit,
      landed: prev?.landed ?? false,
      via: (p.via as string | null | undefined) ?? prev?.via ?? null,
      at: prev?.at ?? row.created_at,
    });
  }
  for (const [key, v] of out) {
    let landed = status.repos.some((r) => r.repoId === v.repoId && r.sha === v.commit && r.landed);
    if (
      !landed &&
      internals.landedOnDefaultResolver &&
      !UNVERIFIABLE_LANDING_VIAS.has(v.via ?? "")
    ) {
      try {
        landed = internals.landedOnDefaultResolver(v.repoId, v.commit);
      } catch {
        landed = false;
      }
    }
    out.set(key, { ...v, landed });
  }
  return [...out.values()];
}

/**
 * MERGE-COMPLETE: `ready_for_merge -> done`. SYSTEM/admin only.
 * The markMerged:true flag is required by TransitionService — a board-drag
 * or agent can never trigger this path.
 *
 * GRADUATED-AUTONOMY (Spec 2, Phase 1, merge-time correction): `approved_unchanged`
 * is first stamped at APPROVE time, but with the testing lane on a tester can amend
 * the branch AFTER approval — so the approve-time value can overstate what actually
 * landed. We RE-RESOLVE the delivery-vs-merged-head signal here (the resolver reads
 * the branch head fresh, which is now the merged head) and emit the CORRECTED value
 * on this transition, so the signal reaching `autonomyRecommendationService` (via
 * {@link EventRepository.reviewDecisions}, which prefers this merge-time value)
 * reflects the merged state. Behaviour is preserved when there was no post-approval
 * amend: the merged head still equals the delivery SHA, so the value is identical to
 * approve time. The key is only emitted when the signal is DEFINITE (`true`/`false`);
 * an unknown (`null`) resolution is omitted, leaving the merge payload byte-for-byte
 * as before so it never clobbers a known approve-time value downstream.
 */
export function markMerged(
  host: LandingHost,
  internals: LandingInternals,
  ref: string,
  actor: Actor,
): TransitionResult {
  if (actor.type !== "system" && actor.type !== "admin") {
    throw new DispatchError(
      "ACTOR_NOT_PERMITTED",
      "Only a system or admin actor may mark a ticket merged.",
      { actor_type: actor.type },
    );
  }
  const ticket = internals.ticketSvc.resolveTicket(ref);
  // PER-REPOSITORY LANDING: `done` means EVERY approved revision landed. A two-repo
  // ticket whose second repo's change is still on its delivery branch stays
  // ready_for_merge (a visible "partly merged" item in the human queue); the merge
  // paths land the rest and call this again.
  let landing = computeLandingStatus(internals.db, ticket.id);
  if (landing.pending > 0 && internals.landedOnDefaultResolver) {
    // Git is the truth for a local landing: record what is verifiably on the default
    // branch already (as SYSTEM evidence, via "git-verified"), then re-read.
    // (Not for a repo with a recorded PR: its checkout holding the commit is no evidence
    // that the PR merged upstream — external review #8.)
    for (const r of landing.repos.filter((x) => !x.landed && x.pinned && !x.prUrl)) {
      let onDefault: boolean;
      try {
        onDefault = internals.landedOnDefaultResolver(r.repoId, r.sha);
      } catch {
        onDefault = false;
      }
      if (onDefault)
        host.recordLanding(
          ticket.id,
          { repo: r.repoId, commit: r.sha, via: "git-verified" },
          { type: "system" },
        );
    }
    landing = computeLandingStatus(internals.db, ticket.id);
  }
  if (landing.pending > 0) {
    const pending = landing.repos.filter((r) => !r.landed);
    // EVERY WRITE REPO: an unpinned write repo is pending too, and says why.
    const unpinned = pending.filter((r) => !r.pinned);
    throw new DispatchError(
      "STATE_CONFLICT",
      `#${ticket.number} is not done: ${pending
        .map((r) =>
          r.pinned
            ? `${r.repo} (${r.sha.slice(0, 12)}${r.prUrl ? `, its PR ${r.prUrl} has not merged upstream` : ""})`
            : `${r.repo} (not covered by the approval)`,
        )
        .join(", ")} ` +
        `${pending.length === 1 ? "has" : "have"} not landed yet` +
        (landing.landed > 0 ? ` (${landing.landed} of ${landing.repos.length} landed)` : "") +
        ". Merge the remaining repositories; the ticket is done when every write repository has landed." +
        (unpinned.length > 0
          ? ` ${unpinned.map((r) => r.repo).join(", ")} ${unpinned.length === 1 ? "has" : "have"} no approved commit: move the ticket back to review and approve every repository together.`
          : ""),
      {
        reason: landing.partial ? "partial_landing" : "not_landed",
        pending: pending.map((r) => ({ repo: r.repo, sha: r.sha, pinned: r.pinned })),
        landed: landing.repos.filter((r) => r.landed).map((r) => ({ repo: r.repo, sha: r.sha })),
      },
    );
  }
  const approvedUnchanged = computeApprovedUnchanged(internals, ticket);
  return internals.transitions.transition({
    ticketId: ticket.id,
    actor,
    toStatus: "done",
    reason: "merge_completed",
    expectedFromStatus: "ready_for_merge",
    markMerged: true,
    // Only carry a DEFINITE merge-time signal; omit an unknown so the payload stays
    // byte-for-byte identical to today and never overrides a known approve-time value.
    ...(approvedUnchanged !== null ? { approvedUnchanged } : {}),
  });
}

/**
 * PR LANDINGS (exploratory finding cli-wg/F-01): `record-landing --via pr|pr-stale` used
 * to record any approved commit as landed with nothing checked, and mark-merged then
 * closed the ticket while its branch sat unmerged. The rule now:
 *   - a PR must be on record for that repository (its ticket_repos / delivery pr_url, or
 *     the ticket's pr_url when it is the ticket's primary write repo): no PR, no PR
 *     landing (`no_pr_recorded`);
 *   - `pr` says the local default branch was fast-forwarded from the merged PR's base, so
 *     the local default must carry the approved change (an ancestor, or for a squash or
 *     rebase merge, merging the commit into it changes nothing): `not_on_default_branch`;
 *   - `pr-stale` says the local default could NOT be updated, so it is checked the same way
 *     against the remote-tracking refs of the default branch (or the local default) when
 *     the checkout has any; with none here, the recorded PR is the only evidence there is.
 */
export function assertPrLanding(
  internals: Pick<LandingInternals, "changeOnRefsResolver" | "db">,
  ticket: Ticket,
  target: { repoId: string; repo: string },
  sha: string,
  via: "pr" | "pr-stale",
): void {
  const repoPr = internals.db
    .prepare(
      `SELECT COALESCE(NULLIF(tr.pr_url, ''), NULLIF(d.pr_url, '')) AS pr
           FROM ticket_repos tr
           LEFT JOIN ticket_repo_delivery d ON d.ticket_id = tr.ticket_id AND d.repo_id = tr.repo_id
          WHERE tr.ticket_id = ? AND tr.repo_id = ?`,
    )
    .get(ticket.id, target.repoId) as { pr: string | null } | undefined;
  const primary = internals.db
    .prepare(
      `SELECT repo_id FROM ticket_repos WHERE ticket_id = ?
          ORDER BY (access = 'write') DESC, (role = 'primary') DESC LIMIT 1`,
    )
    .get(ticket.id) as { repo_id: string } | undefined;
  const ticketPr = String(ticket.pr_url ?? "").trim();
  const pr =
    String(repoPr?.pr ?? "").trim() || (primary?.repo_id === target.repoId ? ticketPr : "");
  if (!pr) {
    throw new DispatchError(
      "STATE_CONFLICT",
      `#${ticket.number ?? "?"} has no pull request on record for ${target.repo}; a landing --via ${via} is recorded only for a PR the delivery opened. A local merge records --via local (checked against git).`,
      { reason: "no_pr_recorded", repo: target.repo, via },
    );
  }
  if (!internals.changeOnRefsResolver) return;
  let carried: boolean | null;
  try {
    carried = internals.changeOnRefsResolver(
      target.repoId,
      sha,
      via === "pr" ? ["default"] : ["remote-default", "default"],
    );
  } catch {
    carried = false;
  }
  // pr-stale with no remote-tracking ref here: the local default is known stale and
  // nothing local can show the merge; the PR record above is the evidence.
  if (carried === true) return;
  if (via === "pr-stale" && carried === null) return;
  throw new DispatchError(
    "STATE_CONFLICT",
    via === "pr"
      ? `${target.repo}'s default branch does not carry ${sha.slice(0, 12)}; a PR landing is recorded once the merged PR has been pulled into the local default branch (git shows the approved change there).`
      : `Neither ${target.repo}'s default branch nor its remote-tracking copy carries ${sha.slice(0, 12)}; fetch or pull the default branch, then record the landing again (--via pr once it is pulled).`,
    { reason: "not_on_default_branch", repo: target.repo, commit: sha, via, pr_url: pr },
  );
}

/**
 * PARTLY LANDED (exploratory finding cli-runner/F-02): a ticket whose change already
 * reached a default branch in at least one repository cannot be cancelled. Cancelling
 * read "won't do" while that repository's default branch carried the merge, and dropped
 * the ticket out of the human queue's *Partly merged* item. Every landing on record
 * counts (recordedLandingRepos), not only the current approval's: a send-back or a
 * reopen withdraws the approval but not the merge, so neither opens a way to cancel. A
 * reverted merge still has its landing on record; such a ticket ends as done.
 */
export function refuseCancelOfLanded(
  host: Pick<LandingHost, "landingsStarted">,
  internals: Pick<LandingInternals, "db">,
  ticket: Ticket,
): void {
  // REVOCATION-SAFE LANDING: a landing that started on the current approval and that git
  // already shows on the default branch counts as well. Its record is written a moment
  // after git moves; a cancellation in that gap used to be accepted, the record was then
  // refused (the ticket was cancelled) and the merge read as a clean success.
  const landed = [
    ...new Set([
      ...recordedLandingRepos(internals.db, ticket.id),
      ...host
        .landingsStarted(ticket.id)
        .filter((l) => l.landed)
        .map((l) => l.repo),
    ]),
  ].sort();
  if (landed.length === 0) return;
  const current = computeLandingStatus(internals.db, ticket.id);
  const pending = current.repos
    .filter((r) => !r.landed && !landed.includes(r.repo))
    .map((r) => r.repo);
  const n = ticket.number ?? "<n>";
  throw new DispatchError(
    "PARTLY_LANDED",
    `#${ticket.number ?? "?"} already landed in ${landed.join(", ")}; a ticket whose change is on a default branch cannot be cancelled, it can only be finished. ` +
      (ticket.status === "ready_for_merge"
        ? pending.length > 0
          ? `Land the rest (gaffer merge ${n}: ${pending.join(", ")} still pending).`
          : `Finish it (gaffer merge ${n}).`
        : `Take it through review again and land the rest (gaffer merge ${n} once it is approved).`),
    { ticket_number: ticket.number, landed, pending },
  );
}

/**
 * The hold a send-back (reject, tester FAIL) of a partly landed ticket becomes: a
 * `ticket.blocked` park event with reason code `partly_landed` naming what landed, so
 * the human queue lists it as parked with that reason. Returns the reason text.
 */
export function partlyLandedHold(
  internals: Pick<LandingInternals, "db">,
  ticket: Ticket,
  landed: string[],
  requested: string,
  reason: string,
  actor: Actor,
): string {
  const why =
    `partly landed: ${landed.join(", ")} already merged on the default branch, so this ` +
    `send-back to ${requested} is held for a person instead of re-queued (${reason}). ` +
    `Rework and re-approve it from here (unblock), then land the rest; it cannot be cancelled.`;
  writeEvent(internals.db, {
    entity_type: "ticket",
    entity_id: ticket.id,
    actor,
    event_type: "ticket.blocked",
    payload: {
      reason: why,
      reason_code: "partly_landed",
      landed,
      requested_target: requested,
    },
  });
  return why;
}

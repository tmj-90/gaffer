import type { IncomingMessage, ServerResponse } from "node:http";

import type { Dispatch, TicketDetailPart } from "../../core.js";
import type { Actor } from "../../domain/types.js";
import { hideOutOfScopeDependencies } from "../../services/accessScope.js";
import { settleApproveOutcome } from "../../services/approveOutcome.js";
import { AUTO_MERGE_ENV, envFlagOn } from "../../services/autonomyPolicyService.js";
import { DispatchError } from "../../util/errors.js";
import { ticketCostInfo } from "../runDetail.js";
import {
  errorBody,
  methodNotAllowed,
  readJsonBody,
  readNoBody,
  sendCreated,
  sendJson,
} from "../http.js";
import type { MemoryReader } from "../memoryReader.js";
import type { MergeRunner } from "../mergeRunner.js";
import {
  addAcBody,
  addTicketDependencyBody,
  approveReviewBody,
  createReviewCommentBody,
  fixTheseBody,
  reviewCommentStateBody,
  reviewCommentsQuery,
  assignReviewerBody,
  continuePausedBody,
  createTicketBody,
  editAcBody,
  editTicketBody,
  humanClaimBody,
  linkTicketScopeBody,
  moveTicketBody,
  recordDeliveryArtifactBody,
  recordRepoDeliveryBody,
  rejectReviewBody,
  reopenForReviewBody,
  reviewOpenedBody,
  regressionOfBody,
  reviewRawOpenedBody,
  reopenWontDoBody,
  setPrimaryScopeBody,
  setRequiredCapabilitiesBody,
  setTestableBody,
  allowTestChangesBody,
  setTestContractBody,
  acceptanceProfileBody,
  setTicketRepoAccessBody,
  stopPausedBody,
  testerVerdictBody,
  TICKET_LIST_DEFAULT_LIMIT,
  ticketDetailsQuery,
  ticketListQuery,
  wontDoBody,
} from "../schemas.js";
import { API_ACTOR, apiActor, apiPrincipal, isSharedOperator, operatorActor } from "./context.js";
import { forgetLoreDrafts } from "./readModels.js";
import { requestTicketFilter } from "../scopeGate.js";
import { reviewRuleThreshold } from "../../health/reviewRules.js";
import { proposeReviewRules } from "../../services/reviewRuleService.js";

const TICKET_SUB = {
  ACCEPTANCE_CRITERIA: "acceptance-criteria",
  READY: "ready",
  MOVE: "move",
  // TRACK-2b: "I'll do this by hand" (human-claim a ready ticket) + hand-back.
  HUMAN_CLAIM: "human-claim",
  HUMAN_RELEASE: "human-release",
  READY_APPROVAL: "ready-approval",
  EVENTS: "events",
  // FAILURE-DIAGNOSIS: the ordered "why did #N fail" rework trail.
  REWORK_TRAIL: "rework-trail",
  REVIEW: "review",
  MARK_MERGED: "mark-merged",
  // Merge an APPROVED ticket (ready_for_merge) whose branch has not landed yet.
  MERGE: "merge",
  DIFF: "diff",
  // A3: the write repos' delivery heads alone (the Review view's live head check).
  HEADS: "heads",
  // DELIVERY-DOSSIER: the tamper-evident evidence artifact (JSON + markdown).
  DOSSIER: "dossier",
  REOPEN_FOR_REVIEW: "reopen-for-review",
  WONT_DO: "wont-do",
  REOPEN: "reopen",
  // PAUSE-ON-CAP: one-click Continue / Stop for a paused (cap-hit) delivery.
  CONTINUE: "continue",
  STOP: "stop",
  DELIVERY_ARTIFACT: "delivery-artifact",
  REQUIRED_CAPABILITIES: "required-capabilities",
  REVIEWER: "reviewer",
  SCOPES: "scopes",
  PRIMARY_SCOPE: "primary-scope",
  REPO_ACCESS: "repo-access",
  WORK_REPOS: "work-repos",
  MONO_FALLBACK: "mono-fallback",
  REPO_DELIVERIES: "repo-deliveries",
  REPO_SUGGESTIONS: "repo-suggestions",
  CLAIMABILITY: "claimability",
  DEPENDENCIES: "dependencies",
  // BBT-001: independent black-box testing handover + tester verdict.
  TESTABLE: "testable",
  TEST_CONTRACT: "test-contract",
  ACCEPTANCE_PROFILE: "acceptance-profile",
  // GATE INTEGRITY: the human's per-ticket "this ticket may change its tests" flag.
  ALLOW_TEST_CHANGES: "allow-test-changes",
  TESTER: "tester",
  // REVIEW TELEMETRY (Release A metrics): a person opened the ticket / a raw view in Review.
  REVIEW_OPENED: "review-opened",
  REVIEW_RAW_OPENED: "review-raw-opened",
  // BLINDING: a person opened the eval judge's collapsed view in Review.
  JUDGE_REVEALED: "judge-revealed",
  // ESCAPED DEFECTS (MF5): a person links this ticket to the accepted change it regresses.
  REGRESSION_OF: "regression-of",
} as const;

/**
 * REVIEW RULES (D6): after a person's send-back or must-fix comment, propose every repeated
 * feedback rule not proposed yet as a lore draft. FAIL-SOFT and OUT OF THE PERSON'S WAY:
 * it runs once the response to the person's act has been sent (`res` closed), so the memory
 * CLI (a synchronous spawn, up to its timeout per draft) can neither delay nor fail the
 * reject or comment, and any error is swallowed. An unconfigured memory is skipped without
 * a spawn, and after a memory failure this server waits {@link RULE_PROPOSAL_BACKOFF_MS}
 * before trying again, so a broken memory CLI is not spawned on every reject (`wg
 * review-rules propose` retries by hand). The person's act triggered it; the server
 * proposes (system).
 */
export const RULE_PROPOSAL_BACKOFF_MS = 5 * 60_000;
const ruleProposalRetryAt = new WeakMap<Dispatch, number>();

function proposeRulesAfterResponse(
  res: ServerResponse,
  wg: Dispatch,
  memoryReader: MemoryReader,
): void {
  if (!(process.env.MEMORY_CLI_BIN ?? "").trim()) return;
  res.once("close", () => {
    setImmediate(() => {
      try {
        if (Date.now() < (ruleProposalRetryAt.get(wg) ?? 0)) return;
        const r = proposeReviewRules(
          wg.db,
          { type: "system" },
          {
            threshold: reviewRuleThreshold(process.env),
            proposer: (d) => {
              const filed = memoryReader.proposeReviewRule(d);
              return filed.available
                ? { ok: true, id: filed.id }
                : { ok: false, reason: filed.reason };
            },
          },
        );
        if (r.failed.length) ruleProposalRetryAt.set(wg, Date.now() + RULE_PROPOSAL_BACKOFF_MS);
        if (r.proposed.length) forgetLoreDrafts(memoryReader);
      } catch {
        // A closed database (shutdown) or any other error: the person's act already stands.
        ruleProposalRetryAt.set(wg, Date.now() + RULE_PROPOSAL_BACKOFF_MS);
      }
    });
  });
}

/** `{ landing_state }` for an approved or held ticket, else nothing (spread into a ticket). */
function withLanding(
  wg: Dispatch,
  ref: string | Parameters<Dispatch["landingState"]>[0],
): { landing_state?: NonNullable<ReturnType<Dispatch["landingState"]>> } {
  const ls = wg.landingState(ref);
  return ls ? { landing_state: ls } : {};
}

/** A merge the API started: noted on the ticket so its status reads "landing" meanwhile. */
function noteMerge(
  wg: Dispatch,
  ticketId: string,
  merge: { triggered: boolean; runId?: string | null } | undefined,
): void {
  if (!merge || !merge.triggered) return;
  try {
    wg.noteMergeStarted(ticketId, merge.runId ?? null, apiActor());
  } catch {
    // Best-effort: the merge has started; only the status word is lost.
  }
}

export async function routeTickets(
  wg: Dispatch,
  mergeRunner: MergeRunner,
  memoryReader: MemoryReader,
  method: string,
  segments: string[],
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // /tickets
  if (segments.length === 1) {
    if (method === "GET") {
      const param = (k: string) => url.searchParams.get(k) ?? undefined;
      const q = ticketListQuery.parse({
        status: param("status"),
        repo: param("repo"),
        risk: param("risk"),
        limit: param("limit"),
        offset: param("offset"),
        fields: param("fields"),
      });
      // Paged by default (exploratory finding api-robustness/F10): a bare GET /tickets
      // answers the first TICKET_LIST_DEFAULT_LIMIT rows and `next_offset`.
      const limit = q.limit ?? TICKET_LIST_DEFAULT_LIMIT;
      const offset = q.offset ?? 0;
      // PRINCIPAL SCOPES: a scoped principal lists only its tickets. The whole match
      // is read and filtered, then windowed, so `total` counts what it may see.
      const visible = requestTicketFilter(wg);
      const page = visible
        ? (() => {
            const all = wg
              .listTicketPage(
                { status: q.status, repo: q.repo, risk: q.risk },
                { summary: q.fields === "summary" },
              )
              .tickets.filter((t) => visible(t.id));
            return { tickets: all.slice(offset, offset + limit), total: all.length };
          })()
        : wg.listTicketPage(
            { status: q.status, repo: q.repo, risk: q.risk },
            { limit, offset, summary: q.fields === "summary" },
          );
      sendJson(res, 200, {
        // Approved and held tickets carry `landing_state` (their truthful status label).
        tickets: page.tickets.map((t) =>
          t.status === "ready_for_merge" || t.status === "blocked"
            ? { ...t, ...withLanding(wg, t.id) }
            : t,
        ),
        total: page.total,
        limit,
        offset,
        next_offset:
          offset + page.tickets.length < page.total ? offset + page.tickets.length : null,
      });
      return;
    }
    if (method === "POST") {
      const body = createTicketBody.parse(await readJsonBody(req));
      // Feature A invariant: when repos are attached, at least one must be a
      // write target — otherwise the ticket is un-deliverable. The create form
      // enforces this client-side too, but it's a real business rule so the API
      // holds it for every caller. Checked BEFORE createTicket so a violation
      // never leaves an orphaned ticket. A repo-less create is still allowed
      // (legacy / draft path); the absence of repoIds is not a violation.
      if (
        body.repoIds &&
        body.repoIds.length > 0 &&
        !body.repoIds.some((r) => r.access === "write")
      ) {
        throw new DispatchError(
          "VALIDATION_ERROR",
          "At least one attached repo must have write access — the ticket needs a delivery target.",
        );
      }
      // Feature A: the legacy single-repo link, the chosen scope node(s) (the first is
      // primary so the ticket lives under a product scope) and each repo's confirmed
      // access boundary (so the ticket is immediately deliverable) — all in ONE
      // transaction with the create, so an unknown repo or scope node (404) leaves no
      // orphan ticket behind for a retry to duplicate.
      const ticket = wg.createTicketWithLinks(
        {
          title: body.title,
          description: body.description ?? "",
          priority: body.priority,
          risk_level: body.risk_level,
          policy_pack: body.policy_pack,
          source: body.source,
        },
        { repo: body.repo, scopeNodeIds: body.scopeNodeIds, repoAccess: body.repoIds },
        apiActor(),
      );
      // cli-wg/F-02: a pack that will refuse this ticket at ready says so now.
      const warnings = wg.ticketCreateWarnings(ticket);
      sendCreated(res, `/tickets/${ticket.id}`, {
        ticket,
        ...(warnings.length > 0 ? { warnings } : {}),
      });
      return;
    }
    methodNotAllowed(res);
    return;
  }

  // /tickets/details — the parts of many tickets' detail in one read (exploratory
  // finding api-robustness/F9: the dashboard read GET /tickets/:id once per ticket, ~1000
  // requests for the Map at 2000 tickets). `?ids=a,b,c` or a page of every ticket.
  if (segments.length === 2 && segments[1] === "details" && method === "GET") {
    const param = (k: string) => url.searchParams.get(k) ?? undefined;
    const q = ticketDetailsQuery.parse({
      ids: param("ids"),
      include: param("include"),
      limit: param("limit"),
      offset: param("offset"),
    });
    const include = new Set<TicketDetailPart>(
      (q.include as TicketDetailPart[] | undefined) ?? ["repositories", "scopes", "dependencies"],
    );
    const limit = q.limit ?? TICKET_LIST_DEFAULT_LIMIT;
    const offset = q.offset ?? 0;
    // PRINCIPAL SCOPES: a scoped principal reads only its tickets (one outside it is
    // `missing`), and a dependency outside its scope comes without its title.
    const visible = requestTicketFilter(wg);
    const read = wg.ticketDetailsBatch(
      q.ids ? { ids: q.ids } : { limit, offset },
      include,
      visible,
    );
    sendJson(res, 200, {
      details: read.details
        .map((d) =>
          d.ticket.status === "ready_for_merge" || d.ticket.status === "blocked"
            ? { ...d, ticket: { ...d.ticket, ...withLanding(wg, d.ticket.id) } }
            : d,
        )
        .map((d) =>
          visible && d.dependencies
            ? { ...d, dependencies: hideOutOfScopeDependencies(d.dependencies, visible) }
            : d,
        ),
      missing: read.missing,
      total: read.total,
      ...(q.ids
        ? {}
        : {
            limit,
            offset,
            next_offset:
              offset + read.details.length < read.total ? offset + read.details.length : null,
          }),
    });
    return;
  }

  const id = segments[1] as string;

  // /tickets/:id
  if (segments.length === 2) {
    if (method === "GET") {
      const view = wg.view(id);
      sendJson(res, 200, {
        ticket: { ...view.ticket, ...withLanding(wg, view.ticket) },
        acceptance_criteria: view.acceptanceCriteria,
        repositories: view.repositories,
        // `scopes` carries the ticket↔scope links (incl. its containing `epic`
        // node), so the Epics view can group tickets under their epic without a
        // new endpoint. The data is already computed by `view()`.
        scopes: view.scopes,
        blocking_decisions: view.blockingDecisions,
        dependencies: hideOutOfScopeDependencies(view.dependencies, requestTicketFilter(wg)),
        evidence: view.evidence,
        events: view.events,
        // FAILURE-DIAGNOSIS: the full ordered "why did #N fail" trail.
        rework_trail: view.reworkTrail,
        // REVIEW COMMENTS (A1): the reviewer's comments (no git: GET …/review/comments
        // ?anchors=1 adds each one's anchor state).
        review_comments: view.reviewComments,
        // ESCAPED DEFECTS (MF5): the accepted changes a person said this ticket regresses,
        // and the later tickets linked to it. A scoped principal sees a ticket outside its
        // scope as a number with no title or note.
        regression: (() => {
          const visible = requestTicketFilter(wg);
          const hide = (l: (typeof view.regression.regression_of)[number]) =>
            !visible || visible(l.ticket_id)
              ? l
              : { ...l, title: null, note: null, outside_scope: true as const };
          return {
            regression_of: view.regression.regression_of.map(hide),
            regressed_by: view.regression.regressed_by.map(hide),
          };
        })(),
        // SQUAD: the presentation (display name, shirt number, role) of every
        // REGISTERED agent this ticket names — event actors, the reviewer, the
        // creator and any active claim holder — keyed by agent id. Additive: the
        // ids above are unchanged.
        agent_display: wg.agentDisplayFor([
          ...view.events.map((e) => e.actor_id),
          view.ticket.reviewer,
          view.ticket.created_by,
          ...wg.claimsRepo
            .listActive()
            .filter((c) => c.ticket_id === view.ticket.id)
            .map((c) => c.agent_id),
        ]),
      });
      return;
    }
    // cli-wg/F-02: edit title / description / policy / priority (contract frozen once claimed).
    if (method === "PATCH") {
      const body = editTicketBody.parse(await readJsonBody(req));
      const result = wg.editTicket(id, body, apiActor());
      sendJson(res, 200, {
        ticket: result.ticket,
        changed: result.changed,
        event_id: result.eventId,
      });
      return;
    }
    methodNotAllowed(res);
    return;
  }

  const sub = segments[2] as string;

  // /tickets/:id/acceptance-criteria/:acId — edit or remove one criterion (cli-wg/F-02).
  if (segments.length === 4 && sub === TICKET_SUB.ACCEPTANCE_CRITERIA) {
    const acId = segments[3] as string;
    if (method === "PATCH") {
      const body = editAcBody.parse(await readJsonBody(req));
      const { ac, eventId } = wg.editAcceptanceCriterion(id, acId, body, apiActor());
      sendJson(res, 200, { acceptance_criterion: ac, event_id: eventId });
      return;
    }
    if (method === "DELETE") {
      const removed = wg.removeAcceptanceCriterion(id, acId, apiActor());
      sendJson(res, 200, { ac_id: removed.acId, event_id: removed.eventId });
      return;
    }
    methodNotAllowed(res);
    return;
  }

  // /tickets/:id/acceptance-criteria
  if (segments.length === 3 && sub === TICKET_SUB.ACCEPTANCE_CRITERIA && method === "POST") {
    const ticket = wg.resolveTicket(id);
    const body = addAcBody.parse(await readJsonBody(req));
    const { ac, eventId } = wg.addAcceptanceCriterion(
      {
        ticket_id: ticket.id,
        text: body.text,
        verification_method: body.verification_method,
        evidence_required: body.evidence_required ?? false,
        ...(body.check_command ? { check_command: body.check_command } : {}),
      },
      apiActor(),
    );
    sendJson(res, 201, { acceptance_criterion: ac, event_id: eventId });
    return;
  }

  // /tickets/:id/ready
  if (segments.length === 3 && sub === TICKET_SUB.READY && method === "POST") {
    const ticket = wg.resolveTicket(id);
    const result = wg.markReady(ticket.id, apiActor());
    sendJson(res, 200, { ticket: result.ticket, event_id: result.eventId });
    return;
  }

  // /tickets/:id/move — human/admin board move (drag a card to a status column,
  // e.g. un-ready: ready -> draft). Guarded by the state machine + policy gates;
  // an illegal drop comes back as ILLEGAL_TRANSITION (409), a no-op as NO_OP.
  if (segments.length === 3 && sub === TICKET_SUB.MOVE && method === "POST") {
    const ticket = wg.resolveTicket(id);
    const body = moveTicketBody.parse(await readJsonBody(req));
    const result = wg.moveTicket(ticket.id, body.to, apiActor());
    sendJson(res, 200, { ticket: result.ticket, event_id: result.eventId });
    return;
  }

  // TRACK-2b: /tickets/:id/human-claim — the operator takes a ready ticket "by
  // hand" ("I'll do this myself"). Moves it ready -> in_progress owned by the human;
  // the agent selection loop structurally skips it thereafter. 409 when the ticket
  // isn't a claimable `ready` ticket.
  if (segments.length === 3 && sub === TICKET_SUB.HUMAN_CLAIM && method === "POST") {
    humanClaimBody.parse(await readJsonBody(req));
    const ticket = wg.resolveTicket(id);
    const result = wg.humanClaimTicket(ticket.id, apiActor());
    sendJson(res, 200, { ticket_id: result.ticketId, number: result.number, human_owned: true });
    return;
  }

  // TRACK-2b: /tickets/:id/human-release — the operator hands a by-hand ticket back
  // to the queue (in_progress -> ready, clearing the ownership marker). 409 when the
  // ticket isn't human-owned in-flight work.
  if (segments.length === 3 && sub === TICKET_SUB.HUMAN_RELEASE && method === "POST") {
    humanClaimBody.parse(await readJsonBody(req));
    const ticket = wg.resolveTicket(id);
    // OWNER ONLY (cli-wg/F-13): a named principal hands back only its own by-hand ticket;
    // the dashboard's operator (the shared token) acts as admin and may hand back any.
    const releaser: Actor = isSharedOperator()
      ? { type: "admin", id: API_ACTOR.id ?? "dispatch-api" }
      : apiActor();
    const result = wg.humanReleaseTicket(ticket.id, releaser);
    sendJson(res, 200, {
      ticket_id: result.ticketId,
      status: result.status,
      event_id: result.eventId,
    });
    return;
  }

  // /tickets/:id/events
  if (segments.length === 3 && sub === TICKET_SUB.EVENTS && method === "GET") {
    sendJson(res, 200, { events: wg.listTicketEvents(id) });
    return;
  }

  // FAILURE-DIAGNOSIS: /tickets/:id/rework-trail — the full ordered "why did #N
  // fail" history (attempt 1 → 2 → …), each with the distilled failing test +
  // assertion. Distinct from the board's latest-only rework chip.
  if (segments.length === 3 && sub === TICKET_SUB.REWORK_TRAIL && method === "GET") {
    sendJson(res, 200, { rework_trail: wg.reworkTrail(id) });
    return;
  }

  // REVIEW COMMENTS (A1): /tickets/:id/review/comments — list (GET) or write (POST) the
  // reviewer's comments. Writes are human/admin acts (the service refuses an agent); a read
  // token never reaches a POST (the method gate). `?anchors=1` adds each comment's
  // git-derived anchor state; the counts and the Fix these outcome ride along.
  if (segments.length === 4 && sub === TICKET_SUB.REVIEW && segments[3] === "comments") {
    if (method === "GET") {
      const q = reviewCommentsQuery.parse(Object.fromEntries(url.searchParams));
      const on = (v: string | undefined) => v === "1" || v === "true";
      const ticket = wg.resolveTicket(id);
      sendJson(res, 200, {
        comments: wg.listReviewComments(ticket.id, { open: on(q.open), anchors: on(q.anchors) }),
        counts: wg.reviewCommentSvc.counts(ticket.id),
        ...(ticket.status === "in_review" ? { reject_outcome: wg.rejectOutcome(ticket.id) } : {}),
      });
      return;
    }
    if (method === "POST") {
      const body = createReviewCommentBody.parse(await readJsonBody(req));
      const comment = wg.createReviewComment(id, body, apiActor());
      // REVIEW RULES (D6): a person's must-fix comment may complete a repeated rule,
      // proposed once this response is sent (fail-soft, never in the person's way).
      if (comment.severity === "must_fix") proposeRulesAfterResponse(res, wg, memoryReader);
      sendCreated(res, `/tickets/${comment.ticket_id}/review/comments/${comment.id}`, {
        comment,
      });
      return;
    }
    methodNotAllowed(res);
    return;
  }

  // /tickets/:id/review/comments/:cid/(resolve|reopen|withdraw) — a human act.
  if (
    segments.length === 6 &&
    sub === TICKET_SUB.REVIEW &&
    segments[3] === "comments" &&
    method === "POST"
  ) {
    const action = segments[5] as string;
    if (action === "resolve" || action === "reopen" || action === "withdraw") {
      reviewCommentStateBody.parse(await readJsonBody(req));
      const comment = wg.setReviewCommentState(segments[4] as string, action, apiActor(), id);
      sendJson(res, 200, { comment });
      return;
    }
  }

  // FIX THESE (A2): /tickets/:id/review/fix — send back with the open must-fix comments as
  // numbered requirements (rejectReview with a deterministic reason). Answers the settled
  // `reject_outcome`, the way approve answers `approve_outcome`.
  if (segments.length === 4 && sub === TICKET_SUB.REVIEW && segments[3] === "fix") {
    if (method !== "POST") {
      methodNotAllowed(res);
      return;
    }
    const body = fixTheseBody.parse(await readJsonBody(req));
    const result = wg.fixThese(
      id,
      {
        ...(body.comment_ids ? { commentIds: body.comment_ids } : {}),
        ...(body.to ? { to: body.to } : {}),
      },
      apiActor(),
    );
    sendJson(res, 200, {
      ticket: result.ticket,
      event_id: result.eventId,
      requirements: result.requirements,
      reject_outcome: result.rejectOutcome,
      ...(result.landedAlready.length > 0 ? { landed_already: result.landedAlready } : {}),
    });
    return;
  }

  // /tickets/:id/review/(approve|reject)
  if (segments.length === 4 && sub === TICKET_SUB.REVIEW && method === "POST") {
    const action = segments[3] as string;
    if (action === "approve") {
      // STALE REVISION (external review #2): the approval names the commit(s) the Review
      // view rendered; the service refuses with 409 stale_revision when a branch moved
      // since, and 409 revision_required when no commit was named.
      const body = approveReviewBody.parse(await readJsonBody(req));
      const result = wg.approveReview(id, apiActor(), {
        commits: (body.commits ?? []).map((c) => ({ repo: c.repo ?? null, sha: c.sha })),
        requireCommits: true,
      });
      // The ticket has reached `ready_for_merge` via the review-approve path (NOT
      // `done` — `done` means the merge actually landed). When AUTO_MERGE ("Auto-merge on
      // approval") is ON, fire the configured merge command (fire-and-forget; logged,
      // never fatal): it does the git merge and then calls `wg ticket mark-merged <n> --as
      // system` (ready_for_merge -> done). Skips silently when unconfigured.
      //
      // When AUTO_MERGE is OFF (the default) the approval does NOT merge: the ticket waits
      // at ready_for_merge for the human to press Merge (POST /tickets/:id/merge, the
      // dashboard's "Merge now", or `gaffer merge <n>`) — what the setting promises
      // ("Off → approved tickets wait at ready-for-merge for a human"). It used to merge
      // regardless, so the switch did nothing in the off direction.
      //
      // GRADUATED-AUTONOMY: this REST approve is the HUMAN merge gate. apiActor() is the
      // hardcoded human actor (the dashboard Approve is the ONLY REST approver; the AFK
      // runner approves through the CLI as an agent actor, never REST). The agent ship
      // floor (envAllowsAuto('merge') = AUTO_MERGE AND MERGE_ON_AGENT_REVIEW) governs the
      // RUNNER's unattended merge of AGENT approvals, NOT this one: a human approval needs
      // only AUTO_MERGE. mergeRunner still enforces DISPATCH_MERGE_CMD.
      //
      // THE TESTER ROUTE starts no merge: an approval that sent the ticket to in_testing
      // (GAFFER_TESTING on and testable, or an epic's acceptance ticket) has not reached
      // ready_for_merge, so nothing may land it yet; the tester's PASS moves it on and the
      // merge lane (or Merge now) lands it from there. Firing the merge runner here spawned
      // a merge the landing refuses, under a button that said "not to merge".
      let merge: { triggered: boolean; pid: number | null; skipped?: string } | undefined;
      const number = result.ticket.number;
      if (number !== null && result.ticket.status === "ready_for_merge") {
        merge = envFlagOn(process.env[AUTO_MERGE_ENV])
          ? mergeRunner.trigger({ ticketNumber: number })
          : { triggered: false, pid: null, skipped: "auto_merge_off" };
        noteMerge(wg, result.ticket.id, merge);
      }
      // What the click actually did, in the words the Review view's done band uses: the
      // predicted outcome settled against the real route (tester, merge started/skipped).
      // Best-effort: the approval has already happened, so a read failure here only
      // leaves the field off (the dashboard falls back to the status and merge result).
      let approveOutcome: ReturnType<typeof settleApproveOutcome> | undefined;
      try {
        approveOutcome = settleApproveOutcome(
          wg.approveOutcomeFacts(result.ticket.id, {
            mergeCommand: mergeRunner.configured?.() ?? false,
            ci: false,
          }),
          { toStatus: result.ticket.status, merge },
        );
      } catch {
        approveOutcome = undefined;
      }
      sendJson(res, 200, {
        // An approval that reached ready_for_merge carries its landing_state, so the
        // Review view's status says what the ticket page and the board say.
        ticket: { ...result.ticket, ...withLanding(wg, result.ticket) },
        event_id: result.eventId,
        ...(merge ? { merge } : {}),
        ...(approveOutcome ? { approve_outcome: approveOutcome } : {}),
      });
      return;
    }
    if (action === "reject") {
      const body = rejectReviewBody.parse(await readJsonBody(req));
      const result = wg.rejectReview(id, body.to, apiActor(), body.reason);
      // REVIEW RULES (D6): a person's send-back reason may complete a repeated rule, which is
      // proposed as a lore draft (never auto-approved) once this response is sent.
      proposeRulesAfterResponse(res, wg, memoryReader);
      // OPT-IN: capture the reviewer's rejection reason as a lore DRAFT (human-gated) so
      // the highest-signal human correction compounds into memory. FAIL-SOFT — a memory
      // outage must never affect the rejection, which has already succeeded. Files via the
      // memory CLI `suggest` (a draft in the review queue), NEVER a memory-DB write.
      let loreCapture:
        | { captured: boolean; id?: string | null; repo?: string | null; reason?: string }
        | undefined;
      if (body.captureLore) {
        const t = result.ticket;
        const summary = `Review rejection of #${t.number} "${t.title}": ${body.reason}`;
        // Scope it to the ticket's write repo: the Memory view lists lore per repo, so a
        // repo-less draft was on no page at all (the toast sent the human to a review
        // queue that never showed it). Best-effort — no write repo leaves it unscoped.
        let repo: string | undefined;
        try {
          const repos = wg.view(t.id).repositories;
          repo = (repos.find((r) => r.access === "write") ?? repos[0])?.name;
        } catch {
          repo = undefined;
        }
        const draft = memoryReader.captureLoreDraft({
          title: `Review feedback: #${t.number} ${t.title}`.slice(0, 200),
          summary: summary.slice(0, 20_000),
          ...(repo ? { repo } : {}),
          tags: ["review-rejection", `ticket-${t.number}`],
        });
        if (draft.available) forgetLoreDrafts(memoryReader); // a new draft for the queue
        // `repo` says where the draft waits, so the dashboard can name it and link there.
        loreCapture = draft.available
          ? { captured: true, id: draft.id, repo: repo ?? null }
          : { captured: false, reason: draft.reason };
      }
      sendJson(res, 200, {
        ticket: result.ticket,
        event_id: result.eventId,
        ...(loreCapture ? { lore_capture: loreCapture } : {}),
        // REVOCATION-SAFE LANDING: landings that had started before the rejection.
        ...(result.landedAlready.length > 0 ? { landed_already: result.landedAlready } : {}),
      });
      return;
    }
  }

  // /tickets/:id/mark-merged — MERGE-COMPLETE callback (ready_for_merge -> done).
  // The merge runner calls this once the git merge of the delivery branch lands,
  // so `done` means actually merged. The service allows only system/admin (a board
  // drag can never reach this). The shared token acts as admin (dispatch-api); a named
  // principal needs actor type admin and acts under its OWN id, so the event names who
  // marked it merged; a human principal is refused, as the CLI refuses it `--as admin`.
  if (segments.length === 3 && sub === TICKET_SUB.MARK_MERGED && method === "POST") {
    const result = wg.markMerged(id, operatorActor("Marking a ticket merged"));
    sendJson(res, 200, { ticket: result.ticket, event_id: result.eventId });
    return;
  }

  // /tickets/:id/merge — MERGE an approved ticket that has not landed. Tickets sit in
  // ready_for_merge after the runner's approve-only AFK path (merge gate held), lite
  // mode, or a merge that hit a conflict / dirty tree; before this route the only
  // board action was "Mark merged", which flips to done WITHOUT merging code. This
  // fires the same merge runner the human Approve path uses. 409 unless the ticket
  // is actually in ready_for_merge.
  if (segments.length === 3 && sub === TICKET_SUB.MERGE && method === "POST") {
    const ticket = wg.resolveTicket(id);
    if (ticket.status !== "ready_for_merge") {
      throw new DispatchError(
        "ILLEGAL_TRANSITION",
        `Only a ticket in ready_for_merge can be merged (#${ticket.number ?? "?"} is ${ticket.status}).`,
      );
    }
    if (ticket.number === null) {
      throw new DispatchError("ILLEGAL_TRANSITION", "Ticket has no number; cannot start a merge.");
    }
    // IN-FLIGHT GUARD: one merge per ticket at a time. The check, the spawn and the
    // merge_started note run without an await between them, so two parallel requests
    // cannot both pass it.
    const inFlight = (): never => {
      throw new DispatchError(
        "MERGE_IN_FLIGHT",
        `A merge of #${ticket.number} is already running; nothing new was started. Wait for it to finish (its status reads "landing" meanwhile).`,
        { ticket_number: ticket.number },
      );
    };
    if (wg.mergeInFlight(ticket.id)) inFlight();
    const merge = mergeRunner.trigger({ ticketNumber: ticket.number });
    if (merge.skipped === "in_flight") inFlight();
    noteMerge(wg, ticket.id, merge);
    sendJson(res, 202, { ticket, merge });
    return;
  }

  // GATE INTEGRITY: /tickets/:id/allow-test-changes — a HUMAN allows (or withdraws the
  // allowance for) this ticket to change its tests. The service refuses agent and
  // system principals, so an agent token cannot excuse its own test edits.
  if (segments.length === 3 && sub === TICKET_SUB.ALLOW_TEST_CHANGES && method === "POST") {
    const body = allowTestChangesBody.parse(await readJsonBody(req));
    const result = wg.setAllowTestChanges(id, body.allow_test_changes, apiActor(), body.reason);
    sendJson(res, 200, {
      ticket_id: result.ticketId,
      allow_test_changes: result.allowTestChanges,
      event_id: result.eventId,
    });
    return;
  }

  // REVIEW TELEMETRY: /tickets/:id/review-opened — the Review view's once-per-round "a
  // person rendered this ticket in review" mark, and /review-raw-opened {what} for a raw
  // log, the evidence in full or the full diff. Human or admin only (the service refuses
  // an agent or the runner; a read token never reaches here). Never bumps updated_at.
  if (segments.length === 3 && sub === TICKET_SUB.REVIEW_OPENED && method === "POST") {
    const body = reviewOpenedBody.parse(await readJsonBody(req));
    const r = wg.recordReviewOpened(id, apiActor(), body.round_entered_at ?? null);
    sendJson(res, 200, {
      ticket_id: r.ticketId,
      recorded: r.recorded,
      reason: r.reason,
      event_id: r.eventId,
      round_entered_at: r.roundEnteredAt,
    });
    return;
  }
  // ESCAPED DEFECTS (MF5): /tickets/:id/regression-of {of, note?, withdraw?}: a person says
  // this ticket (a defect or its fix) regresses the accepted change `of`, or takes that
  // back. Human or admin only (the service refuses an agent or the runner; a read token
  // never reaches here). A measurement for Health; nothing gates on it.
  if (segments.length === 3 && sub === TICKET_SUB.REGRESSION_OF && method === "POST") {
    const body = regressionOfBody.parse(await readJsonBody(req));
    // PRINCIPAL SCOPES: the scope gate checked this ticket; the change it names must be
    // in scope too, or a scoped principal could mark changes it cannot see.
    const visible = requestTicketFilter(wg);
    if (visible && !visible(wg.resolveTicket(body.of).id))
      throw new DispatchError("SCOPE_DENIED", "That ticket is outside this principal's scope.", {
        of: body.of,
      });
    const r = body.withdraw
      ? wg.withdrawRegression(id, body.of, apiActor())
      : wg.fileRegression(id, body.of, apiActor(), body.note ?? null);
    sendJson(res, 200, {
      ticket_id: r.ticketId,
      regression_of: r.regressionOf,
      recorded: r.recorded,
      withdrawn: Boolean(body.withdraw),
      event_id: r.eventId,
    });
    return;
  }
  if (segments.length === 3 && sub === TICKET_SUB.REVIEW_RAW_OPENED && method === "POST") {
    const body = reviewRawOpenedBody.parse(await readJsonBody(req));
    const r = wg.recordReviewRawOpened(id, body.what, apiActor(), body.round_entered_at ?? null);
    sendJson(res, 200, {
      ticket_id: r.ticketId,
      recorded: r.recorded,
      reason: r.reason,
      event_id: r.eventId,
      round_entered_at: r.roundEnteredAt,
    });
    return;
  }

  // BLINDING: /tickets/:id/judge-revealed — a person opened the eval judge's collapsed view
  // ("Show the judge's view") of a ticket in review. Once per round; the same rules as
  // review-opened. Judge agreement counts a decision after it apart from blind ones.
  if (segments.length === 3 && sub === TICKET_SUB.JUDGE_REVEALED && method === "POST") {
    const body = reviewOpenedBody.parse(await readJsonBody(req));
    const r = wg.recordJudgeRevealed(id, apiActor(), body.round_entered_at ?? null);
    sendJson(res, 200, {
      ticket_id: r.ticketId,
      recorded: r.recorded,
      reason: r.reason,
      event_id: r.eventId,
      round_entered_at: r.roundEnteredAt,
    });
    return;
  }

  // BBT-001: /tickets/:id/testable — set the independent-testing eligibility flag.
  if (segments.length === 3 && sub === TICKET_SUB.TESTABLE && method === "POST") {
    const body = setTestableBody.parse(await readJsonBody(req));
    const result = wg.setTestable(id, body.can_be_tested, apiActor());
    sendJson(res, 200, {
      ticket_id: result.ticketId,
      can_be_tested: result.canBeTested,
      event_id: result.eventId,
      // DEPRECATED camelCase twins of the snake_case keys above (every sibling route
      // answers in snake_case). Kept for one release so existing clients keep working.
      ticketId: result.ticketId,
      canBeTested: result.canBeTested,
      eventId: result.eventId,
    });
    return;
  }

  // BBT-001: /tickets/:id/test-contract — record the testing handover artifact.
  if (segments.length === 3 && sub === TICKET_SUB.TEST_CONTRACT && method === "POST") {
    const body = setTestContractBody.parse(await readJsonBody(req));
    const contract = wg.setTestContract(id, body, apiActor());
    sendJson(res, 200, { test_contract: contract });
    return;
  }

  // ACCEPTANCE PROFILE: a person sets how the tester's PASS is proven and the commands
  // the runner runs for it (human/admin only, enforced in the service).
  if (segments.length === 3 && sub === TICKET_SUB.ACCEPTANCE_PROFILE && method === "POST") {
    const body = acceptanceProfileBody.parse(await readJsonBody(req));
    const r = wg.setAcceptanceProfile(id, { profile: body.profile, spec: body.spec }, apiActor());
    sendJson(res, 200, {
      ticket_id: r.ticketId,
      profile: r.profile,
      test_contract: r.contract,
      event_id: r.eventId,
    });
    return;
  }

  // BBT-001: /tickets/:id/tester — record a tester verdict (pass → ready_for_merge,
  // fail → refining) as the calling principal. A human principal (the dashboard
  // button) records a WAIVER on an acceptance ticket, as the gate intends; an
  // automated caller must send the binding (tested_commit / contract_hash / replay)
  // or gets a 422 BINDING_REQUIRED. The merge stays the guarded mark-merged path.
  if (segments.length === 3 && sub === TICKET_SUB.TESTER && method === "POST") {
    const body = testerVerdictBody.parse(await readJsonBody(req));
    const verdictInput = {
      summary: body.summary,
      ...(body.uri ? { uri: body.uri } : {}),
      ...(body.tested_commit ? { tested_commit: body.tested_commit } : {}),
      ...(body.contract_hash ? { contract_hash: body.contract_hash } : {}),
      ...(body.replay ? { replay: body.replay } : {}),
      ...(body.acceptance_evidence ? { acceptance_evidence: body.acceptance_evidence } : {}),
    };
    const result =
      body.verdict === "pass"
        ? wg.testerPass(id, verdictInput, apiActor())
        : wg.testerFail(id, { ...verdictInput, ...(body.to ? { to: body.to } : {}) }, apiActor());
    sendJson(res, 200, { ticket: result.ticket, event_id: result.eventId });
    return;
  }

  // /tickets/:id/diff — diff-in-review: the real git diff per WRITE repo
  // (default-branch...delivery-branch) so a reviewer reads the change before
  // approving (and the resolved diff after a reopen-for-review).
  // `approve_outcome` rides along: the first step a human Approve would certainly take
  // now (tester · land now · next tick · waits for Merge now · held by CI), computed from
  // the settings and ticket state the approve path acts on, so the sign-off button can
  // name it. Only an in_review ticket can be approved, so only it carries one.
  if (segments.length === 3 && sub === TICKET_SUB.DIFF && method === "GET") {
    // SINCE YOUR REVIEW (A3): `?since=rejected` answers the interdiff from the latest reject
    // pin per write repo (or `history_rewritten: true`). A reading aid: it carries no
    // approve_outcome, and an approval still binds to the whole change's heads.
    const since = url.searchParams.get("since");
    if (since !== null) {
      if (since !== "rejected") {
        throw new DispatchError("VALIDATION_ERROR", "since takes one value: rejected.", {
          since,
        });
      }
      sendJson(res, 200, wg.ticketDiffSince(id));
      return;
    }
    // CHANGE IMPACT: each repo's Behavioural surface facts, for a ticket in review (the
    // Review view's read) or on request (`?include=impact`). Advisory; bounded git reads.
    const ticket = wg.resolveTicket(id);
    const diff = wg.ticketDiff(id, {
      impact: ticket.status === "in_review" || url.searchParams.get("include") === "impact",
    });
    sendJson(res, 200, {
      ...diff,
      ...(ticket.status === "in_review"
        ? {
            approve_outcome: wg.approveOutcome(ticket.id, {
              mergeCommand: mergeRunner.configured?.() ?? false,
              repos: diff.repos, // the integrity holds read the diff just computed
            }),
            // FIX THESE (A2): what a send-back with the open must-fix comments does now.
            reject_outcome: wg.rejectOutcome(ticket.id),
          }
        : {}),
    });
    return;
  }

  // A3: /tickets/:id/heads — each write repo's delivery head, from rev-parse alone, so the
  // Review view can poll whether the change moved under the reader without a diff.
  if (segments.length === 3 && sub === TICKET_SUB.HEADS && method === "GET") {
    sendJson(res, 200, wg.ticketHeads(id));
    return;
  }

  // DELIVERY-DOSSIER: /tickets/:id/dossier — the tamper-evident evidence artifact
  // assembled from existing recorded state. READ-ONLY (pure assemble + hash; no
  // write), so it is reachable by a read-scoped token under the method-based gate;
  // recording the hash as an event is the CLI's job (the mutation surface). JSON by
  // default; `?format=markdown` or `Accept: text/markdown` returns the rendered view.
  if (segments.length === 3 && sub === TICKET_SUB.DOSSIER && method === "GET") {
    const dossier = wg.dossier(id);
    const wantsMarkdown =
      url.searchParams.get("format") === "markdown" ||
      (req.headers.accept ?? "").includes("text/markdown");
    if (wantsMarkdown) {
      res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
      res.end(wg.dossierSvc.renderMarkdown(dossier));
      return;
    }
    // REVIEW PACKET (opt-in, `?include=packet`): the Review view's verdict strip and
    // criteria table, beside the dossier and OUTSIDE its hashed subject (the cost reads
    // the live usage ledger). The plain export stays exactly the dossier.
    if (url.searchParams.get("include") === "packet") {
      sendJson(res, 200, {
        ...dossier,
        review_packet: wg.reviewPacket(id, (n) => ticketCostInfo(n)),
      });
      return;
    }
    sendJson(res, 200, dossier);
    return;
  }

  // /tickets/:id/reopen-for-review — auto-merge re-approval callback
  // (done -> in_review). System/admin only; records the resolver's resolution under
  // the calling principal's id; a human principal is refused (see operatorActor).
  if (segments.length === 3 && sub === TICKET_SUB.REOPEN_FOR_REVIEW && method === "POST") {
    const body = reopenForReviewBody.parse(await readJsonBody(req));
    const result = wg.reopenForReview(
      id,
      {
        reason: body.reason,
        resolution: body.resolution,
        ...(body.cause ? { cause: body.cause } : {}),
      },
      operatorActor("Reopening a ticket for review"),
    );
    sendJson(res, 200, {
      ticket_id: result.ticketId,
      status: result.status,
      event_id: result.eventId,
    });
    return;
  }

  // /tickets/:id/wont-do — mark a ticket terminal "won't do" (-> cancelled
  // bucket). Guarded: rejected for in-flight/claimed tickets and resets the ACs.
  if (segments.length === 3 && sub === TICKET_SUB.WONT_DO && method === "POST") {
    const body = wontDoBody.parse(await readJsonBody(req));
    const result = wg.wontDo(id, apiActor(), body.reason);
    sendJson(res, 200, {
      ticket: result.ticket,
      event_id: result.eventId,
      // REVOCATION-SAFE LANDING: landings that had started before the won't-do.
      ...(result.landedAlready.length > 0 ? { landed_already: result.landedAlready } : {}),
    });
    return;
  }

  // /tickets/:id/reopen — pull a won't-do (cancelled) ticket back into the
  // pipeline (-> refining by default, or draft).
  if (segments.length === 3 && sub === TICKET_SUB.REOPEN && method === "POST") {
    const body = reopenWontDoBody.parse(await readJsonBody(req));
    const result = wg.reopenFromWontDo(id, body.to, apiActor());
    sendJson(res, 200, { ticket: result.ticket, event_id: result.eventId });
    return;
  }

  // PAUSE-ON-CAP: /tickets/:id/continue — one-click Continue a paused (cap-hit)
  // delivery. Marks the paused ticket resume-requested so the factory loop re-enters
  // delivery in the existing worktree. 409 if the ticket isn't paused.
  if (segments.length === 3 && sub === TICKET_SUB.CONTINUE && method === "POST") {
    continuePausedBody.parse(await readJsonBody(req));
    const result = wg.continuePaused(id, apiActor());
    sendJson(res, 200, {
      ticket_id: result.ticketId,
      event_id: result.eventId,
      resume_requested: true,
    });
    return;
  }

  // PAUSE-ON-CAP: /tickets/:id/stop — abandon a paused delivery (-> cancelled),
  // dropping the resume context; the runner reaps the worktree. 409 if not paused.
  if (segments.length === 3 && sub === TICKET_SUB.STOP && method === "POST") {
    const body = stopPausedBody.parse(await readJsonBody(req));
    const result = wg.stopPaused(id, apiActor(), body.reason);
    sendJson(res, 200, { ticket: result.ticket, event_id: result.eventId });
    return;
  }

  // /tickets/:id/ready-approval — grant the regulated-pack human ready-approval.
  if (segments.length === 3 && sub === TICKET_SUB.READY_APPROVAL && method === "POST") {
    await readNoBody(req);
    const result = wg.grantReadyApproval(id, apiActor());
    sendJson(res, 200, { ticket_id: result.ticketId, event_id: result.eventId });
    return;
  }

  // /tickets/:id/delivery-artifact — record where the ticket was delivered.
  if (segments.length === 3 && sub === TICKET_SUB.DELIVERY_ARTIFACT && method === "POST") {
    const ticket = wg.resolveTicket(id);
    const body = recordDeliveryArtifactBody.parse(await readJsonBody(req));
    const result = wg.recordDeliveryArtifact(
      {
        ticket_id: ticket.id,
        branch_name: body.branch_name,
        pr_url: body.pr_url,
        commit: body.commit,
        diff_summary: body.diff_summary,
      },
      apiActor(),
    );
    sendJson(res, 200, {
      ticket_id: result.ticketId,
      branch_name: result.branchName,
      pr_url: result.prUrl,
      event_id: result.eventId,
    });
    return;
  }

  // /tickets/:id/reviewer — assign the reviewer the strict packs gate on.
  // A named principal names a REAL reviewer: a registered agent's id or a live
  // principal's actor id (a made-up id would satisfy the strict packs' "has a reviewer"
  // gate with nobody). A scoped principal names only itself or the reviewer already on
  // the ticket, so it cannot pick who reviews its own work. The shared operator token
  // is operator trust, like the tokenless CLI's `--reviewer <your-name>`: unchanged.
  if (segments.length === 3 && sub === TICKET_SUB.REVIEWER && method === "PUT") {
    const body = assignReviewerBody.parse(await readJsonBody(req));
    const principal = isSharedOperator() ? null : apiPrincipal();
    if (principal) {
      const reviewer = body.reviewer.trim();
      const current = wg.resolveTicket(id).reviewer;
      if (principal.scope && reviewer !== principal.actor_id && reviewer !== current) {
        throw new DispatchError(
          "ACTOR_NOT_PERMITTED",
          `A scoped principal assigns only itself ('${principal.actor_id}') or the reviewer already on the ticket${current ? ` ('${current}')` : ""}; '${reviewer}' is someone else.`,
          { principal: principal.name, reviewer, current_reviewer: current },
        );
      }
      const known =
        reviewer === current ||
        wg.db.prepare("SELECT 1 FROM agents WHERE id = ? LIMIT 1").get(reviewer) !== undefined ||
        wg.listPrincipals().some((p) => p.revoked_at === null && p.actor_id === reviewer);
      if (!known) {
        throw new DispatchError(
          "VALIDATION_ERROR",
          `Reviewer '${reviewer}' is not a registered agent or principal; name one (wg agent list, principal list).`,
          { reason: "unknown_reviewer", reviewer },
        );
      }
    }
    const result = wg.assignReviewer(id, body.reviewer, apiActor());
    sendJson(res, 200, {
      ticket_id: result.ticketId,
      reviewer: result.reviewer,
      event_id: result.eventId,
    });
    return;
  }

  // /tickets/:id/required-capabilities — GET the set, or PUT to replace it.
  if (segments.length === 3 && sub === TICKET_SUB.REQUIRED_CAPABILITIES) {
    if (method === "GET") {
      sendJson(res, 200, { capabilities: wg.listRequiredCapabilities(id) });
      return;
    }
    if (method === "PUT") {
      const ticket = wg.resolveTicket(id);
      const body = setRequiredCapabilitiesBody.parse(await readJsonBody(req));
      const result = wg.setRequiredCapabilities(
        { ticket_id: ticket.id, capabilities: body.capabilities },
        apiActor(),
      );
      sendJson(res, 200, { capabilities: result.capabilities, event_id: result.eventId });
      return;
    }
    methodNotAllowed(res);
    return;
  }

  // --- WG-001: ticket scope links ------------------------------------------

  // /tickets/:id/scopes — GET links, POST to link a scope node.
  if (segments.length === 3 && sub === TICKET_SUB.SCOPES) {
    if (method === "GET") {
      sendJson(res, 200, { scopes: wg.listTicketScopes(id) });
      return;
    }
    if (method === "POST") {
      const ticket = wg.resolveTicket(id);
      const body = linkTicketScopeBody.parse(await readJsonBody(req));
      const link = wg.linkTicketScope({ ticket_id: ticket.id, ...body }, apiActor());
      sendJson(res, 201, { scope: link });
      return;
    }
    methodNotAllowed(res);
    return;
  }

  // /tickets/:id/scopes/:nodeId — DELETE a ticket↔scope link.
  if (segments.length === 4 && sub === TICKET_SUB.SCOPES && method === "DELETE") {
    const result = wg.removeTicketScope(id, segments[3] as string, apiActor());
    sendJson(res, 200, {
      ticket_id: result.ticketId,
      scope_node_id: result.scopeNodeId,
      event_id: result.eventId,
    });
    return;
  }

  // /tickets/:id/dependencies — GET this ticket's dependencies, POST to add one.
  if (segments.length === 3 && sub === TICKET_SUB.DEPENDENCIES) {
    if (method === "GET") {
      sendJson(res, 200, {
        dependencies: hideOutOfScopeDependencies(wg.listDependencies(id), requestTicketFilter(wg)),
      });
      return;
    }
    if (method === "POST") {
      const ticket = wg.resolveTicket(id);
      const body = addTicketDependencyBody.parse(await readJsonBody(req));
      const result = wg.addDependency(
        { ticket: ticket.id, depends_on: body.depends_on },
        apiActor(),
      );
      sendJson(res, 201, {
        ticket_id: result.ticketId,
        depends_on_ticket_id: result.dependsOnTicketId,
        event_id: result.eventId,
      });
      return;
    }
    methodNotAllowed(res);
    return;
  }

  // /tickets/:id/dependencies/:dependsOnRef — DELETE one dependency edge.
  if (segments.length === 4 && sub === TICKET_SUB.DEPENDENCIES && method === "DELETE") {
    const result = wg.removeDependency(id, segments[3] as string, apiActor());
    sendJson(res, 200, {
      ticket_id: result.ticketId,
      depends_on_ticket_id: result.dependsOnTicketId,
      event_id: result.eventId,
    });
    return;
  }

  // /tickets/:id/primary-scope — PUT to mark a scope node primary.
  if (segments.length === 3 && sub === TICKET_SUB.PRIMARY_SCOPE && method === "PUT") {
    const body = setPrimaryScopeBody.parse(await readJsonBody(req));
    const link = wg.setPrimaryScope(id, body.scope_node_id, apiActor());
    sendJson(res, 200, { scope: link });
    return;
  }

  // --- WG-002: ticket↔repo access boundaries -------------------------------

  // /tickets/:id/repo-access — PUT to set a repo's access boundary.
  if (segments.length === 3 && sub === TICKET_SUB.REPO_ACCESS && method === "PUT") {
    const ticket = wg.resolveTicket(id);
    const body = setTicketRepoAccessBody.parse(await readJsonBody(req));
    const result = wg.setTicketRepoAccess({ ticket_id: ticket.id, ...body }, apiActor());
    sendJson(res, 200, {
      ticket_id: result.ticketId,
      repo_id: result.repoId,
      access: result.access,
      relation: result.relation,
      event_id: result.eventId,
    });
    return;
  }

  // /tickets/:id/work-repos — GET the partitioned execution boundary.
  if (segments.length === 3 && sub === TICKET_SUB.WORK_REPOS && method === "GET") {
    sendJson(res, 200, { work_repos: wg.workPacketRepos(id) });
    return;
  }

  // /tickets/:id/mono-fallback — POST to promote a single unmapped repo to write.
  if (segments.length === 3 && sub === TICKET_SUB.MONO_FALLBACK && method === "POST") {
    await readNoBody(req);
    const result = wg.applyMonoFallback(id, apiActor()) as {
      applied: boolean;
      ticketId: string;
      repoId?: string;
      reason?: string;
      eventId?: string;
    };
    sendJson(res, 200, {
      applied: result.applied,
      ticket_id: result.ticketId,
      ...(result.repoId !== undefined ? { repo_id: result.repoId } : {}),
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
      ...(result.eventId !== undefined ? { event_id: result.eventId } : {}),
      // DEPRECATED camelCase twins (see /testable), kept for one release.
      ticketId: result.ticketId,
      ...(result.repoId !== undefined ? { repoId: result.repoId } : {}),
      ...(result.eventId !== undefined ? { eventId: result.eventId } : {}),
    });
    return;
  }

  // --- FG-005: scope→repo suggestions --------------------------------------

  // /tickets/:id/repo-suggestions — GET advisory repo suggestions for the ticket.
  if (segments.length === 3 && sub === TICKET_SUB.REPO_SUGGESTIONS && method === "GET") {
    const ticket = wg.resolveTicket(id);
    const suggestions = wg.suggestReposForTicket({ ticketId: ticket.id }, apiActor());
    sendJson(res, 200, { suggestions });
    return;
  }

  // --- WG-004: claimability (readiness preview) ----------------------------

  // /tickets/:id/claimability — GET {ready, blockers, warnings} from the gate.
  if (segments.length === 3 && sub === TICKET_SUB.CLAIMABILITY && method === "GET") {
    sendJson(res, 200, wg.claimability(id));
    return;
  }

  // --- WG-005: per-repo delivery artifacts ---------------------------------

  // /tickets/:id/repo-deliveries — GET the per-repo delivery list, POST to record one.
  if (segments.length === 3 && sub === TICKET_SUB.REPO_DELIVERIES) {
    if (method === "GET") {
      sendJson(res, 200, { deliveries: wg.listRepoDeliveries(id) });
      return;
    }
    if (method === "POST") {
      const ticket = wg.resolveTicket(id);
      const body = recordRepoDeliveryBody.parse(await readJsonBody(req));
      const result = wg.recordRepoDelivery({ ticket_id: ticket.id, ...body }, apiActor());
      sendJson(res, 201, { delivery: result.delivery, event_id: result.eventId });
      return;
    }
    methodNotAllowed(res);
    return;
  }

  sendJson(
    res,
    404,
    errorBody("NOT_FOUND", `No ticket route for ${method} /${segments.join("/")}.`),
  );
}

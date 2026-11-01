import type { IncomingMessage, ServerResponse } from "node:http";

import type { Dispatch } from "../../core.js";
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
  reopenWontDoBody,
  setPrimaryScopeBody,
  setRequiredCapabilitiesBody,
  setTestableBody,
  allowTestChangesBody,
  setTestContractBody,
  setTicketRepoAccessBody,
  stopPausedBody,
  testerVerdictBody,
  ticketListQuery,
  wontDoBody,
} from "../schemas.js";
import { API_ACTOR, apiActor, isSharedOperator, operatorActor } from "./context.js";
import { forgetLoreDrafts } from "./readModels.js";
import { requestTicketFilter } from "../scopeGate.js";

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
  // GATE INTEGRITY: the human's per-ticket "this ticket may change its tests" flag.
  ALLOW_TEST_CHANGES: "allow-test-changes",
  TESTER: "tester",
} as const;

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
            const from = q.offset ?? 0;
            return {
              tickets: q.limit !== undefined ? all.slice(from, from + q.limit) : all.slice(from),
              total: all.length,
            };
          })()
        : wg.listTicketPage(
            { status: q.status, repo: q.repo, risk: q.risk },
            { limit: q.limit, offset: q.offset, summary: q.fields === "summary" },
          );
      sendJson(res, 200, {
        // Approved and held tickets carry `landing_state` (their truthful status label).
        tickets: page.tickets.map((t) =>
          t.status === "ready_for_merge" || t.status === "blocked"
            ? { ...t, ...withLanding(wg, t.id) }
            : t,
        ),
        total: page.total,
        ...(q.limit !== undefined ? { limit: q.limit, offset: q.offset ?? 0 } : {}),
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
  // drag can never reach this); a full-capability REST caller acts as admin under its
  // OWN principal id, so the event names who marked it merged.
  if (segments.length === 3 && sub === TICKET_SUB.MARK_MERGED && method === "POST") {
    const result = wg.markMerged(id, operatorActor());
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
    const diff = wg.ticketDiff(id);
    const ticket = wg.resolveTicket(id);
    sendJson(res, 200, {
      ...diff,
      ...(ticket.status === "in_review"
        ? {
            approve_outcome: wg.approveOutcome(ticket.id, {
              mergeCommand: mergeRunner.configured?.() ?? false,
              repos: diff.repos, // the integrity holds read the diff just computed
            }),
          }
        : {}),
    });
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
  // the calling principal's id (see operatorActor).
  if (segments.length === 3 && sub === TICKET_SUB.REOPEN_FOR_REVIEW && method === "POST") {
    const body = reopenForReviewBody.parse(await readJsonBody(req));
    const result = wg.reopenForReview(
      id,
      { reason: body.reason, resolution: body.resolution },
      operatorActor(),
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
  if (segments.length === 3 && sub === TICKET_SUB.REVIEWER && method === "PUT") {
    const body = assignReviewerBody.parse(await readJsonBody(req));
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

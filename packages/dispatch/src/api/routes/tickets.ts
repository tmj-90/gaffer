import type { IncomingMessage, ServerResponse } from "node:http";

import type { Dispatch } from "../../core.js";
import { DispatchError } from "../../util/errors.js";
import { errorBody, methodNotAllowed, readJsonBody, sendCreated, sendJson } from "../http.js";
import type { MemoryReader } from "../memoryReader.js";
import type { MergeRunner } from "../mergeRunner.js";
import {
  addAcBody,
  addTicketDependencyBody,
  assignReviewerBody,
  continuePausedBody,
  createTicketBody,
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
  setTestContractBody,
  setTicketRepoAccessBody,
  stopPausedBody,
  testerVerdictBody,
  ticketListQuery,
  wontDoBody,
} from "../schemas.js";
import { API_ACTOR } from "./context.js";

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
  DIFF: "diff",
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
  TESTER: "tester",
} as const;

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
      const q = ticketListQuery.parse({
        status: url.searchParams.get("status") ?? undefined,
        repo: url.searchParams.get("repo") ?? undefined,
        risk: url.searchParams.get("risk") ?? undefined,
      });
      sendJson(res, 200, { tickets: wg.listTickets(q) });
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
      const ticket = wg.createTicket(
        {
          title: body.title,
          description: body.description ?? "",
          priority: body.priority,
          risk_level: body.risk_level,
          policy_pack: body.policy_pack,
          source: body.source,
        },
        API_ACTOR,
      );
      // Legacy single-repo link (older callers / mono-fallback flows).
      if (body.repo) wg.linkRepository(ticket.id, body.repo, "primary", API_ACTOR);
      // Feature A: link the chosen scope node(s) — the first is primary so the
      // ticket lives under a product scope, the rest are secondary context.
      if (body.scopeNodeIds) {
        body.scopeNodeIds.forEach((scopeNodeId, i) => {
          wg.linkTicketScope(
            {
              ticket_id: ticket.id,
              scope_node_id: scopeNodeId,
              relation: i === 0 ? "primary" : "secondary",
            },
            API_ACTOR,
          );
        });
      }
      // Feature A: confirm each repo's access boundary so the ticket is
      // immediately deliverable (a write target exists) rather than repo-less.
      if (body.repoIds) {
        for (const r of body.repoIds) {
          wg.setTicketRepoAccess(
            { ticket_id: ticket.id, repo_id: r.repo_id, access: r.access, relation: "confirmed" },
            API_ACTOR,
          );
        }
      }
      sendCreated(res, `/tickets/${ticket.id}`, { ticket });
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
        ticket: view.ticket,
        acceptance_criteria: view.acceptanceCriteria,
        repositories: view.repositories,
        // `scopes` carries the ticket↔scope links (incl. its containing `epic`
        // node), so the Epics view can group tickets under their epic without a
        // new endpoint. The data is already computed by `view()`.
        scopes: view.scopes,
        blocking_decisions: view.blockingDecisions,
        dependencies: view.dependencies,
        evidence: view.evidence,
        events: view.events,
        // FAILURE-DIAGNOSIS: the full ordered "why did #N fail" trail.
        rework_trail: view.reworkTrail,
      });
      return;
    }
    methodNotAllowed(res);
    return;
  }

  const sub = segments[2] as string;

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
      },
      API_ACTOR,
    );
    sendJson(res, 201, { acceptance_criterion: ac, event_id: eventId });
    return;
  }

  // /tickets/:id/ready
  if (segments.length === 3 && sub === TICKET_SUB.READY && method === "POST") {
    const ticket = wg.resolveTicket(id);
    const result = wg.markReady(ticket.id, API_ACTOR);
    sendJson(res, 200, { ticket: result.ticket, event_id: result.eventId });
    return;
  }

  // /tickets/:id/move — human/admin board move (drag a card to a status column,
  // e.g. un-ready: ready -> draft). Guarded by the state machine + policy gates;
  // an illegal drop comes back as ILLEGAL_TRANSITION (409), a no-op as NO_OP.
  if (segments.length === 3 && sub === TICKET_SUB.MOVE && method === "POST") {
    const ticket = wg.resolveTicket(id);
    const body = moveTicketBody.parse(await readJsonBody(req));
    const result = wg.moveTicket(ticket.id, body.to, API_ACTOR);
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
    const result = wg.humanClaimTicket(ticket.id, API_ACTOR);
    sendJson(res, 200, { ticket_id: result.ticketId, number: result.number, human_owned: true });
    return;
  }

  // TRACK-2b: /tickets/:id/human-release — the operator hands a by-hand ticket back
  // to the queue (in_progress -> ready, clearing the ownership marker). 409 when the
  // ticket isn't human-owned in-flight work.
  if (segments.length === 3 && sub === TICKET_SUB.HUMAN_RELEASE && method === "POST") {
    humanClaimBody.parse(await readJsonBody(req));
    const ticket = wg.resolveTicket(id);
    const result = wg.humanReleaseTicket(ticket.id, API_ACTOR);
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
      const result = wg.approveReview(id, API_ACTOR);
      // The ticket has reached `ready_for_merge` via the review-approve path (NOT
      // `done` — `done` means the merge actually landed). Fire the configured
      // auto-merge command (fire-and-gaffert; logged, never fatal): it does the git
      // merge and then calls `wg ticket mark-merged <n> --as system`
      // (ready_for_merge -> done). Skips silently when unconfigured.
      let merge: { triggered: boolean; pid: number | null; skipped?: string } | undefined;
      const number = result.ticket.number;
      // GRADUATED-AUTONOMY (Spec 2, Phase 3): this REST approve is the HUMAN merge gate.
      // API_ACTOR is the hardcoded human actor (the dashboard Approve action is the ONLY
      // REST approver; the AFK runner approves through the CLI as an agent actor, never
      // REST). A human approval has ALWAYS auto-fired the configured merge, and MUST stay
      // byte-identical (Graduated-Autonomy invariant "human path byte-identical") even now
      // that envAllowsAuto('merge') is a BLOCKING floor — that floor governs the RUNNER's
      // unattended merge (runner/tick.sh, `wg ticket auto-decision --gate merge` + its own
      // git merge), NOT a human's explicit approval. So the human approve merges here
      // unconditionally, exactly as before. mergeRunner still enforces DISPATCH_MERGE_CMD.
      if (number !== null) {
        merge = mergeRunner.trigger({ ticketNumber: number });
      }
      sendJson(res, 200, {
        ticket: result.ticket,
        event_id: result.eventId,
        ...(merge ? { merge } : {}),
      });
      return;
    }
    if (action === "reject") {
      const body = rejectReviewBody.parse(await readJsonBody(req));
      const result = wg.rejectReview(id, body.to, API_ACTOR, body.reason);
      // OPT-IN: capture the reviewer's rejection reason as a lore DRAFT (human-gated) so
      // the highest-signal human correction compounds into memory. FAIL-SOFT — a memory
      // outage must never affect the rejection, which has already succeeded. Files via the
      // memory CLI `suggest` (a draft in the review queue), NEVER a memory-DB write.
      let loreCapture: { captured: boolean; id?: string | null; reason?: string } | undefined;
      if (body.captureLore) {
        const t = result.ticket;
        const summary = `Review rejection of #${t.number} "${t.title}": ${body.reason}`;
        // Repo is left for the human to scope on approval (the ticket tag links it) — the
        // Ticket domain object doesn't carry its repos inline, and this is fail-soft anyway.
        const draft = memoryReader.captureLoreDraft({
          title: `Review feedback: #${t.number} ${t.title}`.slice(0, 200),
          summary: summary.slice(0, 20_000),
          tags: ["review-rejection", `ticket-${t.number}`],
        });
        loreCapture = draft.available
          ? { captured: true, id: draft.id }
          : { captured: false, reason: draft.reason };
      }
      sendJson(res, 200, {
        ticket: result.ticket,
        event_id: result.eventId,
        ...(loreCapture ? { lore_capture: loreCapture } : {}),
      });
      return;
    }
  }

  // /tickets/:id/mark-merged — MERGE-COMPLETE callback (ready_for_merge -> done).
  // The merge runner calls this once the git merge of the delivery branch lands,
  // so `done` means actually merged. System/admin only (the REST surface acts as
  // the system actor); a user/board-drag can never reach this.
  if (segments.length === 3 && sub === TICKET_SUB.MARK_MERGED && method === "POST") {
    const result = wg.markMerged(id, { type: "system", id: "dispatch-api" });
    sendJson(res, 200, { ticket: result.ticket, event_id: result.eventId });
    return;
  }

  // BBT-001: /tickets/:id/testable — set the independent-testing eligibility flag.
  if (segments.length === 3 && sub === TICKET_SUB.TESTABLE && method === "POST") {
    const body = setTestableBody.parse(await readJsonBody(req));
    const result = wg.setTestable(id, body.can_be_tested, API_ACTOR);
    sendJson(res, 200, result);
    return;
  }

  // BBT-001: /tickets/:id/test-contract — record the testing handover artifact.
  if (segments.length === 3 && sub === TICKET_SUB.TEST_CONTRACT && method === "POST") {
    const body = setTestContractBody.parse(await readJsonBody(req));
    const contract = wg.setTestContract(id, body, API_ACTOR);
    sendJson(res, 200, { test_contract: contract });
    return;
  }

  // BBT-001: /tickets/:id/tester — record a tester verdict (pass → ready_for_merge,
  // fail → refining). The REST surface acts as the system actor here, recording the
  // tester's reported result; the actual merge stays the guarded mark-merged path.
  if (segments.length === 3 && sub === TICKET_SUB.TESTER && method === "POST") {
    const body = testerVerdictBody.parse(await readJsonBody(req));
    const testerActor = { type: "system" as const, id: "dispatch-api" };
    const verdictInput = { summary: body.summary, ...(body.uri ? { uri: body.uri } : {}) };
    const result =
      body.verdict === "pass"
        ? wg.testerPass(id, verdictInput, testerActor)
        : wg.testerFail(id, verdictInput, testerActor);
    sendJson(res, 200, { ticket: result.ticket, event_id: result.eventId });
    return;
  }

  // /tickets/:id/diff — diff-in-review: the real git diff per WRITE repo
  // (default-branch...delivery-branch) so a reviewer reads the change before
  // approving (and the resolved diff after a reopen-for-review).
  if (segments.length === 3 && sub === TICKET_SUB.DIFF && method === "GET") {
    sendJson(res, 200, wg.ticketDiff(id));
    return;
  }

  // /tickets/:id/reopen-for-review — auto-merge re-approval callback
  // (done -> in_review). System/admin only; records the resolver's resolution.
  if (segments.length === 3 && sub === TICKET_SUB.REOPEN_FOR_REVIEW && method === "POST") {
    const body = reopenForReviewBody.parse(await readJsonBody(req));
    const result = wg.reopenForReview(
      id,
      { reason: body.reason, resolution: body.resolution },
      // The REST surface acts as the system actor for this machine-driven path.
      { type: "system", id: "dispatch-api" },
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
    const result = wg.wontDo(id, API_ACTOR, body.reason);
    sendJson(res, 200, { ticket: result.ticket, event_id: result.eventId });
    return;
  }

  // /tickets/:id/reopen — pull a won't-do (cancelled) ticket back into the
  // pipeline (-> refining by default, or draft).
  if (segments.length === 3 && sub === TICKET_SUB.REOPEN && method === "POST") {
    const body = reopenWontDoBody.parse(await readJsonBody(req));
    const result = wg.reopenFromWontDo(id, body.to, API_ACTOR);
    sendJson(res, 200, { ticket: result.ticket, event_id: result.eventId });
    return;
  }

  // PAUSE-ON-CAP: /tickets/:id/continue — one-click Continue a paused (cap-hit)
  // delivery. Marks the paused ticket resume-requested so the factory loop re-enters
  // delivery in the existing worktree. 409 if the ticket isn't paused.
  if (segments.length === 3 && sub === TICKET_SUB.CONTINUE && method === "POST") {
    continuePausedBody.parse(await readJsonBody(req));
    const result = wg.continuePaused(id, API_ACTOR);
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
    const result = wg.stopPaused(id, API_ACTOR, body.reason);
    sendJson(res, 200, { ticket: result.ticket, event_id: result.eventId });
    return;
  }

  // /tickets/:id/ready-approval — grant the regulated-pack human ready-approval.
  if (segments.length === 3 && sub === TICKET_SUB.READY_APPROVAL && method === "POST") {
    const result = wg.grantReadyApproval(id, API_ACTOR);
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
      API_ACTOR,
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
    const result = wg.assignReviewer(id, body.reviewer, API_ACTOR);
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
        API_ACTOR,
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
      const link = wg.linkTicketScope({ ticket_id: ticket.id, ...body }, API_ACTOR);
      sendJson(res, 201, { scope: link });
      return;
    }
    methodNotAllowed(res);
    return;
  }

  // /tickets/:id/scopes/:nodeId — DELETE a ticket↔scope link.
  if (segments.length === 4 && sub === TICKET_SUB.SCOPES && method === "DELETE") {
    const result = wg.removeTicketScope(id, segments[3] as string, API_ACTOR);
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
      sendJson(res, 200, { dependencies: wg.listDependencies(id) });
      return;
    }
    if (method === "POST") {
      const ticket = wg.resolveTicket(id);
      const body = addTicketDependencyBody.parse(await readJsonBody(req));
      const result = wg.addDependency(
        { ticket: ticket.id, depends_on: body.depends_on },
        API_ACTOR,
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
    const result = wg.removeDependency(id, segments[3] as string, API_ACTOR);
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
    const link = wg.setPrimaryScope(id, body.scope_node_id, API_ACTOR);
    sendJson(res, 200, { scope: link });
    return;
  }

  // --- WG-002: ticket↔repo access boundaries -------------------------------

  // /tickets/:id/repo-access — PUT to set a repo's access boundary.
  if (segments.length === 3 && sub === TICKET_SUB.REPO_ACCESS && method === "PUT") {
    const ticket = wg.resolveTicket(id);
    const body = setTicketRepoAccessBody.parse(await readJsonBody(req));
    const result = wg.setTicketRepoAccess({ ticket_id: ticket.id, ...body }, API_ACTOR);
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
    const result = wg.applyMonoFallback(id, API_ACTOR);
    sendJson(res, 200, result);
    return;
  }

  // --- FG-005: scope→repo suggestions --------------------------------------

  // /tickets/:id/repo-suggestions — GET advisory repo suggestions for the ticket.
  if (segments.length === 3 && sub === TICKET_SUB.REPO_SUGGESTIONS && method === "GET") {
    const ticket = wg.resolveTicket(id);
    const suggestions = wg.suggestReposForTicket({ ticketId: ticket.id }, API_ACTOR);
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
      const result = wg.recordRepoDelivery({ ticket_id: ticket.id, ...body }, API_ACTOR);
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

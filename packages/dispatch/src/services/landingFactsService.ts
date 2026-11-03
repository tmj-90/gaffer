/**
 * WHAT HAPPENS ON APPROVE and WHERE AN APPROVED CHANGE IS: the facts the approve outcome
 * and the landing-state label are decided from (approveOutcome.ts and landingState.ts hold
 * the pure decisions), read from what the approve and landing paths themselves act on,
 * plus the merge-run bookkeeping the merge route reads.
 */
import { type Actor, type Ticket, isActiveTicketRepoRelation } from "../domain/types.js";
import { listEvents, writeEvent } from "../events/eventWriter.js";
import { type RepoDiff } from "./diffService.js";
import { readUsagePause } from "../health/usagePause.js";
import { computeLandingStatus, REVIEW_PIN_PREFIX, type LandingStatus } from "./landingStatus.js";
import { type TesterCoverage, unavailableRepoRemedy } from "./reviewGateService.js";
import { AUTO_MERGE_ENV, envFlagOn, isAutonomyAllowed } from "./autonomyPolicyService.js";
import {
  decideLandingState,
  type LandingFacts,
  type LandingHold,
  type LandingState,
} from "./landingState.js";
import {
  decideApproveOutcome,
  type ApproveOutcome,
  type ApproveOutcomeFacts,
  type ReviewMode,
} from "./approveOutcome.js";
import type { Dispatch } from "../core.js";
import { writeRepoIdsForTicket, resolveApprovedHeads } from "./ticketGitService.js";

/** What these functions read from the {@link Dispatch} facade they are handed. */
export type LandingFactsHost = Pick<
  Dispatch,
  | "approveOutcomeFacts"
  | "autonomyPolicy"
  | "db"
  | "evidence"
  | "landingFacts"
  | "landingState"
  | "observedRiskFor"
  | "repos"
  | "resolveTicket"
  | "reviewGateSvc"
  | "writeRepoHeads"
>;

/**
 * USAGE-WINDOW PAUSE as a landing fact: while the runner's pause file holds a pause no
 * tick runs, so the merge lane lands nothing until it ends (health/usagePause.ts reads
 * the file exactly as the runner does). Null when no pause is active.
 */
function usagePauseFact(
  env: NodeJS.ProcessEnv,
): { until: string; kind: "usage_limit" | "rate_limit" } | null {
  const p = readUsagePause(env);
  return p.active ? { until: p.paused_until ?? "its end", kind: p.kind ?? "usage_limit" } : null;
}

/**
 * WHAT HAPPENS ON APPROVE: the facts a HUMAN approve of this ticket acts on, read from
 * the same predicates the approve path uses — the tester route and the CI hold come from
 * ReviewGateService (the code approveReview runs), AUTO_MERGE as the approve route reads
 * it, the merge gate as the runner's merge lane asks it (the autonomyGateDecision
 * predicate), and the landing repos as every landing path plans them (the first write
 * repo with a local path lands first, then each other write repo with one; see
 * landingStatus.ts). `mergeCommand` is whether the API's merge runner has a command to
 * start (the caller holds the runner). The gate-integrity holds are the auto-ship
 * gate's own read (observedRiskFor); `approver: "agent"` asks what an agent or auto
 * approval would do. `ci: false` skips the CI and integrity reads (they run git) for an
 * approval that already happened; `repos` reuses a diff the caller already read.
 */
export function approveOutcomeFacts(
  host: LandingFactsHost,
  ref: string,
  opts: {
    mergeCommand: boolean;
    ci?: boolean;
    env?: NodeJS.ProcessEnv;
    approver?: "human" | "agent";
    repos?: readonly RepoDiff[];
  },
): ApproveOutcomeFacts {
  const env = opts.env ?? process.env;
  const ticket = host.resolveTicket(ref);
  // GATE INTEGRITY: the hard holds the auto-ship gate would raise (the same read). A
  // throw is indeterminate: the gate fails toward a human, and so does this fact.
  let testModifiedHolds: string[] = [];
  if (opts.ci !== false) {
    try {
      testModifiedHolds = [...(host.observedRiskFor(ticket, opts.repos).holds ?? [])];
    } catch {
      testModifiedHolds = ["the delivery diff could not be read to check its tests"];
    }
  }
  const writes = host.repos
    .listForTicket(ticket.id)
    .filter((l) => isActiveTicketRepoRelation(l.relation) && l.access === "write");
  const lands = writes.find((l) => l.local_path) ?? null;
  const mode = (env.REVIEW_MODE ?? "human").trim().toLowerCase();
  const method = (env.GAFFER_PR_MERGE_METHOD ?? "").trim().toLowerCase();
  const lane = (env.GAFFER_MERGE_LANE ?? "1").trim().toLowerCase();
  return {
    approver: opts.approver ?? "human",
    testModifiedHolds,
    ciHold: opts.ci === false ? null : host.reviewGateSvc.approveCiHold(ticket),
    // EVERY WRITE REPO: the same read approveReview refuses on (repo_unavailable).
    unavailableRepos:
      opts.ci === false
        ? []
        : host.reviewGateSvc.unavailableWriteRepos(ticket).map((m) => ({
            repo: m.repo,
            why: m.why,
            fix: unavailableRepoRemedy(m, ticket.number),
          })),
    // TESTER FIRST: whether the tester's PASS covers the head (git) — read only for an
    // approval still to come (ci !== false); the settle after an approval reads none.
    ...testerApproveFacts(host, ticket, opts.approver ?? "human", opts.ci !== false),
    acceptance: ticket.acceptance === 1,
    autoMerge: envFlagOn(env[AUTO_MERGE_ENV]),
    mergeCommand: opts.mergeCommand,
    mergeLane: !["0", "false", "no", "off"].includes(lane),
    mergeGateEarned: isAutonomyAllowed(
      host.autonomyPolicy,
      writeRepoIdsForTicket(host, ticket),
      ticket.risk_level,
      "merge",
      env,
    ),
    reviewMode: (["human", "agent", "both"].includes(mode) ? mode : "human") as ReviewMode,
    prMode: envFlagOn(env.GAFFER_CREATE_PR),
    prUrl: lands
      ? host.repos.ticketRepoPrUrl(ticket.id, lands.id) || ticket.pr_url || null
      : ticket.pr_url || null,
    prMergeMethod: ["merge", "squash", "rebase"].includes(method) ? method : "merge",
    landsRepo: lands ? lands.name : null,
    baseBranch: lands ? lands.default_branch || null : null,
    // PER-REPOSITORY LANDING: every other write repo with a checkout lands too (the
    // landing plan is the approved revisions with a local path, primary first).
    alsoLandsRepos: writes.filter((l) => l !== lands && l.local_path).map((l) => l.name),
    noCheckoutRepos: writes.filter((l) => !l.local_path).map((l) => l.name),
    // The same pause read as landing_state, so the line and the status agree.
    pause: usagePauseFact(env),
  };
}

/** TESTER FIRST facts for approveOutcomeFacts: route, hold, and the tested commit. */
export function testerApproveFacts(
  host: Pick<LandingFactsHost, "reviewGateSvc">,
  ticket: Ticket,
  approver: "human" | "agent",
  read: boolean,
): Pick<ApproveOutcomeFacts, "toTester" | "untested" | "testedCommit"> {
  if (!read || !host.reviewGateSvc.laneApplies(ticket)) {
    return { toTester: false, untested: null, testedCommit: null };
  }
  let cov: TesterCoverage;
  try {
    cov = host.reviewGateSvc.testerCoverage(ticket);
  } catch {
    cov = { covered: false, why: "no_verdict", tested: null, head: null };
  }
  if (cov.covered) return { toTester: false, untested: null, testedCommit: cov.tested };
  return {
    toTester: true,
    untested: approver === "human" ? { why: cov.why, tested: cov.tested, head: cov.head } : null,
    testedCommit: null,
  };
}

/** The first step a human approve of this ticket will certainly take (see approveOutcome.ts). */
export function approveOutcome(
  host: LandingFactsHost,
  ref: string,
  opts: {
    mergeCommand: boolean;
    env?: NodeJS.ProcessEnv;
    approver?: "human" | "agent";
    repos?: readonly RepoDiff[];
  },
): ApproveOutcome {
  return decideApproveOutcome(host.approveOutcomeFacts(ref, opts));
}

/**
 * WHERE AN APPROVED CHANGE IS: the facts behind a ready_for_merge (or held) ticket's
 * status label, read from what the landing paths themselves act on — the review pin
 * against the branch head (the landing check's "moved since review"), the merge gate's
 * evidence and the CI result for the head, the hold a parked ticket carries, a merge run
 * the API started that is still running, per-repo landings, and the merge lane's rule
 * (an earned merge gate, or AUTO_MERGE and a human approval; GAFFER_MERGE_LANE).
 * Git runs only for a ready_for_merge ticket; any other status reads no facts.
 */
export function landingFacts(
  host: LandingFactsHost,
  ref: string | Ticket,
  env: NodeJS.ProcessEnv = process.env,
): LandingFacts | null {
  const ticket = typeof ref === "string" ? host.resolveTicket(ref) : ref;
  if (ticket.status !== "ready_for_merge" && ticket.status !== "blocked") return null;
  const events = listEvents(host.db, "ticket", ticket.id);
  const transitions = events
    .filter((e) => e.event_type === "ticket.transitioned")
    .map((e) => {
      let pl: { to?: string; reason?: string | null } = {};
      try {
        pl = (JSON.parse(e.payload_json || "{}") as typeof pl) || {};
      } catch {
        pl = {};
      }
      return { e, to: pl.to ?? "", reason: pl.reason ?? "" };
    });
  const lastInto = (st: string) => [...transitions].reverse().find((t) => t.to === st);
  const writeLinks = () =>
    host.repos
      .listForTicket(ticket.id)
      .filter((l) => isActiveTicketRepoRelation(l.relation) && l.access === "write");
  const base = {
    mergeRunning: false,
    landedRepos: [] as string[],
    writeRepos: [] as string[],
    autoMerge: false,
    mergeLane: false,
    mergeGateEarned: false,
    approver: "",
  };
  if (ticket.status === "blocked") {
    const m = /^held:(merge_gate_red|ci_red)$/.exec(lastInto("blocked")?.reason ?? "");
    if (!m) return { ...base, status: ticket.status, hold: null };
    // A held multi-repo landing says which repos already landed (they stay landed).
    return {
      ...base,
      ...landedAndWriteRepos(computeLandingStatus(host.db, ticket.id), writeLinks()),
      status: ticket.status,
      hold: m[1] as LandingHold,
    };
  }
  // Everything after the ticket's latest entry into ready_for_merge, in log order (the
  // event log's insertion order, never a clock comparison across tables).
  const entry = lastInto("ready_for_merge")?.e;
  const afterEntry = entry ? events.slice(events.indexOf(entry) + 1) : events;
  const recordedSince = new Set(
    afterEntry
      .filter((e) => e.event_type === "evidence.recorded")
      .map((e) => {
        try {
          const pl = JSON.parse(e.payload_json || "{}") as { evidence_id?: string };
          return String(pl.evidence_id ?? "");
        } catch {
          return "";
        }
      }),
  );
  const evidence = host.evidence.listForTicket(ticket.id);
  // The approval on the ticket's current path to merge (the merge lane's own rule).
  let start = 0;
  transitions.forEach((t, i) => {
    if (t.to === "in_review") start = i + 1;
  });
  let approver = "";
  for (const t of transitions.slice(start))
    if (t.reason === "review_approved" || t.reason === "review_approved_to_testing")
      approver = t.e.actor_type;
  let hold: LandingHold | null = null;
  // PER-REPOSITORY LANDING: the approved revision of every write repo (its review pin
  // since the ticket last entered review) and whether a landing of it is on record.
  const landing = computeLandingStatus(host.db, ticket.id);
  const heads = resolveApprovedHeads(host, ticket);
  const head = heads[0] ?? null; // the primary write repo: required CI's candidate
  // MOVED SINCE REVIEW, per repo as the landing check reads it: a repo still to land
  // whose delivery-branch head is no longer its pinned commit. A landed repo is done
  // (its branch may be gone). A legacy approval with no per-repo pin compares its one
  // pin with the primary head, as before.
  const movedRepos = landing.repos
    .filter((r) => !r.landed && r.pinned)
    .filter((r) => {
      const h = heads.find((x) => x.repoId === r.repoId);
      return h !== undefined && h.sha !== r.sha;
    })
    .map((r) => r.repo);
  if (landing.repos.length === 0) {
    const pin = [...evidence]
      .reverse()
      .find(
        (ev) =>
          ev.repo_id === null &&
          ev.recorded_by_actor_type === "system" &&
          (ev.uri ?? "").startsWith(REVIEW_PIN_PREFIX),
      );
    const pinned = pin ? (pin.uri ?? "").slice(REVIEW_PIN_PREFIX.length).toLowerCase() : "";
    if (head && pinned && !head.sha.startsWith(pinned) && !pinned.startsWith(head.sha))
      movedRepos.push(head.repo);
  }
  if (movedRepos.length > 0) hold = "moved_since_review";
  else if (landing.unpinned.length > 0) hold = "unpinned_repo";
  else if (
    evidence.some((ev) => ev.summary.startsWith("MERGE GATE FAILED") && recordedSince.has(ev.id))
  )
    hold = "merge_gate_red";
  else if (head && host.reviewGateSvc.ciStatus(ticket.id, head.sha).state === "fail")
    hold = "ci_red";
  // A merge run the API started for this approval, still running.
  const started = [...afterEntry].reverse().find((e) => e.event_type === "ticket.merge_started");
  let mergeRunning = false;
  if (started) {
    try {
      const runId = (JSON.parse(started.payload_json || "{}") as { run_id?: string }).run_id;
      const row = runId
        ? (host.db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as
            { status: string } | undefined)
        : undefined;
      mergeRunning = row?.status === "running";
    } catch {
      mergeRunning = false;
    }
  }
  const writes = writeLinks();
  const lane = (env.GAFFER_MERGE_LANE ?? "1").trim().toLowerCase();
  return {
    status: ticket.status,
    hold,
    mergeRunning,
    movedRepos,
    unpinnedRepos: [...landing.unpinned],
    ...landedAndWriteRepos(landing, writes),
    pause: usagePauseFact(env),
    autoMerge: envFlagOn(env[AUTO_MERGE_ENV]),
    mergeLane: !["0", "false", "no", "off"].includes(lane),
    mergeGateEarned: isAutonomyAllowed(
      host.autonomyPolicy,
      writeRepoIdsForTicket(host, ticket),
      ticket.risk_level,
      "merge",
      env,
    ),
    approver,
  };
}

/**
 * The repos a landing state names: with per-repo review pins, the approved revisions
 * and those recorded landed (`gaffer-landed-commit:` system rows, computeLandingStatus);
 * a legacy approval with no per-repo pin names its write repos, none recorded landed.
 */
export function landedAndWriteRepos(
  landing: LandingStatus,
  writes: ReadonlyArray<{ name: string }>,
): { landedRepos: string[]; writeRepos: string[] } {
  if (landing.repos.length === 0) return { landedRepos: [], writeRepos: writes.map((l) => l.name) };
  return {
    landedRepos: landing.repos.filter((r) => r.landed).map((r) => r.repo),
    writeRepos: landing.repos.map((r) => r.repo),
  };
}

/** The truthful status label for an approved or held ticket (see landingState.ts). */
export function landingState(
  host: LandingFactsHost,
  ref: string | Ticket,
  env: NodeJS.ProcessEnv = process.env,
): LandingState | null {
  try {
    const facts = host.landingFacts(ref, env);
    return facts ? decideLandingState(facts) : null;
  } catch {
    return null; // a status label never fails the read it rides on
  }
}

/** Stamp `landing_state` on each approved or held ticket of a list (others untouched). */
export function withLandingState<T extends Ticket>(
  host: LandingFactsHost,
  tickets: readonly T[],
): Array<T & { landing_state?: LandingState }> {
  return tickets.map((t) => {
    if (t.status !== "ready_for_merge" && t.status !== "blocked") return t;
    const ls = host.landingState(t);
    return ls ? { ...t, landing_state: ls } : t;
  });
}

/**
 * IN-FLIGHT GUARD (exploratory finding api/F1): true while a merge run the API started
 * for this ticket (its latest `ticket.merge_started` event) is still `running` in the
 * run registry. The merge route refuses a second merge then (409 MERGE_IN_FLIGHT).
 */
export function mergeInFlight(host: LandingFactsHost, ref: string): boolean {
  const ticket = host.resolveTicket(ref);
  const ev = host.db
    .prepare(
      `SELECT payload_json FROM work_events
        WHERE entity_type = 'ticket' AND entity_id = ? AND event_type = 'ticket.merge_started'
        ORDER BY rowid DESC LIMIT 1`,
    )
    .get(ticket.id) as { payload_json: string | null } | undefined;
  if (!ev) return false;
  try {
    const runId = (JSON.parse(ev.payload_json || "{}") as { run_id?: string }).run_id;
    if (!runId) return false;
    const row = host.db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as
      { status: string } | undefined;
    return row?.status === "running";
  } catch {
    return false;
  }
}

/**
 * Record that the API started a merge run for an approved ticket, so its status can say
 * "landing" while that run is running (the runs table does not carry the ticket).
 */
export function noteMergeStarted(
  host: LandingFactsHost,
  ref: string,
  runId: string | null,
  actor: Actor,
): void {
  const ticket = host.resolveTicket(ref);
  writeEvent(host.db, {
    entity_type: "ticket",
    entity_id: ticket.id,
    actor,
    event_type: "ticket.merge_started",
    payload: { run_id: runId },
  });
}

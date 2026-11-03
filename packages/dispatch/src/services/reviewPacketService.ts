import { SCOUT_RECORDED_EVENT, scoutRaisedFact, type ScoutRecord } from "./scoutRecord.js";
import type { Db } from "../db/connection.js";
import type {
  AcStatus,
  AcceptanceCriterion,
  Evidence,
  RiskLevel,
  Ticket,
  WorkEvent,
} from "../domain/types.js";
import { parseTestContract } from "../domain/types.js";
import {
  ACCEPTANCE_EVIDENCE_PREFIX,
  contractProfile,
  EXECUTABLE_PROFILES,
  type AcceptanceProfile,
} from "../domain/acceptanceProfile.js";
import { listEvents } from "../events/eventWriter.js";
import { contractHash } from "../util/contractHash.js";
import { testerOffNotice, type TesterLaneDecision } from "../util/testingLane.js";
import { currentJudgment, type RecordedEvalJudgment } from "./evalJudgment.js";
import { AC_CHECK_VERIFIER } from "../policy/policy.js";
import type { AcRepository } from "../repositories/acRepository.js";
import type { EvidenceRepository } from "../repositories/evidenceRepository.js";
import type { ReworkAttemptRepository } from "../repositories/reworkAttemptRepository.js";
import type { TicketRepoDeliveryRepository } from "../repositories/ticketRepoDeliveryRepository.js";
import {
  compareTestClaims,
  parseRunnerTally,
  parseTestClaimsFrom,
  type TestDisagreement,
  type TestTally,
} from "../util/testTally.js";

/**
 * REVIEW PACKET: the runner-verified facts about a delivery, put together for the
 * human at the review gate. Served beside the dossier (`GET /tickets/:id/dossier?
 * include=packet`) and drawn as the Review view's verdict strip and criteria table.
 *
 * Every field is a recorded fact or a deterministic reading of one. Provenance is
 * the point: a gate row, a check exit code or a test count counts as the RUNNER'S
 * only when the row was recorded by the `system` actor (agents record as `agent`
 * and cannot forge one). What the agent wrote is kept apart and labelled as its
 * word. No model call, no write; the only git read is the injected head reader the
 * approval itself uses (`writeRepoHeads`), so "is this the commit that passed?" compares
 * the commit an approval would bind to.
 *
 * Not part of the dossier's hashed subject: the cost figure reads the usage ledger,
 * which changes as the factory works, so the packet sits outside the hash.
 */

/**
 * A gate verdict as the runner recorded it. FLAG is the gate-integrity row's advisory
 * verdict (the delivery changed the tests that gate it): never a fail, never a skip.
 */
export interface PacketGate {
  gate: string;
  repo: string;
  status: "PASS" | "FAIL" | "FLAG" | "SKIPPED";
  rc: string | null;
  /** The command a passing gate ran (the runner records it as the note). */
  command: string | null;
  /** A failing, skipped or integrity gate's note ("exited 1: …", "no command configured",
   *  "deleted 1 test file (…)"). */
  note: string | null;
}

export interface PacketGates {
  overall: "PASS" | "FAIL";
  recorded_at: string;
  rows: PacketGate[];
  /** Test counts read from the runner's own output, when it recorded any. */
  tally: TestTally | null;
}

export interface PacketTester {
  verdict: "pass" | "fail";
  provenance: string | null;
  /** What it tested: the commit and the contract it ran against. */
  tested_commit: string | null;
  contract_hash: string | null;
  summary: string;
  at: string;
  by: string;
}

export interface PacketCost {
  cost_usd: number;
  measured_usd: number;
  estimated_usd: number;
  num_turns: number;
  unknown_calls: number;
  ledger_status: string;
  budget_usd: number | null;
}

export interface PacketRework {
  at: string;
  /** Who sent it back: the runner's gates, the reviewer, or the tester. */
  by: "gate" | "review" | "tester";
  gate: string | null;
  reason: string;
}

export interface PacketAttempts {
  attempt_count: number;
  max_attempts: number;
  rework: PacketRework[];
}

export interface PacketRisk {
  level: RiskLevel;
  /** Recorded reasons (an auto-ship held for observed risk). The diff's own risk
   * annotations join these on the Review view once the diff loads. */
  reasons: string[];
}

export interface PacketPin {
  sha: string;
  summary: string;
  at: string;
}

/**
 * What backs one criterion: `runner` (the runner ran its check), `human` (a person
 * recorded a check result), `agent` (only the agent's own evidence or say-so),
 * `none` (nothing recorded).
 */
export type PacketEvidenceKind = "runner" | "human" | "agent" | "none";

export interface PacketCriterion {
  id: string;
  text: string;
  status: AcStatus;
  check_command: string | null;
  verified_by: string | null;
  verified_at: string | null;
  evidence_kind: PacketEvidenceKind;
  /** The latest trusted check result, when the criterion has a check. */
  check: { exit_code: number | null; passed: boolean; command: string; at: string } | null;
  agent_evidence: number;
}

/**
 * SAME CANDIDATE: the commits one write repo's facts are about, side by side. The gates
 * ran on `gated_sha` (the runner records `ticket_repo_delivery.commit_sha` right after
 * the gates pass, from the same worktree HEAD: runner/tick.sh, with no runner commit in
 * between); `diff_head` is the delivery branch's commit now (the commit the diff and an
 * approval bind to); `tester_tested` the independent tester's commit (the primary repo
 * only: the tester runs that one); `pin` this repo's reviewed-commit pin.
 */
export interface PacketCandidate {
  repo_id: string;
  repo: string;
  gated_sha: string | null;
  /** Who recorded `gated_sha`: the runner (the `system` actor, after its gates), an agent or
   *  a person (neither trusted for `same`: only the runner's record says the gates ran on
   *  it), or null for a row recorded before the delivery event carried the commit. */
  gated_by: "runner" | "agent" | "human" | null;
  /**
   * True when the commit on record was recorded before this delivery attempt began (its
   * claim) and is not the head: the runner records an attempt's gated commit just after it
   * submits, so for a moment after a rework enters review (or for good, when that record
   * failed) the row still holds an earlier attempt's commit. Not the same candidate, but
   * not shown to differ either: this attempt's record is missing.
   */
  gated_earlier: boolean;
  diff_head: string | null;
  /** Why the head could not be read now (no checkout, no branch…), when it could not. */
  head_unavailable: string | null;
  tester_tested: string | null;
  pin: string | null;
  /** True when the gated commit and the head are known and one commit, and any tested or
   *  pinned commit is that commit too. */
  same: boolean;
}

/** REQUIRED CI: the latest result recorded for the candidate commit. */
export interface PacketCi {
  /** A CI result or requirement is on record, so approval waits for a PASS. */
  required: boolean;
  /** The candidate commit's latest state, or null when none was recorded for it. */
  state: "pending" | "pass" | "fail" | null;
  /** The candidate commit (the primary write repo's head), when it resolves. */
  commit: string | null;
  at: string | null;
  detail: string | null;
  /** The latest result for any commit of this ticket (to say "the latest is for X"). */
  latest: { commit: string; state: string; at: string } | null;
}

/**
 * A dashboard-recorded run whose log covers a step of this delivery. The runs table does
 * not carry the ticket, so the link is found by time: the poll run that was running when
 * the ticket entered review (`delivery`) or when the tester's verdict was recorded
 * (`tester`). `method` says so on screen.
 */
export interface PacketRunLink {
  role: "delivery" | "tester";
  run_id: string;
  kind: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  href: string;
  method: "time window";
}

/**
 * INSPECTABLE CONFIDENCE: one deterministic fact and whether it holds. The Review view
 * lists the rows that hold under "What backs this" and the rest under "What is not
 * backed". No score: the rows are the answer. `cell` names the strip cell it comes from.
 */
export interface PacketBacking {
  fact: string;
  holds: boolean;
  source: string;
  cell: "candidate" | "gates" | "tester" | "ci" | "criteria" | "integrity" | "evidence" | "risk";
}

export interface ReviewPacket {
  gates: PacketGates | null;
  tester: PacketTester | null;
  /**
   * The independent tester gates this ticket (an epic's acceptance ticket, or a testable
   * one whose lane is on). With tester-first it tests the candidate before you review, and
   * an approval needs its PASS on the commit you approve.
   */
  tester_expected: boolean;
  /**
   * ADAPTIVE TESTER LANE: the GAFFER_TESTING setting (on, off, or the `auto` default),
   * whether the lane is on for this ticket's repos, and the write repos with no
   * registered test command (why an `auto` lane is off). Null when not read.
   */
  tester_lane: {
    mode: TesterLaneDecision["mode"];
    on: boolean;
    missing_test_command: string[];
    /**
     * LANE-SETTING CONSISTENCY: the lane the runner last routed under, when it differs
     * from this dashboard's mode: that mode, when it was recorded, whether the lane is on
     * for this ticket's repos under it, and whether the tester gates the ticket under it.
     * Absent when the runner recorded nothing or reads the same mode.
     */
    runner?: { mode: TesterLaneDecision["mode"]; at: string; on: boolean; gates: boolean };
  } | null;
  cost: PacketCost;
  attempts: PacketAttempts;
  risk: PacketRisk;
  pin: PacketPin | null;
  acceptance: PacketCriterion[];
  disagreements: TestDisagreement[];
  /**
   * EVAL JUDGE (the runner's opt-in judge): the quality judge's grade of this delivery, or null
   * when none was recorded for it. NOT a runner fact like the rest of the packet: it is a
   * model's opinion of the diff, advisory, read by no gate. The Review view says so.
   */
  judge: RecordedEvalJudgment | null;
  /**
   * PRE-WORK SCOUT: the runner's scout record for the latest delivery attempt
   * (`ticket.scout_recorded`): the risk it classified (it can only raise the declared
   * level), the signals that raised it and its coverage. null when none was recorded.
   */
  scout: ScoutRecord | null;
  /** INTENT: what was asked, the ticket's description as the human wrote it (null when blank). */
  intent: string | null;
  /** SAME CANDIDATE: per active write repo, the gated, shown, tested and pinned commits. */
  candidate: PacketCandidate[];
  /** REQUIRED CI for the candidate commit, or null when no CI is on record for the ticket. */
  ci: PacketCi | null;
  /** The run logs that cover this delivery's steps (see PacketRunLink). */
  run_links: PacketRunLink[];
  /**
   * RUNTIME ACCEPTANCE (Release C): the ticket's acceptance profile and the runner's latest
   * record of running the change as a user meets it (the CLI transcript, the API probes).
   */
  runtime_acceptance: PacketRuntimeAcceptance;
  /** INSPECTABLE CONFIDENCE: the deterministic facts that back this delivery, or do not. */
  backing: PacketBacking[];
}

/** RUNTIME ACCEPTANCE: the profile and the runner's latest acceptance record. */
export interface PacketRuntimeAcceptance {
  profile: AcceptanceProfile;
  /** The runner can run this profile today (cli, api). */
  executable: boolean;
  /** A person registered the commands the runner runs for it. */
  spec_registered: boolean;
  latest: {
    evidence_id: string;
    kind: string;
    passed: boolean;
    tested_commit: string;
    cases: number;
    reason: string | null;
    at: string;
    /** The record was made against the ticket's current contract (profile, spec, criteria). */
    current_contract: boolean;
  } | null;
}

/**
 * One active write repo's delivery head as the approval reads it (Dispatch.writeRepoHeads),
 * in role order (the primary repo first): `sha` null with `why` when it cannot be read.
 */
export interface PacketWriteRepoHead {
  repoId: string;
  repo: string;
  sha: string | null;
  why: string | null;
}

/** Reads one ticket's usage from the ledger. */
export type CostReader = (ticketNumber: number) => Omit<PacketCost, "budget_usd">;

export interface ReviewPacketDeps {
  db: Db;
  acs: AcRepository;
  evidence: EvidenceRepository;
  reworkAttempts: ReworkAttemptRepository;
  maxAttempts: number;
  /** Whether the independent tester gates this ticket (it tests before review). */
  testerExpected: (ticket: Ticket) => boolean;
  /** The ticket's tester lane (setting, on/off for its repos, repos with no test command). */
  testerLane?: (ticket: Ticket) => TesterLaneDecision;
  /** The runner's differing tester lane for this ticket (Dispatch.runnerTesterLaneFor). */
  runnerTesterLane?: (
    ticket: Ticket,
  ) => { mode: TesterLaneDecision["mode"]; at: string; on: boolean; gates: boolean } | null;
  /** Per-repo delivery rows: the commit the runner recorded after the gates. */
  repoDeliveries?: TicketRepoDeliveryRepository;
  /**
   * The current head of every active write repo (the same read the diff and the approval
   * make). The packet's only git touch, injected so the assembler itself spawns nothing.
   * Absent → no candidate rows.
   */
  writeRepoHeads?: (ticket: Ticket) => readonly PacketWriteRepoHead[];
}

const RUNNER = "system";
const PIN_PREFIX = "gaffer-reviewed-commit:";
/** Statuses past delivery; a move from one back to rework is a send-back. */
const PAST_DELIVERY = new Set(["in_review", "in_testing", "ready_for_merge"]);
const BACK_TO_WORK = new Set(["ready", "refining", "blocked"]);

function payloadOf(e: { payload_json: string | null }): Record<string, unknown> {
  if (!e.payload_json) return {};
  try {
    const v = JSON.parse(e.payload_json) as unknown;
    return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The latest `ticket.scout_recorded` record (the scout runs before each attempt). */
function latestScout(
  events: ReadonlyArray<{ event_type: string; payload_json: string | null }>,
): ScoutRecord | null {
  for (let k = events.length - 1; k >= 0; k--) {
    const e = events[k]!;
    if (e.event_type !== SCOUT_RECORDED_EVENT) continue;
    const p = payloadOf(e);
    return typeof p.effective === "string" && typeof p.declared === "string"
      ? (p as unknown as ScoutRecord)
      : null;
  }
  return null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** The runner's DoD row: `DoD: PASS|FAIL`, then the JSON gate line (see runner/lib/dod.sh). */
function readGates(rows: Evidence[]): PacketGates | null {
  const dod = rows.filter(
    (e) =>
      e.evidence_type === "test_output" &&
      e.recorded_by_actor_type === RUNNER &&
      e.summary.startsWith("DoD: "),
  );
  const last = dod[dod.length - 1];
  if (!last) return null;
  const lines = last.summary.split("\n");
  let parsed: { dod?: unknown; gates?: unknown };
  try {
    parsed = JSON.parse(lines[1] ?? "") as { dod?: unknown; gates?: unknown };
  } catch {
    return null;
  }
  if (!parsed || !Array.isArray(parsed.gates)) return null;
  const gateRows: PacketGate[] = (parsed.gates as Array<Record<string, unknown>>).map((g) => {
    const status =
      g.status === "PASS"
        ? "PASS"
        : g.status === "FAIL"
          ? "FAIL"
          : g.status === "FLAG"
            ? "FLAG"
            : "SKIPPED";
    const note = str(g.note);
    // GATE INTEGRITY: the integrity row's note is what it found, not a command it ran.
    const ranCommand = status === "PASS" && g.gate !== "integrity";
    return {
      gate: str(g.gate) ?? "gate",
      repo: str(g.repo) ?? "-",
      status,
      rc: g.rc === undefined || g.rc === null ? null : String(g.rc),
      command: ranCommand ? note : null,
      note: ranCommand ? null : note,
    };
  });
  return {
    overall: parsed.dod === "PASS" ? "PASS" : "FAIL",
    recorded_at: last.created_at,
    rows: gateRows,
    tally: parseRunnerTally(testOutputBlocks(last.summary)),
  };
}

/**
 * The runner-captured test output inside a DoD row, one block per `tests@<repo>`:
 * the `---DOD-TALLY tests@…---` block (the summary lines of a test gate that ran) when
 * the row has one, else the `---DOD-OUTPUT tests@…---` failure tail (older rows written
 * before the TALLY block existed). Never both: on a failing gate dod.sh writes the
 * summary line into each, and reading the two would count every test twice. Only the
 * tests gate's blocks: a lint run's "3 passed" is not a test count.
 */
function testOutputBlocks(summary: string): string {
  const tally = new Map<string, string[]>();
  const output = new Map<string, string[]>();
  const order: string[] = [];
  // The block that is open (any gate's, not only the tests gate's), and where its lines
  // go (null for a block that is not the tests gate's). While a block is open a line
  // that looks like an opener is that block's output, not a new block: a failing lint
  // run's captured tail cannot start a tests tally of its own.
  let openKind: "TALLY" | "OUTPUT" | null = null;
  let into: string[] | null = null;
  for (const line of summary.split("\n")) {
    if (openKind !== null) {
      if (line.startsWith(`---END-DOD-${openKind}---`)) {
        openKind = null;
        into = null;
      } else if (into) into.push(line);
      continue;
    }
    const open = line.match(/^---DOD-(TALLY|OUTPUT) ([^@]+)@(.*?)---\s*$/);
    if (!open) continue;
    openKind = open[1] as "TALLY" | "OUTPUT";
    into = null;
    if (open[2] !== "tests") continue;
    const key = `${open[2]}@${open[3]}`;
    if (!order.includes(key)) order.push(key);
    const bucket = openKind === "TALLY" ? tally : output;
    const lines = bucket.get(key) ?? [];
    bucket.set(key, lines);
    into = lines;
  }
  const out: string[] = [];
  for (const key of order) out.push(...(tally.get(key) ?? output.get(key) ?? []));
  return out.join("\n");
}

/** The evidence ids the tester's verdict events name (its own verdict rows). */
function testerVerdictIds(events: WorkEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const ev of events) {
    if (ev.event_type !== "ticket.tester_passed" && ev.event_type !== "ticket.tester_failed")
      continue;
    const id = str(payloadOf(ev).evidence_id);
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * When the ticket last (re)entered review, or null with no such transition on record.
 * The tester runs after a review approval and a pin is recorded at one, so a verdict or
 * a pin older than this is about an earlier candidate: a rework or a conflict resolution
 * re-entered review with other code. runner/lib/tester-binding.mjs (readReviewPin) dates
 * the landing pin by the same event and ignores an older one.
 */
export function enteredReviewAt(ticketId: string, events: readonly WorkEvent[]): string | null {
  let at: string | null = null;
  for (const e of events) {
    if (e.event_type !== "ticket.transitioned" || e.entity_id !== ticketId) continue;
    if (str(payloadOf(e).to) !== "in_review") continue;
    if (at === null || e.created_at > at) at = e.created_at;
  }
  return at;
}

/**
 * TESTER FIRST: when this candidate's round began, the latest entry into review that was
 * not the tester's PASS returning it (a submit, a rework's submit, a conflict reopen). The
 * tester now runs between the submit and the review, so its verdict on this candidate is
 * recorded after this point and before the latest entry into review.
 */
export function candidateRoundAt(ticketId: string, events: readonly WorkEvent[]): string | null {
  let at: string | null = null;
  for (const e of events) {
    if (e.event_type !== "ticket.transitioned" || e.entity_id !== ticketId) continue;
    const p = payloadOf(e);
    if (str(p.to) !== "in_review" || str(p.from) === "in_testing") continue;
    if (at === null || e.created_at > at) at = e.created_at;
  }
  return at;
}

/** Recorded before `since` (a fact about an earlier candidate); same instant counts as current. */
const before = (e: { created_at: string }, since: string | null): boolean =>
  since !== null && since > e.created_at;

/**
 * The tester's verdict: the latest `test_output` row whose id a `ticket.tester_passed`
 * or `ticket.tester_failed` event on this ticket names. Only reviewGateService's
 * testerPass/testerFail write those events, beside the row they record; a verdict-shaped
 * payload anyone else recorded (an agent's record_ac_evidence, say) is not the tester's.
 * A verdict from before this candidate's round began (candidateRoundAt: the submit, not
 * the tester's PASS returning it to review) tested an earlier candidate (that round's fail
 * is in the rework list), so it is not this delivery's. The commit is the row's
 * tested_commit, else the head the PASS event recorded (a person's waiver).
 */
function readTester(
  rows: Evidence[],
  events: WorkEvent[],
  sinceRound: string | null,
): PacketTester | null {
  const verdictIds = testerVerdictIds(events);
  // Each verdict is dated by its own event (written beside the row, on the event clock
  // the transitions use), and a PASS event names the commit it is about.
  const testedHead = new Map<string, string>();
  const verdictAt = new Map<string, string>();
  for (const ev of events) {
    if (ev.event_type !== "ticket.tester_passed" && ev.event_type !== "ticket.tester_failed")
      continue;
    const p = payloadOf(ev);
    const id = str(p.evidence_id);
    if (!id) continue;
    verdictAt.set(id, ev.created_at);
    const head = str(p.tested_head);
    if (head && ev.event_type === "ticket.tester_passed") testedHead.set(id, head);
  }
  for (let i = rows.length - 1; i >= 0; i--) {
    const e = rows[i]!;
    if (e.evidence_type !== "test_output" || !verdictIds.has(e.id)) continue;
    const p = payloadOf(e);
    if (p.verdict !== "pass" && p.verdict !== "fail") continue;
    if (before({ created_at: verdictAt.get(e.id) ?? e.created_at }, sinceRound)) return null;
    return {
      verdict: p.verdict,
      provenance: str(p.provenance),
      tested_commit: str(p.tested_commit) ?? testedHead.get(e.id) ?? null,
      contract_hash: str(p.contract_hash),
      summary: e.summary.split("\n")[0]!.slice(0, 300),
      at: e.created_at,
      by: e.created_by,
    };
  }
  return null;
}

/** The latest review pin, unless it predates the ticket's latest entry into review (stale). */
function readPin(rows: Evidence[], sinceReview: string | null): PacketPin | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const e = rows[i]!;
    if (e.evidence_type !== "commit" || e.recorded_by_actor_type !== RUNNER) continue;
    if (!e.uri || !e.uri.startsWith(PIN_PREFIX)) continue;
    if (before(e, sinceReview)) return null;
    return { sha: e.uri.slice(PIN_PREFIX.length), summary: e.summary, at: e.created_at };
  }
  return null;
}

/**
 * One criterion's evidence. A check result from before the latest send-back ran against
 * an earlier attempt's code (the send-back reset the criterion to pending), so only the
 * current attempt's checks count as its machine evidence.
 */
function readCriterion(
  ac: AcceptanceCriterion,
  rows: Evidence[],
  sentBackAt: string | null,
): PacketCriterion {
  const mine = rows.filter((e) => e.ac_id === ac.id);
  const agentRows = mine.filter((e) => e.recorded_by_actor_type === "agent");
  const checks = mine.filter(
    (e) =>
      e.recorded_by_actor_type !== null &&
      e.recorded_by_actor_type !== "agent" &&
      payloadOf(e).kind === "ac_check" &&
      (sentBackAt === null || e.created_at > sentBackAt),
  );
  const lastCheck = checks[checks.length - 1];
  let check: PacketCriterion["check"] = null;
  let kind: PacketEvidenceKind = "none";
  if (lastCheck) {
    const p = payloadOf(lastCheck);
    check = {
      exit_code: typeof p.exit_code === "number" ? p.exit_code : null,
      passed: p.passed === true,
      command: str(p.command) ?? ac.check_command ?? "",
      at: lastCheck.created_at,
    };
    kind = lastCheck.recorded_by_actor_type === RUNNER ? "runner" : "human";
  } else if (agentRows.length > 0 || (ac.verified_by && ac.verified_by !== AC_CHECK_VERIFIER)) {
    kind = "agent";
  }
  return {
    id: ac.id,
    text: ac.text,
    status: ac.status,
    check_command: ac.check_command,
    verified_by: ac.verified_by,
    verified_at: ac.verified_at,
    evidence_kind: kind,
    check,
    agent_evidence: agentRows.length,
  };
}

function readRework(
  ticketId: string,
  events: WorkEvent[],
  trail: ReturnType<ReworkAttemptRepository["listForTicket"]>,
): PacketRework[] {
  const out: PacketRework[] = trail.map((r) => ({
    at: r.created_at,
    by: "gate" as const,
    gate: r.gate,
    reason: r.distilled_failure.split("\n")[0]!.slice(0, 300),
  }));
  for (const e of events) {
    if (e.event_type !== "ticket.transitioned" || e.entity_id !== ticketId) continue;
    const p = payloadOf(e);
    const from = str(p.from);
    const to = str(p.to);
    if (!from || !to || !PAST_DELIVERY.has(from) || !BACK_TO_WORK.has(to)) continue;
    const reason = str(p.reason) ?? "sent back";
    out.push({
      at: e.created_at,
      by: from === "in_testing" || reason.includes("tester_failed") ? "tester" : "review",
      gate: null,
      reason: reason.slice(0, 300),
    });
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/** Two commit ids name one commit: equal, or one a prefix (≥ 7 hex) of the other. */
export function sameCommit(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (x.length < 7 || y.length < 7) return false;
  return x.startsWith(y) || y.startsWith(x);
}

const short = (sha: string | null): string => (sha ? sha.slice(0, 12) : "none");

/**
 * This repo's review pin for the current round: the latest system `gaffer-reviewed-commit:`
 * row naming this repo, or (a legacy whole-ticket pin, `repo_id` null) the primary repo's.
 */
function readRepoPin(
  rows: Evidence[],
  sinceReview: string | null,
  repoId: string,
  primary: boolean,
): string | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const e = rows[i]!;
    if (e.evidence_type !== "commit" || e.recorded_by_actor_type !== RUNNER) continue;
    if (!e.uri || !e.uri.startsWith(PIN_PREFIX)) continue;
    if (e.repo_id !== null && e.repo_id !== repoId) continue;
    if (e.repo_id === null && !primary) continue;
    if (before(e, sinceReview)) return null;
    return e.uri.slice(PIN_PREFIX.length).toLowerCase();
  }
  return null;
}

/**
 * Who recorded the delivery commit stored for a repo: the latest `ticket.repo_delivery_
 * recorded` event naming this repo and this commit. The runner records it as `system`; an
 * agent's own record (its MCP tool may pass one) is its word, not the runner's. Null when
 * no event carries the commit (a row recorded before the event did).
 */
function gatedBy(events: WorkEvent[], repoId: string, sha: string): PacketCandidate["gated_by"] {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.event_type !== "ticket.repo_delivery_recorded") continue;
    const p = payloadOf(e);
    if (str(p.repo_id) !== repoId || !sameCommit(str(p.commit_sha), sha)) continue;
    if (e.actor_type === "system") return "runner";
    return e.actor_type === "agent" ? "agent" : "human";
  }
  return null;
}

/**
 * When the current delivery attempt began: the latest claim at or before the ticket last
 * entered review (a conflict resolution re-enters review without a new claim, so its
 * attempt is the original delivery's). Null with no claim on record.
 */
function attemptStartedAt(
  ticketId: string,
  events: readonly WorkEvent[],
  sinceReview: string | null,
): string | null {
  let at: string | null = null;
  for (const e of events) {
    if (e.event_type !== "ticket.transitioned" || e.entity_id !== ticketId) continue;
    if (str(payloadOf(e).to) !== "claimed") continue;
    if (sinceReview !== null && e.created_at > sinceReview) continue;
    if (at === null || e.created_at > at) at = e.created_at;
  }
  return at;
}

/**
 * The commit on record for a repo was recorded before this attempt began: some delivery
 * event carries a commit (so the record is readable at all) and none is from this attempt.
 */
function gatedBeforeAttempt(
  events: WorkEvent[],
  repoId: string,
  attemptAt: string | null,
): boolean {
  if (attemptAt === null) return false;
  let any = false;
  for (const e of events) {
    if (e.event_type !== "ticket.repo_delivery_recorded") continue;
    const p = payloadOf(e);
    if (str(p.repo_id) !== repoId || !str(p.commit_sha)) continue;
    any = true;
    if (!before(e, attemptAt)) return false;
  }
  return any;
}

/** REQUIRED CI for `commit`: the same reading as ReviewGateService.ciStatus, with times. */
function readCi(db: Db, ticketId: string, commit: string | null): PacketCi | null {
  const rows = db
    .prepare(
      `SELECT json_extract(payload_json, '$.commit') AS commit_sha,
              json_extract(payload_json, '$.state')  AS state,
              json_extract(payload_json, '$.detail') AS detail,
              created_at
         FROM work_events
        WHERE entity_type = 'ticket' AND entity_id = ? AND event_type = 'ticket.ci_result'
        ORDER BY rowid DESC`,
    )
    .all(ticketId) as Array<{
    commit_sha: string | null;
    state: string | null;
    detail: string | null;
    created_at: string;
  }>;
  const required =
    rows.length > 0 ||
    db
      .prepare(
        `SELECT 1 FROM work_events
          WHERE entity_type = 'ticket' AND entity_id = ? AND event_type = 'ticket.ci_required' LIMIT 1`,
      )
      .get(ticketId) !== undefined;
  if (!required) return null;
  const c = commit ? commit.toLowerCase() : null;
  const hit = c
    ? rows.find((r) => {
        const rc = String(r.commit_sha ?? "").toLowerCase();
        return rc !== "" && (c.startsWith(rc) || rc.startsWith(c));
      })
    : undefined;
  const state = hit?.state;
  const first = rows[0];
  return {
    required: true,
    state: state === "pass" || state === "fail" || state === "pending" ? state : null,
    commit: c,
    at: hit?.created_at ?? null,
    detail: str(hit?.detail),
    latest:
      first && first.commit_sha && first.state
        ? { commit: String(first.commit_sha), state: String(first.state), at: first.created_at }
        : null,
  };
}

/**
 * The dashboard-recorded poll runs (with a captured log) that were running at `at`. The
 * runs table carries no ticket: the link is a time-window reading, and says so.
 */
function runsAt(db: Db, at: string | null, role: PacketRunLink["role"]): PacketRunLink[] {
  if (!at) return [];
  let rows: Array<{
    id: string;
    kind: string;
    status: string;
    started_at: string;
    ended_at: string | null;
  }>;
  try {
    rows = db
      .prepare(
        `SELECT id, kind, status, started_at, ended_at FROM runs
          WHERE kind = 'poll_work' AND log_path IS NOT NULL
            AND started_at <= ? AND (ended_at IS NULL OR ended_at >= ?)
          ORDER BY started_at DESC LIMIT 3`,
      )
      .all(at, at) as typeof rows;
  } catch {
    return [];
  }
  return rows.map((r) => ({
    role,
    run_id: r.id,
    kind: r.kind,
    status: r.status,
    started_at: r.started_at,
    ended_at: r.ended_at,
    href: `/api/runs/${encodeURIComponent(r.id)}/log`,
    method: "time window" as const,
  }));
}

/** The ticket's description as the intent (what was asked), or null when blank. */
const INTENT_MAX = 20_000;
function readIntent(ticket: Ticket): string | null {
  const d = typeof ticket.description === "string" ? ticket.description.trim() : "";
  return d === "" ? null : d.slice(0, INTENT_MAX);
}

/**
 * INSPECTABLE CONFIDENCE: the deterministic rows behind "What backs this / What is not
 * backed". Each reads a fact the packet already holds; nothing is weighted or scored, and
 * nothing here holds or asks (the flags list stays the one list of asks).
 */
function readBacking(p: Omit<ReviewPacket, "backing">, _evidence: Evidence[]): PacketBacking[] {
  const out: PacketBacking[] = [];
  const add = (fact: string, holds: boolean, source: string, cell: PacketBacking["cell"]) =>
    out.push({ fact, holds, source, cell });

  // The exact candidate: the gates ran on the commit the diff shows, per write repo.
  for (const c of p.candidate) {
    const name = p.candidate.length > 1 ? ` in ${c.repo}` : "";
    if (!c.diff_head)
      add(
        `The head commit${name} cannot be read now (${c.head_unavailable ?? "unknown"})`,
        false,
        "git rev-parse of the delivery branch",
        "candidate",
      );
    else if (!c.gated_sha)
      add(
        `No gated commit is recorded${name}, so it is not known that the gates ran on ${short(c.diff_head)}`,
        false,
        "ticket_repo_delivery.commit_sha",
        "candidate",
      );
    else if (c.gated_by === "agent" || c.gated_by === "human")
      add(
        `The gated commit${name} was recorded by ${c.gated_by === "agent" ? "the agent" : "a person"}, not the runner`,
        false,
        "ticket.repo_delivery_recorded actor",
        "candidate",
      );
    else if (c.gated_earlier)
      add(
        `This attempt's gated commit${name} is not recorded yet: the one on record, ${short(c.gated_sha)}, is from an earlier attempt`,
        false,
        "ticket.repo_delivery_recorded times vs the attempt's claim",
        "candidate",
      );
    else if (c.same)
      add(
        `The gates ran on the commit the diff shows${name} (${short(c.diff_head)})`,
        true,
        "ticket_repo_delivery.commit_sha = the delivery branch head",
        "candidate",
      );
    else if (!sameCommit(c.gated_sha, c.diff_head))
      add(
        `The gates ran on ${short(c.gated_sha)}, but the branch${name} is now at ${short(c.diff_head)}`,
        false,
        "ticket_repo_delivery.commit_sha vs the delivery branch head",
        "candidate",
      );
    else
      add(
        `A tested or pinned commit${name} is not the head ${short(c.diff_head)}`,
        false,
        "the tester's tested_commit / the review pin vs the branch head",
        "candidate",
      );
  }

  const g = p.gates;
  if (!g) add("No gate report is recorded", false, "the runner's DoD row", "gates");
  else {
    const ran = g.rows.filter((r) => r.gate !== "integrity" && r.status !== "SKIPPED");
    const skipped = g.rows.filter((r) => r.gate !== "integrity" && r.status === "SKIPPED");
    add(
      g.overall === "PASS" ? "The runner's gates passed" : "A runner gate failed",
      g.overall === "PASS",
      "the runner's DoD row (system)",
      "gates",
    );
    if (ran.length === 0) add("No gate command ran", false, "the runner's DoD row", "gates");
    for (const r of skipped)
      add(
        `The ${r.gate} gate did not run${r.note ? ` (${r.note})` : ""}`,
        false,
        "the runner's DoD row",
        "gates",
      );
    const integrity = g.rows.find((r) => r.gate === "integrity");
    if (integrity)
      add(
        integrity.status === "FLAG"
          ? `The delivery changed the tests that gate it${integrity.note ? `: ${integrity.note}` : ""}`
          : "No gating test, skip marker or gate script changed",
        integrity.status !== "FLAG",
        "the runner's gate-integrity row",
        "integrity",
      );
  }
  if (p.disagreements.length)
    add(
      "The agent's test count disagrees with the runner's",
      false,
      "the agent's evidence vs the runner's test output",
      "gates",
    );

  // Criteria: what backs each one, counted by kind (never a ratio of rows).
  const crit = p.acceptance;
  if (crit.length) {
    const runnerOk = crit.filter((a) => a.evidence_kind === "runner" && a.check?.passed);
    const checked = crit.filter((a) => a.check_command);
    const agentOnly = crit.filter((a) => a.evidence_kind === "agent");
    const none = crit.filter((a) => a.evidence_kind === "none");
    if (checked.length)
      add(
        `${runnerOk.length} of ${checked.length} checked ${checked.length === 1 ? "criterion has" : "criteria have"} a passing runner check`,
        runnerOk.length === checked.length,
        "the runner's check results (system)",
        "criteria",
      );
    if (agentOnly.length)
      add(
        `${agentOnly.length} ${agentOnly.length === 1 ? "criterion rests" : "criteria rest"} on the agent's word only`,
        false,
        "agent-recorded evidence",
        "criteria",
      );
    if (none.length)
      add(
        `${none.length} ${none.length === 1 ? "criterion has" : "criteria have"} no evidence recorded`,
        false,
        "the ticket's evidence",
        "criteria",
      );
  }

  // The independent tester, on which commit.
  const ts = p.tester;
  if (ts) {
    // On a head of the write repo it tested (any write repo: see readCandidate).
    const onHead = p.candidate.some((c) => sameCommit(ts.tested_commit, c.diff_head));
    add(
      ts.verdict === "pass"
        ? onHead
          ? "The independent tester passed this commit"
          : `The independent tester passed ${ts.tested_commit ? short(ts.tested_commit) : "an unrecorded commit"}, not the head`
        : "The independent tester failed it",
      ts.verdict === "pass" && onHead,
      "the tester's verdict row (tested_commit)",
      "tester",
    );
  } else
    add(
      p.tester_expected
        ? "The independent tester has not passed this commit yet (it tests before you approve, and approval waits for its PASS)"
        : "No independent tester runs for this ticket",
      false,
      "the tester's verdict rows",
      "tester",
    );
  // ADAPTIVE TESTER LANE: why the tester does not run, when the `auto` default left it
  // off because a write repo has no registered test command (a PASS there could not be
  // replayed, so it would be held as unverified). An acceptance ticket is tested anyway.
  const lane = p.tester_lane;
  if (lane && lane.mode === "auto" && !lane.on && !p.tester_expected)
    for (const repo of lane.missing_test_command)
      add(testerOffNotice(repo), false, "the repository's registered test command", "tester");

  // Required CI for the candidate commit.
  const ci = p.ci;
  if (!ci) add("No CI result is recorded for this ticket", false, "ticket.ci_result", "ci");
  else
    add(
      ci.state === "pass"
        ? "Required CI is green on this commit"
        : ci.state === "fail"
          ? "Required CI failed on this commit"
          : ci.state === "pending"
            ? "Required CI is still running on this commit"
            : "Required CI has no result for this commit",
      ci.state === "pass",
      "ticket.ci_result for the candidate commit",
      "ci",
    );

  // PRE-WORK SCOUT: a risk the runner raised before delivery, with the signals that raised
  // it (path patterns, the ticket text, the code index). Not backed: it says where to look.
  const raised = scoutRaisedFact(p.scout);
  if (raised)
    add(
      raised,
      false,
      "the runner's scout before delivery (ticket.scout_recorded): path patterns, ticket text, code index",
      "risk",
    );

  // RUNTIME ACCEPTANCE (Release C): the runner ran the change as a user meets it.
  const rt = p.runtime_acceptance;
  const what = rt.profile === "cli" ? "cli transcript" : "api probes";
  if (rt.profile === "unit")
    add(
      "No runtime profile for this ticket: nothing ran the change as a user meets it (CLI, API, browser)",
      false,
      "the test contract's acceptance profile",
      "evidence",
    );
  else if (!rt.executable)
    add(
      `The ${rt.profile} acceptance profile is not run by the runner yet, so an automated PASS cannot be recorded: the verdict is yours`,
      false,
      "the test contract's acceptance profile",
      "evidence",
    );
  else if (!rt.latest)
    add(
      rt.spec_registered
        ? `Runtime acceptance: no ${what} recorded yet`
        : `Runtime acceptance: no commands are registered for the ${rt.profile} profile, so the tester's PASS is held (register them under Acceptance profile)`,
      false,
      "the runner's acceptance evidence (system)",
      "evidence",
    );
  else {
    const onHead = p.candidate.some((c) =>
      sameCommit(rt.latest?.tested_commit ?? null, c.diff_head),
    );
    add(
      rt.latest.passed
        ? onHead || p.candidate.length === 0
          ? rt.latest.current_contract
            ? `Runtime acceptance: ${rt.profile === "cli" ? "cli transcript replayed" : "api probes passed"} on ${short(rt.latest.tested_commit)} (${rt.latest.cases} ${rt.profile === "cli" ? "commands" : "probes"})`
            : `Runtime acceptance passed on ${short(rt.latest.tested_commit)} against an earlier contract (the profile, its commands or the criteria changed since)`
          : `Runtime acceptance passed on ${short(rt.latest.tested_commit)}, not the head`
        : `Runtime acceptance: the ${what} did not pass on ${short(rt.latest.tested_commit)}${rt.latest.reason ? ` (${rt.latest.reason})` : ""}`,
      rt.latest.passed && rt.latest.current_contract && (onHead || p.candidate.length === 0),
      "the runner's acceptance evidence (system)",
      "evidence",
    );
  }
  return out;
}

/** The ticket's acceptance profile and the runner's latest acceptance record. */
function readRuntimeAcceptance(
  ticket: Ticket,
  rows: Evidence[],
  currentHash: string | null,
): PacketRuntimeAcceptance {
  const contract = parseTestContract(ticket.test_contract);
  const profile = contractProfile(contract);
  const row = rows
    .filter(
      (e) =>
        e.recorded_by_actor_type === RUNNER &&
        String(e.uri ?? "").startsWith(ACCEPTANCE_EVIDENCE_PREFIX),
    )
    .pop();
  let latest: PacketRuntimeAcceptance["latest"] = null;
  if (row) {
    try {
      const pl = JSON.parse(row.payload_json ?? "{}") as Record<string, unknown>;
      if (pl.profile === profile)
        latest = {
          evidence_id: row.id,
          kind: String(pl.kind ?? ""),
          passed: pl.passed === true,
          tested_commit: String(pl.tested_commit ?? ""),
          cases: Array.isArray(pl.cases) ? pl.cases.length : 0,
          reason: typeof pl.reason === "string" ? pl.reason.slice(0, 300) : null,
          at: row.created_at,
          current_contract: currentHash !== null && pl.contract_hash === currentHash,
        };
    } catch {
      latest = null;
    }
  }
  return {
    profile,
    executable: EXECUTABLE_PROFILES.includes(profile),
    spec_registered: !!contract?.profile_spec,
    latest,
  };
}

export class ReviewPacketService {
  constructor(private readonly deps: ReviewPacketDeps) {}

  /**
   * Assemble the packet for `ticket` from recorded state. Pure read. `costFor` reads
   * the usage ledger (the API passes runDetail's ticketCostInfo, the same accounting
   * the run detail and the caps use); a throw reads as `unreadable`, never as $0.
   */
  assemble(ticket: Ticket, costFor: CostReader): ReviewPacket {
    const rows = this.deps.evidence
      .listForTicket(ticket.id)
      .slice()
      .sort((a, b) =>
        a.created_at !== b.created_at
          ? a.created_at < b.created_at
            ? -1
            : 1
          : a.id < b.id
            ? -1
            : a.id > b.id
              ? 1
              : 0,
      );
    const events = listEvents(this.deps.db, "ticket", ticket.id);
    const gates = readGates(rows);

    const escalations = events.filter((e) => e.event_type === "ticket.autoship_escalated");
    const reasons: string[] = [];
    for (const e of escalations) {
      const r = payloadOf(e).reasons;
      if (Array.isArray(r))
        for (const x of r) if (typeof x === "string" && !reasons.includes(x)) reasons.push(x);
    }

    const rework = readRework(ticket.id, events, this.deps.reworkAttempts.listForTicket(ticket.id));
    // The agent's words about the CURRENT attempt: the rows an agent recorded since
    // the latest send-back (a gate bounce, a tester fail, a review rejection). A claim
    // an earlier attempt made was about earlier code; the runner's tally is this one's.
    // The tester's verdict rows are not the delivery's summary (it ran its own tests).
    const testerRows = testerVerdictIds(events);
    const sentBackAt = rework.length > 0 ? rework[rework.length - 1]!.at : null;
    const sinceReview = enteredReviewAt(ticket.id, events);
    const claims = parseTestClaimsFrom(
      rows
        .filter(
          (e) =>
            e.recorded_by_actor_type === "agent" &&
            !testerRows.has(e.id) &&
            (sentBackAt === null || e.created_at > sentBackAt),
        )
        .map((e) => ({ text: e.summary, acScoped: e.ac_id !== null })),
    );
    const testsFailed = Boolean(
      gates && gates.rows.some((g) => g.gate === "tests" && g.status === "FAIL"),
    );
    const disagreements = compareTestClaims(claims, gates?.tally ?? null, {
      testsGateFailed: testsFailed,
    });

    let cost: Omit<PacketCost, "budget_usd">;
    try {
      cost =
        ticket.number === null
          ? { ...ZERO_COST, ledger_status: "no_ticket" }
          : costFor(ticket.number);
    } catch {
      cost = { ...ZERO_COST, ledger_status: "unreadable" };
    }

    const tester = readTester(rows, events, candidateRoundAt(ticket.id, events));
    const candidate = this.readCandidate(ticket, rows, events, sinceReview, tester);
    // REQUIRED CI's candidate is the first write repo whose head resolves (ciCandidateHead).
    const ci = readCi(
      this.deps.db,
      ticket.id,
      candidate.find((c) => c.diff_head !== null)?.diff_head ?? null,
    );
    const runLinks = [
      ...runsAt(this.deps.db, sinceReview, "delivery"),
      ...runsAt(this.deps.db, tester?.at ?? null, "tester"),
    ];
    const base: Omit<ReviewPacket, "backing"> = {
      gates,
      tester,
      tester_expected: safeBool(() => this.deps.testerExpected(ticket)),
      tester_lane: readLane(
        () => this.deps.testerLane?.(ticket) ?? null,
        () => this.deps.runnerTesterLane?.(ticket) ?? null,
      ),
      cost: { ...cost, budget_usd: ticket.delivery_budget_usd },
      attempts: {
        attempt_count: ticket.attempt_count,
        max_attempts: this.deps.maxAttempts,
        rework,
      },
      risk: { level: ticket.risk_level, reasons },
      pin: readPin(rows, sinceReview),
      acceptance: this.deps.acs
        .listForTicket(ticket.id)
        .map((ac) => readCriterion(ac, rows, sentBackAt)),
      disagreements,
      judge: currentJudgment(events, sinceReview),
      scout: latestScout(events),
      intent: readIntent(ticket),
      candidate,
      ci,
      run_links: runLinks,
      runtime_acceptance: readRuntimeAcceptance(
        ticket,
        rows,
        contractHash(this.deps.db, ticket.id),
      ),
    };
    return { ...base, backing: readBacking(base, rows) };
  }

  /**
   * SAME CANDIDATE, per active write repo: the gated commit the runner recorded, the head
   * now, the tester's commit (primary repo) and this repo's pin. Fail-soft: a head reader
   * that throws leaves every head unknown, never a guessed one.
   */
  private readCandidate(
    ticket: Ticket,
    rows: Evidence[],
    events: WorkEvent[],
    sinceReview: string | null,
    tester: PacketTester | null,
  ): PacketCandidate[] {
    const reader = this.deps.writeRepoHeads;
    if (!reader) return [];
    const attemptAt = attemptStartedAt(ticket.id, events, sinceReview);
    let entries: readonly PacketWriteRepoHead[];
    try {
      entries = reader(ticket);
    } catch {
      return [];
    }
    // The tester runs in one write repo (runner/bin/merge-ticket.mjs's first write link),
    // which on a multi-repo ticket need not be the first one here: its commit belongs to the
    // repo whose head it is (as the approval's coverage check reads it), else the first.
    const testedCommit = tester?.tested_commit ?? null;
    const testedAt = Math.max(
      0,
      entries.findIndex((e) => sameCommit(testedCommit, e.sha)),
    );
    return entries.map((e, i) => {
      const primary = i === 0;
      const gated = this.deps.repoDeliveries?.find(ticket.id, e.repoId)?.commit_sha ?? null;
      const gatedSha =
        gated && /^[0-9a-f]{7,64}$/i.test(gated.trim()) ? gated.trim().toLowerCase() : null;
      const by = gatedSha ? gatedBy(events, e.repoId, gatedSha) : null;
      const tested = i === testedAt ? testedCommit : null;
      const pin = readRepoPin(rows, sinceReview, e.repoId, primary);
      const same =
        gatedSha !== null &&
        e.sha !== null &&
        (by === "runner" || by === null) &&
        sameCommit(gatedSha, e.sha) &&
        (tested === null || sameCommit(tested, e.sha)) &&
        (pin === null || sameCommit(pin, e.sha));
      const earlier =
        gatedSha !== null &&
        e.sha !== null &&
        !sameCommit(gatedSha, e.sha) &&
        gatedBeforeAttempt(events, e.repoId, attemptAt);
      return {
        repo_id: e.repoId,
        repo: e.repo,
        gated_sha: gatedSha,
        gated_by: by,
        gated_earlier: earlier,
        diff_head: e.sha,
        head_unavailable: e.why,
        tester_tested: tested,
        pin,
        same,
      };
    });
  }
}

const ZERO_COST: Omit<PacketCost, "budget_usd"> = {
  cost_usd: 0,
  measured_usd: 0,
  estimated_usd: 0,
  num_turns: 0,
  unknown_calls: 0,
  ledger_status: "unconfigured",
};

function readLane(
  fn: () => TesterLaneDecision | null,
  runnerFn: () => NonNullable<ReviewPacket["tester_lane"]>["runner"] | null,
): ReviewPacket["tester_lane"] {
  let d: TesterLaneDecision | null;
  try {
    d = fn();
  } catch {
    return null;
  }
  if (!d) return null;
  let runner: NonNullable<ReviewPacket["tester_lane"]>["runner"] | null;
  try {
    runner = runnerFn();
  } catch {
    runner = null;
  }
  return {
    mode: d.mode,
    on: d.on,
    missing_test_command: [...d.missing_test_command],
    ...(runner ? { runner: { ...runner } } : {}),
  };
}

function safeBool(fn: () => boolean): boolean {
  try {
    return fn();
  } catch {
    return false;
  }
}

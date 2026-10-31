import type { Db } from "../db/connection.js";
import type {
  AcStatus,
  AcceptanceCriterion,
  Evidence,
  RiskLevel,
  Ticket,
  WorkEvent,
} from "../domain/types.js";
import { listEvents } from "../events/eventWriter.js";
import { AC_CHECK_VERIFIER } from "../policy/policy.js";
import type { AcRepository } from "../repositories/acRepository.js";
import type { EvidenceRepository } from "../repositories/evidenceRepository.js";
import type { ReworkAttemptRepository } from "../repositories/reworkAttemptRepository.js";
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
 * word. No model call, no git call, no write.
 *
 * Not part of the dossier's hashed subject: the cost figure reads the usage ledger,
 * which changes as the factory works, so the packet sits outside the hash.
 */

/** A gate verdict as the runner recorded it. */
export interface PacketGate {
  gate: string;
  repo: string;
  status: "PASS" | "FAIL" | "SKIPPED";
  rc: string | null;
  /** The command a passing gate ran (the runner records it as the note). */
  command: string | null;
  /** A failing or skipped gate's note ("exited 1: …", "no command configured"). */
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

export interface ReviewPacket {
  gates: PacketGates | null;
  tester: PacketTester | null;
  /** The tester runs after the review approval, when this ticket goes through one. */
  tester_expected: boolean;
  cost: PacketCost;
  attempts: PacketAttempts;
  risk: PacketRisk;
  pin: PacketPin | null;
  acceptance: PacketCriterion[];
  disagreements: TestDisagreement[];
}

/** Reads one ticket's usage from the ledger. */
export type CostReader = (ticketNumber: number) => Omit<PacketCost, "budget_usd">;

export interface ReviewPacketDeps {
  db: Db;
  acs: AcRepository;
  evidence: EvidenceRepository;
  reworkAttempts: ReworkAttemptRepository;
  maxAttempts: number;
  /** Whether the independent tester runs for this ticket after approval. */
  testerExpected: (ticket: Ticket) => boolean;
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
    const status = g.status === "PASS" ? "PASS" : g.status === "FAIL" ? "FAIL" : "SKIPPED";
    const note = str(g.note);
    return {
      gate: str(g.gate) ?? "gate",
      repo: str(g.repo) ?? "-",
      status,
      rc: g.rc === undefined || g.rc === null ? null : String(g.rc),
      command: status === "PASS" ? note : null,
      note: status === "PASS" ? null : note,
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
function enteredReviewAt(ticketId: string, events: WorkEvent[]): string | null {
  let at: string | null = null;
  for (const e of events) {
    if (e.event_type !== "ticket.transitioned" || e.entity_id !== ticketId) continue;
    if (str(payloadOf(e).to) !== "in_review") continue;
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
 * A verdict from before the ticket last entered review tested an earlier candidate
 * (that round's fail is in the rework list), so it is not this delivery's.
 */
function readTester(
  rows: Evidence[],
  events: WorkEvent[],
  sinceReview: string | null,
): PacketTester | null {
  const verdictIds = testerVerdictIds(events);
  for (let i = rows.length - 1; i >= 0; i--) {
    const e = rows[i]!;
    if (e.evidence_type !== "test_output" || !verdictIds.has(e.id)) continue;
    const p = payloadOf(e);
    if (p.verdict !== "pass" && p.verdict !== "fail") continue;
    if (before(e, sinceReview)) return null;
    return {
      verdict: p.verdict,
      provenance: str(p.provenance),
      tested_commit: str(p.tested_commit),
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

    return {
      gates,
      tester: readTester(rows, events, sinceReview),
      tester_expected: safeBool(() => this.deps.testerExpected(ticket)),
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
    };
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

function safeBool(fn: () => boolean): boolean {
  try {
    return fn();
  } catch {
    return false;
  }
}

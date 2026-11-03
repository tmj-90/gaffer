/**
 * SPECIALIST VALUE REPORT (delta roadmap gap 5; gap-specialists D1; strategy "specialists
 * must earn their keep"): for each judging lane, what it changed.
 *
 * Attempts are segmented on each ticket's timeline: an attempt starts at each start of
 * work (a move into in_progress or claimed from anywhere else but a pause: resuming a
 * delivery paused at a cap continues the same attempt) and runs to the next one.
 * Its outcome is its first send-back (health/sendBacks.ts isReviewSendBack, by anyone) or
 * its move to done. A lane verdict (`ticket.lane_verdict`) belongs to the attempt it falls
 * in by time; the tester records its verdict just after its own transition, which is still
 * before the next start of work, so it lands on the attempt it judged.
 *
 *   position          approve / pass = pass, changes / fail = block; borderline (the eval
 *                     judge) and held take no position. A lane's position on an attempt is
 *                     its last verdict there that took one.
 *   person's decision the last human or admin exit from in_review in the attempt: an
 *                     approval (to the merge queue, testing or done) = pass, a send-back =
 *                     block.
 *   compared          attempts where the lane took a position and a person decided
 *   differed          of those, the lane and the person disagreed (split by direction)
 *   unique catches    attempts that ended in a send-back where this lane was the only lane
 *                     that said block (whether a person or the lane itself sent it back)
 *   cost per attempt  the lane's ledger spend (its own `kind`, estimates included) over the
 *                     distinct attempt ids on those rows (`cost_per_attempt_basis`
 *                     ledger_attempt_id: the runner stamps a judging row with the ticket's
 *                     latest delivery row's id when it ran, a join by time order); a row with
 *                     no attempt id counts as its own attempt. The plan debate books its turns as `decompose` with
 *                     the rest of planning, so it has no spend of its own here.
 *
 * Counts only. Nothing here recommends switching a lane off: that is a person's call, and
 * the security review and the tester are safety lanes that telemetry never switches off.
 * Pure: the caller supplies the transitions, the verdicts and the ledger rows.
 */
import type { HealthRow } from "./healthAggregator.js";
import { isReviewSendBack } from "./sendBacks.js";

export interface LaneValueTransition {
  readonly ticketId: string;
  readonly actorType: string;
  readonly fromStatus: string | null;
  readonly toStatus: string | null;
  readonly reason: string | null;
  readonly atMs: number;
}

export interface LaneValueVerdict {
  readonly ticketId: string;
  readonly lane: string;
  readonly verdict: string;
  readonly atMs: number;
}

export interface LaneValue {
  readonly lane: string;
  readonly label: string;
  /** A safety lane: telemetry never switches it off. */
  readonly safety: boolean;
  readonly verdicts_recorded: number;
  readonly by_verdict: Readonly<Record<string, number>>;
  readonly attempts_judged: number;
  readonly compared: number;
  readonly differed: number;
  /** The lane said block, the person passed it. */
  readonly differed_lane_blocked: number;
  /** The lane said pass, the person sent it back. */
  readonly differed_lane_passed: number;
  readonly unique_catches: number;
  /** Ledger spend booked under the lane's kind; null when the lane has no kind of its own. */
  readonly spend_usd: number | null;
  readonly ledger_calls: number;
  readonly ledger_attempts: number;
  readonly cost_per_attempt_usd: number | null;
  /** "no verdicts recorded" when the lane has none; null otherwise. */
  readonly note: string | null;
}

export interface LaneValueReport {
  readonly measure: "lane_value";
  readonly attempts: number;
  readonly attempts_with_person_decision: number;
  readonly send_backs: number;
  /** Send-backs where no lane said block: a person (or a gate) caught them. */
  readonly send_backs_no_lane_caught: number;
  readonly lanes: readonly LaneValue[];
  /**
   * What `cost_per_attempt_usd` divides by: the distinct `attempt_id`s on the lane's ledger
   * rows (the latest delivery row's id when the call ran; a row without one is its own).
   */
  readonly cost_per_attempt_basis: "ledger_attempt_id";
  readonly footnote: string;
  readonly limits: readonly string[];
}

/** Each lane in the report: its label, the ledger kind its calls book to, and safety. */
export const LANE_VALUE_LANES: ReadonlyArray<{
  lane: string;
  label: string;
  kind: string | null;
  safety: boolean;
}> = [
  { lane: "agent-review", label: "Reviewer agent", kind: "review", safety: false },
  { lane: "security-review", label: "Security review", kind: "security-review", safety: true },
  { lane: "tester", label: "Tester", kind: "tester", safety: true },
  { lane: "eval-judge", label: "Eval judge", kind: "eval-judge", safety: false },
  { lane: "plan-debate", label: "Plan debate", kind: null, safety: false },
];

export const LANE_VALUE_FOOTNOTE =
  "Counts only, no recommendation: whether a lane is worth its cost is a person's call. The security review and the tester are safety lanes and are never switched off by telemetry.";

export const LANE_VALUE_LIMITS: readonly string[] = [
  "attempts are segmented on each ticket's timeline from each start of work; a verdict is joined to the attempt it falls in by time, not by commit",
  "a unique catch is a send-back only this lane asked for; it is not confirmed as a real defect",
  "compared counts only attempts a person decided; an agent's own approval or send-back is not a person's decision",
  "spend is the lane's ledger kind, estimates included; the plan debate books with the rest of planning and has no spend of its own here",
  "cost per attempt divides by the attempt ids on the lane's ledger rows: the ticket's latest delivery row when the call ran (a join by time order, not a commit match); a row without one counts as its own attempt",
];

const START_OF_WORK = new Set(["in_progress", "claimed"]);
/** A move into work from here continues the attempt (a resume after a pause at a cap). */
const CONTINUES_FROM = new Set(["in_progress", "claimed", "paused"]);
const APPROVED_TO = new Set(["ready_for_merge", "in_testing", "done"]);
const isPerson = (a: string): boolean => a === "human" || a === "admin";

type Position = "pass" | "block";
function positionOf(verdict: string): Position | null {
  const v = verdict.toLowerCase();
  if (v === "approve" || v === "pass") return "pass";
  if (v === "changes" || v === "fail") return "block";
  return null;
}

interface Attempt {
  readonly ticketId: string;
  outcome: "sent_back" | "accepted" | null;
  person: Position | null;
  /** Per lane: last position taken (null: only held/borderline). */
  readonly lanes: Map<string, Position | null>;
}

const usd = (v: number): number => Math.round(v * 1e6) / 1e6;

/** The report (see the module comment). */
export function laneValueReport(input: {
  transitions: readonly LaneValueTransition[];
  verdicts: readonly LaneValueVerdict[];
  ledger: readonly HealthRow[];
}): LaneValueReport {
  type Item =
    | { kind: "t"; atMs: number; seq: number; t: LaneValueTransition }
    | { kind: "v"; atMs: number; seq: number; v: LaneValueVerdict };
  const byTicket = new Map<string, Item[]>();
  let seq = 0;
  const push = (id: string, item: Item): void => {
    const list = byTicket.get(id);
    if (list) list.push(item);
    else byTicket.set(id, [item]);
  };
  for (const t of input.transitions) push(t.ticketId, { kind: "t", atMs: t.atMs, seq: seq++, t });
  for (const v of input.verdicts) push(v.ticketId, { kind: "v", atMs: v.atMs, seq: seq++, v });

  const byVerdict = new Map<string, Map<string, number>>();
  for (const v of input.verdicts) {
    const m = byVerdict.get(v.lane) ?? new Map<string, number>();
    m.set(v.verdict, (m.get(v.verdict) ?? 0) + 1);
    byVerdict.set(v.lane, m);
  }

  const attempts: Attempt[] = [];
  for (const [ticketId, items] of byTicket) {
    // Time order; at the same millisecond, the order the rows were written.
    items.sort((a, b) => a.atMs - b.atMs || a.seq - b.seq);
    let cur: Attempt | null = null;
    const open = (): Attempt => {
      const a: Attempt = { ticketId, outcome: null, person: null, lanes: new Map() };
      attempts.push(a);
      return a;
    };
    for (const it of items) {
      if (it.kind === "t") {
        const t = it.t;
        const starts =
          START_OF_WORK.has(t.toStatus ?? "") && !CONTINUES_FROM.has(t.fromStatus ?? "");
        if (starts || cur === null) cur = open();
        if (t.fromStatus === "in_review" && isPerson(t.actorType)) {
          if (APPROVED_TO.has(t.toStatus ?? "")) cur.person = "pass";
          else if (isReviewSendBack({ ...t, at: "" })) cur.person = "block";
        }
        if (cur.outcome === null) {
          if (isReviewSendBack({ ...t, at: "" })) cur.outcome = "sent_back";
          else if (t.toStatus === "done") cur.outcome = "accepted";
        }
      } else {
        if (cur === null) cur = open();
        const pos = positionOf(it.v.verdict);
        const prev = cur.lanes.get(it.v.lane);
        if (pos !== null) cur.lanes.set(it.v.lane, pos);
        else if (prev === undefined) cur.lanes.set(it.v.lane, null);
      }
    }
  }

  const lanes: LaneValue[] = LANE_VALUE_LANES.map((def) => {
    let judged = 0;
    let compared = 0;
    let lb = 0;
    let lp = 0;
    let unique = 0;
    for (const a of attempts) {
      if (!a.lanes.has(def.lane)) continue;
      judged += 1;
      const pos = a.lanes.get(def.lane) ?? null;
      if (pos !== null && a.person !== null) {
        compared += 1;
        if (pos === "block" && a.person === "pass") lb += 1;
        if (pos === "pass" && a.person === "block") lp += 1;
      }
      if (a.outcome === "sent_back" && pos === "block") {
        const others = [...a.lanes].some(([l, p]) => l !== def.lane && p === "block");
        if (!others) unique += 1;
      }
    }
    const counts = byVerdict.get(def.lane);
    const recorded = counts ? [...counts.values()].reduce((s, n) => s + n, 0) : 0;
    let spend: number | null = null;
    let calls = 0;
    const ids = new Set<string>();
    if (def.kind !== null) {
      spend = 0;
      input.ledger.forEach((r, i) => {
        if (r.kind !== def.kind) return;
        calls += 1;
        spend = (spend ?? 0) + r.total_cost_usd + (r.estimated_cost_usd ?? 0);
        ids.add(r.attempt_id ?? `row-${i}`);
      });
    }
    return {
      lane: def.lane,
      label: def.label,
      safety: def.safety,
      verdicts_recorded: recorded,
      by_verdict: counts ? Object.fromEntries(counts) : {},
      attempts_judged: judged,
      compared,
      differed: lb + lp,
      differed_lane_blocked: lb,
      differed_lane_passed: lp,
      unique_catches: unique,
      spend_usd: spend === null ? null : usd(spend),
      ledger_calls: calls,
      ledger_attempts: ids.size,
      cost_per_attempt_usd: spend !== null && ids.size > 0 ? usd(spend / ids.size) : null,
      note: recorded === 0 ? "no verdicts recorded" : null,
    };
  });

  const sentBack = attempts.filter((a) => a.outcome === "sent_back");
  return {
    measure: "lane_value",
    attempts: attempts.length,
    attempts_with_person_decision: attempts.filter((a) => a.person !== null).length,
    send_backs: sentBack.length,
    send_backs_no_lane_caught: sentBack.filter((a) => ![...a.lanes.values()].includes("block"))
      .length,
    lanes,
    cost_per_attempt_basis: "ledger_attempt_id",
    footnote: LANE_VALUE_FOOTNOTE,
    limits: LANE_VALUE_LIMITS,
  };
}

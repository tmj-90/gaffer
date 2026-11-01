/**
 * JUDGE AGREEMENT: is the eval judge's score worth having? (docs/eval-harness.md,
 * "Is the judge worth having?")
 *
 * The judge (opt-in in the runner) grades every submitted delivery 0-5. A grade is worth
 * its model call only if it tells a reviewer something: a low grade should come before a
 * send-back, a high one before an acceptance. This pairs each judgment with what then
 * happened to THAT delivery, from the factory's own records:
 *
 *   - accepted: the review approved it and nothing sent it back before it reached
 *     ready_for_merge or done (through the tester, when the ticket uses one);
 *   - sent_back: a reviewer, the agent review or the tester sent it back to work
 *     (or the retry cap parked it after a rejection);
 *   - cancelled: it was closed from review without landing (won't do);
 *   - pending: still waiting for a decision.
 *
 * and reports how well the grade separated the two: a confusion table by verdict, the
 * precision / recall / lift of a non-pass verdict as a warning of a send-back, the AUC of
 * the score against acceptance, per-dimension means per outcome, the misses (the judge
 * passed it, then it was sent back, with the reason) and the false alarms, and how many
 * review entries the judge covered at all. A reading with fixed thresholds says whether
 * the data is enough to tell.
 *
 * Judgments come from `ticket.eval_judged` events (recorded since the verdict reached the
 * ticket) and from eval-ledger.jsonl records (older judgments, paired by ticket number and
 * time); a ledger record with a matching event is the same judgment and counted once.
 * Pure functions plus one read-only DB reader; no model call, no write.
 */
import type { Db } from "../db/connection.js";
import { EVAL_JUDGED_EVENT, JUDGE_DIMENSIONS, readJudgments } from "../services/evalJudgment.js";
import type { JudgeDimension, JudgeOverall } from "../services/evalJudgment.js";
import type { WorkEvent } from "../domain/types.js";
import { isReviewSendBack } from "./sendBacks.js";

export interface JudgmentPoint {
  ticketId: string;
  ticketNumber: number | null;
  at: string;
  overall: JudgeOverall;
  score: number;
  dims: Partial<Record<JudgeDimension, number>>;
  source: "event" | "ledger";
}

export interface TransitionPoint {
  ticketId: string;
  from: string | null;
  to: string | null;
  reason: string | null;
  actorType: string;
  at: string;
}

export type Outcome = "accepted" | "sent_back" | "cancelled" | "pending";
/** Who made the decision: a person, the agent review, the independent tester, the runner. */
export type Decider = "human" | "agent" | "tester" | "system";

export interface PairedJudgment extends JudgmentPoint {
  outcome: Outcome;
  decidedBy: Decider | null;
  decidedAt: string | null;
  /** The send-back's recorded reason (sent_back / cancelled), else null. */
  reason: string | null;
  /** Every send-back of this ticket after the judgment (this delivery's and later ones'). */
  laterSendBacks: number;
}

export interface AgreementReading {
  status: "no_judgments" | "insufficient_data" | "separates" | "does_not_separate";
  text: string;
}

export interface JudgeAgreementReport {
  judgments: number;
  fromEvents: number;
  fromLedger: number;
  decided: number;
  pending: number;
  /** Review entries since the first judgment, and how many of them were judged. */
  coverage: { reviewEntries: number; judged: number; rate: number | null };
  /** Verdict x outcome. `rejected` is sent_back + cancelled. */
  table: Record<JudgeOverall, { accepted: number; rejected: number; pending: number }>;
  byDecider: Record<Decider, { accepted: number; rejected: number }>;
  /** A non-pass verdict read as a warning that the delivery will be rejected. */
  warning: {
    rejectedRate: number | null;
    precision: number | null;
    recall: number | null;
    lift: number | null;
  };
  meanScore: { accepted: number | null; rejected: number | null };
  /** P(an accepted delivery scored above a rejected one), ties count half. 0.5 = no signal. */
  auc: number | null;
  dimensionMeans: Record<
    JudgeDimension,
    { accepted: number | null; rejected: number | null; gap: number | null }
  >;
  misses: Array<{ ticketNumber: number | null; score: number; reason: string | null; at: string }>;
  falseAlarms: Array<{
    ticketNumber: number | null;
    score: number;
    overall: JudgeOverall;
    weakest: string | null;
    at: string;
  }>;
  thresholds: typeof THRESHOLDS;
  reading: AgreementReading;
  pairs: PairedJudgment[];
}

/**
 * The rule of thumb the reading applies (docs/eval-harness.md). Below the sample sizes the
 * report says it cannot tell; above them the judge "separates" when its score ranks
 * accepted work above rejected work clearly (AUC) AND a non-pass verdict raises the
 * chance of a rejection well above the base rate (lift).
 */
export const THRESHOLDS = {
  minDecided: 20,
  minEachOutcome: 5,
  minAuc: 0.7,
  minLift: 1.5,
} as const;

const REVIEW_STATES = new Set(["in_review", "in_testing", "ready_for_merge"]);
const round2 = (n: number): number => Math.round(n * 100) / 100;
const ratio = (a: number, b: number): number | null => (b > 0 ? round2(a / b) : null);
const meanOf = (xs: number[]): number | null =>
  xs.length ? round2(xs.reduce((a, b) => a + b, 0) / xs.length) : null;

function deciderOf(t: TransitionPoint): Decider {
  if (t.from === "in_testing" || (t.reason ?? "").includes("tester_")) return "tester";
  if (t.actorType === "human" || t.actorType === "admin") return "human";
  if (t.actorType === "agent") return "agent";
  return "system";
}

/**
 * What happened to the delivery judged at `j.at`: the first decision on the ticket after
 * it. An approval to in_testing waits for the tester; a hold (blocked for CI, a merge gate)
 * is not a quality decision and is skipped.
 */
export function outcomeAfter(
  j: Pick<JudgmentPoint, "ticketId" | "at">,
  transitions: readonly TransitionPoint[],
): Pick<PairedJudgment, "outcome" | "decidedBy" | "decidedAt" | "reason" | "laterSendBacks"> {
  const mine = transitions
    .filter((t) => t.ticketId === j.ticketId && t.at >= j.at)
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const laterSendBacks = mine.filter((t) =>
    isReviewSendBack({
      ticketId: t.ticketId,
      fromStatus: t.from,
      toStatus: t.to,
      reason: t.reason,
      at: t.at,
    }),
  ).length;
  for (const t of mine) {
    const sendBack = isReviewSendBack({
      ticketId: t.ticketId,
      fromStatus: t.from,
      toStatus: t.to,
      reason: t.reason,
      at: t.at,
    });
    if (sendBack)
      return {
        outcome: "sent_back",
        decidedBy: deciderOf(t),
        decidedAt: t.at,
        reason: t.reason,
        laterSendBacks,
      };
    if (t.to === "cancelled" && REVIEW_STATES.has(t.from ?? ""))
      return {
        outcome: "cancelled",
        decidedBy: deciderOf(t),
        decidedAt: t.at,
        reason: t.reason,
        laterSendBacks,
      };
    if (t.to === "ready_for_merge" || t.to === "done")
      return {
        outcome: "accepted",
        decidedBy: deciderOf(t),
        decidedAt: t.at,
        reason: null,
        laterSendBacks,
      };
    // A judgment made before the delivery re-entered work (it graded an attempt the
    // gates later bounced inside the tick) is followed by in_progress/claimed moves:
    // keep reading until a review decision.
  }
  return { outcome: "pending", decidedBy: null, decidedAt: null, reason: null, laterSendBacks };
}

/** The Mann-Whitney AUC: P(score of an accepted > score of a rejected), ties half. */
export function aucOf(accepted: readonly number[], rejected: readonly number[]): number | null {
  if (!accepted.length || !rejected.length) return null;
  let wins = 0;
  for (const a of accepted) for (const r of rejected) wins += a > r ? 1 : a === r ? 0.5 : 0;
  return round2(wins / (accepted.length * rejected.length));
}

/**
 * One judgment per delivery: a ledger record is the same judgment as an event on the
 * same ticket number with the same verdict and score recorded within ten minutes of it
 * (eval-judge.sh appends the ledger line, then records the event).
 */
export function mergeJudgments(
  events: readonly JudgmentPoint[],
  ledger: readonly JudgmentPoint[],
): JudgmentPoint[] {
  const WINDOW = 10 * 60 * 1000;
  const out = [...events];
  for (const l of ledger) {
    const dup = events.some(
      (e) =>
        e.ticketNumber !== null &&
        e.ticketNumber === l.ticketNumber &&
        e.overall === l.overall &&
        Math.abs(e.score - l.score) < 0.01 &&
        Math.abs(Date.parse(e.at) - Date.parse(l.at)) <= WINDOW,
    );
    if (!dup) out.push(l);
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

function readingOf(r: Omit<JudgeAgreementReport, "reading" | "thresholds">): AgreementReading {
  if (r.judgments === 0)
    return {
      status: "no_judgments",
      text:
        "No judged deliveries. Turn the eval judge on (docs/eval-harness.md, Knobs) for a run of real " +
        "tickets, review them as usual, then run this again.",
    };
  const acc = r.pairs.filter((p) => p.outcome === "accepted").length;
  const rej = r.pairs.filter((p) => p.outcome === "sent_back" || p.outcome === "cancelled").length;
  if (
    r.decided < THRESHOLDS.minDecided ||
    acc < THRESHOLDS.minEachOutcome ||
    rej < THRESHOLDS.minEachOutcome
  )
    return {
      status: "insufficient_data",
      text:
        `Not enough decided deliveries to tell: ${r.decided} decided (${acc} accepted, ${rej} ` +
        `rejected); the reading needs at least ${THRESHOLDS.minDecided}, with ` +
        `${THRESHOLDS.minEachOutcome} of each.`,
    };
  const lift = r.warning.lift;
  if (r.auc !== null && r.auc >= THRESHOLDS.minAuc && lift !== null && lift >= THRESHOLDS.minLift)
    return {
      status: "separates",
      text:
        `The judge separates accepted from rejected work here: AUC ${r.auc}, and a non-pass ` +
        `verdict was followed by a rejection ${lift}x as often as the base rate. Its grade is ` +
        "worth showing to the reviewer.",
    };
  return {
    status: "does_not_separate",
    text:
      `The judge does not separate accepted from rejected work here (AUC ${r.auc ?? "n/a"}, ` +
      `lift ${lift ?? "n/a"}; it needs AUC >= ${THRESHOLDS.minAuc} and lift >= ` +
      `${THRESHOLDS.minLift}). Its model call is not paying for itself on this factory; read ` +
      "the misses before changing the judge model or turning it off.",
  };
}

/**
 * How many entries into review the judge covered, counted from the first entry it judged:
 * an entry is judged when a judgment on that ticket falls between it and the ticket's next
 * entry into review. A low rate means the judge is failing quietly (an unbuilt crew, a
 * dead model turn, a refusal), and the agreement figures describe a sample, not the run.
 */
export function coverageOf(
  pairs: readonly Pick<JudgmentPoint, "ticketId" | "at">[],
  transitions: readonly TransitionPoint[],
): JudgeAgreementReport["coverage"] {
  const entries = transitions
    .filter((t) => t.to === "in_review")
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const judgedFlags = entries.map((e, i) => {
    const next = entries.slice(i + 1).find((n) => n.ticketId === e.ticketId);
    return pairs.some(
      (p) => p.ticketId === e.ticketId && p.at >= e.at && (next === undefined || p.at < next.at),
    );
  });
  const start = judgedFlags.indexOf(true);
  if (start === -1) return { reviewEntries: 0, judged: 0, rate: null };
  const counted = judgedFlags.slice(start);
  const judged = counted.filter(Boolean).length;
  return { reviewEntries: counted.length, judged, rate: ratio(judged, counted.length) };
}

/** Pair every judgment with its outcome and summarise the agreement. Pure. */
export function judgeAgreement(
  judgments: readonly JudgmentPoint[],
  transitions: readonly TransitionPoint[],
): JudgeAgreementReport {
  const pairs: PairedJudgment[] = judgments.map((j) => ({ ...j, ...outcomeAfter(j, transitions) }));
  const isRej = (p: PairedJudgment): boolean =>
    p.outcome === "sent_back" || p.outcome === "cancelled";
  const decidedPairs = pairs.filter((p) => p.outcome !== "pending");
  const accepted = decidedPairs.filter((p) => p.outcome === "accepted");
  const rejected = decidedPairs.filter(isRej);

  const table = {
    pass: { accepted: 0, rejected: 0, pending: 0 },
    borderline: { accepted: 0, rejected: 0, pending: 0 },
    fail: { accepted: 0, rejected: 0, pending: 0 },
  };
  const byDecider = {
    human: { accepted: 0, rejected: 0 },
    agent: { accepted: 0, rejected: 0 },
    tester: { accepted: 0, rejected: 0 },
    system: { accepted: 0, rejected: 0 },
  };
  for (const p of pairs) {
    const row = table[p.overall];
    if (p.outcome === "pending") row.pending++;
    else if (p.outcome === "accepted") row.accepted++;
    else row.rejected++;
    if (p.decidedBy) {
      if (p.outcome === "accepted") byDecider[p.decidedBy].accepted++;
      else if (isRej(p)) byDecider[p.decidedBy].rejected++;
    }
  }

  const warned = decidedPairs.filter((p) => p.overall !== "pass");
  const warnedRejected = warned.filter(isRej).length;
  const rejectedRate = ratio(rejected.length, decidedPairs.length);
  const precision = ratio(warnedRejected, warned.length);
  const recall = ratio(warnedRejected, rejected.length);
  const lift = precision !== null && rejectedRate ? round2(precision / rejectedRate) : null;

  const dimensionMeans = {} as JudgeAgreementReport["dimensionMeans"];
  for (const d of JUDGE_DIMENSIONS) {
    const a = meanOf(accepted.map((p) => p.dims[d]).filter((v): v is number => v !== undefined));
    const r = meanOf(rejected.map((p) => p.dims[d]).filter((v): v is number => v !== undefined));
    dimensionMeans[d] = {
      accepted: a,
      rejected: r,
      gap: a !== null && r !== null ? round2(a - r) : null,
    };
  }

  const coverage = coverageOf(pairs, transitions);

  const weakestOf = (p: PairedJudgment): string | null => {
    let best: [string, number] | null = null;
    for (const [d, v] of Object.entries(p.dims))
      if (typeof v === "number" && (best === null || v < best[1])) best = [d, v];
    return best ? `${best[0]} ${best[1]}/5` : null;
  };

  const base: Omit<JudgeAgreementReport, "reading" | "thresholds"> = {
    judgments: pairs.length,
    fromEvents: pairs.filter((p) => p.source === "event").length,
    fromLedger: pairs.filter((p) => p.source === "ledger").length,
    decided: decidedPairs.length,
    pending: pairs.length - decidedPairs.length,
    coverage,
    table,
    byDecider,
    warning: { rejectedRate, precision, recall, lift },
    meanScore: {
      accepted: meanOf(accepted.map((p) => p.score)),
      rejected: meanOf(rejected.map((p) => p.score)),
    },
    auc: aucOf(
      accepted.map((p) => p.score),
      rejected.map((p) => p.score),
    ),
    dimensionMeans,
    misses: rejected
      .filter((p) => p.overall === "pass")
      .map((p) => ({ ticketNumber: p.ticketNumber, score: p.score, reason: p.reason, at: p.at })),
    falseAlarms: accepted
      .filter((p) => p.overall !== "pass")
      .map((p) => ({
        ticketNumber: p.ticketNumber,
        score: p.score,
        overall: p.overall,
        weakest: weakestOf(p),
        at: p.at,
      })),
    pairs,
  };
  return { ...base, thresholds: THRESHOLDS, reading: readingOf(base) };
}

/**
 * Parse eval-ledger.jsonl into judgment points, resolving each record's ticket NUMBER
 * (the runner writes the number as `ticketId`) to the ticket id. Records for tickets this
 * database does not hold are dropped (another factory's ledger, or a deleted ticket).
 */
export function parseLedgerJudgments(
  jsonl: string,
  idByNumber: ReadonlyMap<number, string>,
): JudgmentPoint[] {
  const out: JudgmentPoint[] = [];
  for (const line of jsonl.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let r: Record<string, unknown>;
    try {
      const v = JSON.parse(t) as unknown;
      if (!v || typeof v !== "object" || Array.isArray(v)) continue;
      r = v as Record<string, unknown>;
    } catch {
      continue;
    }
    const num = Number.parseInt(String(r.ticketId ?? "").replace(/^#/, ""), 10);
    const id = Number.isFinite(num) ? idByNumber.get(num) : undefined;
    if (!id || typeof r.score !== "number" || typeof r.ts !== "string") continue;
    const overall: JudgeOverall =
      r.overall === "pass" || r.overall === "borderline" ? r.overall : "fail";
    const dims: Partial<Record<JudgeDimension, number>> = {};
    if (r.dims && typeof r.dims === "object")
      for (const d of JUDGE_DIMENSIONS) {
        const v = (r.dims as Record<string, unknown>)[d];
        if (typeof v === "number") dims[d] = v;
      }
    out.push({
      ticketId: id,
      ticketNumber: num,
      at: r.ts,
      overall,
      score: r.score,
      dims,
      source: "ledger",
    });
  }
  return out;
}

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

/** Read the judgments and transitions from a factory's database (read-only) and report. */
export function readJudgeAgreement(
  db: Db,
  opts: { ledgerJsonl?: string } = {},
): JudgeAgreementReport {
  const tickets = db.prepare(`SELECT id, number FROM tickets`).all() as Array<{
    id: string;
    number: number | null;
  }>;
  const numberById = new Map(tickets.map((t) => [t.id, t.number]));
  const idByNumber = new Map<number, string>();
  for (const t of tickets) if (t.number !== null) idByNumber.set(t.number, t.id);

  const rows = db
    .prepare(
      `SELECT * FROM work_events WHERE entity_type = 'ticket'
         AND event_type IN ('ticket.transitioned', ?) ORDER BY rowid ASC`,
    )
    .all(EVAL_JUDGED_EVENT) as WorkEvent[];
  const transitions: TransitionPoint[] = [];
  const byTicket = new Map<string, WorkEvent[]>();
  for (const e of rows) {
    if (e.event_type === "ticket.transitioned") {
      const p = payloadOf(e);
      transitions.push({
        ticketId: e.entity_id,
        from: str(p.from),
        to: str(p.to),
        reason: str(p.reason),
        actorType: e.actor_type,
        at: e.created_at,
      });
    } else {
      const list = byTicket.get(e.entity_id) ?? [];
      list.push(e);
      byTicket.set(e.entity_id, list);
    }
  }
  const events: JudgmentPoint[] = [];
  for (const [ticketId, list] of byTicket)
    for (const j of readJudgments(list))
      events.push({
        ticketId,
        ticketNumber: numberById.get(ticketId) ?? null,
        at: j.at,
        overall: j.overall,
        score: j.score,
        dims: j.dims,
        source: "event",
      });
  const ledger = opts.ledgerJsonl ? parseLedgerJudgments(opts.ledgerJsonl, idByNumber) : [];
  return judgeAgreement(mergeJudgments(events, ledger), transitions);
}

const pct = (v: number | null): string => (v === null ? "n/a" : `${Math.round(v * 100)}%`);
const num = (v: number | null): string => (v === null ? "n/a" : String(v));

/** The text report `wg judge-agreement` prints. */
export function renderJudgeAgreement(r: JudgeAgreementReport): string {
  const out: string[] = [];
  out.push("Eval judge agreement (does a low judge score come before a rejection?)");
  out.push(
    `  judged deliveries: ${r.judgments} (${r.fromEvents} on the ticket, ${r.fromLedger} from the ledger only)`,
  );
  out.push(`  decided: ${r.decided}, still pending: ${r.pending}`);
  if (r.coverage.reviewEntries > 0)
    out.push(
      `  coverage: ${r.coverage.judged} of ${r.coverage.reviewEntries} review entries since the first judgment were judged (${pct(r.coverage.rate)})`,
    );
  if (r.judgments > 0) {
    out.push("  verdict      accepted  rejected  pending");
    for (const v of ["pass", "borderline", "fail"] as const) {
      const row = r.table[v];
      out.push(
        `  ${v.padEnd(11)}  ${String(row.accepted).padStart(8)}  ${String(row.rejected).padStart(8)}  ${String(row.pending).padStart(7)}`,
      );
    }
    out.push(
      `  rejected overall: ${pct(r.warning.rejectedRate)}; after a non-pass verdict: ${pct(r.warning.precision)} (lift ${num(r.warning.lift)}); rejections the judge warned of: ${pct(r.warning.recall)}`,
    );
    out.push(
      `  mean score: accepted ${num(r.meanScore.accepted)}, rejected ${num(r.meanScore.rejected)}; AUC ${num(r.auc)} (0.5 = no signal)`,
    );
    const gaps = JUDGE_DIMENSIONS.filter((d) => r.dimensionMeans[d].gap !== null).map(
      (d) => `${d} ${num(r.dimensionMeans[d].gap)}`,
    );
    if (gaps.length) out.push(`  dimension gap (accepted - rejected): ${gaps.join(", ")}`);
    const d = r.byDecider;
    out.push(
      `  decided by: people ${d.human.accepted}/${d.human.rejected}, agent review ${d.agent.accepted}/${d.agent.rejected}, tester ${d.tester.accepted}/${d.tester.rejected} (accepted/rejected)`,
    );
    for (const m of r.misses.slice(0, 5))
      out.push(
        `  miss: #${m.ticketNumber ?? "?"} judged pass ${m.score}, then sent back: ${(m.reason ?? "no reason").slice(0, 160)}`,
      );
    for (const f of r.falseAlarms.slice(0, 5))
      out.push(
        `  false alarm: #${f.ticketNumber ?? "?"} judged ${f.overall} ${f.score}${f.weakest ? ` (${f.weakest})` : ""}, then accepted`,
      );
  }
  out.push(`  reading: ${r.reading.text}`);
  return out.join("\n");
}

import type { Actor, WorkEvent } from "../domain/types.js";
import { DispatchError } from "../util/errors.js";

/**
 * EVAL JUDGE ON THE TICKET: the delivery-quality judge's verdict (runner/lib/eval-judge.sh,
 * opt-in in the runner) recorded as a `ticket.eval_judged` event, so it sits beside the
 * review and tester outcomes it is meant to predict. It used to live only in
 * $GAFFER_DATA/eval-ledger.jsonl, where nothing could pair a score with what the reviewer
 * then did, and the reviewer never saw it.
 *
 * Advisory only: no gate, approval or landing path reads this event. It is a model's
 * opinion of a diff, so the Review view labels it as one and never as a runner fact.
 * Only the runner (system) or an admin records one; an agent never grades itself (the
 * safety hook also denies `wg ticket eval-score` to an agent shell).
 */
export const EVAL_JUDGED_EVENT = "ticket.eval_judged" as const;

/** The rubric dimensions, in the judge's order (packages/crew/src/eval/deliveryJudge.ts). */
export const JUDGE_DIMENSIONS = [
  "ac_coverage",
  "correctness",
  "minimalism",
  "test_adequacy",
  "security",
] as const;
export type JudgeDimension = (typeof JUDGE_DIMENSIONS)[number];
export type JudgeOverall = "pass" | "borderline" | "fail";

export interface EvalJudgment {
  overall: JudgeOverall;
  /** Mean of the dimension scores, 0-5. */
  score: number;
  blocking: boolean;
  /** Per-dimension 0-5 scores. */
  dims: Partial<Record<JudgeDimension, number>>;
  /** The judge's one-sentence reason per dimension, when it gave one. */
  rationale: Partial<Record<JudgeDimension, string>>;
  summary: string | null;
  judge_model: string | null;
  memory_present: boolean | null;
  cost_usd: number | null;
  /** The ticket's attempt count when the delivery was judged (which delivery it graded). */
  attempt: number | null;
}

/** A judgment as read back from the event log. */
export interface RecordedEvalJudgment extends EvalJudgment {
  at: string;
  event_id: string;
  recorded_by: string;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

function score05(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number.parseFloat(v) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(5, n));
}

/** "$0.1234", "0.12" or 0.12 -> 0.12; anything else (an "unknown" spend) -> null, never 0. */
function usd(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v !== "string") return null;
  const m = /^\s*\$?\s*(\d+(?:\.\d+)?)\s*$/.exec(v);
  return m ? Number.parseFloat(m[1]!) : null;
}

/**
 * Validate a judge record into the stored shape. Accepts the runner's ledger record
 * (runner/lib/json-tool.mjs judge-record: the parsed verdict with `dimensions[]` and
 * `summary`, plus `memoryPresent`, `costUsd`, `judgeModel`) or the ledger's own
 * compact form (`dims` / `rationale` maps). Refuses a record with no rubric score:
 * an unparseable reply is an infra outcome and must never read as a quality fail.
 */
export function normalizeJudgment(input: unknown, attempt: number | null): EvalJudgment {
  if (!isObj(input))
    throw new DispatchError("VALIDATION_ERROR", "a judge record is a JSON object.");
  if (input.judged === false)
    throw new DispatchError(
      "VALIDATION_ERROR",
      "the judge reply carried no rubric grading (judged: false); nothing to record.",
    );
  const dims: Partial<Record<JudgeDimension, number>> = {};
  const rationale: Partial<Record<JudgeDimension, string>> = {};
  const put = (dim: unknown, s: unknown, why: unknown): void => {
    if (!(JUDGE_DIMENSIONS as readonly unknown[]).includes(dim)) return;
    const d = dim as JudgeDimension;
    const v = score05(s);
    if (v === null) return;
    dims[d] = v;
    if (typeof why === "string" && why.trim() !== "" && why !== "not scored by the judge")
      rationale[d] = why.replace(/\s+/g, " ").trim().slice(0, 500);
  };
  if (Array.isArray(input.dimensions)) {
    for (const e of input.dimensions) if (isObj(e)) put(e.dimension, e.score, e.rationale);
  }
  if (isObj(input.dims)) {
    const why = isObj(input.rationale) ? input.rationale : {};
    for (const [d, s] of Object.entries(input.dims)) if (!(d in dims)) put(d, s, why[d]);
  }
  if (Object.keys(dims).length === 0)
    throw new DispatchError(
      "VALIDATION_ERROR",
      `a judge record needs at least one rubric dimension score (${JUDGE_DIMENSIONS.join(", ")}).`,
    );
  const overall = input.overall;
  if (overall !== "pass" && overall !== "borderline" && overall !== "fail")
    throw new DispatchError("VALIDATION_ERROR", "overall must be pass, borderline or fail.", {
      overall,
    });
  const vals = Object.values(dims);
  const mean = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;
  const s = score05(input.score);
  const summary =
    typeof input.summary === "string" && input.summary.trim() !== ""
      ? input.summary.replace(/\s+/g, " ").trim().slice(0, 300)
      : null;
  const model =
    typeof input.judgeModel === "string" && input.judgeModel.trim() !== ""
      ? input.judgeModel.trim().slice(0, 120)
      : typeof input.judge_model === "string" && input.judge_model.trim() !== ""
        ? input.judge_model.trim().slice(0, 120)
        : null;
  const mem =
    typeof input.memoryPresent === "boolean"
      ? input.memoryPresent
      : typeof input.memory_present === "boolean"
        ? input.memory_present
        : null;
  return {
    overall,
    score: s ?? mean,
    blocking: input.blocking === true,
    dims,
    rationale,
    summary,
    judge_model: model,
    memory_present: mem,
    cost_usd: usd(input.costUsd ?? input.cost_usd),
    attempt,
  };
}

/** Refuse anyone but the runner or an admin: an agent never grades its own delivery. */
export function assertMayRecordJudgment(actor: Actor): void {
  if (actor.type !== "system" && actor.type !== "admin")
    throw new DispatchError(
      "ACTOR_NOT_PERMITTED",
      "Only the runner (system) or an admin may record an eval judge verdict.",
      { actor_type: actor.type },
    );
}

function payload(e: WorkEvent): Record<string, unknown> {
  if (!e.payload_json) return {};
  try {
    const v = JSON.parse(e.payload_json) as unknown;
    return isObj(v) ? v : {};
  } catch {
    return {};
  }
}

/** Every judgment recorded on a ticket, oldest first (events already in insertion order). */
export function readJudgments(events: readonly WorkEvent[]): RecordedEvalJudgment[] {
  const out: RecordedEvalJudgment[] = [];
  for (const e of events) {
    if (e.event_type !== EVAL_JUDGED_EVENT) continue;
    if (e.actor_type !== "system" && e.actor_type !== "admin") continue;
    const p = payload(e);
    let j: EvalJudgment;
    try {
      j = normalizeJudgment(p, typeof p.attempt === "number" ? p.attempt : null);
    } catch {
      continue;
    }
    out.push({ ...j, at: e.created_at, event_id: e.id, recorded_by: e.actor_type });
  }
  return out;
}

/**
 * The judgment about the CURRENT delivery: the latest one, unless it predates the
 * ticket's latest entry into review (`sinceReview`), when it graded an earlier attempt.
 * The judge runs right after the submit that moves a ticket into review, so the current
 * one is recorded at or after that moment.
 */
export function currentJudgment(
  events: readonly WorkEvent[],
  sinceReview: string | null,
): RecordedEvalJudgment | null {
  const all = readJudgments(events);
  const last = all[all.length - 1];
  if (!last) return null;
  if (sinceReview !== null && last.at < sinceReview) return null;
  return last;
}

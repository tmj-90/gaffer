import type { Db } from "../db/connection.js";
import { JUDGE_BLIND_SINCE_KEY } from "../db/schema.js";
import type { Actor } from "../domain/types.js";
import { DispatchError } from "../util/errors.js";

/**
 * REVIEW TELEMETRY (Release A metrics package): the events the review-time and lane
 * read models are computed from. None of them is read by a gate, an approval or a
 * landing path; they are measurements.
 *
 *  - `ticket.review_opened` {round_entered_at, head_shas}: a person rendered the ticket
 *    in the Review view in this review round. Recorded once per round (deduped here,
 *    server-side, on ticket + round_entered_at). Splits wall-clock time in review into
 *    queue wait and decision time (health/reviewTime.ts).
 *  - `ticket.review_raw_opened` {what, round_entered_at}: a person opened a raw log, the
 *    evidence in full or the full diff while the ticket was in review. Once per round
 *    and kind. Feeds "% approved without opening raw logs".
 *  - `ticket.review_judge_revealed` {what: "judge", round_entered_at}: a person opened the
 *    eval judge's collapsed view while the ticket was in review. Once per round. Splits
 *    `wg judge-agreement` into blind decisions and decisions made after the grade was seen
 *    (health/judgeAgreement.ts).
 *  - `ticket.lane_verdict` {lane, verdict, commit, attempt_id, actor, ...}: what a
 *    judging lane (the reviewer agent, the security reviewer, the tester, the eval judge)
 *    concluded about one candidate, so "did this lane change the decision" is computable.
 *    Runner (system) or admin only: an agent never records a lane verdict (the safety
 *    hook also denies `wg ticket lane-verdict` to an agent shell).
 *
 * Opening a ticket never bumps its updated_at: the Review queue re-renders on
 * `id@updated_at` (reviewSignature in web/js/live.js), so a bump would redraw every viewer's page.
 */
export const REVIEW_OPENED_EVENT = "ticket.review_opened" as const;
export const REVIEW_RAW_OPENED_EVENT = "ticket.review_raw_opened" as const;
export const LANE_VERDICT_EVENT = "ticket.lane_verdict" as const;
export const REVIEW_JUDGE_REVEALED_EVENT = "ticket.review_judge_revealed" as const;

/** BLINDING: the schema_meta key the v33 migration stamps (see db/schema.ts). */
export { JUDGE_BLIND_SINCE_KEY };

/** When this database started hiding the judge's grade, or null (hidden from the start). */
export function readJudgeBlindSince(db: Db): string | null {
  try {
    const row = db
      .prepare("SELECT value FROM schema_meta WHERE key = ?")
      .get(JUDGE_BLIND_SINCE_KEY) as { value?: unknown } | undefined;
    return typeof row?.value === "string" && row.value !== "" ? row.value : null;
  } catch {
    return null;
  }
}

export const RAW_OPEN_KINDS = ["run_log", "evidence", "full_diff"] as const;
export type RawOpenKind = (typeof RAW_OPEN_KINDS)[number];

/** Each judging lane and the verdict words it can record. */
export const LANE_VERDICTS = {
  "agent-review": ["approve", "changes", "held"],
  "security-review": ["approve", "changes", "held"],
  tester: ["pass", "fail", "held"],
  "eval-judge": ["pass", "borderline", "fail"],
} as const;
export type Lane = keyof typeof LANE_VERDICTS;
export const LANES = Object.keys(LANE_VERDICTS) as Lane[];

export interface LaneVerdict {
  lane: Lane;
  verdict: string;
  /** The candidate commit the lane judged, when the runner knew it. */
  commit: string | null;
  /** The delivery attempt the lane judged (`c<claim hash>/<n>`), when known. */
  attempt_id: string | null;
  /**
   * How attempt_id was found: `latest_delivery_row` (the ticket's latest delivery row in
   * the usage ledger when the lane ran, the runner's method: a time-order join, not a
   * commit match) or `stated` (the caller named it). Null with no attempt_id.
   */
  attempt_id_basis: AttemptIdBasis | null;
  /** Who recorded it: always `system` or `admin` (an agent is refused). */
  actor: string;
  /** Why a held verdict is not a verdict (the runner's reason), when held. */
  held_reason: string | null;
  /** The model the lane's call asked for, as a label. */
  model_requested: string | null;
}

/** Only a person (human or admin principal) records that they opened a ticket in review. */
export function assertMayRecordReviewOpen(actor: Actor): void {
  if (actor.type !== "human" && actor.type !== "admin")
    throw new DispatchError(
      "ACTOR_NOT_PERMITTED",
      "Only a person (a human or admin principal) records opening a ticket in review.",
      { actor_type: actor.type },
    );
}

/** Refuse anyone but the runner or an admin: an agent never records a lane verdict. */
export function assertMayRecordLaneVerdict(actor: Actor): void {
  if (actor.type !== "system" && actor.type !== "admin")
    throw new DispatchError(
      "ACTOR_NOT_PERMITTED",
      "Only the runner (system) or an admin may record a lane verdict.",
      { actor_type: actor.type },
    );
}

export const ATTEMPT_ID_BASES = ["latest_delivery_row", "stated"] as const;
export type AttemptIdBasis = (typeof ATTEMPT_ID_BASES)[number];

const SHA = /^[0-9a-f]{7,64}$/i;
const ATTEMPT = /^[A-Za-z0-9._:/-]{1,96}$/;

function label(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s ? s.slice(0, max) : null;
}

/** Validate a lane verdict into the stored shape (refuses an unknown lane or verdict). */
export function normalizeLaneVerdict(input: Record<string, unknown>, actor: Actor): LaneVerdict {
  const lane = String(input.lane ?? "").trim() as Lane;
  if (!(LANES as string[]).includes(lane))
    throw new DispatchError("VALIDATION_ERROR", `lane must be one of: ${LANES.join(", ")}.`, {
      lane: input.lane,
    });
  const verdict = String(input.verdict ?? "")
    .trim()
    .toLowerCase();
  const allowed = LANE_VERDICTS[lane] as readonly string[];
  if (!allowed.includes(verdict))
    throw new DispatchError(
      "VALIDATION_ERROR",
      `a ${lane} verdict is one of: ${allowed.join(", ")}.`,
      { lane, verdict: input.verdict },
    );
  const commitRaw = typeof input.commit === "string" ? input.commit.trim() : "";
  if (commitRaw && !SHA.test(commitRaw))
    throw new DispatchError("VALIDATION_ERROR", "commit must be a git sha.", {
      commit: input.commit,
    });
  const attemptRaw = typeof input.attempt_id === "string" ? input.attempt_id.trim() : "";
  if (attemptRaw && !ATTEMPT.test(attemptRaw))
    throw new DispatchError("VALIDATION_ERROR", "attempt_id is not a recorded attempt id.", {
      attempt_id: input.attempt_id,
    });
  const basisRaw = typeof input.attempt_id_basis === "string" ? input.attempt_id_basis.trim() : "";
  if (basisRaw && !(ATTEMPT_ID_BASES as readonly string[]).includes(basisRaw))
    throw new DispatchError(
      "VALIDATION_ERROR",
      `attempt_id_basis is one of: ${ATTEMPT_ID_BASES.join(", ")}.`,
      { attempt_id_basis: input.attempt_id_basis },
    );
  return {
    lane,
    verdict,
    commit: commitRaw ? commitRaw.toLowerCase() : null,
    attempt_id: attemptRaw || null,
    attempt_id_basis: attemptRaw ? ((basisRaw || "stated") as AttemptIdBasis) : null,
    actor: actor.type,
    held_reason: verdict === "held" ? label(input.held_reason, 300) : null,
    model_requested: label(input.model_requested, 80),
  };
}

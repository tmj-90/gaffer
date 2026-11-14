import type { Db } from "../db/connection.js";

/**
 * AUTONOMY STEP-DOWN: the store. A step-down takes autonomy back for one
 * (repo x risk x gate) when the evidence turns bad (autonomyStepDownService.ts holds the
 * triggers). It lives in the tamper-evident event chain, never in a mutable table:
 *
 *  - `autonomy.stepped_down` {risk_level, gate, trigger, why, tickets, cascade_from}:
 *    autonomy for that row is taken back from this moment. The actor columns say who or
 *    what caused it (the person who filed the regression, the runner's tester verdict).
 *  - `autonomy.step_down_lifted` {risk_level, gate, how, reason, evidence}: a person gave
 *    it back (re-enabled after the evidence cleared the bar again, or overrode it with a
 *    reason).
 *
 * Both are recorded on the repository (entity_type `repository`, entity_id the repo id).
 * The policy row is never touched: a step-down holds whatever the row says, and it holds
 * where no row exists at all (a mode's env floor can be what made the row automatic), so
 * taking autonomy back never depends on how it was given.
 *
 * Per row, the LAST of the two events decides: a step-down is in force while the latest
 * one is `autonomy.stepped_down`. The time of the latest step-down (lifted or not) is where
 * the evidence count for that row restarts.
 */
export const AUTONOMY_STEPPED_DOWN_EVENT = "autonomy.stepped_down" as const;
export const AUTONOMY_STEP_DOWN_LIFTED_EVENT = "autonomy.step_down_lifted" as const;

/** What caused a step-down. `cascade` is a merge step-down at a lower risk in the repo. */
export const STEP_DOWN_TRIGGERS = ["regression", "reopened", "tester_failures", "cascade"] as const;
export type StepDownTrigger = (typeof STEP_DOWN_TRIGGERS)[number];

/** A ticket a step-down names (id and number, never a title). */
export interface StepDownTicket {
  readonly id: string;
  readonly number: number | null;
}

/** One recorded step-down, as the read model and the gate see it. */
export interface StepDownRecord {
  readonly eventId: string;
  readonly repoId: string;
  readonly riskLevel: string;
  readonly gate: string;
  readonly trigger: StepDownTrigger;
  readonly why: string;
  readonly tickets: StepDownTicket[];
  /** The lower risk whose merge step-down this one follows (trigger `cascade`). */
  readonly cascadeFrom: string | null;
  readonly at: string;
  readonly by: { readonly type: string; readonly id: string | null };
}

/** One recorded lift. */
export interface StepDownLift {
  readonly eventId: string;
  readonly how: "reenabled" | "override";
  readonly reason: string | null;
  readonly at: string;
  readonly by: { readonly type: string; readonly id: string | null };
}

/** The state of one (repo x risk x gate) row folded from the chain. */
export interface StepDownState {
  /** The step-down in force, or null. */
  readonly inForce: StepDownRecord | null;
  /** The latest step-down, lifted or not: where the evidence count restarts. */
  readonly lastStepDown: StepDownRecord | null;
  /** The latest lift, or null. */
  readonly lastLift: StepDownLift | null;
}

/** The fold key for a row. */
export function stepDownKey(repoId: string, riskLevel: string, gate: string): string {
  return `${repoId}\u0000${riskLevel}\u0000${gate}`;
}

interface Row {
  id: string;
  repo_id: string;
  event_type: string;
  actor_type: string;
  actor_id: string | null;
  created_at: string;
  payload_json: string | null;
}

function payloadOf(raw: string | null): Record<string, unknown> {
  try {
    const v = JSON.parse(raw ?? "{}") as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function ticketsOf(v: unknown): StepDownTicket[] {
  if (!Array.isArray(v)) return [];
  const out: StepDownTicket[] = [];
  for (const t of v) {
    if (!t || typeof t !== "object") continue;
    const o = t as Record<string, unknown>;
    const id = str(o.id);
    if (!id) continue;
    out.push({ id, number: typeof o.number === "number" ? o.number : null });
  }
  return out;
}

function triggerOf(v: unknown): StepDownTrigger {
  return (STEP_DOWN_TRIGGERS as readonly string[]).includes(String(v))
    ? (v as StepDownTrigger)
    : "regression";
}

function recordOf(r: Row, p: Record<string, unknown>): StepDownRecord {
  return {
    eventId: r.id,
    repoId: r.repo_id,
    riskLevel: String(p.risk_level ?? ""),
    gate: String(p.gate ?? ""),
    trigger: triggerOf(p.trigger),
    why: str(p.why) ?? "autonomy was taken back",
    tickets: ticketsOf(p.tickets),
    cascadeFrom: str(p.cascade_from),
    at: r.created_at,
    by: { type: r.actor_type, id: r.actor_id },
  };
}

/** Every step-down and lift on record, in insertion order (the fold's input). */
export function stepDownRows(db: Db, repoId?: string): Row[] {
  const where = repoId === undefined ? "" : " AND entity_id = @repoId";
  return db
    .prepare(
      `SELECT id, entity_id AS repo_id, event_type, actor_type, actor_id, created_at, payload_json
         FROM work_events
        WHERE entity_type = 'repository' AND event_type IN (@down, @lift)${where}
        ORDER BY rowid`,
    )
    .all({
      down: AUTONOMY_STEPPED_DOWN_EVENT,
      lift: AUTONOMY_STEP_DOWN_LIFTED_EVENT,
      ...(repoId === undefined ? {} : { repoId }),
    }) as Row[];
}

/** Fold the chain into the state of every row that has ever stepped down. */
export function readStepDowns(db: Db, repoId?: string): Map<string, StepDownState> {
  const out = new Map<string, StepDownState>();
  for (const r of stepDownRows(db, repoId)) {
    const p = payloadOf(r.payload_json);
    const risk = String(p.risk_level ?? "");
    const gate = String(p.gate ?? "");
    if (!risk || !gate) continue;
    const key = stepDownKey(r.repo_id, risk, gate);
    const prev = out.get(key) ?? { inForce: null, lastStepDown: null, lastLift: null };
    if (r.event_type === AUTONOMY_STEPPED_DOWN_EVENT) {
      const rec = recordOf(r, p);
      out.set(key, { inForce: rec, lastStepDown: rec, lastLift: prev.lastLift });
    } else {
      out.set(key, {
        inForce: null,
        lastStepDown: prev.lastStepDown,
        lastLift: {
          eventId: r.id,
          how: p.how === "override" ? "override" : "reenabled",
          reason: str(p.reason),
          at: r.created_at,
          by: { type: r.actor_type, id: r.actor_id },
        },
      });
    }
  }
  return out;
}

/**
 * Is a step-down in force for (repo, risk, gate)? The point read the gate asks on every
 * decision: the latest step-down or lift for that row decides. Throws on a database error;
 * the gate treats a throw as "in force" (fail closed).
 */
export function stepDownInForce(db: Db, repoId: string, riskLevel: string, gate: string): boolean {
  const row = db
    .prepare(
      `SELECT event_type FROM work_events
        WHERE entity_type = 'repository' AND entity_id = @repoId
          AND event_type IN (@down, @lift)
          AND json_extract(payload_json, '$.risk_level') = @riskLevel
          AND json_extract(payload_json, '$.gate') = @gate
        ORDER BY rowid DESC LIMIT 1`,
    )
    .get({
      repoId,
      riskLevel,
      gate,
      down: AUTONOMY_STEPPED_DOWN_EVENT,
      lift: AUTONOMY_STEP_DOWN_LIFTED_EVENT,
    }) as { event_type: string } | undefined;
  return row?.event_type === AUTONOMY_STEPPED_DOWN_EVENT;
}

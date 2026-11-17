import { timingSafeEqual } from "node:crypto";

import type { Db } from "../db/connection.js";
import { RISK_LEVELS, type Actor } from "../domain/types.js";
import { writeEvent } from "./eventWriter.js";
import type { GateKeyring, SealDb } from "./gateSeal.js";
import {
  canonicalFacts,
  retireRowSeal,
  rowSealMaterial,
  sealRow,
  verifyLifecycleChain,
  verifyRowSeal,
  type RowFacts,
  type RowSealCheck,
  type RowSealSubject,
} from "./rowSeal.js";

/**
 * SEALED AUTONOMY (events/rowSeal.ts applied to the rows that decide what may happen
 * WITHOUT A PERSON). Before this, a process that could write the sqlite file inserted an
 * `autonomy_policy` row with mode `auto`, or lowered a ticket's `risk_level` to one that
 * had such a row, or appended a lift of a step-down, and the runner then approved and
 * merged on its own. Now each of them counts only with a seal under the factory key:
 *
 *  - a POLICY ROW (kind `autonomy_policy`, the row id): sealed with the lifecycle event that
 *    set it (`autonomy_policy.enabled` / `.changed` / `.resigned`); turning it off writes
 *    `autonomy_policy.disabled` and retires the seal. A row that does not verify counts as
 *    ABSENT at every decision (a person decides; the env floor of a mode is unchanged).
 *  - a TICKET'S RISK (kind `ticket_risk`, the ticket id): sealed with a `ticket.risk_set`
 *    event (at creation by a key holder, at the first claim by the trusted host, or by a
 *    person's re-sign). A risk that does not verify reads as the HIGHEST risk for every
 *    autonomy decision (with the critical ceiling: a person decides), never as stored.
 *  - a LIFT of a step-down (kind `autonomy_lift`, the lift event's id): a lift without a
 *    valid seal bound to that event is ignored and the step-down stays in force. A step-down
 *    needs no seal (a forged one only takes autonomy away); removing one is caught by the
 *    chain check every "not stepped down" answer makes.
 * Every read here is fail closed: an error, a missing key, a broken anchor or chain is
 * "a person decides". Nothing here repairs a missing or broken seal.
 */

// ---------------------------------------------------------------------------------------
// Policy rows
// ---------------------------------------------------------------------------------------

export const AUTONOMY_POLICY_SEAL_KIND = "autonomy_policy";
export const AUTONOMY_POLICY_ENABLED_EVENT = "autonomy_policy.enabled";
export const AUTONOMY_POLICY_CHANGED_EVENT = "autonomy_policy.changed";
export const AUTONOMY_POLICY_DISABLED_EVENT = "autonomy_policy.disabled";
export const AUTONOMY_POLICY_RESIGNED_EVENT = "autonomy_policy.resigned";
export const AUTONOMY_POLICY_LIFECYCLE_EVENTS = [
  AUTONOMY_POLICY_ENABLED_EVENT,
  AUTONOMY_POLICY_CHANGED_EVENT,
  AUTONOMY_POLICY_DISABLED_EVENT,
  AUTONOMY_POLICY_RESIGNED_EVENT,
] as const;

/** The stored columns of a policy row that carry authority (and its id). */
export interface PolicySealRow {
  id: string;
  repo_id: string;
  risk_level: string;
  gate: string;
  mode: string;
  enabled_by: string | null;
  enabled_at: string | null;
  created_at: string;
}

export function policySubject(id: string): RowSealSubject {
  return {
    kind: AUTONOMY_POLICY_SEAL_KIND,
    rowId: id,
    entityType: "autonomy_policy",
    lifecycleEvents: AUTONOMY_POLICY_LIFECYCLE_EVENTS,
  };
}

/** The repository a policy row names, as the repositories table holds it now. */
export interface PolicyRepoIdentity {
  name: string | null;
  local_path: string | null;
  remote_url: string | null;
}

/**
 * The identity of repository `repoId` (null fields when there is none). A policy row's seal
 * binds it: the repositories row is a plain row, and a database writer that pointed a signed
 * row's repo id at another checkout would otherwise carry that row's autonomy to it.
 */
export function policyRepoIdentity(db: SealDb, repoId: string): PolicyRepoIdentity {
  const r = db
    .prepare("SELECT name, local_path, remote_url FROM repositories WHERE id = ?")
    .get(repoId) as
    { name: string | null; local_path: string | null; remote_url: string | null } | undefined;
  return {
    name: r?.name ?? null,
    local_path: r?.local_path ?? null,
    remote_url: r?.remote_url ?? null,
  };
}

/**
 * What a policy row's seal binds: where it applies (the repo id AND the repository it names:
 * name, checkout path, remote), what it allows, who and when.
 */
export function policyFacts(row: PolicySealRow, repo: PolicyRepoIdentity): RowFacts {
  return {
    id: row.id,
    repo_id: row.repo_id,
    repo_name: repo.name,
    repo_local_path: repo.local_path,
    repo_remote_url: repo.remote_url,
    risk_level: row.risk_level,
    gate: row.gate,
    mode: row.mode,
    enabled_by: row.enabled_by,
    enabled_at: row.enabled_at,
    created_at: row.created_at,
  };
}

/** Seal policy row `row` against event `eventId` (a trusted host act, in its transaction). */
export function sealPolicy(
  db: SealDb,
  keyring: GateKeyring,
  row: PolicySealRow,
  eventId: string,
  now: string,
): void {
  sealRow(
    db,
    keyring,
    policySubject(row.id),
    eventId,
    policyFacts(row, policyRepoIdentity(db, row.repo_id)),
    now,
  );
}

export function retirePolicySeal(db: SealDb, id: string): void {
  retireRowSeal(db, policySubject(id));
}

/**
 * Does this stored policy row carry a valid seal for exactly its current authority? A row
 * in mode `off` carries none and needs none (it grants nothing): it reads as ok. Read-only.
 */
export function verifyPolicyRow(
  db: SealDb,
  keyring: GateKeyring,
  row: PolicySealRow,
): RowSealCheck {
  if (row.mode === "off") return { ok: true, eventId: "" };
  return verifyRowSeal(
    db,
    keyring,
    policySubject(row.id),
    policyFacts(row, policyRepoIdentity(db, row.repo_id)),
  );
}

// ---------------------------------------------------------------------------------------
// Ticket risk
// ---------------------------------------------------------------------------------------

export const TICKET_RISK_SEAL_KIND = "ticket_risk";
export const TICKET_RISK_SET_EVENT = "ticket.risk_set";
export const TICKET_RISK_LIFECYCLE_EVENTS = [TICKET_RISK_SET_EVENT] as const;

/** The risk an unsigned ticket is decided at: the highest there is. */
export const UNSIGNED_RISK: string = RISK_LEVELS[RISK_LEVELS.length - 1]!;

/** Where a ticket's risk seal came from (recorded in the event). */
export type TicketRiskSource = "created" | "claim" | "resigned";

export function ticketRiskSubject(ticketId: string): RowSealSubject {
  return {
    kind: TICKET_RISK_SEAL_KIND,
    rowId: ticketId,
    entityType: "ticket",
    lifecycleEvents: TICKET_RISK_LIFECYCLE_EVENTS,
  };
}

export function ticketRiskFacts(ticketId: string, riskLevel: string): RowFacts {
  return { ticket_id: ticketId, risk_level: riskLevel };
}

/**
 * Record ticket `ticketId`'s risk as `riskLevel`: a `ticket.risk_set` event and its seal,
 * in the caller's transaction. Throws (GateKeyError) where this process may not sign; the
 * caller decides whether that rolls back its whole act or only this record.
 */
export function recordTicketRisk(
  db: Db,
  keyring: GateKeyring,
  input: {
    ticketId: string;
    riskLevel: string;
    source: TicketRiskSource;
    now: string;
    extra?: Record<string, unknown>;
  },
  actor: Actor,
): string {
  const eventId = writeEvent(db, {
    entity_type: "ticket",
    entity_id: input.ticketId,
    actor,
    event_type: TICKET_RISK_SET_EVENT,
    payload: { risk_level: input.riskLevel, source: input.source, ...(input.extra ?? {}) },
  });
  sealRow(
    db,
    keyring,
    ticketRiskSubject(input.ticketId),
    eventId,
    ticketRiskFacts(input.ticketId, input.riskLevel),
    input.now,
  );
  return eventId;
}

/** The ticket's stored risk carries a valid seal. Read-only; never creates anything. */
export function verifyTicketRisk(
  db: SealDb,
  keyring: GateKeyring,
  ticketId: string,
  storedRisk: string,
): RowSealCheck {
  return verifyRowSeal(
    db,
    keyring,
    ticketRiskSubject(ticketId),
    ticketRiskFacts(ticketId, storedRisk),
  );
}

/** A ticket's risk as an autonomy decision reads it. */
export interface DecidedRisk {
  /** The level every autonomy decision uses: the stored one when signed, else the highest. */
  level: string;
  /** The stored column, as written. */
  stored: string;
  signed: boolean;
  /** Why it is not signed (absent when signed). */
  detail?: string;
}

export function decidedRisk(
  db: SealDb,
  keyring: GateKeyring,
  ticket: { id: string; risk_level: string },
): DecidedRisk {
  const check = verifyTicketRisk(db, keyring, ticket.id, ticket.risk_level);
  if (check.ok) return { level: ticket.risk_level, stored: ticket.risk_level, signed: true };
  return {
    level: UNSIGNED_RISK,
    stored: ticket.risk_level,
    signed: false,
    detail: check.detail,
  };
}

/**
 * THE CLAIM RULE: may the trusted host seal this ticket's risk at this claim? Only a
 * ticket that has NEVER had a risk recorded (no `ticket.risk_set` event, no seal row) and
 * was never claimed before (this claim is its first `claim.created`, and it has no other
 * claim row). A ticket in flight before this change, an imported one, one whose seal was
 * removed, or one claimed before: never (a person re-signs it). The caller also verifies
 * the whole chain before it seals (a deleted earlier claim must not pass for a first one).
 *
 * And only the risk its CREATOR stated: the ticket has exactly one `ticket.created` event,
 * and the stored column still says the risk that event recorded. A ticket the planner, a
 * keyless process or a person filed at one risk and a database writer lowered before the
 * claim is not sealed at the writer's value (a person re-signs it); a row inserted with no
 * creation on record is not sealed at all. A creation event from before the risk was
 * recorded in it carries none: the stored column is all there is (as before).
 */
export function firstClaimMaySeal(db: SealDb, ticketId: string, claimId: string): boolean {
  const created = db
    .prepare(
      "SELECT payload_json FROM work_events WHERE entity_type = 'ticket' AND entity_id = ? AND event_type = 'ticket.created'",
    )
    .all(ticketId) as Array<{ payload_json: string | null }>;
  if (created.length !== 1) return false;
  const stated = payloadOf(created[0]!.payload_json);
  if ("risk_level" in stated) {
    const stored = db.prepare("SELECT risk_level FROM tickets WHERE id = ?").get(ticketId) as
      { risk_level: string } | undefined;
    if (!stored || String(stored.risk_level) !== stated.risk_level) return false;
  }
  const risk = db
    .prepare(
      "SELECT 1 AS x FROM work_events WHERE entity_type = 'ticket' AND entity_id = ? AND event_type = ? LIMIT 1",
    )
    .get(ticketId, TICKET_RISK_SET_EVENT);
  if (risk) return false;
  const seal = db
    .prepare("SELECT 1 AS x FROM row_seals WHERE kind = ? AND row_id = ?")
    .get(TICKET_RISK_SEAL_KIND, ticketId);
  if (seal) return false;
  const claims = db
    .prepare(
      "SELECT count(*) AS n FROM work_events WHERE entity_type = 'ticket' AND entity_id = ? AND event_type IN ('claim.created', 'ticket.human_claimed')",
    )
    .get(ticketId) as { n: number } | undefined;
  if (Number(claims?.n ?? 0) > 1) return false;
  const rows = db
    .prepare("SELECT id FROM ticket_claims WHERE ticket_id = ?")
    .all(ticketId) as Array<{ id: string }>;
  return rows.every((r) => String(r.id) === claimId);
}

// ---------------------------------------------------------------------------------------
// Lifts of a step-down
// ---------------------------------------------------------------------------------------

export const AUTONOMY_LIFT_SEAL_KIND = "autonomy_lift";
const STEPPED_DOWN = "autonomy.stepped_down";
const LIFTED = "autonomy.step_down_lifted";

/** The claim history the claim rule reads (a chain track, never a seal's lifecycle). */
export const CLAIM_TRACK: Pick<RowSealSubject, "entityType" | "lifecycleEvents"> = {
  entityType: "ticket",
  lifecycleEvents: ["claim.created", "ticket.created", "ticket.human_claimed"],
};

/** The chain track every "is a step-down in force" answer checks. */
export const STEP_DOWN_TRACK: Pick<RowSealSubject, "entityType" | "lifecycleEvents"> = {
  entityType: "repository",
  lifecycleEvents: [STEPPED_DOWN, LIFTED],
};

interface LiftEventRow {
  id: string;
  entity_type: string;
  entity_id: string;
  event_type: string;
  actor_type: string;
  actor_id: string | null;
  payload_json: string | null;
  hash: string | null;
}

function payloadOf(raw: string | null): Record<string, unknown> {
  try {
    const v = JSON.parse(raw ?? "{}") as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** What a lift's seal binds: which row it gives back, how, by whom, over which step-down. */
function liftFacts(ev: LiftEventRow): RowFacts {
  const p = payloadOf(ev.payload_json);
  const s = (v: unknown): string | null => (typeof v === "string" ? v : null);
  return {
    repo_id: ev.entity_id,
    risk_level: s(p.risk_level),
    gate: s(p.gate),
    how: s(p.how),
    step_down_event: s(p.step_down_event),
    actor_type: ev.actor_type,
    actor_id: ev.actor_id,
  };
}

function readLiftEvent(db: SealDb, eventId: string): LiftEventRow | undefined {
  return db
    .prepare(
      "SELECT id, entity_type, entity_id, event_type, actor_type, actor_id, payload_json, hash FROM work_events WHERE id = ?",
    )
    .get(eventId) as LiftEventRow | undefined;
}

/** Seal lift event `eventId` (in the transaction that wrote it; a person's act). */
export function sealLift(db: SealDb, keyring: GateKeyring, eventId: string, now: string): void {
  const ev = readLiftEvent(db, eventId);
  if (!ev || ev.event_type !== LIFTED) throw new Error(`event ${eventId} is not a lift`);
  sealRow(
    db,
    keyring,
    { kind: AUTONOMY_LIFT_SEAL_KIND, rowId: eventId },
    eventId,
    liftFacts(ev),
    now,
  );
}

/**
 * The lift event `eventId` carries a valid seal under the factory key, bound to exactly
 * this event (its id and chain hash) and what it gives back. Read-only; false on any doubt.
 * The chain itself is checked by the caller ({@link sealedStepDownInForce}).
 */
export function liftSealed(db: SealDb, keyring: GateKeyring, eventId: string): boolean {
  try {
    const ev = readLiftEvent(db, eventId);
    if (!ev || !ev.hash || ev.event_type !== LIFTED || ev.entity_type !== "repository") {
      return false;
    }
    const seal = db
      .prepare("SELECT event_id, mac FROM row_seals WHERE kind = ? AND row_id = ?")
      .get(AUTONOMY_LIFT_SEAL_KIND, eventId) as { event_id: string; mac: string } | undefined;
    if (!seal || String(seal.event_id) !== eventId) return false;
    const want = keyring.verifyMac(
      rowSealMaterial(
        AUTONOMY_LIFT_SEAL_KIND,
        eventId,
        eventId,
        String(ev.hash),
        canonicalFacts(liftFacts(ev)),
      ),
    );
    if ("missing" in want) return false;
    const a = Buffer.from(want.mac, "hex");
    const b = Buffer.from(String(seal.mac ?? ""), "hex");
    return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Is a step-down in force for (repo, risk, gate)? The newest step-down or SEALED lift for
 * that row decides; a lift without a valid seal is ignored. Every answer of "not in force"
 * also needs the event log to verify (the anchor and the chain over the step-down and lift
 * events), so a step-down deleted or rewritten does not lift anything. FAIL CLOSED: any
 * doubt, error or unverifiable chain is "in force" (a person decides).
 */
export function sealedStepDownInForce(
  db: SealDb,
  keyring: GateKeyring,
  repoId: string,
  riskLevel: string,
  gate: string,
): boolean {
  try {
    const rows = db
      .prepare(
        `SELECT id, event_type FROM work_events
          WHERE entity_type = 'repository' AND entity_id = ?
            AND event_type IN (?, ?)
            AND json_extract(payload_json, '$.risk_level') = ?
            AND json_extract(payload_json, '$.gate') = ?
          ORDER BY rowid DESC`,
      )
      .all(repoId, STEPPED_DOWN, LIFTED, riskLevel, gate) as Array<{
      id: string;
      event_type: string;
    }>;
    for (const r of rows) {
      if (String(r.event_type) === STEPPED_DOWN) return true;
      if (liftSealed(db, keyring, String(r.id))) break;
    }
    return !verifyLifecycleChain(db, keyring, STEP_DOWN_TRACK, repoId).ok;
  } catch {
    return true;
  }
}

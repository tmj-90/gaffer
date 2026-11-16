/**
 * SEALED AUTONOMY, the writer's side: sealing a ticket's risk where the rules allow it
 * (at creation by a key holder, at the first claim by the trusted host), what is not
 * signed (doctor, Settings, the CLI), and a PERSON's re-sign of policy rows and ticket
 * risks the factory does not trust yet (rows from before signing, restored from a backup,
 * or written outside the factory). Nothing is ever signed on upgrade or on a read, and a
 * missing or broken seal is never repaired automatically: only the acts below sign.
 */
import { inReadSnapshot, inTransaction } from "../db/connection.js";
import { RISK_LEVELS, type Actor, type Ticket } from "../domain/types.js";
import { writeEvent } from "../events/eventWriter.js";
import {
  AUTONOMY_POLICY_RESIGNED_EVENT,
  CLAIM_TRACK,
  TICKET_RISK_SET_EVENT,
  firstClaimMaySeal,
  ticketRiskSubject,
  recordTicketRisk,
  sealPolicy,
  verifyPolicyRow,
  verifyTicketRisk,
  type PolicySealRow,
} from "../events/autonomySeal.js";
import { GateKeyError, eventLogHead, type GateKeyring } from "../events/gateSeal.js";
import { anchorReadFirst, reviewCode, verifyLifecycleChain } from "../events/rowSeal.js";
import type { PrincipalView } from "../repositories/principalRepository.js";
import { DispatchError } from "../util/errors.js";
import type { Dispatch } from "../core.js";

/** What these functions read from the {@link Dispatch} facade they are handed. */
export type AutonomySealHost = Pick<Dispatch, "db" | "gateKeyring" | "clock">;

/** What the read-only listings need (doctor runs them on a bare handle). */
export type AutonomySealReader = Pick<AutonomySealHost, "db" | "gateKeyring">;

/** Statuses where a ticket's risk decides nothing any more. */
const SETTLED_STATUSES = ["done", "cancelled", "failed"];

// ---------------------------------------------------------------------------------------
// Sealing a ticket's risk (creation, first claim)
// ---------------------------------------------------------------------------------------

/**
 * Run `fn` as a savepoint; a GateKeyError (this process may not sign: the MCP server, an
 * agent's sandboxed CLI) rolls back only what `fn` wrote and returns false. Anything else
 * propagates.
 */
function trySign(host: AutonomySealHost, fn: () => void): boolean {
  try {
    inTransaction(host.db, fn);
    return true;
  } catch (e) {
    if (e instanceof GateKeyError) return false;
    throw e;
  }
}

/**
 * AT CREATION: a ticket created by a KEY HOLDER (the REST server, the host CLI) has its
 * stated risk sealed in the creation transaction. A keyless process (the agent-facing MCP
 * server, an agent's sandboxed CLI) cannot sign: the ticket stays unsigned, reads as the
 * highest risk, and is sealed at its first claim by the trusted host.
 */
export function sealRiskAtCreation(host: AutonomySealHost, ticket: Ticket, actor: Actor): void {
  // A process-local key (a library caller that passed none, such as crew's idle loops) on
  // a database file signs nothing another process accepts, and its `ticket.risk_set` would
  // keep the host from sealing the ticket at its first claim: leave it for the claim.
  if (host.gateKeyring.processLocal && !(host.db as { memory?: boolean }).memory) return;
  trySign(host, () => {
    recordTicketRisk(
      host.db,
      host.gateKeyring,
      {
        ticketId: ticket.id,
        riskLevel: ticket.risk_level,
        source: "created",
        now: host.clock.now(),
      },
      actor,
    );
  });
}

/**
 * The event log verifies up to the head the host anchored, and this ticket's risk records
 * and claim history are exactly as the chain recorded them (none deleted, moved or
 * rewritten, before or after the chain checkpoint).
 */
function claimHistoryVerifies(host: AutonomySealHost, ticketId: string): boolean {
  try {
    // Up to the head, not only the anchor: rows a keyless process wrote since the last
    // anchor are linked and re-hashed too.
    const head = eventLogHead(host.db)?.seq ?? 0;
    return (
      verifyLifecycleChain(host.db, host.gateKeyring, ticketRiskSubject(ticketId), ticketId, head)
        .ok && verifyLifecycleChain(host.db, host.gateKeyring, CLAIM_TRACK, ticketId, head).ok
    );
  } catch {
    return false;
  }
}

/**
 * THE CLAIM RULE: at the FIRST claim of a ticket that has never had a risk recorded, the
 * trusted host seals the risk it now commits to work at (a `ticket.risk_set` event with
 * source `claim`), in the claim's transaction. Never on a later claim, never for a ticket
 * in flight before this change, imported, or whose seal was removed (a person re-signs
 * those), never in a process that cannot sign (the MCP server, an agent's sandboxed CLI),
 * and only when the event log verifies with this ticket's claim history and risk records
 * intact (a deleted or rewritten earlier claim or risk record must not pass for a first one). Before the claim the stated risk is the creator's own claim;
 * from here on a change to it is caught.
 */
export function sealRiskAtClaim(
  host: AutonomySealHost,
  ticketId: string,
  claimId: string,
  actor: Actor,
): void {
  try {
    if (!firstClaimMaySeal(host.db, ticketId, claimId)) return;
    const row = host.db.prepare("SELECT risk_level FROM tickets WHERE id = ?").get(ticketId) as
      { risk_level: string } | undefined;
    if (!row) return;
    // A process that cannot sign is told so by the keyring before the whole walk is paid.
    host.gateKeyring.verifyMac("gaffer-claim-probe");
    if (!claimHistoryVerifies(host, ticketId)) return;
    trySign(host, () => {
      recordTicketRisk(
        host.db,
        host.gateKeyring,
        {
          ticketId,
          riskLevel: row.risk_level,
          source: "claim",
          now: host.clock.now(),
          ...(claimId ? { extra: { claim_id: claimId } } : {}),
        },
        actor,
      );
    });
  } catch {
    // Sealing is never what fails a claim: an unsigned risk reads as the highest.
  }
}

// ---------------------------------------------------------------------------------------
// Who may re-sign
// ---------------------------------------------------------------------------------------

const PERSON_ONLY =
  "Re-signing what decides autonomy is a person's act: the operator (the shared token, or the CLI without a principal token), or an active, unscoped admin principal with full capability; never an agent, the runner or MCP.";

/** Refuse anyone but a person (the operator, or an active unscoped full admin principal). */
export function assertResigner(
  host: AutonomySealHost,
  actor: Actor,
  principal: PrincipalView | null,
): void {
  const refuse = (why: string): never => {
    throw new DispatchError("ACTOR_NOT_PERMITTED", `${PERSON_ONLY} ${why}`, {
      reason: "person_required",
      actor_type: actor.type,
    });
  };
  if (actor.type !== "human" && actor.type !== "admin") refuse(`This call is ${actor.type}.`);
  if (!principal) return;
  const row = host.db
    .prepare(
      "SELECT name, capability, actor_type, actor_id, scope_repos, scope_tickets, revoked_at FROM api_principals WHERE id = ?",
    )
    .get(principal.id) as
    | {
        name: string;
        capability: string;
        actor_type: string;
        actor_id: string;
        scope_repos: string | null;
        scope_tickets: string | null;
        revoked_at: string | null;
      }
    | undefined;
  if (!row) return refuse("The principal is unknown.");
  if (row.revoked_at) refuse(`Principal '${row.name}' is revoked.`);
  if (row.actor_type !== "admin") refuse(`Principal '${row.name}' is not an admin.`);
  if (row.capability !== "full") refuse(`Principal '${row.name}' is read-only.`);
  if (row.scope_repos !== null || row.scope_tickets !== null) {
    refuse(`Principal '${row.name}' is scoped.`);
  }
  if (row.actor_id !== (actor.id ?? "")) refuse(`The actor is not principal '${row.name}'.`);
}

function refuseSealKey(e: unknown): never {
  if (e instanceof GateKeyError) {
    throw new DispatchError(
      "GATE_KEY_REFUSED",
      `Nothing was re-signed: ${e.message}. Autonomy is signed with the factory key on the host (gaffer setup creates it).`,
      { reason: e.why },
    );
  }
  throw e;
}

function noReview(what: string, cmd: string): never {
  throw new DispatchError(
    "VALIDATION_ERROR",
    `Nothing was re-signed: review the unsigned ${what} first (${cmd} lists each one), then pass the code it prints with --confirm. A row written into the database looks like any other, so only your review tells it apart.`,
  );
}

function stale(what: string, cmd: string): never {
  throw new DispatchError(
    "STATE_CONFLICT",
    `Nothing was re-signed: the unsigned ${what} changed since you reviewed them (or the code is another list's). Review again (${cmd}) and confirm the new code.`,
    { reason: "review_stale" },
  );
}

// ---------------------------------------------------------------------------------------
// Policy rows
// ---------------------------------------------------------------------------------------

/** One stored policy row that grants something and is not signed. */
export interface UnsignedPolicy {
  id: string;
  repo_id: string;
  repo_name: string;
  /** The repository's checkout and remote as the row is signed over them. */
  repo_path: string | null;
  repo_remote: string | null;
  risk_level: string;
  gate: string;
  mode: string;
  enabled_by: string | null;
  enabled_at: string | null;
  created_at: string;
  failure: string;
  detail: string;
  review_code: string;
}

const POLICY_COLUMNS =
  "p.id, p.repo_id, p.risk_level, p.gate, p.mode, p.enabled_by, p.enabled_at, p.created_at";

/** A stored policy row with the repository it names, as a person reviews it. */
type ReviewedPolicyRow = PolicySealRow & {
  repo_name: string;
  repo_path: string | null;
  repo_remote: string | null;
};

function policyCodeRow(r: ReviewedPolicyRow): unknown[] {
  // The repository the row names is part of what is signed (events/autonomySeal.ts
  // policyFacts), so it is part of what the person reviews and confirms.
  return [
    r.id,
    r.repo_id,
    r.repo_name,
    r.repo_path,
    r.repo_remote,
    r.risk_level,
    r.gate,
    r.mode,
    r.enabled_by,
    r.enabled_at,
    r.created_at,
  ];
}

const POLICY_LABEL = "gaffer-unsigned-autonomy-policies";

function unsignedPolicyRows(
  db: AutonomySealHost["db"],
  keyring: GateKeyring,
): Array<{ row: ReviewedPolicyRow; failure: string; detail: string }> {
  let rows: ReviewedPolicyRow[];
  try {
    rows = db
      .prepare(
        `SELECT ${POLICY_COLUMNS}, COALESCE(r.name, p.repo_id) AS repo_name,
                r.local_path AS repo_path, r.remote_url AS repo_remote
           FROM autonomy_policy p LEFT JOIN repositories r ON r.id = p.repo_id
          WHERE p.mode != 'off' ORDER BY repo_name, p.risk_level, p.gate`,
      )
      .all() as typeof rows;
  } catch {
    return [];
  }
  const out: ReturnType<typeof unsignedPolicyRows> = [];
  for (const row of rows) {
    const v = verifyPolicyRow(db, keyring, row);
    if (!v.ok) out.push({ row, failure: v.failure, detail: v.detail });
  }
  return out;
}

/** What a person reviews before re-signing policy rows: each row and the list's code. */
export interface UnsignedPolicyReview {
  unsigned: UnsignedPolicy[];
  fingerprint: string;
}

export function reviewUnsignedPolicies(host: AutonomySealReader): UnsignedPolicyReview {
  // ONE READ, ONE SNAPSHOT (the reviewed-list rule): what is shown and the code confirmed
  // are computed from the same rows. The anchor is read first (rowSeal anchorReadFirst).
  const keyring = anchorReadFirst(host.gateKeyring);
  return inReadSnapshot(host.db, () => {
    const entries = unsignedPolicyRows(host.db, keyring);
    return {
      unsigned: entries.map(({ row, failure, detail }) => ({
        ...row,
        failure,
        detail,
        review_code: reviewCode(POLICY_LABEL, [policyCodeRow(row)]),
      })),
      fingerprint: reviewCode(
        POLICY_LABEL,
        entries.map((e) => policyCodeRow(e.row)),
      ),
    };
  });
}

export interface ResignPoliciesResult {
  resigned: Array<{ id: string; repo: string; risk_level: string; gate: string; event_id: string }>;
}

/**
 * RE-SIGN policy rows the factory does not honour: a PERSON's deliberate act (see
 * {@link assertResigner}; the safety hook denies the verb to agents; MCP has no tool).
 * `all` signs the reviewed list when `confirm` is its code; `ids` signs exactly those rows
 * when `confirm` is the code of those rows (or of the whole list). Each re-signed row gets
 * an `autonomy_policy.resigned` event and a fresh seal, in one transaction.
 */
export function resignPolicies(
  host: AutonomySealHost,
  input: { ids?: readonly string[] | undefined; all?: boolean | undefined; confirm?: string },
  actor: Actor,
  principal: PrincipalView | null,
): ResignPoliciesResult {
  assertResigner(host, actor, principal);
  const ids = (input.ids ?? []).map((s) => String(s).trim()).filter((s) => s !== "");
  const cmd = "gaffer wg autonomy unsigned";
  if (!input.all && ids.length === 0) {
    throw new DispatchError(
      "VALIDATION_ERROR",
      `Name the policy rows to re-sign (their ids), or pass --all with the code of the list you reviewed (${cmd}).`,
    );
  }
  if (input.all && ids.length > 0) {
    throw new DispatchError("VALIDATION_ERROR", "Pass ids or --all, not both.");
  }
  const confirm = String(input.confirm ?? "").trim();
  if (confirm === "") noReview("autonomy policies", cmd);
  const now = host.clock.now();
  return inTransaction(host.db, () => {
    const list = unsignedPolicyRows(host.db, host.gateKeyring);
    const whole = reviewCode(
      POLICY_LABEL,
      list.map((e) => policyCodeRow(e.row)),
    );
    let targets = list;
    if (!input.all) {
      targets = ids.map((id) => {
        const hit = list.find((e) => e.row.id === id);
        if (!hit) {
          throw new DispatchError(
            "STATE_CONFLICT",
            `Policy row ${id} is not an unsigned row that grants something (it is signed, off, or unknown). Nothing was re-signed.`,
            { reason: "not_unsigned", id },
          );
        }
        return hit;
      });
      const named = reviewCode(
        POLICY_LABEL,
        targets.map((e) => policyCodeRow(e.row)),
      );
      if (confirm !== named && confirm !== whole) stale("autonomy policies", cmd);
    } else if (confirm !== whole) {
      stale("autonomy policies", cmd);
    }
    const out: ResignPoliciesResult = { resigned: [] };
    for (const { row, failure } of targets) {
      const eventId = writeEvent(host.db, {
        entity_type: "autonomy_policy",
        entity_id: row.id,
        actor,
        event_type: AUTONOMY_POLICY_RESIGNED_EVENT,
        payload: {
          repo_id: row.repo_id,
          repo: row.repo_name,
          risk_level: row.risk_level,
          gate: row.gate,
          mode: row.mode,
          enabled_by: row.enabled_by,
          was: failure,
        },
      });
      try {
        sealPolicy(host.db, host.gateKeyring, row, eventId, now);
      } catch (e) {
        refuseSealKey(e);
      }
      out.resigned.push({
        id: row.id,
        repo: row.repo_name,
        risk_level: row.risk_level,
        gate: row.gate,
        event_id: eventId,
      });
    }
    return out;
  });
}

// ---------------------------------------------------------------------------------------
// Ticket risks
// ---------------------------------------------------------------------------------------

export interface UnsignedRisk {
  id: string;
  number: number | null;
  title: string;
  status: string;
  risk_level: string;
  failure: string;
  detail: string;
  /** Sealed at its first claim by the trusted host, with no act needed (never claimed yet). */
  sealed_at_claim: boolean;
}

const RISK_LABEL = "gaffer-unsigned-ticket-risks";

function riskCodeRow(t: { id: string; number: number | null; risk_level: string }): unknown[] {
  return [t.id, t.number, t.risk_level];
}

function unsignedRiskRows(db: AutonomySealHost["db"], keyring: GateKeyring): UnsignedRisk[] {
  let rows: Array<{
    id: string;
    number: number | null;
    title: string;
    status: string;
    risk_level: string;
  }>;
  try {
    rows = db
      .prepare(
        `SELECT id, number, title, status, risk_level FROM tickets
          WHERE status NOT IN (${SETTLED_STATUSES.map(() => "?").join(", ")}) ORDER BY number`,
      )
      .all(...SETTLED_STATUSES) as typeof rows;
  } catch {
    return [];
  }
  const out: UnsignedRisk[] = [];
  for (const t of rows) {
    const v = verifyTicketRisk(db, keyring, t.id, t.risk_level);
    if (v.ok) continue;
    let atClaim: boolean;
    try {
      atClaim =
        (t.status === "draft" || t.status === "refining" || t.status === "ready") &&
        firstClaimMaySeal(db, t.id, "");
    } catch {
      atClaim = false;
    }
    out.push({ ...t, failure: v.failure, detail: v.detail, sealed_at_claim: atClaim });
  }
  return out;
}

/** What a person reviews before re-signing ticket risks: the list, counts per risk, a code. */
export interface UnsignedRiskReview {
  unsigned: UnsignedRisk[];
  by_risk: Record<string, number>;
  fingerprint: string;
}

export function reviewUnsignedRisks(host: AutonomySealReader): UnsignedRiskReview {
  const keyring = anchorReadFirst(host.gateKeyring);
  return inReadSnapshot(host.db, () => {
    const unsigned = unsignedRiskRows(host.db, keyring);
    const by: Record<string, number> = {};
    for (const r of RISK_LEVELS) by[r] = 0;
    for (const t of unsigned) by[t.risk_level] = (by[t.risk_level] ?? 0) + 1;
    return {
      unsigned,
      by_risk: by,
      fingerprint: reviewCode(RISK_LABEL, unsigned.map(riskCodeRow)),
    };
  });
}

export interface ResignRisksResult {
  resigned: Array<{ id: string; number: number | null; risk_level: string; event_id: string }>;
}

/**
 * RE-SIGN ticket risks the factory does not honour (tickets in flight before this change,
 * imported, or whose seal broke): a PERSON's act, like {@link resignPolicies}. `all` signs
 * the reviewed list (every unsigned open ticket) when `confirm` is its code; `tickets`
 * signs exactly those when `confirm` is their code (or the whole list's).
 */
export function resignRisks(
  host: AutonomySealHost,
  input: {
    tickets?: ReadonlyArray<string | number> | undefined;
    all?: boolean | undefined;
    confirm?: string;
  },
  actor: Actor,
  principal: PrincipalView | null,
  resolve: (ref: string) => Ticket,
): ResignRisksResult {
  assertResigner(host, actor, principal);
  const refs = (input.tickets ?? []).map((s) => String(s).trim()).filter((s) => s !== "");
  const cmd = "gaffer wg autonomy risk-unsigned";
  if (!input.all && refs.length === 0) {
    throw new DispatchError(
      "VALIDATION_ERROR",
      `Name the tickets whose risk to re-sign, or pass --all with the code of the list you reviewed (${cmd}).`,
    );
  }
  if (input.all && refs.length > 0) {
    throw new DispatchError("VALIDATION_ERROR", "Pass tickets or --all, not both.");
  }
  const confirm = String(input.confirm ?? "").trim();
  if (confirm === "") noReview("ticket risks", cmd);
  const now = host.clock.now();
  return inTransaction(host.db, () => {
    const list = unsignedRiskRows(host.db, host.gateKeyring);
    const whole = reviewCode(RISK_LABEL, list.map(riskCodeRow));
    let targets = list;
    if (!input.all) {
      targets = refs.map((ref) => {
        const t = resolve(ref);
        const hit = list.find((u) => u.id === t.id);
        if (!hit) {
          throw new DispatchError(
            "STATE_CONFLICT",
            `Ticket #${t.number ?? t.id}'s risk is not an unsigned open one (it is signed, or the ticket is settled). Nothing was re-signed.`,
            { reason: "not_unsigned", ticket: t.number ?? t.id },
          );
        }
        return hit;
      });
      const named = reviewCode(RISK_LABEL, targets.map(riskCodeRow));
      if (confirm !== named && confirm !== whole) stale("ticket risks", cmd);
    } else if (confirm !== whole) {
      stale("ticket risks", cmd);
    }
    const out: ResignRisksResult = { resigned: [] };
    for (const t of targets) {
      let eventId: string;
      try {
        eventId = recordTicketRisk(
          host.db,
          host.gateKeyring,
          {
            ticketId: t.id,
            riskLevel: t.risk_level,
            source: "resigned",
            now,
            extra: { was: t.failure },
          },
          actor,
        );
      } catch (e) {
        refuseSealKey(e);
      }
      out.resigned.push({
        id: t.id,
        number: t.number,
        risk_level: t.risk_level,
        event_id: eventId,
      });
    }
    return out;
  });
}

// ---------------------------------------------------------------------------------------
// What is not signed, and what it costs (doctor, Settings, the startup line)
// ---------------------------------------------------------------------------------------

export interface AutonomySealSummary {
  /** Unsigned rows that grant something, and of those how many say `auto`. */
  policies: { unsigned: number; auto: number };
  /** Unsigned open tickets, and how many of those will be sealed at their first claim. */
  risks: { unsigned: number; sealed_at_claim: number; by_risk: Record<string, number> };
  /** One sentence per finding, for doctor and the startup log (empty: nothing to say). */
  messages: string[];
}

export function autonomySealSummary(host: AutonomySealReader): AutonomySealSummary {
  const policies = reviewUnsignedPolicies(host).unsigned;
  const risks = reviewUnsignedRisks(host);
  const auto = policies.filter((p) => p.mode === "auto").length;
  const atClaim = risks.unsigned.filter((t) => t.sealed_at_claim).length;
  const needAct = risks.unsigned.length - atClaim;
  const messages: string[] = [];
  if (policies.length > 0) {
    messages.push(
      `${policies.length} autonomy polic${policies.length === 1 ? "y row is" : "y rows are"} not signed${auto > 0 ? ` (${auto} automatic)` : ""}: they are off until a person signs them (gaffer wg autonomy unsigned, then gaffer wg autonomy resign, or Settings > Autonomy)`,
    );
  }
  if (needAct > 0) {
    messages.push(
      `${needAct} open ticket${needAct === 1 ? "'s risk is" : "s' risks are"} not signed: each is decided as the highest risk (a person decides) until a person re-signs it (gaffer wg autonomy risk-unsigned, then gaffer wg autonomy risk-resign)`,
    );
  }
  return {
    policies: { unsigned: policies.length, auto },
    risks: { unsigned: risks.unsigned.length, sealed_at_claim: atClaim, by_risk: risks.by_risk },
    messages,
  };
}

export { TICKET_RISK_SET_EVENT };

import type { Actor } from "../domain/types.js";
import { DispatchError } from "../util/errors.js";

/**
 * PRE-WORK SCOUT RECORD (delta roadmap gap 3). Before each delivery the runner builds a
 * deterministic scout packet (runner/lib/scout.mjs: the named files, stack frames and
 * the code index's importers and tests of them) and classifies the ticket's risk
 * (runner/lib/risk-classify.mjs: it can only raise the declared level). It records the
 * packet's summary here as `ticket.scout_recorded`, a system event:
 *
 *  - the Review packet's backing rows say "Risk raised to high by the scout ..." with
 *    the signals that raised it (reviewPacketService readBacking);
 *  - Health's scout read model counts coverage (attempts with a packet, items from the
 *    index vs named only, model scout runs and their cost) and splits first-pass
 *    acceptance by it (health/scoutMeasures.ts). A report, never a gate.
 *
 * Runner (system) or admin only: an agent never records it (the safety hook also denies
 * `wg ticket scout-record` to an agent shell). Nothing gates on it; it never bumps
 * updated_at. Every field is bounded and validated: the packet's paths come from ticket
 * text and the repo, so only counts, levels and short labelled details are stored.
 */
export const SCOUT_RECORDED_EVENT = "ticket.scout_recorded" as const;

export const RISK_ORDER = ["low", "medium", "high", "critical"] as const;
export type ScoutRiskLevel = (typeof RISK_ORDER)[number];

export const SCOUT_SIGNAL_KINDS = [
  "migration",
  "auth",
  "schema",
  "public_api",
  "concurrency",
  "cross_repo",
  "prior_failure",
  "fan_out",
  "untested",
] as const;

export interface ScoutSignal {
  kind: (typeof SCOUT_SIGNAL_KINDS)[number];
  detail: string;
  level: ScoutRiskLevel;
  raises: boolean;
}

export interface ScoutRecord {
  /** The delivery attempt the packet was built for (1-based), when known. */
  attempt: number | null;
  base_sha: string | null;
  /** The code index's state for the seeds: fresh | stale | missing | unknown | unavailable. */
  index_status: string;
  items: number;
  /** Items the index added (not named, not in a stack frame). */
  from_index: number;
  named: number;
  stack: number;
  omitted: number;
  declared: ScoutRiskLevel;
  effective: ScoutRiskLevel;
  raised: boolean;
  signals: ScoutSignal[];
  model_scout: {
    ran: boolean;
    kept_files: number;
    dropped: number;
    notes: number;
    cost_usd: number | null;
    model: string | null;
  } | null;
  actor: string;
}

/** Refuse anyone but the runner or an admin. */
export function assertMayRecordScout(actor: Actor): void {
  if (actor.type !== "system" && actor.type !== "admin")
    throw new DispatchError(
      "ACTOR_NOT_PERMITTED",
      "Only the runner (system) or an admin may record a scout packet.",
      { actor_type: actor.type },
    );
}

const SHA = /^[0-9a-f]{7,64}$/i;
const INDEX_STATUSES = ["fresh", "stale", "missing", "unknown", "unavailable"];

const count = (v: unknown): number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? Math.min(v, 100000) : 0;
const level = (v: unknown, fallback: ScoutRiskLevel): ScoutRiskLevel =>
  (RISK_ORDER as readonly string[]).includes(String(v)) ? (v as ScoutRiskLevel) : fallback;
const text = (v: unknown, max: number): string =>
  typeof v === "string"
    ? v
        .replace(/[\r\n\t]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max)
    : "";
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * Validate the runner's scout packet (the JSON lib/scout.mjs writes, with its `risk`)
 * into the stored summary. Refuses a packet without a risk classification; clamps the
 * rest. `declared` is the ticket's own risk_level when the caller passes it (the packet's
 * copy is only a fallback), and `effective` is recomputed as max(declared, signals), so a
 * record can never say the scout lowered a ticket's risk, nor claim a raise from a level
 * below the one the ticket declares.
 */
export function normalizeScoutRecord(
  input: Record<string, unknown>,
  actor: Actor,
  ticketDeclared?: string,
): ScoutRecord {
  const risk = obj(input.risk);
  if (!risk.declared && !risk.effective)
    throw new DispatchError("VALIDATION_ERROR", "a scout record needs the packet's risk.", {});
  const declared =
    ticketDeclared !== undefined ? level(ticketDeclared, "medium") : level(risk.declared, "medium");
  const signals: ScoutSignal[] = (Array.isArray(risk.signals) ? risk.signals : [])
    .map((s) => obj(s))
    .filter((s) => (SCOUT_SIGNAL_KINDS as readonly string[]).includes(String(s.kind)))
    .slice(0, 12)
    .map((s) => {
      const l = level(s.level, "medium");
      return {
        kind: s.kind as ScoutSignal["kind"],
        detail: text(s.detail, 200),
        level: l,
        raises: RISK_ORDER.indexOf(l) > RISK_ORDER.indexOf(declared),
      };
    });
  let eff = RISK_ORDER.indexOf(declared);
  for (const s of signals) eff = Math.max(eff, Math.min(RISK_ORDER.indexOf(s.level), 2));
  const effective = RISK_ORDER[eff]!;
  const counts = obj(input.counts);
  const index = obj(input.index);
  const ms = input.model_scout ? obj(input.model_scout) : null;
  const sha = typeof input.base_sha === "string" ? input.base_sha.trim() : "";
  const status = String(index.status ?? "");
  const attempt = input.attempt;
  return {
    attempt:
      typeof attempt === "number" && Number.isInteger(attempt) && attempt > 0 && attempt < 1000
        ? attempt
        : null,
    base_sha: SHA.test(sha) ? sha.toLowerCase() : null,
    index_status: INDEX_STATUSES.includes(status) ? status : "unavailable",
    items: count(counts.items),
    from_index: count(counts.index),
    named: count(counts.named),
    stack: count(counts.stack),
    omitted: count(input.omitted),
    declared,
    effective,
    raised: eff > RISK_ORDER.indexOf(declared),
    signals,
    model_scout: ms
      ? {
          ran: ms.ran === true,
          kept_files: count(ms.kept_files),
          dropped: count(ms.dropped_files) + count(ms.dropped_symbols),
          notes: Array.isArray(ms.notes) ? Math.min(ms.notes.length, 10) : 0,
          cost_usd:
            typeof ms.cost_usd === "number" && Number.isFinite(ms.cost_usd) && ms.cost_usd >= 0
              ? ms.cost_usd
              : null,
          model: text(ms.model, 80) || null,
        }
      : null,
    actor: actor.type,
  };
}

/** "Risk raised to high by the scout before delivery (declared medium): a, b" or null. */
export function scoutRaisedFact(r: ScoutRecord | null): string | null {
  if (!r || !r.raised) return null;
  const why = r.signals.filter((s) => s.raises).map((s) => s.detail);
  return `Risk raised to ${r.effective} by the scout before delivery (declared ${r.declared})${why.length ? `: ${why.join(", ")}` : ""}`;
}

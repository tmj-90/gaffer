/**
 * PRE-WORK SCOUT COVERAGE (delta roadmap gap 3, gap-verify B0): what the scout gave the
 * delivery attempts, from the runner's `ticket.scout_recorded` events, joined to
 * first-pass acceptance so "does the scout help" can be computed. A report only: no
 * recommendation, no score, nothing gates on it.
 *
 *   attempts          scout records (one per delivery attempt the runner scouted)
 *   with_index_items  records where the code index added at least one file
 *   named_only        records with items, none of them from the index (no index, a stale
 *                     one, or nothing imports what the ticket names)
 *   empty             records with no item (the ticket names no code and quotes no frame)
 *   risk_raised       records where the classifier raised the declared risk
 *   model_scout       bounded model scout runs, files kept and dropped, and the cost the
 *                     runner read from each call (unknown costs counted, never imputed)
 *   first_pass        first-pass acceptance (health/firstPass.ts, the same definition)
 *                     split by the ticket's FIRST scout record: index items / named only /
 *                     nothing found / no record (tickets delivered before the scout, or
 *                     with the scout packet turned off). Arms are observational, not randomised.
 * Pure.
 */
import { firstPassAcceptance, type FirstPassCount, type FirstPassRetry } from "./firstPass.js";
import type { ReviewTimeTransition } from "./reviewTime.js";

export interface ScoutEventRow {
  readonly ticketId: string;
  readonly atMs: number;
  readonly payload: Record<string, unknown>;
}

export type ScoutArm = "index_items" | "named_only" | "nothing_found" | "no_record";

export interface ScoutCoverage {
  readonly measure: "scout_coverage";
  readonly attempts: number;
  readonly tickets: number;
  readonly with_index_items: number;
  readonly named_only: number;
  readonly empty: number;
  readonly index_status: Readonly<Record<string, number>>;
  readonly risk_raised: number;
  readonly model_scout: {
    readonly runs: number;
    readonly kept_files: number;
    readonly dropped: number;
    readonly cost_usd: number;
    readonly cost_unknown: number;
  };
  readonly first_pass: Readonly<Record<ScoutArm, FirstPassCount>>;
  readonly limits: readonly string[];
}

export const SCOUT_LIMITS: readonly string[] = [
  "one record per delivery attempt the runner scouted; the arms split tickets by their first record",
  "the arms are observational (which tickets name code differs), not a controlled experiment",
  "the index's importers and tests are by import text, a lower bound",
];

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function scoutCoverage(input: {
  events: readonly ScoutEventRow[];
  transitions: readonly (ReviewTimeTransition & { reason?: string | null })[];
  retries: readonly FirstPassRetry[];
  tickets: readonly { id: string; status: string }[];
}): ScoutCoverage {
  const events = [...input.events].sort((a, b) => a.atMs - b.atMs);
  const status: Record<string, number> = {};
  let withIndex = 0;
  let namedOnly = 0;
  let empty = 0;
  let raised = 0;
  const model = { runs: 0, kept_files: 0, dropped: 0, cost_usd: 0, cost_unknown: 0 };
  const firstArm = new Map<string, ScoutArm>();
  for (const e of events) {
    const p = e.payload;
    const s = typeof p.index_status === "string" ? p.index_status : "unavailable";
    status[s] = (status[s] ?? 0) + 1;
    const items = num(p.items);
    const fromIndex = num(p.from_index);
    const arm: ScoutArm =
      fromIndex > 0 ? "index_items" : items > 0 ? "named_only" : "nothing_found";
    if (arm === "index_items") withIndex++;
    else if (arm === "named_only") namedOnly++;
    else empty++;
    if (p.raised === true) raised++;
    const ms =
      p.model_scout && typeof p.model_scout === "object"
        ? (p.model_scout as Record<string, unknown>)
        : null;
    if (ms && ms.ran === true) {
      model.runs++;
      model.kept_files += num(ms.kept_files);
      model.dropped += num(ms.dropped);
      if (typeof ms.cost_usd === "number" && Number.isFinite(ms.cost_usd))
        model.cost_usd += ms.cost_usd;
      else model.cost_unknown++;
    }
    if (!firstArm.has(e.ticketId)) firstArm.set(e.ticketId, arm);
  }
  const armOf = (id: string): ScoutArm => firstArm.get(id) ?? "no_record";
  const split = (arm: ScoutArm): FirstPassCount => {
    const r = firstPassAcceptance({
      transitions: input.transitions,
      retries: input.retries,
      tickets: input.tickets.filter((t) => armOf(t.id) === arm),
    });
    return { done: r.done, first_pass: r.first_pass, rate_pct: r.rate_pct };
  };
  return {
    measure: "scout_coverage",
    attempts: events.length,
    tickets: firstArm.size,
    with_index_items: withIndex,
    named_only: namedOnly,
    empty,
    index_status: status,
    risk_raised: raised,
    model_scout: { ...model, cost_usd: Math.round(model.cost_usd * 10000) / 10000 },
    first_pass: {
      index_items: split("index_items"),
      named_only: split("named_only"),
      nothing_found: split("nothing_found"),
      no_record: split("no_record"),
    },
    limits: SCOUT_LIMITS,
  };
}

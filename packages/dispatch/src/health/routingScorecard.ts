/**
 * ROUTING SCORECARD (delta roadmap gap 4, P1; strategy "historical provider/model
 * scorecards"): what each provider and model did per role and work class, from the usage
 * ledger, the runner's replay manifests and the outcomes dispatch owns. A report only:
 * no recommendation, no composite score, nothing routes on it. route-model.mjs stays the
 * only thing that routes; `wg routing recommend` (routingRecommend.ts) reads this and only
 * prints a proposed registry edit for a person to apply.
 *
 *   cell             provider x model x role x work class. The provider is the worker that
 *                    ran the call (`worker_provider`, claude-code when absent); the model is
 *                    the one the call ASKED for (`model_requested`, the routing decision,
 *                    `default` for the CLI's own); the role is the ledger kind's phase
 *                    (delivery = implement); the work class is the risk the router saw on
 *                    the row (`risk`, the effective risk) and the repo's stack where known
 *                    (the manifest's, else the repository's), `unknown` otherwise.
 *   calls            ledger rows in the cell; spend = measured cost + labelled estimates;
 *                    `unknown_rows` counts calls with neither (never imputed as $0 cost: the
 *                    figure is labelled as leaving them out)
 *   attempts         implement only: distinct delivery attempt ids (a row with none is its own)
 *   submissions      implement only: attempts whose replay manifest says `submit`, over the
 *                    attempts that have a manifest (`outcome_known`)
 *   rework rate      implement only: attempts whose manifest says rework, park or failed, over
 *                    `outcome_known`
 *   tickets          implement only: tickets whose FIRST delivery attempt ran in this cell
 *                    (the route the ticket started on); the ticket-level measures below are
 *                    over those tickets
 *   first pass       first-pass acceptance (health/firstPass.ts, the same definition) over
 *                    those tickets that reached done
 *   attempts / cost per accepted change
 *                    health/acceptedChange.ts over those tickets' ledger rows (every attempt,
 *                    every kind, estimates included), divided by those that reached done
 *   escaped defects  accepted tickets of the cell a person linked a later regression to
 *   tester false greens
 *                    escaped ones whose tester's last verdict was a pass
 *
 * Every figure carries its n. A cell whose own n (attempts for implement, calls for any other
 * role) is under the minimum (default 10) reads "too few to compare" with every rate null;
 * a rate whose denominator is under the minimum is null too. Cells are listed in a fixed key
 * order and never ranked. Pure apart from `readRoutingScorecard`, which reads the database
 * and is handed the ledger rows and the manifests.
 */
import type { Db } from "../db/connection.js";
import {
  currentRegressionLinks,
  DEFECT_ESCAPED_EVENT,
  DEFECT_ESCAPED_WITHDRAWN_EVENT,
  type RegressionEventRow,
} from "../services/escapedDefects.js";
import { LANE_VERDICT_EVENT } from "../services/reviewTelemetry.js";
import { acceptedChangeCost } from "./acceptedChange.js";
import { firstPassAcceptance } from "./firstPass.js";
import { parseHealthLine, type HealthRow } from "./healthAggregator.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The minimum n below which a cell or a rate is "too few to compare". */
export const DEFAULT_ROUTING_MIN_N = 10;
export const TOO_FEW = "too few to compare";

/** A ledger row with the routing labels the runner stamps on it. */
export interface RoutingRow extends HealthRow {
  readonly model_requested?: string | null;
  readonly worker_provider?: string | null;
  readonly risk?: string | null;
  readonly repo?: string | null;
  readonly route_tier?: string | null;
  readonly unknown_cost: boolean;
}

/** What the scorecard needs from one replay manifest. */
export interface ManifestFact {
  readonly ticket: number | null;
  readonly attemptId: string | null;
  readonly result: string | null;
  readonly stack: string | null;
}

export interface Rate {
  readonly value: number | null;
  readonly n: number;
}

export interface ScorecardCell {
  readonly provider: string;
  readonly model: string;
  readonly role: string;
  readonly risk: string;
  readonly stack: string;
  /** The cell's own n: attempts for implement, calls otherwise. */
  readonly n: number;
  readonly too_few: boolean;
  readonly note: string | null;
  readonly calls: number;
  readonly spend_usd: number | null;
  readonly estimated_usd: number | null;
  readonly estimated_rows: number;
  readonly unknown_rows: number;
  readonly attempts: number | null;
  readonly outcome_known: number | null;
  readonly submission_pct: Rate | null;
  readonly rework_pct: Rate | null;
  readonly tickets: number | null;
  readonly accepted: number | null;
  readonly first_pass_pct: Rate | null;
  readonly attempts_per_accepted_change: Rate | null;
  readonly cost_per_accepted_change_usd: Rate | null;
  /**
   * Implement only: ledger rows of the cell's tickets with neither a measured cost nor an
   * estimate. They are left out of cost per accepted change (never read as $0), and said.
   */
  readonly cost_unknown_rows: number | null;
  readonly escaped_defect_pct: Rate | null;
  readonly tester_false_greens: Rate | null;
}

export interface RoutingScorecard {
  readonly measure: "routing_scorecard";
  readonly report_only: true;
  readonly min_n: number;
  readonly rows: number;
  readonly manifests: number;
  readonly cells: readonly ScorecardCell[];
  readonly definitions: Readonly<Record<string, string>>;
  readonly footnote: string;
  readonly limits: readonly string[];
}

export const ROUTING_DEFINITIONS: Readonly<Record<string, string>> = {
  cell: "provider x model x role x work class (effective risk, repo stack); the model is the one the call asked for",
  n: "attempts for the implement role, ledger calls for any other role",
  spend_usd:
    "measured cost plus labelled estimates for killed calls; calls with neither are counted as unknown_rows, not as $0",
  submission_pct:
    "attempts whose replay manifest says submit, over attempts whose manifest is complete (a manifest still open, an attempt that crashed before the runner closed it, is left out)",
  rework_pct:
    "attempts whose replay manifest says rework, park or failed, over the same attempts (paused, released, killed and ended attempts count in the denominator only)",
  tickets: "tickets whose first delivery attempt ran in this cell",
  first_pass_pct:
    "first-pass acceptance (no send-back after review, never reopened) of those tickets that reached done",
  attempts_per_accepted_change:
    "every delivery attempt on those tickets over those that reached done",
  cost_per_accepted_change_usd:
    "every ledger row of those tickets, every kind, estimates included, over those that reached done; rows with no measured or estimated cost are left out and counted in cost_unknown_rows",
  escaped_defect_pct:
    "accepted tickets a person linked a later regression to, over accepted tickets",
  tester_false_greens: "escaped accepted tickets whose tester's last verdict was pass",
};

export const ROUTING_FOOTNOTE =
  "Report only: no composite score, cells are never ranked, and nothing routes on this. A routing change is a person's edit to the model registry.";

export const ROUTING_LIMITS: readonly string[] = [
  "observational: the router chose these models for these tickets, so cells differ in their work as well as their model; a matched experiment (gaffer eval experiment) compares like with like",
  "a ticket is counted in the cell of its first delivery attempt; an escalated attempt's own cell counts its attempts and spend only",
  "submission and rework rates read the replay manifests, which exist only for attempts since they were recorded",
  "the stack is the manifest's or the repository's; a row with no repo reads unknown",
];

const ROLE_OF: Readonly<Record<string, string>> = {
  delivery: "implement",
  review: "review",
  "security-review": "security-review",
  tester: "test",
  clarify: "clarify",
  scout: "scout",
  decompose: "plan",
  "merge-resolver": "merge-conflict-resolve",
};

export function roleOfKind(kind: string | null): string {
  if (!kind) return "unknown";
  return ROLE_OF[kind] ?? kind;
}

const short = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const s = v.replace(/[^A-Za-z0-9 ._()+:/@[\]-]/g, "").trim();
  return s ? s.slice(0, 80) : null;
};

/** Parse one ledger line with its routing labels. */
export function parseRoutingLine(line: string): RoutingRow | null {
  const base = parseHealthLine(line);
  if (!base) return null;
  // parseHealthLine accepted it, so it parses as an object.
  const raw = JSON.parse(line.trim()) as Record<string, unknown>;
  return {
    ...base,
    model_requested: short(raw.model_requested),
    worker_provider: short(raw.worker_provider),
    risk: short(raw.risk),
    repo: short(raw.repo),
    route_tier: short(raw.route_tier),
    unknown_cost: !base.measured && !(base.estimated_cost_usd && base.estimated_cost_usd > 0),
  };
}

export function readRoutingRows(ledgerPath: string | null): RoutingRow[] {
  if (!ledgerPath) return [];
  try {
    if (!existsSync(ledgerPath)) return [];
    const out: RoutingRow[] = [];
    for (const line of readFileSync(ledgerPath, "utf8").split("\n")) {
      const r = parseRoutingLine(line);
      if (r) out.push(r);
    }
    return out;
  } catch {
    return [];
  }
}

/** At most this many manifests are read (newest attempts last per ticket). */
export const MAX_MANIFESTS = 5000;

/** The runner's replay manifests under `<GAFFER_DATA>/manifests` (lib/replay-manifest.mjs). */
export function readManifestFacts(dir: string | null): ManifestFact[] {
  if (!dir) return [];
  try {
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir)
      .filter((f) => /^\d+-\d+\.json$/.test(f))
      .slice(-MAX_MANIFESTS);
    const out: ManifestFact[] = [];
    for (const f of files) {
      try {
        const m = JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>;
        if (m.schema !== "gaffer.replay-manifest/1") continue;
        const ticket = (m.ticket ?? {}) as Record<string, unknown>;
        const ledger = (m.ledger ?? {}) as Record<string, unknown>;
        const outcome = (m.outcome ?? null) as Record<string, unknown> | null;
        const repos = Array.isArray(m.repos) ? (m.repos as Array<Record<string, unknown>>) : [];
        out.push({
          ticket: typeof ticket.number === "number" ? ticket.number : null,
          attemptId: typeof ledger.attempt_id === "string" ? ledger.attempt_id : null,
          result: outcome && typeof outcome.result === "string" ? outcome.result : null,
          stack: short(repos[0]?.stack) ?? null,
        });
      } catch {
        continue;
      }
    }
    return out;
  } catch {
    return [];
  }
}

export interface ScorecardTransition {
  readonly ticketId: string;
  readonly actorType: string;
  readonly fromStatus: string | null;
  readonly toStatus: string | null;
  readonly reason: string | null;
  readonly atMs: number;
}

export interface ScorecardInput {
  readonly rows: readonly RoutingRow[];
  readonly manifests: readonly ManifestFact[];
  readonly tickets: readonly { id: string; number: number; status: string }[];
  readonly transitions: readonly ScorecardTransition[];
  readonly retries: readonly { ticketId: string; at: string }[];
  /** Ticket ids of accepted changes a person linked a later regression to. */
  readonly escaped: ReadonlySet<string>;
  /** Ticket id -> the tester's last verdict. */
  readonly testerVerdict: ReadonlyMap<string, string>;
  /** Repository name -> stack. */
  readonly repoStack: ReadonlyMap<string, string>;
  readonly minN?: number;
}

const usd = (v: number): number => Math.round(v * 1e6) / 1e6;
const pct = (n: number, d: number): number => Math.round((n / d) * 1000) / 10;

interface Acc {
  readonly key: { provider: string; model: string; role: string; risk: string; stack: string };
  readonly rows: RoutingRow[];
  readonly attemptIds: Set<string>;
}

function rate(value: number | null, n: number, min: number): Rate {
  return { value: n >= min ? value : null, n };
}

/** The scorecard (see the module comment). */
export function routingScorecard(input: ScorecardInput): RoutingScorecard {
  const min = Math.max(1, Math.trunc(input.minN ?? DEFAULT_ROUTING_MIN_N));
  const outcomeByAttempt = new Map<string, ManifestFact>();
  for (const m of input.manifests)
    if (m.ticket !== null && m.attemptId) outcomeByAttempt.set(`${m.ticket}:${m.attemptId}`, m);
  const ticketByNumber = new Map(input.tickets.map((t) => [t.number, t]));

  const cellKey = (r: RoutingRow): Acc["key"] => {
    const m =
      r.ticket !== null && r.attempt_id
        ? outcomeByAttempt.get(`${r.ticket}:${r.attempt_id}`)
        : undefined;
    return {
      provider: r.worker_provider ?? "claude-code",
      model: r.model_requested ?? "default",
      role: roleOfKind(r.kind),
      risk: r.risk ?? "unknown",
      stack: m?.stack ?? (r.repo ? input.repoStack.get(r.repo) : undefined) ?? "unknown",
    };
  };
  const keyStr = (k: Acc["key"]): string =>
    [k.role, k.provider, k.model, k.risk, k.stack].join("\u0000");

  const cells = new Map<string, Acc>();
  // The first delivery attempt of each ticket: the cell the ticket started in.
  const firstCell = new Map<number, string>();
  const firstAt = new Map<number, number>();
  input.rows.forEach((r, i) => {
    const k = cellKey(r);
    const ks = keyStr(k);
    let acc = cells.get(ks);
    if (!acc) {
      acc = { key: k, rows: [], attemptIds: new Set() };
      cells.set(ks, acc);
    }
    acc.rows.push(r);
    if (k.role === "implement") {
      acc.attemptIds.add(r.attempt_id ? `${r.ticket}:${r.attempt_id}` : `row-${i}`);
      if (r.ticket !== null) {
        const at = Date.parse(r.started_at ?? r.ts) || i;
        if (!firstAt.has(r.ticket) || at < (firstAt.get(r.ticket) as number)) {
          firstAt.set(r.ticket, at);
          firstCell.set(r.ticket, ks);
        }
      }
    }
  });
  const rowsByTicket = new Map<number, RoutingRow[]>();
  for (const r of input.rows) {
    if (r.ticket === null) continue;
    const list = rowsByTicket.get(r.ticket) ?? [];
    list.push(r);
    rowsByTicket.set(r.ticket, list);
  }

  const out: ScorecardCell[] = [];
  const sorted = [...cells.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [ks, acc] of sorted) {
    const implement = acc.key.role === "implement";
    let spend = 0;
    let estimated = 0;
    let estimatedRows = 0;
    let unknownRows = 0;
    for (const r of acc.rows) {
      spend += r.total_cost_usd + (r.estimated_cost_usd ?? 0);
      if ((r.estimated_cost_usd ?? 0) > 0) {
        estimated += r.estimated_cost_usd ?? 0;
        estimatedRows += 1;
      }
      if (r.unknown_cost) unknownRows += 1;
    }
    const n = implement ? acc.attemptIds.size : acc.rows.length;
    const tooFew = n < min;
    const base = {
      ...acc.key,
      n,
      too_few: tooFew,
      note: tooFew ? TOO_FEW : null,
      calls: acc.rows.length,
      spend_usd: tooFew ? null : usd(spend),
      estimated_usd: tooFew ? null : usd(estimated),
      estimated_rows: estimatedRows,
      unknown_rows: unknownRows,
    };
    if (!implement) {
      out.push({
        ...base,
        attempts: null,
        outcome_known: null,
        submission_pct: null,
        rework_pct: null,
        tickets: null,
        accepted: null,
        first_pass_pct: null,
        attempts_per_accepted_change: null,
        cost_per_accepted_change_usd: null,
        cost_unknown_rows: null,
        escaped_defect_pct: null,
        tester_false_greens: null,
      });
      continue;
    }
    // Attempt outcomes from the manifests.
    let known = 0;
    let submitted = 0;
    let reworked = 0;
    const seen = new Set<string>();
    for (const r of acc.rows) {
      if (r.ticket === null || !r.attempt_id) continue;
      const id = `${r.ticket}:${r.attempt_id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const m = outcomeByAttempt.get(id);
      if (!m || !m.result) continue;
      known += 1;
      if (m.result === "submit") submitted += 1;
      else if (/^(?:rework|park|failed)\b/.test(m.result)) reworked += 1;
    }
    // Ticket-level measures over the tickets this cell started.
    const numbers = [...firstCell.entries()].filter(([, c]) => c === ks).map(([t]) => t);
    const tickets = numbers
      .map((num) => ticketByNumber.get(num))
      .filter((t): t is { id: string; number: number; status: string } => !!t);
    const ids = new Set(tickets.map((t) => t.id));
    const done = tickets.filter((t) => t.status === "done");
    const fp = firstPassAcceptance({
      transitions: input.transitions.filter((t) => ids.has(t.ticketId)),
      retries: input.retries.filter((r) => ids.has(r.ticketId)),
      tickets,
    });
    const ticketRows = numbers.flatMap((num) => rowsByTicket.get(num) ?? []);
    const ac = acceptedChangeCost(ticketRows, tickets, []);
    const escaped = done.filter((t) => input.escaped.has(t.id));
    const falseGreens = escaped.filter(
      (t) => (input.testerVerdict.get(t.id) ?? "").toLowerCase() === "pass",
    ).length;
    const dn = done.length;
    out.push({
      ...base,
      attempts: n,
      outcome_known: known,
      submission_pct: tooFew ? null : rate(known ? pct(submitted, known) : null, known, min),
      rework_pct: tooFew ? null : rate(known ? pct(reworked, known) : null, known, min),
      tickets: tickets.length,
      accepted: dn,
      first_pass_pct: tooFew ? null : rate(fp.rate_pct, dn, min),
      attempts_per_accepted_change: tooFew ? null : rate(ac.attempts_per_accepted_change, dn, min),
      cost_per_accepted_change_usd: tooFew ? null : rate(ac.cost_per_accepted_change_usd, dn, min),
      cost_unknown_rows: ticketRows.filter((r) => r.unknown_cost).length,
      escaped_defect_pct: tooFew ? null : rate(dn ? pct(escaped.length, dn) : null, dn, min),
      tester_false_greens: tooFew ? null : rate(dn ? falseGreens : null, dn, min),
    });
  }
  return {
    measure: "routing_scorecard",
    report_only: true,
    min_n: min,
    rows: input.rows.length,
    manifests: input.manifests.length,
    cells: out,
    definitions: ROUTING_DEFINITIONS,
    footnote: ROUTING_FOOTNOTE,
    limits: ROUTING_LIMITS,
  };
}

/** Read every input from the database; the caller hands over the ledger and manifests. */
export function readRoutingScorecard(
  db: Db,
  opts: { rows: readonly RoutingRow[]; manifests: readonly ManifestFact[]; minN?: number },
): RoutingScorecard {
  const tickets = db.prepare("SELECT id, number, status FROM tickets").all() as Array<{
    id: string;
    number: number;
    status: string;
  }>;
  const transitions = (
    db
      .prepare(
        `SELECT entity_id AS ticketId, actor_type AS actorType,
                json_extract(payload_json, '$.from')   AS fromStatus,
                json_extract(payload_json, '$.to')     AS toStatus,
                json_extract(payload_json, '$.reason') AS reason,
                created_at AS at
           FROM work_events
          WHERE entity_type = 'ticket' AND event_type = 'ticket.transitioned'
          ORDER BY rowid`,
      )
      .all() as Array<Omit<ScorecardTransition, "atMs"> & { at: string }>
  ).map((r) => ({ ...r, atMs: Date.parse(r.at) || 0 }));
  const retries = db
    .prepare(`SELECT ticket_id AS ticketId, created_at AS at FROM rework_attempts`)
    .all() as Array<{ ticketId: string; at: string }>;
  const regressionRows = db
    .prepare(
      `SELECT entity_id AS ticketId, event_type AS eventType, actor_type AS actorType,
              actor_id AS actorId, created_at AS at,
              json_extract(payload_json, '$.regression_of') AS regressionOf,
              json_extract(payload_json, '$.note') AS note
         FROM work_events
        WHERE entity_type = 'ticket' AND event_type IN (?, ?)
        ORDER BY rowid`,
    )
    .all(DEFECT_ESCAPED_EVENT, DEFECT_ESCAPED_WITHDRAWN_EVENT) as RegressionEventRow[];
  const escaped = new Set(
    currentRegressionLinks(regressionRows)
      .filter((l) => l.filedBy.type === "human" || l.filedBy.type === "admin")
      .map((l) => l.regressionOf),
  );
  const testerVerdict = new Map<string, string>();
  for (const r of db
    .prepare(
      `SELECT entity_id AS ticketId, json_extract(payload_json, '$.verdict') AS verdict
         FROM work_events
        WHERE entity_type = 'ticket' AND event_type = ?
          AND json_extract(payload_json, '$.lane') = 'tester'
        ORDER BY rowid`,
    )
    .all(LANE_VERDICT_EVENT) as Array<{ ticketId: string; verdict: string | null }>)
    if (r.verdict) testerVerdict.set(r.ticketId, r.verdict);
  const repoStack = new Map<string, string>();
  for (const r of db.prepare("SELECT name, stack FROM repositories").all() as Array<{
    name: string;
    stack: string | null;
  }>)
    if (r.stack) repoStack.set(r.name, r.stack);
  return routingScorecard({
    rows: opts.rows,
    manifests: opts.manifests,
    tickets,
    transitions,
    retries,
    escaped,
    testerVerdict,
    repoStack,
    ...(opts.minN !== undefined ? { minN: opts.minN } : {}),
  });
}

/** `<GAFFER_DATA>/manifests`, or null when GAFFER_DATA is unset. */
export function manifestsDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const data = env.GAFFER_DATA;
  return data ? join(data, "manifests") : null;
}

const fmtRate = (r: Rate | null, unit: "%" | "$" | ""): string => {
  if (!r) return "n/a";
  if (r.value === null) return `${TOO_FEW} (n=${r.n})`;
  const v = unit === "$" ? `$${r.value.toFixed(2)}` : unit === "%" ? `${r.value}%` : `${r.value}`;
  return `${v} (n=${r.n})`;
};

/** The text `wg stats routing` prints. */
export function renderRoutingScorecard(s: RoutingScorecard): string {
  const lines = [
    `Routing scorecard (report only; minimum n ${s.min_n}; ${s.rows} ledger rows, ${s.manifests} replay manifests)`,
  ];
  if (s.cells.length === 0) lines.push("  no ledger rows yet");
  for (const c of s.cells) {
    const head = `  ${c.role} · ${c.provider} · ${c.model} · risk ${c.risk} · stack ${c.stack}: n=${c.n}`;
    if (c.too_few) {
      lines.push(`${head} · ${TOO_FEW}`);
      continue;
    }
    const spend = `spend $${(c.spend_usd ?? 0).toFixed(2)} over ${c.calls} call(s)${c.estimated_rows ? `, ${c.estimated_rows} estimated` : ""}${c.unknown_rows ? `, ${c.unknown_rows} with unknown cost left out` : ""}`;
    if (c.role !== "implement") {
      lines.push(`${head} · ${spend}`);
      continue;
    }
    lines.push(
      `${head} · submitted ${fmtRate(c.submission_pct, "%")} · rework ${fmtRate(c.rework_pct, "%")} · ${c.tickets} ticket(s) started here, ${c.accepted} accepted · first pass ${fmtRate(c.first_pass_pct, "%")} · attempts per accepted change ${fmtRate(c.attempts_per_accepted_change, "")} · cost per accepted change ${fmtRate(c.cost_per_accepted_change_usd, "$")}${c.cost_unknown_rows ? ` (${c.cost_unknown_rows} call(s) of unknown cost left out)` : ""} · escaped ${fmtRate(c.escaped_defect_pct, "%")} · tester false greens ${fmtRate(c.tester_false_greens, "")} · ${spend}`,
    );
  }
  lines.push(`  ${s.footnote}`);
  return lines.join("\n");
}

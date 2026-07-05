import type { ServerResponse } from "node:http";

import { readAuditTail } from "../../audit/auditTail.js";
import type { Dispatch } from "../../core.js";
import {
  aggregateCosts,
  readLedgerRows,
  resolveLedgerPath,
  todaySpend,
} from "../../cost/costAggregator.js";
import { deliveryFlow, type FlowTicket } from "../../health/deliveryFlow.js";
import { aggregateHealth, type ReworkResolver } from "../../health/healthAggregator.js";
import { aggregateSkillTelemetry } from "../../health/skillsTelemetryAggregator.js";
import { errorBody, methodNotAllowed, safeDecode, sendJson } from "../http.js";
import type { MemoryReader } from "../memoryReader.js";
import { buildRunDetail } from "../runDetail.js";
import { RUN_LOG_TAIL_BYTES, readLogTail } from "../static.js";
import { activityQuery, runsQuery } from "../schemas.js";

/** Default number of audit lines surfaced by GET /api/audit. */
const AUDIT_TAIL_DEFAULT = 50;

/**
 * Read-only "showcase" surfaces under /api: the kanban board, the factory
 * dashboard summary, the cross-ticket activity feed, and the optional tool-audit
 * tail. All GET-only — none of these mutate state.
 */
export function routeReadModels(
  wg: Dispatch,
  memoryReader: MemoryReader,
  method: string,
  segments: string[],
  url: URL,
  res: ServerResponse,
): void {
  // --- Memory product read surfaces (memory digest / features / lore) ----
  //
  // These read the SEPARATE memory store SERVER-SIDE (via the configured memory
  // CLI) so the SPA hits ONE origin. Every one degrades gracefully: when the
  // memory product is unavailable they answer 200 with `{ available:false,
  // reason }`, NEVER a 500 — an unconfigured/unbuilt memory store must never
  // break the dashboard.
  if (segments.length === 4 && segments[1] === "memory" && segments[2] === "digest") {
    if (method !== "GET") return methodNotAllowed(res);
    const repo = safeDecode(segments[3] as string);
    if (repo === null)
      return sendJson(res, 422, errorBody("VALIDATION_ERROR", "Malformed repo path segment."));
    sendJson(res, 200, memoryReader.digest(repo));
    return;
  }
  if (segments.length === 4 && segments[1] === "memory" && segments[2] === "features") {
    if (method !== "GET") return methodNotAllowed(res);
    const repo = safeDecode(segments[3] as string);
    if (repo === null)
      return sendJson(res, 422, errorBody("VALIDATION_ERROR", "Malformed repo path segment."));
    const status = url.searchParams.get("status") ?? undefined;
    const node = url.searchParams.get("node") ?? undefined;
    sendJson(
      res,
      200,
      memoryReader.features(repo, {
        ...(status !== undefined ? { status } : {}),
        ...(node !== undefined ? { node } : {}),
      }),
    );
    return;
  }
  if (segments.length === 3 && segments[1] === "memory" && segments[2] === "lore") {
    if (method !== "GET") return methodNotAllowed(res);
    sendJson(res, 200, memoryReader.lore());
    return;
  }

  // /api/board — tickets grouped into kanban columns (+ closed area).
  // Accepts optional ?repo= to restrict the board to one repository.
  if (segments.length === 2 && segments[1] === "board") {
    if (method !== "GET") return methodNotAllowed(res);
    const repoFilter = url.searchParams.get("repo") ?? undefined;
    sendJson(res, 200, wg.board(repoFilter));
    return;
  }

  // /api/dashboard — summary tiles for the factory activity dashboard.
  if (segments.length === 2 && segments[1] === "dashboard") {
    if (method !== "GET") return methodNotAllowed(res);
    sendJson(res, 200, { summary: wg.dashboard() });
    return;
  }

  // /api/human-queue — Track 2a "What I own": the HUMAN-owned queue (pending
  // decisions with reasons, review sign-offs, regulated ready-approvals/reviewer
  // assignments), each with what/which-ticket/why/how-long. Read-only.
  if (segments.length === 2 && segments[1] === "human-queue") {
    if (method !== "GET") return methodNotAllowed(res);
    sendJson(res, 200, wg.humanQueue());
    return;
  }

  // /api/activity?limit=&offset= — newest-first cross-ticket event feed.
  if (segments.length === 2 && segments[1] === "activity") {
    if (method !== "GET") return methodNotAllowed(res);
    const q = activityQuery.parse({
      limit: url.searchParams.get("limit") ?? undefined,
      offset: url.searchParams.get("offset") ?? undefined,
    });
    const page = wg.activity(q);
    sendJson(res, 200, {
      events: page.events,
      total: page.total,
      limit: q.limit,
      offset: q.offset,
    });
    return;
  }

  // FAILURE-DIAGNOSIS: GET /api/rework/bouncing?min=&limit= — the cross-ticket
  // "these keep bouncing" signal: tickets with a rework trail, ranked worst-first
  // (repeated same-gate failures lead). The operator's key quality signal.
  if (segments.length === 3 && segments[1] === "rework" && segments[2] === "bouncing") {
    if (method !== "GET") return methodNotAllowed(res);
    const parseCap = (raw: string | null, fallback: number): number => {
      if (raw === null) return fallback;
      const n = Number.parseInt(raw, 10);
      return Number.isInteger(n) && n > 0 ? n : fallback;
    };
    const bouncing = wg.bouncingTickets({
      minReworks: parseCap(url.searchParams.get("min"), 2),
      limit: parseCap(url.searchParams.get("limit"), 20),
    });
    sendJson(res, 200, { bouncing });
    return;
  }

  // /api/audit?limit= — optional redacted tool-audit tail (hidden when absent).
  if (segments.length === 2 && segments[1] === "audit") {
    if (method !== "GET") return methodNotAllowed(res);
    const raw = url.searchParams.get("limit");
    const parsed = raw === null ? AUDIT_TAIL_DEFAULT : Number.parseInt(raw, 10);
    const limit = Number.isInteger(parsed) && parsed > 0 ? parsed : AUDIT_TAIL_DEFAULT;
    sendJson(res, 200, readAuditTail(limit));
    return;
  }

  // RUN-ACTIVITY: GET /api/runs?active=1&limit=N — the in-flight + recent runs
  // that power the dashboard's "Running now" panel. Returns BOTH the active runs
  // and the most-recent finished runs so the panel renders in one fetch.
  if (segments.length === 2 && segments[1] === "runs") {
    if (method !== "GET") return methodNotAllowed(res);
    const q = runsQuery.parse({
      active: url.searchParams.get("active") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });
    // Active list is hard-capped (a wedged factory could leak many running rows);
    // surface truncation so the panel can show "showing N of many" rather than
    // silently dropping in-flight runs.
    const activeResult = wg.listRunsResult({ active: true });
    // The recent list is the most-recent N of any status; drop the still-running
    // ones so `recent` reads as the finished tail (active are shown separately).
    const recent = wg
      .listRuns({ limit: q.limit })
      .filter((r) => r.status !== "running")
      .slice(0, q.limit);
    sendJson(res, 200, {
      active: activeResult.runs,
      active_truncated: activeResult.truncated,
      recent,
    });
    return;
  }

  // GET /api/cost — factory-wide cost summary from the usage ledger.
  // Defensive: returns a zero-state envelope when the ledger is absent or
  // unreadable. Lists are capped so a large ledger never bloats the response.
  // Behind the same bearer gate as the rest of /api (checked in route()).
  if (segments.length === 2 && segments[1] === "cost") {
    if (method !== "GET") return methodNotAllowed(res);
    const TOP_N = 25;
    // Build a ticket-number→repo-name resolver from the dispatch state.
    const resolver = (ticketNumber: number): string | null => {
      try {
        const ticket = wg.tickets.findByNumber(ticketNumber);
        if (!ticket) return null;
        const links = wg.repos.accessLinksForTicket(ticket.id);
        return links[0]?.name ?? null;
      } catch {
        return null;
      }
    };
    const agg = aggregateCosts(process.env, resolver);
    // Compute today's spend separately for the dashboard tile.
    const ledgerPath = resolveLedgerPath(process.env);
    const rows = ledgerPath ? readLedgerRows(ledgerPath) : [];
    const today_usd = todaySpend(rows);
    sendJson(res, 200, {
      total_usd: agg.total_usd,
      today_usd,
      ticket_count: agg.ticket_count,
      last_record_at: agg.last_record_at,
      by_repo: agg.by_repo.slice(0, TOP_N),
      top_tickets: agg.by_ticket.slice(0, TOP_N),
    });
    return;
  }

  // GET /api/health — factory-health / ROI synthesis. Two authoritative reads in
  // one envelope, mirroring /api/cost's compose pattern:
  //   1. ledger ROI (aggregateHealth) — cost-per-shipped, spend-by-kind, token
  //      mix, measured-vs-unknown coverage, daily spend, cost-of-rework, latency;
  //   2. delivery flow (deliveryFlow) — the ONE server-side cycle-time/throughput
  //      definition the Overview now reads (was recomputed client-side).
  // Defensive: zero-state safe when the ledger is absent; lists capped so a large
  // ledger never bloats the response. Read-only, behind the same posture as /api.
  if (segments.length === 2 && segments[1] === "health") {
    if (method !== "GET") return methodNotAllowed(res);
    const TOP_N = 25;

    // Shipped divisor + ticket list for delivery flow come from one ticket read.
    const allTickets = wg.tickets.listFiltered({});
    const shippedCount = allTickets.filter((t) => t.status === "done").length;
    const flowTickets: FlowTicket[] = allTickets.map((t) => ({
      status: t.status,
      created_at: t.created_at,
      updated_at: t.updated_at,
    }));

    // Rework resolver: ticket-number → rework-attempt count, one grouped query.
    const reworkRows = wg.db
      .prepare(
        `SELECT t.number AS number, COUNT(*) AS c
           FROM rework_attempts ra
           JOIN tickets t ON t.id = ra.ticket_id
          WHERE t.number IS NOT NULL
          GROUP BY t.number`,
      )
      .all() as Array<{ number: number; c: number }>;
    const reworkByNumber = new Map(reworkRows.map((r) => [r.number, r.c]));
    const resolveRework: ReworkResolver = (n) => reworkByNumber.get(n) ?? 0;

    const health = aggregateHealth(process.env, { shippedCount, resolveRework });
    const flow = deliveryFlow(flowTickets, Date.parse(wg.clock.now()) || Date.now());

    // Two previously-DEAD data sources, surfaced best-effort (a missing source
    // degrades to a null/available:false cell, NEVER breaks the endpoint):
    //   - skills telemetry: selected-vs-applied skill hit-rate (JSONL, zero-state
    //     when the trail is absent);
    //   - recall effectiveness: served-knowledge → clean/rework outcome trend,
    //     read via Memory's own CLI (standalone product; unavailable when unwired).
    const skills = aggregateSkillTelemetry(process.env);
    const recallRead = memoryReader.recallEffectiveness();

    sendJson(res, 200, {
      total_usd: health.total_usd,
      ticket_count: health.ticket_count,
      shipped_count: health.shipped_count,
      cost_per_shipped_usd: health.cost_per_shipped_usd,
      coverage: health.coverage,
      by_kind: health.by_kind.slice(0, TOP_N),
      by_model: health.by_model.slice(0, TOP_N),
      daily_spend: health.daily_spend,
      rework: {
        total_rework_cost_usd: health.rework.total_rework_cost_usd,
        rework_cost_share_pct: health.rework.rework_cost_share_pct,
        by_ticket: health.rework.by_ticket.slice(0, TOP_N),
      },
      duration: health.duration,
      cycle_time: flow.cycle_time,
      throughput: flow.throughput,
      // Skill hit-rate (selected-vs-applied). Zero-state when no telemetry.
      skills: {
        total_records: skills.total_records,
        total_selected: skills.total_selected,
        total_applied: skills.total_applied,
        overall_hit_rate_pct: skills.overall_hit_rate_pct,
        by_skill: skills.by_skill.slice(0, TOP_N),
        last_record_at: skills.last_record_at,
      },
      // Recall-effectiveness trend. available:false when Memory isn't wired.
      recall: recallRead.available
        ? { available: true, ...recallRead.recall }
        : { available: false, reason: recallRead.reason },
      last_record_at: health.last_record_at,
    });
    return;
  }

  // GRADUATED-AUTONOMY (Spec 2, Phase 2): GET /api/autonomy/recommendations — the
  // read-only, advisory per-repo/per-risk/per-gate autonomy recommendations backed by
  // the review track record. Never enables anything (Phase 3 adds the enable action);
  // the Settings surface renders these as advisory text. Behind the same bearer gate
  // as the rest of /api (checked in route()).
  if (segments.length === 3 && segments[1] === "autonomy" && segments[2] === "recommendations") {
    if (method !== "GET") return methodNotAllowed(res);
    sendJson(res, 200, { recommendations: wg.autonomyRecommendationsList() });
    return;
  }

  // RUN-ACTIVITY: GET /api/runs/:id — enriched run detail (phase · model · turns
  // · cost · log tail · outcome) assembled from the run row + its log file +
  // the usage ledger. Zero-state safe: missing log or absent ledger returns
  // null/zero fields rather than a 5xx. 404 for unknown run ids.
  if (segments.length === 3 && segments[1] === "runs") {
    if (method !== "GET") return methodNotAllowed(res);
    const run = wg.runs.findById(segments[2] as string);
    if (!run) {
      sendJson(res, 404, errorBody("NOT_FOUND", "Run not found."));
      return;
    }
    // Read the byte-capped raw tail (same reader as the /log endpoint); the
    // detail builder then applies the line cap on top.
    const logText = run.log_path ? readLogTail(run.log_path, RUN_LOG_TAIL_BYTES) : null;
    const detail = buildRunDetail(run, logText, process.env);
    sendJson(res, 200, { detail });
    return;
  }

  // RUN-ACTIVITY: GET /api/runs/:id/log — the tail (last RUN_LOG_TAIL_BYTES) of a
  // run's captured output, as text/plain. 404 when the run or its log is missing.
  // Privileged read like the rest of /api (behind the bearer gate in route()).
  if (segments.length === 4 && segments[1] === "runs" && segments[3] === "log") {
    if (method !== "GET") return methodNotAllowed(res);
    const run = wg.runs.findById(segments[2] as string);
    if (!run || !run.log_path) {
      sendJson(res, 404, errorBody("NOT_FOUND", "No log for that run."));
      return;
    }
    const tail = readLogTail(run.log_path, RUN_LOG_TAIL_BYTES);
    if (tail === null) {
      sendJson(res, 404, errorBody("NOT_FOUND", "Run log file is missing."));
      return;
    }
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(tail);
    return;
  }

  sendJson(res, 404, errorBody("NOT_FOUND", `No route for ${method} ${url.pathname}.`));
}

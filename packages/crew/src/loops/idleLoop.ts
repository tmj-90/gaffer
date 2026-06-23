import { dateStamp } from "../util/clock.js";
import { findingKey, isBelowDeliveredThreshold } from "./idleScans.js";
import type { Clock } from "../util/clock.js";
import type { CommandRunner } from "../adapters/commandRunner.js";
import { resolveMinDeliveredTickets } from "../config/schema.js";
import type { CrewConfig, RepoConfig } from "../config/schema.js";
import type { EventLog } from "../events/eventLog.js";
import type { RepoRegistry } from "../registry/repoRegistry.js";
import type { SelfImproveGate } from "./selfImprove.js";
import type { DispatchClient } from "../dispatch/client.js";

export interface CoverageFinding {
  repoName: string;
  totalCoverage: number | null;
  lowFiles: Array<{ file: string; coverage: number }>;
  raw: string;
}

export interface IdleLoopDeps {
  config: CrewConfig;
  repoRegistry: RepoRegistry;
  dispatch: DispatchClient;
  runner: CommandRunner;
  events: EventLog;
  clock: Clock;
  /**
   * Optional self-improve gate. When present and enabled it may promote an idle
   * DRAFT ticket to `ready` (closing the loop). Absent in direct single-loop
   * tests and when the feature is off, leaving draft behaviour unchanged.
   */
  selfImprove?: SelfImproveGate;
}

export interface CoverageDraft {
  ticketId: string;
  number: number;
  repoName: string;
  finding: CoverageFinding;
}

export interface CoverageObservation {
  repoName: string;
  finding: CoverageFinding;
}

export type IdleLoopOutcome =
  | { status: "skipped_tickets_ready" }
  | { status: "no_repos" }
  | { status: "no_findings" }
  | { status: "draft_created"; drafts: CoverageDraft[] }
  | { status: "ready_created"; drafts: CoverageDraft[] }
  | { status: "observed"; observations: CoverageObservation[] };

/**
 * Parse coverage output minimally. Recognises a `TOTAL ... NN%` line (pytest /
 * coverage.py style) and `All files | NN` (nyc/istanbul style). Best-effort —
 * the goal is an evidence summary, not a precise report.
 */
export function parseCoverage(output: string): {
  total: number | null;
  lowFiles: Array<{ file: string; coverage: number }>;
} {
  let total: number | null = null;

  const totalMatch =
    output.match(/^TOTAL\s+.*?(\d{1,3})%/m) ??
    output.match(/All files\s*\|\s*(\d{1,3}(?:\.\d+)?)/m) ??
    output.match(/Total coverage:\s*(\d{1,3}(?:\.\d+)?)/im);
  if (totalMatch?.[1]) total = Number(totalMatch[1]);

  const lowFiles: Array<{ file: string; coverage: number }> = [];
  // coverage.py per-file rows: "path/to/file.py   120    30    75%"
  const fileRowRe = /^([\w./-]+\.\w+)\s+\d+\s+\d+\s+(\d{1,3})%/gm;
  let m: RegExpExecArray | null;
  while ((m = fileRowRe.exec(output)) !== null) {
    const file = m[1]!;
    const cov = Number(m[2]!);
    if (cov < 100) lowFiles.push({ file, coverage: cov });
  }
  lowFiles.sort((a, b) => a.coverage - b.coverage);
  return { total, lowFiles };
}

function evidenceSummary(finding: CoverageFinding, threshold: number): string {
  const head =
    finding.totalCoverage !== null
      ? `Coverage for ${finding.repoName} is ${finding.totalCoverage}%`
      : `Coverage scan for ${finding.repoName} completed`;
  const worst = finding.lowFiles
    .slice(0, 5)
    .map((f) => `  - ${f.file}: ${f.coverage}%`)
    .join("\n");
  const gap =
    finding.totalCoverage !== null
      ? ` (below the ${threshold}% target by ${Math.max(0, threshold - finding.totalCoverage)} points).`
      : ".";
  return `${head}${gap}${worst ? `\nLowest-covered files:\n${worst}` : ""}`;
}

/**
 * One tick of the idle coverage loop. Only runs when Dispatch has no ready
 * tickets. For each configured repo with a coverage command, it runs the
 * command, parses output, and creates a DRAFT Dispatch ticket with an evidence
 * summary. It never edits code.
 */
export function runIdleCoverageLoop(deps: IdleLoopDeps): IdleLoopOutcome {
  const { events } = deps;
  events.record("loop_started", { loop: "idle_coverage" });

  if (deps.dispatch.listReady().length > 0) {
    events.record("loop_finished", { loop: "idle_coverage", result: "skipped_tickets_ready" });
    return { status: "skipped_tickets_ready" };
  }

  const configuredRepoNames = deps.config.loops.idle_coverage.repos;
  const minDelivered = resolveMinDeliveredTickets(
    deps.config.loops,
    deps.config.loops.idle_coverage.min_delivered_tickets,
  );
  const candidates: RepoConfig[] = deps.repoRegistry
    .list()
    .filter(
      (r) =>
        (configuredRepoNames.length === 0 || configuredRepoNames.includes(r.name)) &&
        r.coverage_command,
    )
    .filter((r) => !isBelowDeliveredThreshold(deps, "coverage", r, minDelivered));

  if (candidates.length === 0) {
    events.record("loop_finished", { loop: "idle_coverage", result: "no_repos" });
    return { status: "no_repos" };
  }

  const { minimum_gap_threshold: threshold, mode } = deps.config.loops.idle_coverage;
  const drafts: CoverageDraft[] = [];
  const observations: CoverageObservation[] = [];
  let readyCount = 0;

  for (const repo of candidates) {
    const cwd = deps.repoRegistry.absolutePath(repo);
    const result = deps.runner.run(repo.coverage_command!, cwd);
    const parsed = parseCoverage(result.stdout);
    const finding: CoverageFinding = {
      repoName: repo.name,
      totalCoverage: parsed.total,
      lowFiles: parsed.lowFiles,
      raw: result.stdout,
    };
    events.record("coverage_scanned", {
      repoName: repo.name,
      total: parsed.total,
      lowFileCount: parsed.lowFiles.length,
    });

    const summary = evidenceSummary(finding, threshold);

    if (mode === "observe_only") {
      events.record("idle_finding_observed", {
        loop: "idle_coverage",
        repoName: repo.name,
        summary,
      });
      observations.push({ repoName: repo.name, finding });
      continue;
    }

    // Dedup: one open coverage draft per repo. The key is stable (no date
    // stamp) so a later tick re-maps to the existing draft instead of spamming.
    const key = findingKey("coverage", repo.name);
    const existing = deps.dispatch.findOpenTicketByFindingKey(key);
    if (existing) {
      events.record("idle_finding_deduped", {
        loop: "idle_coverage",
        repoName: repo.name,
        findingKey: key,
        ticketId: existing.ticketId,
      });
      continue;
    }

    const created = deps.dispatch.createDraftTicket({
      title: `Coverage gap: ${repo.name} (${dateStamp(deps.clock)})`,
      description:
        `Idle coverage scan found gaps in ${repo.name}. This is an observation-only finding — ` +
        `no code was changed.\n\n${summary}`,
      repoName: repo.name,
      evidenceSummary: summary,
      findingKey: key,
      policyPack: deps.config.dispatch.default_policy_pack,
    });
    events.record("idle_ticket_created", {
      ticketId: created.ticketId,
      number: created.number,
      repoName: repo.name,
    });
    // Promote to ready either because this loop is explicitly in
    // `create_ready_tickets` mode, or because the self-improve gate elects to
    // close the loop for this (opted-in, low-risk, under-cap) repo.
    const promote =
      mode === "create_ready_tickets" ||
      (mode === "create_draft_tickets" && (deps.selfImprove?.tryPromote(repo) ?? false));
    if (promote) {
      deps.dispatch.markTicketReady(created.ticketId);
      readyCount += 1;
      events.record("idle_ticket_marked_ready", {
        ticketId: created.ticketId,
        number: created.number,
        repoName: repo.name,
        via: mode === "create_ready_tickets" ? "mode" : "self_improve",
      });
    }
    drafts.push({
      ticketId: created.ticketId,
      number: created.number,
      repoName: repo.name,
      finding,
    });
  }

  if (mode === "observe_only") {
    events.record("loop_finished", {
      loop: "idle_coverage",
      result: "observed",
      count: observations.length,
    });
    return { status: "observed", observations };
  }
  // Every finding may have deduped against an existing open draft; report
  // no_findings rather than a draft_created with an empty list.
  if (drafts.length === 0) {
    events.record("loop_finished", { loop: "idle_coverage", result: "no_findings" });
    return { status: "no_findings" };
  }
  const status = readyCount === drafts.length ? "ready_created" : "draft_created";
  events.record("loop_finished", { loop: "idle_coverage", result: status, drafts: drafts.length });
  return { status, drafts };
}

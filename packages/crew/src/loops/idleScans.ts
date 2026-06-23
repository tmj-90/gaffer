import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { dateStamp } from "../util/clock.js";
import type { IdleLoopDeps } from "./idleLoop.js";
import type { IdleLoopMode, RepoConfig } from "../config/schema.js";

/**
 * A stable de-dup key for an idle finding: `loop:repo:signature`. It MUST be
 * stable across ticks (no date stamp) so the same finding re-discovered on a
 * later tick maps to the same open draft. Most scan loops are one-finding-per-
 * repo, so the loop+repo pair is the signature; callers with finer-grained
 * findings (e.g. lore-gap) pass an explicit signature.
 */
export function findingKey(loop: string, repoName: string, signature?: string): string {
  return signature ? `${loop}:${repoName}:${signature}` : `${loop}:${repoName}`;
}

/**
 * Shared shapes + helpers for the idle scan loops. None of these ever edit code;
 * what they do with a finding is controlled by the per-loop {@link IdleLoopMode}:
 *
 *  - `observe_only` — record the finding as a runtime event, create nothing.
 *  - `create_draft_tickets` — create a DRAFT Dispatch ticket (the default).
 *  - `create_ready_tickets` — create the ticket AND mark it ready.
 *
 * They parse real command/scan output minimally into an evidence summary.
 */

export interface ScanDraft {
  ticketId: string;
  number: number;
  repoName: string;
  summary: string;
}

export interface ScanObservation {
  repoName: string;
  summary: string;
}

export type IdleScanOutcome =
  | { status: "skipped_tickets_ready" }
  | { status: "no_repos" }
  | { status: "no_findings" }
  | { status: "draft_created"; drafts: ScanDraft[] }
  | { status: "ready_created"; drafts: ScanDraft[] }
  | { status: "observed"; observations: ScanObservation[] };

/**
 * Per-repo delivered-ticket gate. A scan loop must SKIP a repo whose count of
 * DELIVERED (`done`) tickets is below `minDelivered`. New/young repos don't earn
 * tech-debt/security scans until they've shipped real work. Returns true (skip)
 * and records a `loop_finished` `skipped_below_threshold` event when under; the
 * threshold of 0 (the default) is a no-op so behaviour is unchanged unless set.
 */
export function isBelowDeliveredThreshold(
  deps: IdleLoopDeps,
  loop: string,
  repo: RepoConfig,
  minDelivered: number,
): boolean {
  if (minDelivered <= 0) return false;
  const delivered = deps.dispatch.countDeliveredTickets(repo.name);
  if (delivered >= minDelivered) return false;
  deps.events.record("loop_finished", {
    loop,
    result: "skipped_below_threshold",
    repoName: repo.name,
    delivered,
    minDelivered,
  });
  return true;
}

/**
 * Repos in scope for an idle scan: the configured allow-list (empty = all),
 * minus any repo below the loop's delivered-ticket threshold. Skipped repos are
 * recorded via {@link isBelowDeliveredThreshold} so the runtime log shows why a
 * young repo was passed over.
 */
export function repoCandidates(
  deps: IdleLoopDeps,
  allow: readonly string[],
  gate?: { loop: string; minDelivered: number },
): RepoConfig[] {
  return deps.repoRegistry
    .list()
    .filter((r) => allow.length === 0 || allow.includes(r.name))
    .filter((r) => !gate || !isBelowDeliveredThreshold(deps, gate.loop, r, gate.minDelivered));
}

/**
 * Apply a finding according to the loop's {@link IdleLoopMode}. Returns a
 * discriminated result so callers can aggregate drafts and observations
 * separately. Never edits code regardless of mode.
 */
export function applyScanFinding(
  deps: IdleLoopDeps,
  loop: string,
  mode: IdleLoopMode,
  repo: RepoConfig,
  title: string,
  summary: string,
  signature?: string,
):
  | { kind: "observed"; observation: ScanObservation }
  | { kind: "draft" | "ready"; draft: ScanDraft }
  | { kind: "deduped" } {
  if (mode === "observe_only") {
    deps.events.record("idle_finding_observed", { loop, repoName: repo.name, summary });
    return { kind: "observed", observation: { repoName: repo.name, summary } };
  }

  // Dedup against an already-open draft for this exact finding so repeated idle
  // ticks don't spam a fresh draft each time. The key is stable (loop+repo+sig),
  // NOT date-stamped, so the same finding re-maps to the same open ticket.
  const key = findingKey(loop, repo.name, signature);
  const existing = deps.dispatch.findOpenTicketByFindingKey(key);
  if (existing) {
    deps.events.record("idle_finding_deduped", {
      loop,
      repoName: repo.name,
      findingKey: key,
      ticketId: existing.ticketId,
    });
    return { kind: "deduped" };
  }

  const created = deps.dispatch.createDraftTicket({
    title: `${title} (${dateStamp(deps.clock)})`,
    description:
      `Idle ${loop} scan flagged ${repo.name}. This is an observation-only finding — ` +
      `no code was changed.\n\n${summary}`,
    repoName: repo.name,
    evidenceSummary: summary,
    findingKey: key,
    policyPack: deps.config.dispatch.default_policy_pack,
  });
  deps.events.record("idle_ticket_created", {
    loop,
    ticketId: created.ticketId,
    number: created.number,
    repoName: repo.name,
  });

  const draft: ScanDraft = {
    ticketId: created.ticketId,
    number: created.number,
    repoName: repo.name,
    summary,
  };

  // Promote to ready either because this loop is explicitly in
  // `create_ready_tickets` mode, or because the self-improve gate elects to
  // close the loop for this (opted-in, low-risk, under-cap) repo.
  const promote =
    mode === "create_ready_tickets" ||
    (mode === "create_draft_tickets" && (deps.selfImprove?.tryPromote(repo) ?? false));
  if (promote) {
    deps.dispatch.markTicketReady(created.ticketId);
    deps.events.record("idle_ticket_marked_ready", {
      loop,
      ticketId: created.ticketId,
      number: created.number,
      repoName: repo.name,
      via: mode === "create_ready_tickets" ? "mode" : "self_improve",
    });
    return { kind: "ready", draft };
  }
  return { kind: "draft", draft };
}

/**
 * Build the terminal {@link IdleScanOutcome} from the per-finding results a loop
 * collected, and record the matching `loop_finished` event. Keeps the
 * mode-to-outcome mapping in one place so every scan loop behaves identically.
 *
 * In `observe_only` mode the queue-skip guard never fires (it only checks for
 * ready tickets, and observe_only creates none), so a scan that found nothing
 * still reports `no_findings`.
 */
export function finalizeScan(
  deps: IdleLoopDeps,
  loop: string,
  results: Array<ReturnType<typeof applyScanFinding>>,
): IdleScanOutcome {
  // Deduped findings produced no new ticket; drop them before deciding the
  // outcome so a tick that only re-found existing drafts reports no_findings
  // rather than spuriously claiming a draft was created.
  const live = results.filter((r) => r.kind !== "deduped");
  if (live.length === 0) {
    deps.events.record("loop_finished", { loop, result: "no_findings" });
    return { status: "no_findings" };
  }

  const observations = live
    .filter((r): r is { kind: "observed"; observation: ScanObservation } => r.kind === "observed")
    .map((r) => r.observation);
  if (observations.length === live.length) {
    deps.events.record("loop_finished", { loop, result: "observed", count: observations.length });
    return { status: "observed", observations };
  }

  const drafts = live
    .filter(
      (r): r is { kind: "draft" | "ready"; draft: ScanDraft } =>
        r.kind === "draft" || r.kind === "ready",
    )
    .map((r) => r.draft);
  const allReady = live.every((r) => r.kind === "ready");
  const status = allReady ? "ready_created" : "draft_created";
  deps.events.record("loop_finished", { loop, result: status, drafts: drafts.length });
  return { status, drafts };
}

/** Guard shared by every scan loop: only run when the queue is empty. */
export function shouldSkipForReadyTickets(deps: IdleLoopDeps, loop: string): boolean {
  if (deps.dispatch.listReady().length > 0) {
    deps.events.record("loop_finished", { loop, result: "skipped_tickets_ready" });
    return true;
  }
  return false;
}

// ── File walking (small, dependency-free) ──────────────────────────────────

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next"]);
const MAX_FILES = 5000;

/** Recursively list files under `root` whose name matches `match`, bounded. */
export function walkFiles(root: string, match: (name: string) => boolean): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  const stack: string[] = [root];
  while (stack.length > 0 && out.length < MAX_FILES) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let s;
      try {
        s = statSync(full);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        if (!IGNORED_DIRS.has(entry)) stack.push(full);
      } else if (s.isFile() && match(entry)) {
        out.push(full);
      }
    }
  }
  return out;
}

/** Read a file as UTF-8, returning empty string on any error. */
export function safeRead(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/i;

export function isTestFile(name: string): boolean {
  return TEST_FILE_RE.test(name);
}

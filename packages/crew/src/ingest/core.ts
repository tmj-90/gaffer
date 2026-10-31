import type { CommandRunner } from "../adapters/commandRunner.js";
import type { CrewConfig } from "../config/schema.js";
import type { EventLog } from "../events/eventLog.js";
import type { RepoRegistry } from "../registry/repoRegistry.js";
import type { DispatchClient } from "../dispatch/client.js";

/**
 * Shared core for every ingest adapter (GitHub, Jira, …). Adapters differ only
 * in HOW they list labelled issues from their source; once an issue is
 * normalised they all create Dispatch drafts through the SAME dedup contract:
 *
 *   identity = the issue's source URL, recorded into the draft description as a
 *   `Source: <url>` marker and looked up via {@link DispatchClient.findTicketBySource}.
 *
 * This makes ingest idempotent independent of any source-side side effect
 * (relabelling, status change): re-running ingest finds the existing ticket by
 * source URL and skips creation instead of duplicating it.
 */

export interface IngestDeps {
  config: CrewConfig;
  repoRegistry: RepoRegistry;
  dispatch: DispatchClient;
  runner: CommandRunner;
  events: EventLog;
}

export interface IngestedIssue {
  repo: string;
  issue: string;
  ticketId: string;
  number: number;
}

export interface IngestError {
  repo: string;
  message: string;
}

export interface IngestSummary {
  ingested: IngestedIssue[];
  /** Sources skipped (e.g. a repo with no GitHub remote). */
  skipped: number;
  /** Issues skipped because a ticket already exists for their source URL. */
  deduped: number;
  errors: IngestError[];
}

/** A source issue normalised to the fields ingest needs, source-agnostic. */
export interface NormalizedIssue {
  number: number;
  title: string;
  body: string | null;
  /** Stable, unique source URL — the dedup identity and `Source:` marker. */
  url: string;
  /** The issue's labels at ingest time, shown on the draft (empty/absent = none). */
  labels?: readonly string[];
}

export interface IngestResult {
  ticketId: string;
  /** True when an existing ticket already covered this issue's source URL. */
  deduped: boolean;
}

/**
 * The shared ingest dedup contract. If a ticket already exists for the issue's
 * source URL it is returned untouched (`deduped: true`); otherwise a DRAFT is
 * created carrying the `Source: <url>` marker (`deduped: false`).
 */
export function ingestIssueAsDraft(
  dispatch: DispatchClient,
  issue: NormalizedIssue,
  opts: { repoName?: string | undefined; evidenceSummary: string; policyPack?: string | undefined },
): IngestResult {
  const existing = dispatch.findTicketBySource(issue.url);
  if (existing) return { ticketId: existing.ticketId, deduped: true };

  // The labels a teammate triaged the issue with (bug, enhancement, …) travel with the
  // draft so whoever promotes it sees them; the Source marker stays the last line.
  const labels = (issue.labels ?? []).filter(Boolean);
  const labelLine = labels.length ? `\n\nLabels: ${labels.join(", ")}` : "";
  const description = `${issue.body ?? ""}${labelLine}\n\nSource: ${issue.url}`;
  const created = dispatch.createDraftTicket({
    title: issue.title,
    description,
    evidenceSummary: opts.evidenceSummary,
    ...(opts.repoName !== undefined ? { repoName: opts.repoName } : {}),
    ...(opts.policyPack !== undefined ? { policyPack: opts.policyPack } : {}),
  });
  return { ticketId: created.ticketId, deduped: false };
}

/** Quote a CLI argument for safe interpolation into a single shell command. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

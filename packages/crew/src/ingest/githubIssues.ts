import { z } from "zod";

import { CrewError } from "../util/errors.js";
import { ingestIssueAsDraft, shellQuote } from "./core.js";
import type { RepoConfig } from "../config/schema.js";
import type { IngestDeps, IngestSummary, IngestedIssue, IngestError } from "./core.js";

// Re-export the shared ingest types so existing importers (and the public index)
// keep resolving them from this module.
export type { IngestDeps, IngestSummary, IngestedIssue, IngestError } from "./core.js";

/**
 * GitHub-issue ingest: the on-ramp so teammates don't write Dispatch tickets by
 * hand. A teammate labels a GitHub issue with the configured `label`; Crew
 * pulls it into Dispatch as a DRAFT ticket and relabels the issue to
 * `ingested_label`.
 *
 * Dedup is identity-based, not relabel-based, and shared with every other ingest
 * adapter via {@link ingestIssueAsDraft}: before creating a ticket we ask
 * Dispatch whether one already exists for that issue's source URL
 * (`findTicketBySource`, matching the `Source: <url>` marker). This is the source
 * of truth. If a ticket was created but the subsequent relabel failed (issue
 * still carries the trigger label), the next run still finds the existing ticket
 * and skips creation instead of duplicating it. Relabelling remains a
 * convenience (it stops the issue appearing in the list at all) but is no longer
 * relied on for correctness.
 *
 * All `gh` invocations go through an injected {@link CommandRunner}, never direct
 * exec, so tests inject a fake runner and no real `gh` or network is used.
 */

/** Schema for a single `gh issue list --json number,title,body,url` row. */
const ghIssueSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  body: z.string().nullable().default(""),
  url: z.string(),
});

const ghIssueListSchema = z.array(ghIssueSchema);

export type GithubIssue = z.infer<typeof ghIssueSchema>;

/**
 * Parse an `owner/repo` slug from a github.com remote URL (ssh or https). Returns
 * undefined for non-GitHub or unparseable remotes so the caller can skip them.
 *
 * Handles, e.g.:
 *   - git@github.com:owner/repo.git
 *   - ssh://git@github.com/owner/repo.git
 *   - https://github.com/owner/repo.git
 *   - https://github.com/owner/repo
 */
export function parseGithubSlug(remoteUrl: string | null): string | undefined {
  if (!remoteUrl) return undefined;
  const trimmed = remoteUrl.trim();
  // scp-like ssh form: git@github.com:owner/repo(.git)
  const scp = trimmed.match(/^[^@]+@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
  if (scp?.[1] && scp[2]) return `${scp[1]}/${scp[2]}`;
  // url form: (https|ssh)://[user@]github.com/owner/repo(.git)
  const url = trimmed.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (url?.[1] && url[2]) return `${url[1]}/${url[2]}`;
  return undefined;
}

/** Repos in scope: the configured allow-list (omitted/empty = all repos). */
function repoCandidates(deps: IngestDeps, allow: readonly string[] | undefined): RepoConfig[] {
  return deps.repoRegistry
    .list()
    .filter((r) => allow === undefined || allow.length === 0 || allow.includes(r.name));
}

function parseIssueList(stdout: string, slug: string): GithubIssue[] {
  let json: unknown;
  try {
    json = JSON.parse(stdout || "[]");
  } catch {
    throw new CrewError(
      "INGEST_PARSE_FAILED",
      `Could not parse 'gh issue list' output for ${slug}.`,
      {
        slug,
      },
    );
  }
  const parsed = ghIssueListSchema.safeParse(json);
  if (!parsed.success) {
    throw new CrewError("INGEST_PARSE_FAILED", `Unexpected 'gh issue list' shape for ${slug}.`, {
      slug,
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

/**
 * Run one ingest pass over every configured repo with a GitHub remote. A `gh`
 * failure for one repo is collected as an error and does not abort the rest.
 */
export function ingestGithubIssues(deps: IngestDeps): IngestSummary {
  const { events } = deps;
  const cfg = deps.config.ingest.github;
  events.record("ingest_started", { label: cfg.label, ingestedLabel: cfg.ingested_label });

  const ingested: IngestedIssue[] = [];
  const errors: IngestError[] = [];
  let skipped = 0;
  let deduped = 0;

  for (const repo of repoCandidates(deps, cfg.repos)) {
    const slug = parseGithubSlug(repo.remote_url);
    if (!slug) {
      skipped += 1;
      events.record("ingest_repo_skipped", { repoName: repo.name, reason: "no_github_remote" });
      continue;
    }

    try {
      const listCommand =
        `gh issue list --repo ${shellQuote(slug)} --label ${shellQuote(cfg.label)} ` +
        `--state open --json number,title,body,url`;
      const listResult = deps.runner.run(listCommand, deps.repoRegistry.absolutePath(repo));
      if (listResult.exitCode !== 0) {
        throw new CrewError("INGEST_GH_FAILED", `'gh issue list' failed for ${slug}.`, {
          slug,
          exitCode: listResult.exitCode,
          output: listResult.stdout,
        });
      }

      const issues = parseIssueList(listResult.stdout, slug);
      events.record("ingest_repo_listed", { repoName: repo.name, slug, count: issues.length });

      for (const issue of issues) {
        // Identity-based dedup via the shared contract: if a ticket already
        // exists for this issue's URL, skip creation. This makes ingest
        // idempotent even when a prior run created the ticket but failed to
        // relabel the issue.
        const result = ingestIssueAsDraft(deps.dispatch, issue, {
          repoName: repo.name,
          evidenceSummary: `Ingested from GitHub issue #${issue.number} (${issue.url})`,
          policyPack: deps.config.dispatch.default_policy_pack,
        });
        if (result.deduped) {
          deduped += 1;
          events.record("ingest_issue_deduped", {
            repoName: repo.name,
            number: issue.number,
            ticketId: result.ticketId,
          });
          continue;
        }

        // Relabel so the next run's open+label filter no longer matches: this is
        // a convenience on top of identity-based dedup.
        const editCommand =
          `gh issue edit ${issue.number} --repo ${shellQuote(slug)} ` +
          `--remove-label ${shellQuote(cfg.label)} --add-label ${shellQuote(cfg.ingested_label)}`;
        const editResult = deps.runner.run(editCommand, deps.repoRegistry.absolutePath(repo));
        if (editResult.exitCode !== 0) {
          throw new CrewError(
            "INGEST_RELABEL_FAILED",
            `Failed to relabel issue #${issue.number} on ${slug}.`,
            {
              slug,
              number: issue.number,
              exitCode: editResult.exitCode,
              output: editResult.stdout,
            },
          );
        }

        ingested.push({
          repo: repo.name,
          issue: issue.url,
          ticketId: result.ticketId,
          number: issue.number,
        });
        events.record("ingest_issue_ingested", {
          repoName: repo.name,
          number: issue.number,
          ticketId: result.ticketId,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ repo: repo.name, message });
      events.record("ingest_repo_error", { repoName: repo.name, message });
    }
  }

  events.record("ingest_finished", {
    ingested: ingested.length,
    skipped,
    deduped,
    errors: errors.length,
  });
  return { ingested, skipped, deduped, errors };
}

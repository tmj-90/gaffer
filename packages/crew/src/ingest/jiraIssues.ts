import { z } from "zod";

import { CrewError } from "../util/errors.js";
import { ingestIssueAsDraft, shellQuote, type IngestDeps, type IngestSummary } from "./core.js";
import type { NormalizedIssue } from "./core.js";

/**
 * Jira-issue ingest: the Jira sibling of the GitHub on-ramp, for teams whose
 * backlog lives in Jira. A teammate labels a Jira issue with the configured
 * `label`; Crew pulls it into Dispatch as a DRAFT ticket.
 *
 * It shares the GitHub adapter's dedup contract exactly — every issue is created
 * through {@link ingestIssueAsDraft}, which dedupes on the issue's source URL
 * (the Jira `self` REST URL) via `Source: <url>`. Re-running ingest therefore
 * finds the existing ticket and skips it; no Jira-side relabelling is needed for
 * correctness.
 *
 * Issues are listed through the injected {@link CommandRunner} running the `jira`
 * CLI with `--raw`, so it emits the Jira REST search shape and tests inject a
 * fake runner — no real `jira` or network is used.
 */

/** A single issue row from the Jira REST search shape (`jira issue list --raw`). */
const jiraIssueSchema = z.object({
  key: z.string(),
  /** Stable per-issue REST URL — used as the dedup identity. */
  self: z.string(),
  fields: z.object({
    summary: z.string(),
    // Jira Cloud returns an ADF object here; coerce anything non-string to null.
    description: z.string().nullable().catch(null),
  }),
});

const jiraSearchSchema = z.object({ issues: z.array(jiraIssueSchema).default([]) });

export type JiraIssue = z.infer<typeof jiraIssueSchema>;

/** The trailing integer of a Jira key (`PROJ-42` → 42), 0 when not numeric. */
function keyNumber(key: string): number {
  const n = Number(key.split("-").pop());
  return Number.isFinite(n) ? n : 0;
}

function parseSearch(stdout: string): JiraIssue[] {
  let json: unknown;
  try {
    json = JSON.parse(stdout || "{}");
  } catch {
    throw new CrewError("INGEST_PARSE_FAILED", "Could not parse 'jira issue list' output.");
  }
  const parsed = jiraSearchSchema.safeParse(json);
  if (!parsed.success) {
    throw new CrewError("INGEST_PARSE_FAILED", "Unexpected 'jira issue list' shape.", {
      issues: parsed.error.issues,
    });
  }
  return parsed.data.issues;
}

/**
 * Run one ingest pass over labelled Jira issues. A single `jira` invocation lists
 * the issues (Jira is project-, not repo-scoped); each becomes a Dispatch draft
 * via the shared dedup contract. Drafts attach to `cfg.repo` when configured.
 */
export function ingestJiraIssues(deps: IngestDeps): IngestSummary {
  const { events } = deps;
  const cfg = deps.config.ingest.jira;
  events.record("ingest_started", { source: "jira", label: cfg.label });

  const ingested: IngestSummary["ingested"] = [];
  const errors: IngestSummary["errors"] = [];
  let deduped = 0;

  // Jira CLI runs against its own host config; cwd only anchors the process, so
  // use the configured repo's checkout when known, else the current directory.
  const repo = cfg.repo ? deps.repoRegistry.find(cfg.repo) : undefined;
  const cwd = repo ? deps.repoRegistry.absolutePath(repo) : ".";
  const repoName = repo?.name;

  try {
    const jql = cfg.jql ?? `labels = ${JSON.stringify(cfg.label)}`;
    const listCommand = `jira issue list -q ${shellQuote(jql)} --raw`;
    const listResult = deps.runner.run(listCommand, cwd);
    if (listResult.exitCode !== 0) {
      throw new CrewError("INGEST_JIRA_FAILED", "'jira issue list' failed.", {
        exitCode: listResult.exitCode,
        output: listResult.stdout,
      });
    }

    const issues = parseSearch(listResult.stdout);
    events.record("ingest_repo_listed", { source: "jira", count: issues.length });

    for (const issue of issues) {
      const normalized: NormalizedIssue = {
        number: keyNumber(issue.key),
        title: issue.fields.summary,
        body: issue.fields.description ?? "",
        url: issue.self,
      };
      const result = ingestIssueAsDraft(deps.dispatch, normalized, {
        repoName,
        evidenceSummary: `Ingested from Jira issue ${issue.key} (${issue.self})`,
        policyPack: deps.config.dispatch.default_policy_pack,
      });
      if (result.deduped) {
        deduped += 1;
        events.record("ingest_issue_deduped", {
          source: "jira",
          key: issue.key,
          ticketId: result.ticketId,
        });
        continue;
      }
      ingested.push({
        repo: repoName ?? "",
        issue: issue.self,
        ticketId: result.ticketId,
        number: normalized.number,
      });
      events.record("ingest_issue_ingested", {
        source: "jira",
        key: issue.key,
        ticketId: result.ticketId,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push({ repo: repoName ?? "jira", message });
    events.record("ingest_repo_error", { source: "jira", message });
  }

  events.record("ingest_finished", {
    source: "jira",
    ingested: ingested.length,
    deduped,
    errors: errors.length,
  });
  return { ingested, skipped: 0, deduped, errors };
}

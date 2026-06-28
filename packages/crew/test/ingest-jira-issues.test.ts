import { describe, expect, it } from "vitest";

import {
  EventLog,
  FakeDispatchClient,
  RepoRegistry,
  TestClock,
  crewConfigSchema,
  ingestJiraIssues,
  type CommandResult,
  type CommandRunner,
  type CrewConfig,
  type IngestDeps,
} from "../src/index.js";

/** Scripted runner: returns a canned result per matched command. No real `jira`. */
class ScriptedRunner implements CommandRunner {
  readonly calls: Array<{ command: string; cwd: string }> = [];
  constructor(private readonly responder: (command: string) => CommandResult) {}
  run(command: string, cwd: string): CommandResult {
    this.calls.push({ command, cwd });
    return this.responder(command);
  }
  runArgs(file: string, args: readonly string[], cwd: string): CommandResult {
    const command = [file, ...args].join(" ");
    this.calls.push({ command, cwd });
    return this.responder(command);
  }
}

function ok(stdout: string): CommandResult {
  return { stdout, exitCode: 0 };
}

function search(issues: unknown[]): string {
  return JSON.stringify({ issues });
}

const jiraIssue = (key: string, summary: string, description: string | null) => ({
  key,
  self: `https://acme.atlassian.net/rest/api/2/issue/${key}`,
  fields: { summary, description },
});

function makeConfig(jira: Record<string, unknown>): CrewConfig {
  return crewConfigSchema.parse({
    factory: { name: "test-factory", mode: "local_strict" },
    repos: [{ id: "web-app", name: "web-app", path: "/tmp/web-app", remote_url: null }],
    ingest: { jira: { enabled: true, label: "agent-ok", ...jira } },
  });
}

function makeDeps(
  config: CrewConfig,
  runner: CommandRunner,
): { deps: IngestDeps; dispatch: FakeDispatchClient; events: EventLog } {
  const dispatch = new FakeDispatchClient();
  const events = new EventLog(new TestClock());
  const repoRegistry = RepoRegistry.fromConfig(config, "/tmp");
  return { deps: { config, repoRegistry, dispatch, runner, events }, dispatch, events };
}

describe("ingestJiraIssues", () => {
  it("creates a draft ticket per labelled issue", () => {
    const issues = [
      jiraIssue("PROJ-7", "Add login throttling", "Brute-force protection."),
      jiraIssue("PROJ-9", "Dark mode toggle", "User-requested."),
    ];
    const runner = new ScriptedRunner((command) =>
      command.includes("issue list") ? ok(search(issues)) : ok(""),
    );
    const { deps, dispatch, events } = makeDeps(makeConfig({ repo: "web-app" }), runner);

    const summary = ingestJiraIssues(deps);

    expect(summary.ingested).toHaveLength(2);
    expect(summary.deduped).toBe(0);
    expect(summary.errors).toEqual([]);

    expect(dispatch.events.filter((e) => e.type === "draft_ticket.created")).toHaveLength(2);
    const ticket = dispatch.getTicket(summary.ingested[0]!.ticketId);
    expect(ticket.ticket.title).toBe("Add login throttling");
    expect(ticket.ticket.description).toContain("Brute-force protection.");
    expect(ticket.ticket.description).toContain(
      "Source: https://acme.atlassian.net/rest/api/2/issue/PROJ-7",
    );
    // Drafts attach to the configured repo.
    expect(ticket.repositories[0]?.name).toBe("web-app");

    // The list command scopes by the configured label and requests raw JSON.
    const listCall = runner.calls.find((c) => c.command.includes("issue list"))!;
    expect(listCall.command).toContain('labels = "agent-ok"');
    expect(listCall.command).toContain("--raw");
    expect(events.types()).toContain("ingest_issue_ingested");
  });

  it("shares the github dedup contract: a re-run dedups by source URL", () => {
    const issues = [jiraIssue("PROJ-42", "Idempotent please", "Body.")];
    const runner = new ScriptedRunner((command) =>
      command.includes("issue list") ? ok(search(issues)) : ok(""),
    );
    const { deps, dispatch } = makeDeps(makeConfig({}), runner);

    const first = ingestJiraIssues(deps);
    expect(first.ingested).toHaveLength(1);
    expect(first.deduped).toBe(0);

    // Identity is the issue's self URL, the same Source: marker the github
    // adapter writes — so findTicketBySource resolves it on the next run.
    const sourceUrl = "https://acme.atlassian.net/rest/api/2/issue/PROJ-42";
    expect(dispatch.findTicketBySource(sourceUrl)?.ticketId).toBe(first.ingested[0]!.ticketId);

    const second = ingestJiraIssues(deps);
    expect(second.ingested).toHaveLength(0);
    expect(second.deduped).toBe(1);
    expect(dispatch.events.filter((e) => e.type === "draft_ticket.created")).toHaveLength(1);
    expect(deps.events.types()).toContain("ingest_issue_deduped");
  });

  it("uses a custom JQL override when configured", () => {
    const runner = new ScriptedRunner(() => ok(search([])));
    const { deps } = makeDeps(makeConfig({ jql: "project = OPS AND labels = ready" }), runner);

    ingestJiraIssues(deps);

    const listCall = runner.calls.find((c) => c.command.includes("issue list"))!;
    expect(listCall.command).toContain("project = OPS AND labels = ready");
  });

  it("records an error and creates nothing when the jira CLI fails", () => {
    const runner = new ScriptedRunner(() => ({ stdout: "jira: not authenticated", exitCode: 1 }));
    const { deps, dispatch } = makeDeps(makeConfig({}), runner);

    const summary = ingestJiraIssues(deps);

    expect(summary.errors).toHaveLength(1);
    expect(summary.ingested).toEqual([]);
    expect(dispatch.events.filter((e) => e.type === "draft_ticket.created")).toHaveLength(0);
  });

  it("tolerates a non-string (ADF) description from Jira Cloud", () => {
    const issue = {
      key: "PROJ-5",
      self: "https://acme.atlassian.net/rest/api/2/issue/PROJ-5",
      fields: { summary: "Rich text", description: { type: "doc", content: [] } },
    };
    const runner = new ScriptedRunner(() => ok(search([issue])));
    const { deps, dispatch } = makeDeps(makeConfig({}), runner);

    const summary = ingestJiraIssues(deps);

    expect(summary.ingested).toHaveLength(1);
    const ticket = dispatch.getTicket(summary.ingested[0]!.ticketId);
    expect(ticket.ticket.title).toBe("Rich text");
    expect(ticket.ticket.description).toContain("Source: ");
  });
});

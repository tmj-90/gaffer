import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  EventLog,
  FakeDispatchClient,
  RepoRegistry,
  TestClock,
  crewConfigSchema,
  ingestGithubIssues,
  parseGithubSlug,
  type CommandResult,
  type CommandRunner,
  type CrewConfig,
  type IngestDeps,
} from "../src/index.js";

/**
 * A scripted runner: returns a queued result per matched command substring, so a
 * test can hand back canned `gh issue list` JSON and assert relabel calls. No
 * real `gh` or network is ever touched.
 */
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

// Accept the schema's INPUT shape (partial repos), not the parsed output —
// `crewConfigSchema.parse` fills the per-repo defaults at runtime.
type RepoInput = z.input<typeof crewConfigSchema>["repos"];

function configWithRepos(repos: RepoInput): CrewConfig {
  return crewConfigSchema.parse({
    factory: { name: "test-factory", mode: "local_strict" },
    repos,
    ingest: { github: { enabled: true, label: "agent-ok", ingested_label: "agent-queued" } },
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

const ghRepo = {
  id: "web-app",
  name: "web-app",
  path: "/tmp/web-app",
  remote_url: "git@github.com:acme/web-app.git",
};

describe("parseGithubSlug", () => {
  it("parses ssh scp-form remotes", () => {
    expect(parseGithubSlug("git@github.com:acme/web-app.git")).toBe("acme/web-app");
  });

  it("parses https remotes with and without .git", () => {
    expect(parseGithubSlug("https://github.com/acme/web-app.git")).toBe("acme/web-app");
    expect(parseGithubSlug("https://github.com/acme/web-app")).toBe("acme/web-app");
  });

  it("parses ssh:// url-form remotes", () => {
    expect(parseGithubSlug("ssh://git@github.com/acme/web-app.git")).toBe("acme/web-app");
  });

  it("returns undefined for non-github or null remotes", () => {
    expect(parseGithubSlug(null)).toBeUndefined();
    expect(parseGithubSlug("git@gitlab.com:acme/web-app.git")).toBeUndefined();
  });
});

describe("ingestGithubIssues", () => {
  it("creates a draft ticket per issue and relabels each issue", () => {
    const issues = [
      {
        number: 7,
        title: "Add login throttling",
        body: "Brute-force protection.",
        url: "https://github.com/acme/web-app/issues/7",
      },
      {
        number: 9,
        title: "Dark mode toggle",
        body: "User-requested.",
        url: "https://github.com/acme/web-app/issues/9",
      },
    ];
    const runner = new ScriptedRunner((command) =>
      command.includes("issue list") ? ok(JSON.stringify(issues)) : ok(""),
    );
    const { deps, dispatch, events } = makeDeps(configWithRepos([ghRepo]), runner);

    const summary = ingestGithubIssues(deps);

    expect(summary.ingested).toHaveLength(2);
    expect(summary.skipped).toBe(0);
    expect(summary.errors).toEqual([]);

    // A draft ticket per issue with title, body + Source url, and repo name.
    expect(dispatch.events.filter((e) => e.type === "draft_ticket.created")).toHaveLength(2);
    const ticket7 = dispatch.getTicket(
      String(
        summary.ingested[0]!.number === 7
          ? summary.ingested[0]!.ticketId
          : summary.ingested[1]!.ticketId,
      ),
    );
    expect(ticket7.ticket.title).toBe("Add login throttling");
    expect(ticket7.ticket.description).toContain("Brute-force protection.");
    expect(ticket7.ticket.description).toContain(
      "Source: https://github.com/acme/web-app/issues/7",
    );
    expect(ticket7.repositories[0]?.name).toBe("web-app");

    // A relabel command per issue, removing the trigger label and adding the queued one.
    const editCalls = runner.calls.filter((c) => c.command.includes("issue edit"));
    expect(editCalls).toHaveLength(2);
    expect(editCalls[0]!.command).toContain("gh issue edit 7");
    expect(editCalls[0]!.command).toContain("--remove-label 'agent-ok'");
    expect(editCalls[0]!.command).toContain("--add-label 'agent-queued'");
    expect(editCalls[1]!.command).toContain("gh issue edit 9");

    // The list command targets the resolved owner/repo, label and open state.
    const listCall = runner.calls.find((c) => c.command.includes("issue list"))!;
    expect(listCall.command).toContain("--repo 'acme/web-app'");
    expect(listCall.command).toContain("--label 'agent-ok'");
    expect(listCall.command).toContain("--state open");

    expect(events.types()).toContain("ingest_issue_ingested");
  });

  it("skips a repo with no GitHub remote", () => {
    const noRemote = { id: "local", name: "local", path: "/tmp/local", remote_url: null };
    const runner = new ScriptedRunner(() => ok("[]"));
    const { dispatch, summary } = (() => {
      const made = makeDeps(configWithRepos([noRemote]), runner);
      return { ...made, summary: ingestGithubIssues(made.deps) };
    })();

    expect(summary.skipped).toBe(1);
    expect(summary.ingested).toEqual([]);
    // No gh call at all for a non-GitHub repo.
    expect(runner.calls).toHaveLength(0);
    expect(dispatch.events.filter((e) => e.type === "draft_ticket.created")).toHaveLength(0);
  });

  it("does not abort other repos when gh fails for one repo", () => {
    const goodRepo = ghRepo;
    const badRepo = {
      id: "api",
      name: "api",
      path: "/tmp/api",
      remote_url: "git@github.com:acme/api.git",
    };
    const issue = {
      number: 1,
      title: "Fix it",
      body: "Please.",
      url: "https://github.com/acme/web-app/issues/1",
    };

    const runner = new ScriptedRunner((command) => {
      if (command.includes("'acme/api'")) return { stdout: "gh: not authenticated", exitCode: 1 };
      if (command.includes("issue list")) return ok(JSON.stringify([issue]));
      return ok("");
    });
    // Order matters: bad repo first to prove the good one still runs after it.
    const { deps, dispatch } = makeDeps(configWithRepos([badRepo, goodRepo]), runner);

    const summary = ingestGithubIssues(deps);

    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]!.repo).toBe("api");
    expect(summary.ingested).toHaveLength(1);
    expect(summary.ingested[0]!.repo).toBe("web-app");
    expect(dispatch.events.filter((e) => e.type === "draft_ticket.created")).toHaveLength(1);
  });

  it("returns an error and creates nothing when relabel fails", () => {
    const issue = {
      number: 3,
      title: "T",
      body: "B",
      url: "https://github.com/acme/web-app/issues/3",
    };
    const runner = new ScriptedRunner((command) => {
      if (command.includes("issue list")) return ok(JSON.stringify([issue]));
      return { stdout: "label not found", exitCode: 1 }; // edit fails
    });
    const { deps } = makeDeps(configWithRepos([ghRepo]), runner);

    const summary = ingestGithubIssues(deps);

    // The draft was created, then relabel failed: surfaced as a repo error.
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]!.message).toContain("relabel");
  });

  it("does not create a second ticket when the issue was already ingested (relabel having failed)", () => {
    // Simulates the P1 #5 failure mode: a prior run created the ticket but the
    // relabel failed, so the issue STILL carries the trigger label and reappears
    // in the next `gh issue list`. Identity-based dedup must skip it.
    const issue = {
      number: 42,
      title: "Idempotent please",
      body: "Body.",
      url: "https://github.com/acme/web-app/issues/42",
    };
    const runner = new ScriptedRunner((command) =>
      command.includes("issue list") ? ok(JSON.stringify([issue])) : ok(""),
    );
    const { deps, dispatch } = makeDeps(configWithRepos([ghRepo]), runner);

    // First ingest creates the ticket (the Source: <url> marker is recorded).
    const first = ingestGithubIssues(deps);
    expect(first.ingested).toHaveLength(1);
    expect(first.deduped).toBe(0);
    expect(dispatch.events.filter((e) => e.type === "draft_ticket.created")).toHaveLength(1);

    // Sanity: the issue identity is now resolvable for dedup.
    expect(dispatch.findTicketBySource(issue.url)?.ticketId).toBe(first.ingested[0]!.ticketId);

    // Second ingest of the SAME issue (still labelled) must NOT create another.
    const second = ingestGithubIssues(deps);
    expect(second.ingested).toHaveLength(0);
    expect(second.deduped).toBe(1);
    expect(second.errors).toEqual([]);

    // Still exactly one draft ticket overall.
    expect(dispatch.events.filter((e) => e.type === "draft_ticket.created")).toHaveLength(1);
    expect(deps.events.types()).toContain("ingest_issue_deduped");

    // No relabel was attempted on the deduped pass (we skipped before relabel).
    const editCalls = runner.calls.filter((c) => c.command.includes("issue edit"));
    expect(editCalls).toHaveLength(1); // only the first run's relabel
  });

  it("respects the repos allow-list", () => {
    const repoA = ghRepo;
    const repoB = {
      id: "api",
      name: "api",
      path: "/tmp/api",
      remote_url: "git@github.com:acme/api.git",
    };
    const config = crewConfigSchema.parse({
      factory: { name: "f", mode: "local_strict" },
      repos: [repoA, repoB],
      ingest: { github: { enabled: true, repos: ["api"] } },
    });
    const runner = new ScriptedRunner(() => ok("[]"));
    const { deps } = makeDeps(config, runner);

    ingestGithubIssues(deps);

    // Only the allow-listed repo was polled.
    const listCalls = runner.calls.filter((c) => c.command.includes("issue list"));
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0]!.command).toContain("'acme/api'");
  });
});

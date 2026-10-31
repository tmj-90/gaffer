// @vitest-environment jsdom
//
// The ticket page's attempt history names WHICH model served each delivery attempt
// and WHICH Claude Code CLI ran it, from the runner's agent-run evidence
// (runner/factory.config.sh gaffer_record_agent_run → evidence_type "log",
// payload kind "agent_run"). A failed attempt carries the line under its head; a
// ticket that never failed still gets a plain list of its attempts.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const TICKET = {
  id: "tkt-9",
  number: 9,
  title: "Widget endpoint",
  description: "deliver it",
  status: "in_review",
  risk_level: "low",
  policy_pack: "team_light",
  priority: 0,
  attempt_count: 0,
  branch_name: "gaffer/ticket-9",
  pr_url: null,
  can_be_tested: 0,
  test_contract: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

function run(attempt: number, at: string, over: Record<string, unknown> = {}) {
  return {
    id: `ev-${attempt}-${at}`,
    ticket_id: TICKET.id,
    ac_id: null,
    repo_id: null,
    decision_id: null,
    evidence_type: "log",
    summary: `Agent run, attempt ${attempt}/3`,
    uri: null,
    payload_json: JSON.stringify({
      kind: "agent_run",
      role: "delivery",
      attempt,
      max_attempts: 3,
      model_requested: "stub-requested",
      models_served: [`stub-served-${attempt}`],
      claude_version: `4.${attempt}.0 (Claude Code)`,
      rc: 0,
      ...over,
    }),
    created_by: "system",
    recorded_by_actor_type: "system",
    created_at: at,
  };
}

const FAIL_1 = {
  id: "rw1",
  ticket_id: TICKET.id,
  attempt: 1,
  max_attempts: 3,
  gate: "tests",
  distilled_failure: "FAIL adds: expected 3 to be 4",
  ac_id: null,
  created_at: "2026-01-02T00:05:00Z",
};

function stubFetch(evidence: unknown[], trail: unknown[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      let body: unknown;
      if (url.includes(`/tickets/${TICKET.id}/diff`)) body = { ticketId: TICKET.id, repos: [] };
      else if (url.includes(`/tickets/${TICKET.id}/claimability`))
        body = { ticketId: TICKET.id, ready: true, blockers: [], warnings: [] };
      else if (url.includes(`/tickets/${TICKET.id}/work-repos`))
        body = {
          writeRepos: [],
          readOnlyRepos: [],
          testRepos: [],
          deniedRepos: [],
          suggestedRepos: [],
          rejectedRepos: [],
        };
      else if (url.includes(`/tickets/${TICKET.id}`))
        body = {
          ticket: TICKET,
          acceptance_criteria: [],
          repositories: [],
          scopes: [],
          blocking_decisions: [],
          dependencies: [],
          evidence,
          events: [],
          rework_trail: trail,
        };
      else body = { tickets: [TICKET] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

function mountShell(): void {
  document.body.innerHTML = `
    <div id="toast" class="toast" role="alert" hidden></div>
    <div class="shell">
      <header id="appbar" class="appbar" hidden></header>
      <main id="app" class="app"><p class="loading">Loading…</p></main>
      <nav id="bottomnav" class="bottomnav" hidden></nav>
    </div>`;
  location.hash = `#/ticket/${TICKET.id}`;
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function boot(): Promise<void> {
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}-${Math.random()}`);
  for (let i = 0; i < 4; i++) await tick();
}

describe("web: the attempt history names the model and the CLI", () => {
  beforeEach(() => {
    mountShell();
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("puts the serving model and CLI version on each failed attempt", async () => {
    stubFetch([run(1, "2026-01-02T00:00:00Z"), run(2, "2026-01-02T01:00:00Z")], [FAIL_1]);
    await boot();
    const attempt = document.querySelector(".failure-history .failure-attempt");
    expect(attempt).toBeTruthy();
    const line = attempt!.querySelector(".attempt-run")?.textContent;
    expect(line).toBe("Model stub-served-1 · CLI 4.1.0 (Claude Code)");
  });

  it("lists the attempts of a ticket that never failed", async () => {
    stubFetch([run(1, "2026-01-02T00:00:00Z")], []);
    await boot();
    const card = document.querySelector(".agent-runs");
    expect(card).toBeTruthy();
    expect(card!.querySelector("h2")?.textContent).toContain("1 run");
    const row = card!.querySelector(".agent-run")!;
    expect(row.textContent).toContain("Attempt 1/3");
    expect(row.querySelector(".attempt-run")?.textContent).toBe(
      "Model stub-served-1 · CLI 4.1.0 (Claude Code)",
    );
  });

  it("falls back to the requested model when nothing measured the call", async () => {
    stubFetch([run(1, "2026-01-02T00:00:00Z", { models_served: [], rc: 124 })], []);
    await boot();
    const row = document.querySelector(".agent-run")!;
    expect(row.querySelector(".attempt-run")?.textContent).toBe(
      "Model stub-requested · CLI 4.1.0 (Claude Code)",
    );
    expect(row.textContent).toContain("exit 124");
  });

  it("ignores ordinary log evidence and shows no card without runs or failures", async () => {
    const plain = { ...run(1, "2026-01-02T00:00:00Z"), payload_json: null };
    stubFetch([plain], []);
    await boot();
    expect(document.querySelector(".failure-history")).toBeNull();
  });
});

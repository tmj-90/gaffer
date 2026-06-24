// @vitest-environment jsdom
//
// BBT-001 DOM test: the ticket-detail "Independent testing" card renders the
// can_be_tested toggle, the test_contract (surfaces / deps / env / run / harness),
// and the tester's test_output evidence.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const TICKET = {
  id: "tkt-1",
  number: 7,
  title: "Widget endpoint",
  description: "deliver it",
  status: "in_testing",
  risk_level: "low",
  policy_pack: "team_light",
  priority: 0,
  attempt_count: 0,
  branch_name: "feat/x",
  pr_url: null,
  can_be_tested: 1,
  test_contract: JSON.stringify({
    changed_surfaces: ["POST /api/widgets"],
    runtime_deps: ["Postgres 16"],
    env_vars: ["DATABASE_URL"],
    run_command: "docker compose up",
    harness_ready: false,
  }),
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const EVIDENCE = [
  {
    id: "ev1",
    evidence_type: "test_output",
    summary: "12 black-box tests pass against the contract",
    created_by: "tester-1",
    created_at: "2026-01-02T00:00:00Z",
  },
];

function stubFetch(): void {
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
          evidence: EVIDENCE,
          events: [],
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

async function bootDetail(): Promise<void> {
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
  await tick();
  await tick();
  await tick();
}

describe("BBT-001 web: the Independent testing card", () => {
  beforeEach(() => {
    mountShell();
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("renders the testing card with the toggle, the contract, and tester evidence", async () => {
    stubFetch();
    await bootDetail();

    const text = document.body.textContent ?? "";
    expect(text).toContain("Independent testing");
    expect(text).toContain("Test contract");
    // Contract fields render.
    expect(text).toContain("POST /api/widgets");
    expect(text).toContain("Postgres 16");
    expect(text).toContain("docker compose up");
    expect(text).toContain("harness mode");
    // The tester's test_output evidence renders.
    expect(text).toContain("12 black-box tests pass against the contract");

    // The testable toggle is rendered and reflects can_be_tested = 1.
    const toggle = Array.from(
      document.querySelectorAll('input[type="checkbox"][role="switch"]'),
    ).find((el) => (el as HTMLInputElement).getAttribute("aria-label") === "Testable") as
      | HTMLInputElement
      | undefined;
    expect(toggle).toBeDefined();
    expect(toggle!.checked).toBe(true);
  });
});

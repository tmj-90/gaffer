// @vitest-environment jsdom
//
// TRACK-3a DOM test: the ticket-detail head surfaces the per-ticket delivery
// BUDGET ceiling as a badge when set, and shows nothing when it is null. Proves the
// cost-as-control field is visible to an operator, not just stored.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const BASE_TICKET = {
  id: "tkt-1",
  number: 7,
  title: "Budgeted work",
  description: "deliver it",
  status: "ready",
  risk_level: "low",
  policy_pack: "solo_loose",
  priority: 0,
  attempt_count: 0,
  branch_name: null,
  pr_url: null,
  can_be_tested: 0,
  test_contract: null,
  delivery_budget_usd: null as number | null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

function stubFetch(ticket: typeof BASE_TICKET): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      let body: unknown;
      if (url.includes(`/tickets/${ticket.id}/diff`)) body = { ticketId: ticket.id, repos: [] };
      else if (url.includes(`/tickets/${ticket.id}/claimability`))
        body = { ticketId: ticket.id, ready: true, blockers: [], warnings: [] };
      else if (url.includes(`/tickets/${ticket.id}/work-repos`))
        body = {
          writeRepos: [],
          readOnlyRepos: [],
          testRepos: [],
          deniedRepos: [],
          suggestedRepos: [],
          rejectedRepos: [],
        };
      else if (url.includes(`/tickets/${ticket.id}`))
        body = {
          ticket,
          acceptance_criteria: [],
          repositories: [],
          scopes: [],
          blocking_decisions: [],
          dependencies: [],
          evidence: [],
          events: [],
          rework_trail: [],
        };
      else body = { tickets: [ticket] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

function mountShell(ticketId: string): void {
  document.body.innerHTML = `
    <div id="toast" class="toast" role="alert" hidden></div>
    <div class="shell">
      <header id="appbar" class="appbar" hidden></header>
      <main id="app" class="app"><p class="loading">Loading…</p></main>
      <nav id="bottomnav" class="bottomnav" hidden></nav>
    </div>`;
  location.hash = `#/ticket/${ticketId}`;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function bootDetail(): Promise<void> {
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
  await tick();
  await tick();
  await tick();
}

describe("TRACK-3a web: the ticket-detail delivery-budget badge", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("renders a 'budget $X.XX' badge when a per-ticket budget is set", async () => {
    mountShell(BASE_TICKET.id);
    stubFetch({ ...BASE_TICKET, delivery_budget_usd: 2.5 });
    await bootDetail();
    const head = document.querySelector(".detail-title")?.closest(".card");
    expect(head?.textContent ?? "").toContain("budget $2.50");
  });

  it("shows no budget badge when the ticket has no per-ticket budget", async () => {
    mountShell(BASE_TICKET.id);
    stubFetch({ ...BASE_TICKET, delivery_budget_usd: null });
    await bootDetail();
    const head = document.querySelector(".detail-title")?.closest(".card");
    expect(head?.textContent ?? "").not.toContain("budget $");
  });
});

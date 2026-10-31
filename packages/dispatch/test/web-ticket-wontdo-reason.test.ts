// @vitest-environment jsdom
//
// A won't-do ticket's page says WHY it will not be built: the reason given when it
// was closed (the latest move into cancelled), not only that it closed. Found by the
// browser scenario suite S2 (the reason was stored and shown nowhere).

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const BASE_TICKET = {
  id: "tkt-1",
  number: 7,
  title: "Budgeted work",
  description: "deliver it",
  status: "cancelled",
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

function stubFetch(ticket: typeof BASE_TICKET, events: unknown[] = []): void {
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
          events,
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

const moved = (from: string, to: string, reason: string, at: string) => ({
  id: `${from}-${to}-${at}`,
  event_type: "ticket.transitioned",
  payload_json: JSON.stringify({ from, to, reason, patch: null }),
  actor_type: "human",
  actor_id: "tom",
  created_at: at,
});

describe("web: the won't-do ticket page names its reason", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("quotes the reason of the latest close", async () => {
    mountShell(BASE_TICKET.id);
    stubFetch(BASE_TICKET, [
      moved("draft", "cancelled", "Out of scope", "2026-01-01T00:00:01Z"),
      moved("cancelled", "refining", "reopened_from_wont_do", "2026-01-01T00:00:02Z"),
      moved("refining", "cancelled", "Covered by another ticket", "2026-01-01T00:00:03Z"),
    ]);
    await bootDetail();
    const lede = document.querySelector(".tk-lede")?.textContent ?? "";
    expect(lede).toContain("Won't do.");
    expect(lede).toContain("Covered by another ticket");
    expect(lede).not.toContain("Out of scope");
  });

  it("falls back to the plain sentence when no reason was recorded", async () => {
    mountShell(BASE_TICKET.id);
    stubFetch(BASE_TICKET, []);
    await bootDetail();
    expect(document.querySelector(".tk-lede")?.textContent ?? "").toContain(
      "It will not be built.",
    );
  });
});

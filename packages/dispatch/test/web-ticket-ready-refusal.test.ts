// @vitest-environment jsdom
//
// Mark ready refused by the policy says WHICH check failed: the failures the server
// returns (e.g. SCOPE_REPO_UNCONFIRMED and its message), not only "Policy denied
// ready". Found by the browser scenario suite S14.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const BASE_TICKET = {
  id: "tkt-1",
  number: 7,
  title: "Budgeted work",
  description: "deliver it",
  status: "draft",
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
      if (url.endsWith(`/tickets/${ticket.id}/ready`)) {
        return new Response(
          JSON.stringify({
            error: {
              code: "POLICY_DENIED",
              message: "Policy 'solo_loose' denied ready.",
              details: {
                policy: {
                  allowed: false,
                  failures: [
                    {
                      code: "SCOPE_REPO_UNCONFIRMED",
                      message: "none of its repos is confirmed yet",
                    },
                  ],
                },
              },
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
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

describe("web: a refused Mark ready names the failed policy check", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("lists the policy failures under the refusal", async () => {
    mountShell(BASE_TICKET.id);
    stubFetch(BASE_TICKET, [
      {
        id: "e1",
        event_type: "ticket.created",
        payload_json: "{}",
        created_at: "2026-01-01T00:00:00Z",
      },
    ]);
    await bootDetail();
    const btn = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Mark ready",
    );
    expect(btn).toBeTruthy();
    btn!.click();
    for (let i = 0; i < 6; i++) await tick();
    const box = document.querySelector(".policy-result.fail")?.textContent ?? "";
    expect(box).toContain("Mark-ready failed");
    expect(box).toContain("none of its repos is confirmed yet");
    expect(box).toContain("SCOPE_REPO_UNCONFIRMED");
  });
});

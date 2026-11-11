// @vitest-environment jsdom
//
// DECISION VISIBILITY (external review 17, finding 2): a scoped token's ticket page shows
// a blocking decision outside its scope as the bare fact ("A decision outside this
// token's scope", still blocking) and the one it may read in full, without errors.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const TICKET = {
  id: "tkt-1",
  number: 42,
  title: "Widget endpoint",
  description: "deliver it",
  status: "in_progress",
  risk_level: "low",
  policy_pack: "team_light",
  priority: 0,
  attempt_count: 0,
  branch_name: "feat/x",
  pr_url: null,
  can_be_tested: 0,
  test_contract: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

// One decision the token may read, and one outside its scope (the server's marker).
const BLOCKING = [
  {
    id: "dec-own",
    title: "Pick a colour",
    question: "Which colour?",
    status: "human_required",
    severity: "human_required",
  },
  { id: null, title: null, outside_scope: true },
];

function stubFetch(trail: unknown[] = []): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      let body: unknown;
      if (url.includes(`/tickets/${TICKET.id}/diff`)) body = { ticketId: TICKET.id, repos: [] };
      else if (url.includes(`/tickets/${TICKET.id}/claimability`))
        body = {
          ticketId: TICKET.id,
          ready: false,
          blockers: [
            {
              code: "DECISION_BLOCKED",
              message:
                "Waiting on 2 decisions: Pick a colour; a decision outside this credential's scope (answer it: gaffer wg decisions resolve <id>).",
            },
          ],
          warnings: [],
        };
      else if (url.includes("/api/whoami"))
        body = {
          capability: "full",
          actor: { type: "human", id: "a-only" },
          principal: { id: "p1", name: "a-only" },
          scope: { tickets: [TICKET.id] },
        };
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
          blocking_decisions: BLOCKING,
          dependencies: [],
          evidence: [],
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

async function bootDetail(): Promise<void> {
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
  await tick();
  await tick();
  await tick();
}

describe("decision visibility web: a blocker outside the token's scope", () => {
  beforeEach(() => {
    mountShell();
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("draws the generic blocker beside the readable one, and nothing named null", async () => {
    const errors: unknown[] = [];
    const onError = (e: ErrorEvent) => errors.push(e.error ?? e.message);
    window.addEventListener("error", onError);
    stubFetch();
    try {
      await bootDetail();
    } finally {
      window.removeEventListener("error", onError);
    }
    const panel = document.querySelector(".tk-blockers");
    expect(panel, document.querySelector("#app")?.textContent ?? "").toBeTruthy();
    const items = Array.from(panel?.querySelectorAll(".tk-blocker-list li") ?? []);
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain("Pick a colour");
    expect(items[1]?.textContent).toContain("A decision outside this token's scope");
    expect(items[1]?.textContent).toContain("It still blocks this ticket.");
    const text = panel?.textContent ?? "";
    expect(text).not.toContain("null");
    expect(text).not.toContain("undefined");
    expect(errors).toEqual([]);
  });
});

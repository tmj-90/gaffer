// @vitest-environment jsdom
//
// An approved ticket's status says where its landing really is (the external UI review's
// sign-off point, carried to the status label). Every ready_for_merge ticket read
// "Approved · merging", also with AUTO_MERGE off where nothing lands it until someone
// presses Merge now. The server stamps `landing_state` on approved and held tickets
// (ticket, list, board, human queue) and the dashboard's status words read it.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const WAITING = {
  kind: "waiting_for_merge",
  label: "Approved · waiting for Merge now",
  detail: "Auto-merge on approval is off: it lands when someone presses Merge now.",
  hold: null,
};
const T = {
  id: "tk-21",
  number: 21,
  title: "Retry queue with backoff",
  description: "x",
  status: "ready_for_merge",
  risk_level: "low",
  policy_pack: "team_light",
  priority: 5,
  attempt_count: 0,
  branch_name: "gaffer/ticket-21",
  pr_url: null,
  can_be_tested: 0,
  test_contract: null,
  delivery_budget_usd: null,
  created_at: "2026-10-27T10:30:00Z",
  updated_at: "2026-10-29T11:48:00Z",
};
const CARD = {
  id: "tk-22",
  number: 22,
  title: "Webhook delivery for task events",
  status: "ready_for_merge",
  priority: 0,
  risk_level: "medium",
  updated_at: "2026-10-29T11:48:00Z",
  acTotal: 1,
  acSatisfied: 1,
  acEvidenced: 0,
  acEvidenceRequired: 0,
  blockingCount: 0,
  claim: null,
  lastReviewFeedback: null,
  landing_state: { ...WAITING },
};
const HELD = {
  ...CARD,
  id: "tk-23",
  number: 23,
  status: "blocked",
  landing_state: {
    kind: "held",
    label: "Held · merge gate failed",
    detail: "The merge onto the current default branch failed its gates.",
    hold: "merge_gate_red",
  },
};

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      let body: unknown;
      if (url.includes("/api/board"))
        body = {
          columns: [
            { column: "draft", cards: [] },
            { column: "ready", cards: [] },
            { column: "in_progress", cards: [] },
            { column: "blocked", cards: [HELD] },
            { column: "in_review", cards: [] },
            { column: "in_testing", cards: [] },
            { column: "ready_for_merge", cards: [CARD] },
            { column: "done", cards: [] },
          ],
          closed: [],
          wontDo: [],
          readyForMerge: [CARD],
        };
      else if (url.includes(`/tickets/${T.id}`) && !url.includes(`/tickets/${T.id}/`))
        body = {
          ticket: { ...T, landing_state: { ...WAITING } },
          acceptance_criteria: [],
          repositories: [],
          scopes: [],
          blocking_decisions: [],
          dependencies: [],
          evidence: [],
          events: [],
          rework_trail: [],
        };
      else if (url.includes("/diff")) body = { ticketId: T.id, repos: [] };
      else if (url.includes("/claimability"))
        body = { ticketId: T.id, ready: true, blockers: [], warnings: [] };
      else if (url.includes("/work-repos"))
        body = {
          work_repos: {
            writeRepos: [],
            readOnlyRepos: [],
            testRepos: [],
            deniedRepos: [],
            suggestedRepos: [],
            rejectedRepos: [],
          },
        };
      else if (url.includes("/repositories")) body = { repositories: [] };
      else if (url.includes("/scope/nodes")) body = { nodes: [] };
      else if (url.includes("/api/runs")) body = { active: [], recent: [] };
      else body = {};
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

function mount(hash: string): void {
  document.body.innerHTML = `
    <div id="toast" class="toast" role="alert" hidden></div>
    <div class="shell">
      <header id="appbar" class="appbar" hidden></header>
      <main id="app" class="app"><p class="loading">Loading…</p></main>
      <nav id="bottomnav" class="bottomnav" hidden></nav>
    </div>`;
  location.hash = hash;
}
const tick = () => new Promise((r) => setTimeout(r, 0));
async function boot(): Promise<void> {
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}-${Math.random()}`);
  for (let i = 0; i < 8; i++) await tick();
}

describe("web: an approved ticket's status never says merging when nothing merges it", () => {
  beforeEach(() => {
    vi.resetModules();
    stubFetch();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("the ticket page (AUTO_MERGE off): 'Approved · waiting for Merge now'", async () => {
    mount(`#/ticket/${T.id}`);
    await boot();
    const app = document.getElementById("app") as HTMLElement;
    const badge = app.querySelector(".badge.st.status-ready_for_merge") as HTMLElement;
    expect(badge?.textContent).toBe("Approved · waiting for Merge now");
    expect(badge.getAttribute("title")).toContain("Auto-merge on approval is off");
    expect(app.textContent).not.toMatch(/merging/i);
    expect(app.textContent).not.toContain("with the merge runner now");
  });

  it("the board: the approved card and the held card say where they are", async () => {
    mount("#/work");
    await boot();
    const card = document.querySelector('[data-column="ready_for_merge"]') as HTMLElement;
    expect(card?.textContent).toContain("Approved · waiting for Merge now");
    expect(card.textContent).not.toMatch(/merging/i);
    const held = document.querySelector('[data-column="blocked"]') as HTMLElement;
    expect(held?.textContent).toContain("Held · merge gate failed");
  });
});

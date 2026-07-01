// @vitest-environment jsdom
//
// FAILURE-DIAGNOSIS DOM test: the ticket-detail "Failure history" card renders the
// full ordered rework trail (attempt 1 → 2 → …), each with its gate + the distilled
// failing test + assertion. This is the "why did #N fail" surface an operator
// returns to — distinct from the board's latest-only rework chip.

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

const REWORK_TRAIL = [
  {
    id: "rw1",
    ticket_id: TICKET.id,
    attempt: 1,
    max_attempts: 3,
    gate: "tests",
    distilled_failure:
      "FAIL src/add.test.ts > adds\n  expected 3 to be 4\n    at add.test.ts:12:20",
    ac_id: null,
    created_at: "2026-01-02T00:00:00Z",
  },
  {
    id: "rw2",
    ticket_id: TICKET.id,
    attempt: 2,
    max_attempts: 3,
    gate: "lint",
    distilled_failure: "src/add.ts:2:7  error  'y' is assigned a value but never used",
    ac_id: null,
    created_at: "2026-01-02T01:00:00Z",
  },
];

function stubFetch(trail: unknown[] = REWORK_TRAIL): void {
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

describe("failure-diagnosis web: the ticket-detail Failure history card", () => {
  beforeEach(() => {
    mountShell();
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("renders the full ordered trail with each attempt's gate + distilled failure", async () => {
    stubFetch();
    await bootDetail();

    const card = document.querySelector(".failure-history");
    expect(card).toBeTruthy();
    const text = card?.textContent ?? "";

    // Header reflects the attempt count.
    expect(text).toContain("Failure history");
    expect(text).toContain("2 attempts");

    // Both attempts render with their gate.
    expect(text).toContain("Attempt 1/3");
    expect(text).toContain("Attempt 2/3");
    expect(text).toContain("tests");
    expect(text).toContain("lint");

    // The FULL distilled failing test + assertion rides along (not a one-liner).
    expect(text).toContain("expected 3 to be 4");
    expect(text).toContain("add.test.ts:12:20");
    expect(text).toContain("never used");

    // Ordered oldest-first: attempt 1's block precedes attempt 2's.
    const attempts = Array.from(card?.querySelectorAll(".failure-attempt") ?? []);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.textContent).toContain("Attempt 1/3");
    expect(attempts[1]?.textContent).toContain("Attempt 2/3");

    // The distilled failure is rendered as text inside <pre> (never innerHTML).
    const pre = card?.querySelector("pre.failure-detail");
    expect(pre).toBeTruthy();
    expect(pre?.querySelector("*")).toBeNull();
  });

  it("shows no Failure history card for a ticket that never bounced", async () => {
    stubFetch([]);
    await bootDetail();
    expect(document.querySelector(".failure-history")).toBeNull();
  });
});

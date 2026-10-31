// @vitest-environment jsdom
//
// The ticket page shows the evidence trail (reviewer-agent notes, the DoD
// checklist, AC check output…) in a folded Evidence card, grouped by who recorded
// it. Only Review showed it before, so a ticket that left Review (an advisory
// CHANGES, a send back) lost the visible trail. Found by the browser suites.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const T = {
  id: "tkt-9",
  number: 9,
  title: "Document the helper",
  description: "",
  status: "refining",
  risk_level: "low",
  policy_pack: "solo_loose",
  priority: 0,
  attempt_count: 1,
  branch_name: null,
  pr_url: null,
  can_be_tested: 0,
  test_contract: null,
  delivery_budget_usd: null,
  created_at: "2026-10-01T10:00:00Z",
  updated_at: "2026-10-01T12:00:00Z",
};
const ev = (
  id: string,
  type: string,
  by: string,
  actor: string | null,
  summary: string,
  at: string,
) => ({
  id,
  ticket_id: T.id,
  ac_id: null,
  repo_id: null,
  decision_id: null,
  evidence_type: type,
  summary,
  uri: null,
  payload_json: null,
  created_by: by,
  recorded_by_actor_type: actor,
  recorded_by_agent: actor === "agent",
  created_at: at,
});
let evidence: unknown[] = [];

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      let body: unknown;
      if (url.includes("/claimability"))
        body = { ticketId: T.id, ready: true, blockers: [], warnings: [] };
      else if (url.includes("/work-repos"))
        body = {
          work_repos: { writeRepos: [], readOnlyRepos: [], testRepos: [], deniedRepos: [] },
        };
      else if (url.includes("/repo-suggestions")) body = { suggestions: [] };
      else if (url.includes("/api/runs")) body = { active: [], recent: [] };
      else if (url.includes(`/tickets/${T.id}`))
        body = {
          ticket: T,
          acceptance_criteria: [],
          repositories: [],
          scopes: [],
          blocking_decisions: [],
          dependencies: [],
          evidence,
          events: [],
          rework_trail: [],
        };
      else body = { tickets: [T] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}
const tick = () => new Promise((r) => setTimeout(r, 0));
async function boot(): Promise<void> {
  document.body.innerHTML = `
    <div id="toast" class="toast" role="alert" hidden></div>
    <div class="shell">
      <header id="appbar" class="appbar" hidden></header>
      <main id="app" class="app"><p class="loading">Loading…</p></main>
      <nav id="bottomnav" class="bottomnav" hidden></nav>
    </div>`;
  location.hash = `#/ticket/${T.id}`;
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}-${Math.random()}`);
  for (let i = 0; i < 8; i++) await tick();
}

describe("web: the ticket page keeps the evidence trail", () => {
  beforeEach(() => {
    vi.resetModules();
    stubFetch();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("lists every row in a folded Evidence card, grouped by who recorded it", async () => {
    evidence = [
      ev(
        "e1",
        "manual_note",
        "crew-delivery-01",
        "agent",
        "smallest-change check: one file",
        "2026-10-01T10:05:00Z",
      ),
      ev(
        "e2",
        "test_output",
        "system",
        "system",
        "DoD: tests pass\nlint pass",
        "2026-10-01T10:06:00Z",
      ),
      ev(
        "e3",
        "review_note",
        "system",
        "system",
        "Reviewer agent: CHANGES — add a docstring",
        "2026-10-01T10:07:00Z",
      ),
      ev("e4", "manual_note", "tom", "human", "Checked by hand", "2026-10-01T10:08:00Z"),
    ];
    await boot();
    const card = document.querySelector<HTMLDetailsElement>("details.tk-evidence")!;
    expect(card).toBeTruthy();
    expect(card.open, "folded by default: it is the record, not the next move").toBe(false);
    expect(card.querySelector("summary")?.textContent).toContain("4 rows");
    const groups = [...card.querySelectorAll<HTMLElement>(".tk-evidence-group")];
    expect(groups.map((g) => g.dataset.provenance)).toEqual(["agent", "system", "human"]);
    expect(groups[0]!.querySelector(".prov-agent")?.textContent).toBe("agent-reported");
    const runner = groups[1]!.textContent ?? "";
    expect(runner).toContain("Recorded by the runner");
    expect(runner).toContain("Reviewer agent: CHANGES — add a docstring");
    // Oldest first within a group.
    expect(runner.indexOf("DoD: tests pass")).toBeLessThan(runner.indexOf("Reviewer agent"));
    expect(groups[2]!.textContent).toContain("Checked by hand");
  });

  it("has no Evidence card when nothing was recorded", async () => {
    evidence = [];
    await boot();
    expect(document.querySelector(".tk-evidence")).toBeNull();
  });
});

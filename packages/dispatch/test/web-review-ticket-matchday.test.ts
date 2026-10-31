// @vitest-environment jsdom
//
// Review + Ticket (Match Day views): the logic behind what the pages now say.
//  - A done ticket's boundary is read-only (no access selects, no Add repo form).
//  - A live delivery links to its run log: run rows carry no ticket number, so the
//    ticket page reads it from the run detail (before, it compared a field the list
//    never has and always said "no live run is attached").
//  - The blocked-write flag names the path the hook stopped, not the write root
//    (the old greedy match took "[write-roots: …]" for the target).
//  - An edit outside the agent's smallest-change note is flagged, and says it is derived.
//  - After Approve, a second press does nothing and the page stays on the change.
//  - The first `a` (or click) arms the button itself (its confirm label) and shows the
//    3s window; once approved, the done band is the sign-off's foot (no key hint).
//  - An empty queue is the clear desk: the board's counts and where the work went.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const ROOT = "/data/repos";
const T = {
  id: "tkt-1",
  number: 16,
  title: "Partial refunds",
  description: "Refund selected lines.",
  status: "in_review",
  risk_level: "high",
  policy_pack: "team_light",
  priority: 5,
  attempt_count: 0,
  branch_name: "gaffer/ticket-16",
  pr_url: null,
  can_be_tested: 0,
  test_contract: null,
  delivery_budget_usd: null,
  created_at: "2026-10-27T10:30:00Z",
  updated_at: "2026-10-29T11:48:00Z",
};
const DIFF = [
  "diff --git a/src/refund.ts b/src/refund.ts",
  "--- a/src/refund.ts",
  "+++ b/src/refund.ts",
  "@@ -1,1 +1,2 @@",
  " a",
  "+b",
  "diff --git a/src/tax/rateCache.ts b/src/tax/rateCache.ts",
  "--- a/src/tax/rateCache.ts",
  "+++ b/src/tax/rateCache.ts",
  "@@ -1,1 +1,1 @@",
  "-x",
  "+y",
].join("\n");
const EVIDENCE = [
  {
    id: "ev-fg7",
    evidence_type: "manual_note",
    summary:
      "FG-007 boundary violation(s) blocked by the safety hook during delivery:\n" +
      `BLOCKED by gaffer safety hook: write outside write-roots (target is in a read-only root): ${ROOT}/web-storefront/src/checkout/banner.tsx [write-roots: ${ROOT}/billing-api]`,
    created_by: "system",
    created_at: "2026-10-29T11:42:00Z",
  },
  {
    id: "ev-note-1234567",
    evidence_type: "manual_note",
    summary: "Smallest-change note: modified src/refund.ts.",
    created_by: "agent",
    recorded_by_agent: true,
    created_at: "2026-10-29T11:44:00Z",
  },
];

interface Opts {
  ticket?: Partial<typeof T>;
  runs?: unknown;
  runDetail?: Record<string, unknown>;
  events?: unknown[];
  queue?: unknown[];
}
let posts: string[] = [];
function stubFetch(o: Opts = {}): void {
  const ticket = { ...T, ...(o.ticket || {}) };
  posts = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init && init.method === "POST") posts.push(url);
      let body: unknown;
      if (o.queue && url.includes("status=in_review")) body = { tickets: o.queue };
      else if (url.includes("/review/approve"))
        body = { ticket: { ...ticket, status: "ready_for_merge" } };
      else if (url.includes("/diff"))
        body = {
          ticketId: ticket.id,
          repos: [
            {
              repo: "billing-api",
              branch: ticket.branch_name,
              baseBranch: "main",
              files: 2,
              additions: 2,
              deletions: 1,
              diff: DIFF,
              riskAnnotations: [],
            },
          ],
        };
      else if (url.includes("/claimability"))
        body = { ticketId: ticket.id, ready: true, blockers: [], warnings: [] };
      else if (url.includes("/work-repos"))
        body = {
          work_repos: {
            writeRepos: [{ id: "r1", name: "billing-api", access: "write", relation: "confirmed" }],
            readOnlyRepos: [],
            testRepos: [],
            deniedRepos: [],
            suggestedRepos: [],
            rejectedRepos: [],
          },
        };
      else if (url.includes("/repo-suggestions")) body = { suggestions: [] };
      else if (url.includes("/repositories")) body = { repositories: [] };
      else if (/\/api\/runs\/[^/?]+$/.test(url))
        body = { detail: o.runDetail || { ticket_number: null, run: { status: "running" } } };
      else if (url.includes("/api/runs")) body = o.runs || { active: [], recent: [] };
      else if (url.includes(`/tickets/${ticket.id}`))
        body = {
          ticket,
          acceptance_criteria: [],
          repositories: [
            { id: "r1", name: "billing-api", local_path: `${ROOT}/billing-api`, access: "write" },
            {
              id: "r2",
              name: "web-storefront",
              local_path: `${ROOT}/web-storefront`,
              access: "read",
            },
          ],
          scopes: [],
          blocking_decisions: [],
          dependencies: [],
          evidence: EVIDENCE,
          events: o.events || [],
          rework_trail: [],
        };
      else if (url.includes("/agents")) body = { agents: [] };
      else body = { tickets: [ticket] };
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
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
  for (let i = 0; i < 8; i++) await tick();
}

describe("web: Match Day review + ticket", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("reads a done ticket's boundary only: no access select, no Add repo form", async () => {
    stubFetch({ ticket: { status: "done" } });
    mount(`#/ticket/${T.id}`);
    await boot();
    const panel = document.querySelector(".repo-panel");
    expect(panel?.classList.contains("is-readonly")).toBe(true);
    expect(panel?.textContent).toContain("billing-api");
    expect(panel?.querySelector("select")).toBeNull();
    expect(panel?.querySelector("form")).toBeNull();
    expect(
      Array.from(panel?.querySelectorAll("button") || []).map((b) => b.textContent),
    ).not.toContain("Reject");
  });

  it("keeps the boundary editable before the merge", async () => {
    stubFetch({ ticket: { status: "ready" } });
    mount(`#/ticket/${T.id}`);
    await boot();
    const panel = document.querySelector(".repo-panel");
    expect(panel?.classList.contains("is-readonly")).toBe(false);
    expect(panel?.querySelector("select.access-select")).toBeTruthy();
    expect(panel?.querySelector("form")).toBeTruthy();
  });

  it("links a live delivery to its log via the run detail's ticket number", async () => {
    stubFetch({
      ticket: { status: "in_progress" },
      runs: {
        active: [
          { id: "run-9", kind: "poll_work", status: "running", started_at: "2026-10-29T18:32:47Z" },
        ],
        recent: [],
      },
      runDetail: {
        ticket_number: 16,
        phase: "implement",
        num_turns: 31,
        cost_usd: 1.02,
        run: { status: "running" },
      },
    });
    mount(`#/ticket/${T.id}`);
    await boot();
    const btn = document.querySelector(".tk-runs .run-viewlog");
    expect(btn?.textContent).toContain("View live log");
    expect(document.querySelector(".tk-runs")?.textContent).not.toContain(
      "no live run is attached",
    );
  });

  it("says so when a delivering ticket has no live run", async () => {
    stubFetch({
      ticket: { status: "in_progress" },
      runs: {
        active: [
          { id: "run-9", kind: "poll_work", status: "running", started_at: "2026-10-29T18:32:47Z" },
        ],
        recent: [],
      },
      runDetail: { ticket_number: 99, run: { status: "running" } },
    });
    mount(`#/ticket/${T.id}`);
    await boot();
    expect(document.querySelector(".tk-runs")?.textContent).toContain("no live run is attached");
    expect(document.querySelector(".tk-runs .run-viewlog")).toBeNull();
  });

  it("names the blocked target (not the write root) and flags an edit outside the stated change", async () => {
    stubFetch();
    mount(`#/review/${T.id}`);
    await boot();
    const flags = Array.from(document.querySelectorAll(".flag")).map((f) => f.textContent || "");
    const blocked = flags.find((f) => f.includes("Blocked write")) || "";
    expect(blocked).toContain("web-storefront/src/checkout/banner.tsx");
    expect(blocked).toContain("may write only to billing-api");
    const outside = flags.find((f) => f.includes("Edit outside the stated change")) || "";
    expect(outside).toContain("src/tax/rateCache.ts");
    expect(outside).toContain("Derived from");
    expect(flags.some((f) => f.includes("src/refund.ts is changed"))).toBe(false);
    const jumps = Array.from(document.querySelectorAll(".diff-filejump"));
    const rate = jumps.find((j) => j.textContent?.includes("rateCache"));
    expect(rate?.classList.contains("has-risk")).toBe(true);
  });

  it("stays on the change after Approve; a second press does nothing", async () => {
    stubFetch();
    mount(`#/review/${T.id}`);
    await boot();
    const btn = document.querySelector("button.signoff-btn") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    btn.click(); // arm
    btn.click(); // confirm
    for (let i = 0; i < 6; i++) await tick();
    expect(posts.filter((p) => p.includes("/review/approve"))).toHaveLength(1);
    expect(btn.textContent).toContain("Approved");
    const done = document.querySelector(".rv-done") as HTMLElement;
    expect(done.hidden).toBe(false);
    expect(location.hash).toBe(`#/review/${T.id}`);
    // The keyboard path: a, a again must not approve a second time.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    for (let i = 0; i < 6; i++) await tick();
    expect(posts.filter((p) => p.includes("/review/approve"))).toHaveLength(1);
  });

  it("the first `a` arms the button and shows the window; Esc puts it down", async () => {
    stubFetch();
    mount(`#/review/${T.id}`);
    await boot();
    const btn = document.querySelector("button.signoff-btn") as HTMLButtonElement;
    const hint = document.querySelector(".rv-arm") as HTMLElement;
    expect(hint.hidden).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(btn.textContent).toContain("Confirm approval");
    expect(btn.classList.contains("btn-armed")).toBe(true);
    expect(document.querySelector(".signoff")?.classList.contains("card-armed")).toBe(true);
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toContain("again to approve");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(btn.textContent).toBe("Approve");
    expect(btn.getAttribute("aria-label")).toBe("Approve");
    expect(hint.hidden).toBe(true);
    // A click-arm is put down by Esc too (it used to wait out the timer).
    btn.click();
    expect(btn.textContent).toContain("Confirm approval");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(btn.textContent).toBe("Approve");
    expect(posts.filter((p) => p.includes("/review/approve"))).toHaveLength(0);
  });

  it("once approved, the done band is the sign-off's foot and the key hint goes", async () => {
    stubFetch();
    mount(`#/review/${T.id}`);
    await boot();
    const btn = document.querySelector("button.signoff-btn") as HTMLButtonElement;
    btn.click();
    btn.click();
    for (let i = 0; i < 6; i++) await tick();
    const signoff = document.querySelector(".signoff") as HTMLElement;
    expect(signoff.querySelector(".rv-keys")).toBeNull();
    expect(signoff.lastElementChild?.classList.contains("rv-done")).toBe(true);
  });

  it("an empty queue is the clear desk: counts and where the work went", async () => {
    stubFetch({ ticket: { status: "ready_for_merge" }, queue: [] });
    mount("#/review");
    await boot();
    const app = document.getElementById("app") as HTMLElement;
    expect(app.querySelector(".rv-clear-board h1")?.textContent).toContain(
      "Nothing waits for your sign-off",
    );
    const cells = Array.from(app.querySelectorAll(".rv-clear-board .kpi")).map(
      (c) => c.textContent || "",
    );
    expect(cells.find((c) => c.startsWith("To merge"))).toContain("01");
    const results = app.querySelector(".rv-results")?.textContent || "";
    expect(results).toContain("#16");
    // No landing_state in this payload: the neutral word, never "merging".
    expect(results).toContain("Approved · to merge");
    expect(results).not.toMatch(/merging/i);
    expect(app.querySelector('.rv-results a[href="#/ticket/tkt-1"]')).toBeTruthy();
  });
});

// @vitest-environment jsdom
//
// ESCAPED DEFECTS (MF5) on the ticket page: the "Escaped defects" card lists the accepted
// changes a person linked this ticket to (with who filed it and a Withdraw control), the
// later tickets that regress this one, and a small form that files a link through
// POST /tickets/:id/regression-of. A read-only token sees the links and no control.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const TICKET = {
  id: "tkt-9",
  number: 9,
  title: "Export crashes on an empty list",
  description: "",
  status: "ready",
  risk_level: "low",
  policy_pack: "solo_loose",
  priority: 0,
  attempt_count: 0,
  branch_name: null,
  pr_url: null,
  can_be_tested: 0,
  test_contract: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const LINKED = {
  regression_of: [
    {
      ticket_id: "tkt-5",
      number: 5,
      title: "Add the export button",
      status: "done",
      filed_by: { type: "human", id: "tom" },
      filed_at: "2026-01-02T00:00:00Z",
      note: "crashes on empty",
    },
  ],
  regressed_by: [],
};

let posts: Array<{ url: string; body: unknown }> = [];
let capability = "full";
let regression: unknown = LINKED;

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      let body: unknown;
      if (init?.method === "POST") {
        posts.push({ url, body: JSON.parse(String(init.body ?? "{}")) });
        body = { recorded: true };
      } else if (url.includes("/api/whoami")) body = { capability };
      else if (url.includes(`/tickets/${TICKET.id}/diff`))
        body = { ticketId: TICKET.id, repos: [] };
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
          rework_trail: [],
          regression,
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
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
  for (let i = 0; i < 5; i += 1) await tick();
}
const card = () => document.querySelector<HTMLElement>(".tk-regressions");

describe("ticket page: escaped-defect links", () => {
  beforeEach(() => {
    vi.resetModules();
    posts = [];
    capability = "full";
    regression = LINKED;
    mountShell();
    stubFetch();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("lists the link with who filed it, withdraws it, and files a new one", async () => {
    await boot();
    const c = card();
    expect(c).not.toBeNull();
    const text = c!.textContent ?? "";
    expect(text).toMatch(/Regression of #5 Add the export button/);
    expect(text).toMatch(/filed by tom/);
    expect(text).toMatch(/crashes on empty/);
    expect(text).toMatch(/counts only the links a person files/);

    const withdraw = c!.querySelector<HTMLButtonElement>(
      'button[aria-label="Withdraw the regression link to #5"]',
    );
    withdraw!.click();
    for (let i = 0; i < 3; i += 1) await tick();
    expect(posts).toContainEqual({
      url: expect.stringContaining(`/tickets/${TICKET.id}/regression-of`),
      body: { of: "tkt-5", withdraw: true },
    });

    const form = card()!.querySelector<HTMLFormElement>("form.tk-regression-form")!;
    const [ref, note] = Array.from(form.querySelectorAll<HTMLInputElement>("input"));
    ref!.value = "#12";
    note!.value = "broke the totals";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    for (let i = 0; i < 3; i += 1) await tick();
    expect(posts).toContainEqual({
      url: expect.stringContaining(`/tickets/${TICKET.id}/regression-of`),
      body: { of: "12", note: "broke the totals" },
    });
  });

  it("shows the change's later regressions", async () => {
    regression = {
      regression_of: [],
      regressed_by: [{ ...LINKED.regression_of[0], ticket_id: "tkt-11", number: 11, title: "Fix" }],
    };
    await boot();
    expect(card()!.textContent).toMatch(/Regressed by #11 Fix/);
  });

  it("a read-only token sees the links and no control", async () => {
    capability = "read";
    await boot();
    const c = card();
    expect(c).not.toBeNull();
    expect(c!.querySelector("form")).toBeNull();
    expect(c!.querySelector("button")).toBeNull();
    expect(c!.textContent).toMatch(/Regression of #5/);
  });
});

// @vitest-environment jsdom
//
// BBT-001 DOM test: a human can record the independent tester's verdict from the board.
// An `in_testing` ticket's detail head offers "Record tester PASS" / "Record tester FAIL";
// PASS asks for a summary and POSTs {verdict:"pass", summary}; FAIL opens the reject
// dialog and POSTs {verdict:"fail", summary:<reason>}; an in_review ticket offers neither
// (the review actions stay the review actions). Before this the board had no action for
// in_testing at all, so a ticket the tester lane held (no verdict token) could only be
// moved on from a shell.
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

function ticket(status: string) {
  return {
    id: "tkt-1",
    number: 7,
    title: "Widget endpoint",
    description: "deliver it",
    status,
    risk_level: "low",
    policy_pack: "team_light",
    priority: 0,
    attempt_count: 0,
    branch_name: "feat/x",
    pr_url: null,
    can_be_tested: 1,
    test_contract: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

type Call = { method: string; url: string; body: unknown };
let calls: Call[] = [];

function stubFetch(t: ReturnType<typeof ticket>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      let parsed: unknown = null;
      if (typeof init?.body === "string") {
        try {
          parsed = JSON.parse(init.body);
        } catch {
          parsed = init.body;
        }
      }
      calls.push({ method, url, body: parsed });
      let body: unknown;
      if (url.includes(`/tickets/${t.id}/tester`)) body = { ticket: { ...t }, event_id: "ev" };
      else if (url.includes(`/tickets/${t.id}/diff`)) body = { ticketId: t.id, repos: [] };
      else if (url.includes(`/tickets/${t.id}/claimability`))
        body = { ticketId: t.id, ready: true, blockers: [], warnings: [] };
      else if (url.includes(`/tickets/${t.id}/work-repos`))
        body = {
          writeRepos: [],
          readOnlyRepos: [],
          testRepos: [],
          deniedRepos: [],
          suggestedRepos: [],
          rejectedRepos: [],
        };
      else if (url.includes(`/tickets/${t.id}`))
        body = {
          ticket: t,
          acceptance_criteria: [],
          repositories: [],
          scopes: [],
          blocking_decisions: [],
          dependencies: [],
          evidence: [],
          events: [],
        };
      else body = { tickets: [t] };
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
  location.hash = "#/ticket/tkt-1";
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function bootDetail(): Promise<void> {
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
  for (let i = 0; i < 4; i += 1) await tick();
}

function buttonByText(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined;
}
function testerCalls(): Call[] {
  return calls.filter((c) => c.method === "POST" && c.url.endsWith("/tickets/tkt-1/tester"));
}

describe("BBT-001 web: recording the tester's verdict from the board", () => {
  beforeEach(() => {
    calls = [];
    mountShell();
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("an in_testing ticket offers PASS and FAIL actions; PASS records the verdict with a summary", async () => {
    stubFetch(ticket("in_testing"));
    vi.stubGlobal(
      "prompt",
      vi.fn(() => "Probed the endpoint by hand; every AC holds"),
    );
    await bootDetail();
    const pass = buttonByText("Record tester PASS");
    const fail = buttonByText("Record tester FAIL");
    expect(pass, "PASS action present on in_testing").toBeDefined();
    expect(fail, "FAIL action present on in_testing").toBeDefined();
    expect(buttonByText("Approve"), "no review Approve on in_testing").toBeUndefined();

    pass!.click();
    for (let i = 0; i < 4; i += 1) await tick();
    expect(testerCalls()).toHaveLength(1);
    expect(testerCalls()[0]!.body).toEqual({
      verdict: "pass",
      summary: "Probed the endpoint by hand; every AC holds",
    });
  });

  it("PASS with an empty summary records nothing (a summary is required)", async () => {
    stubFetch(ticket("in_testing"));
    vi.stubGlobal(
      "prompt",
      vi.fn(() => "   "),
    );
    await bootDetail();
    buttonByText("Record tester PASS")!.click();
    for (let i = 0; i < 4; i += 1) await tick();
    expect(testerCalls()).toHaveLength(0);
  });

  it("FAIL goes through the reject dialog and records the reason as the failing observation", async () => {
    stubFetch(ticket("in_testing"));
    await bootDetail();
    buttonByText("Record tester FAIL")!.click();
    for (let i = 0; i < 3; i += 1) await tick();
    const input = document.querySelector<HTMLInputElement>(".reject-reason-input");
    expect(input, "the reject dialog opened").not.toBeNull();
    input!.value = "POST /widgets returns 500 on an empty name";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    // Confirm via the dialog's form submit / confirm button, whichever it exposes.
    const dialog = input!.closest("form, dialog, .modal, .reject-dialog, div");
    const confirm =
      (dialog &&
        Array.from(dialog.querySelectorAll("button")).find((b) =>
          /confirm|reject|record|ok|send/i.test(b.textContent || ""),
        )) ||
      undefined;
    if (confirm) confirm.click();
    else input!.form?.requestSubmit();
    for (let i = 0; i < 4; i += 1) await tick();
    expect(testerCalls()).toHaveLength(1);
    expect(testerCalls()[0]!.body).toEqual({
      verdict: "fail",
      summary: "POST /widgets returns 500 on an empty name",
    });
  });

  it("an in_review ticket offers no tester actions", async () => {
    stubFetch(ticket("in_review"));
    await bootDetail();
    expect(buttonByText("Record tester PASS")).toBeUndefined();
    expect(buttonByText("Record tester FAIL")).toBeUndefined();
  });
});

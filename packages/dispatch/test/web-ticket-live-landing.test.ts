// @vitest-environment jsdom
//
// The ticket page follows the live stream (exploratory finding ui-workflows/F4). The
// board and Review re-read themselves on every pushed event, but the ticket page was not
// a refreshable view: after Merge now landed a ticket it still read "Approved · landing"
// (or "waiting for Merge now") with Merge now and Mark merged on offer, until a reload.
// Now a pushed event re-reads the ticket, and a changed ticket re-renders the page.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const T = {
  id: "tkt-11",
  number: 11,
  title: "Land me",
  description: "d",
  status: "ready_for_merge",
  risk_level: "low",
  policy_pack: "solo_loose",
  priority: 0,
  attempt_count: 1,
  branch_name: "gaffer/ticket-11",
  pr_url: null,
  can_be_tested: 0,
  test_contract: null,
  delivery_budget_usd: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  landing_state: {
    kind: "landing",
    hold: null,
    label: "Approved · landing",
    detail: "The merge runner is landing it now.",
  },
};

let current: Record<string, unknown> = T;
let frames: string[] = [];
const ticketReads: string[] = [];

function json(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  current = T;
  ticketReads.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input).replace(/^https?:\/\/[^/]+/, "");
      if (url.startsWith("/api/events/stream")) {
        const body = frames.shift() ?? "";
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (url.includes(`/tickets/${T.id}/diff`)) return json({ ticketId: T.id, repos: [] });
      if (url.includes(`/tickets/${T.id}/work-repos`))
        return json({
          writeRepos: [],
          readOnlyRepos: [],
          testRepos: [],
          deniedRepos: [],
          suggestedRepos: [],
          rejectedRepos: [],
        });
      if (url === `/tickets/${T.id}`) {
        ticketReads.push(url);
        return json({
          ticket: current,
          acceptance_criteria: [],
          repositories: [],
          scopes: [],
          blocking_decisions: [],
          dependencies: [],
          evidence: [],
          events: [],
          rework_trail: [],
        });
      }
      return json({ tickets: [], active: [], recent: [] });
    }),
  );
  document.body.innerHTML = `
    <div id="toast" class="toast" role="alert" hidden></div>
    <div class="shell">
      <header id="appbar" class="appbar" hidden></header>
      <main id="app" class="app"><p class="loading">Loading…</p></main>
      <nav id="bottomnav" class="bottomnav" hidden></nav>
    </div>`;
  location.hash = `#/ticket/${T.id}`;
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const tick = () => new Promise((r) => setTimeout(r, 0));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const buttons = () => [...document.querySelectorAll("#app button")].map((b) => b.textContent);

describe("web: the ticket page updates live when a landing completes (exploratory finding ui-workflows/F4)", () => {
  it("a pushed event re-reads the ticket; Done replaces the approved status and its actions", async () => {
    // The stream stays quiet until the landing: one connect, then (after the page is up)
    // the ticket.transitioned event the merge runner's mark-merged wrote.
    frames = [": connected seq=1\n\n"];
    await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
    for (let i = 0; i < 10; i++) await tick();
    expect(document.querySelector(".tk-head")?.textContent).toContain("Approved · landing");
    expect(buttons()).toContain("Merge now");

    current = { ...T, status: "done", updated_at: "2026-01-01T00:05:00Z" };
    delete (current as { landing_state?: unknown }).landing_state;
    frames = [
      'id: 2\nevent: work_event\ndata: {"event_type":"ticket.transitioned","entity_id":"tkt-11"}\n\n',
    ];
    // Reconnect now (the app restarts the stream when the tab is shown again).
    document.dispatchEvent(new Event("visibilitychange"));
    await wait(900); // the stream's 400 ms debounce + the re-render
    for (let i = 0; i < 10; i++) await tick();
    expect(document.querySelector(".tk-head")?.textContent).not.toContain("Approved");
    expect(buttons()).not.toContain("Merge now");
    expect(buttons()).not.toContain("Mark merged");
    expect(document.querySelector(".tk-ft")).not.toBeNull(); // the Full time card
  });

  it("an event that does not change the ticket leaves the page as it is", async () => {
    frames = [": connected seq=1\n\n"];
    await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}-2`);
    for (let i = 0; i < 10; i++) await tick();
    const view = document.querySelector("#app > .view") as HTMLElement & { __mark?: boolean };
    view.__mark = true;
    frames = ['id: 2\nevent: work_event\ndata: {"event_type":"evidence.recorded"}\n\n'];
    document.dispatchEvent(new Event("visibilitychange"));
    await wait(900);
    for (let i = 0; i < 10; i++) await tick();
    const after = document.querySelector("#app > .view") as HTMLElement & { __mark?: boolean };
    expect(after.__mark).toBe(true);
  });
});

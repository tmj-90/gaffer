// @vitest-environment jsdom
//
// review-n-plus-one-refresh (dashboard-logic audit): the 9s refresh re-rendered
// the whole Review queue blindly — one GET /tickets/:id plus one GET
// /tickets/:id/diff (a spawnSync git on the API thread) per queued ticket, every
// tick — and the rebuild threw the reader back to the top of the page.
//
// Now the refresh first compares the queue's id@updated_at signature with the
// one the view on screen was rendered from; an unchanged queue costs ONE list
// request and touches no DOM. A changed queue still re-renders.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

let queue: Array<Record<string, unknown>> = [];
const calls: string[] = [];

function json(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/tickets?status=in_review")) return json({ tickets: queue });
      const diff = url.match(/\/tickets\/([^/?]+)\/diff/);
      if (diff) return json({ repos: [] });
      const detail = url.match(/\/tickets\/([^/?]+)$/);
      if (detail)
        return json({
          ticket: { id: detail[1] },
          acceptance_criteria: [],
          evidence: [],
          events: [],
        });
      if (url.includes("/api/dashboard")) return json({ summary: { ticketsByStatus: {} } });
      return json({});
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
  location.hash = "#/review";
}
const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) await tick();
}
const count = (re: RegExp) => calls.filter((u) => re.test(u)).length;
const DETAIL = /\/tickets\/rv-\d+$/;
const DIFF = /\/tickets\/rv-\d+\/diff$/;

describe("web: Review refresh only re-reads a changed queue", () => {
  beforeEach(() => {
    calls.length = 0;
    queue = [1, 2].map((n) => ({
      id: `rv-${n}`,
      number: n,
      title: `Review ${n}`,
      status: "in_review",
      risk_level: "low",
      updated_at: "2026-10-30T10:00:00Z",
    }));
    // Only the interval is faked: the 9s refresh fires on demand, fetch stays async.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    stubFetch();
    mountShell();
    vi.resetModules();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("skips the per-ticket reads and keeps the DOM when nothing changed", async () => {
    await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}-${Math.random()}`);
    await settle();
    // Match Day: Review shows ONE change per page (#/review opens the first in the
    // queue), so a first paint reads one ticket's detail and one diff, not N.
    expect(count(DETAIL)).toBe(1);
    expect(count(DIFF)).toBe(1);
    const before = document.querySelector("#app > .view");
    expect(before).not.toBeNull();

    vi.advanceTimersByTime(9000); // one refresh tick
    await settle();
    vi.advanceTimersByTime(9000); // and another
    await settle();

    // The refresh did run (it re-read the queue list each tick)…
    expect(count(/\/tickets\?status=in_review/)).toBe(3);
    // …but, no N+1: the unchanged queue triggered no detail or diff reads…
    expect(count(DETAIL)).toBe(1);
    expect(count(DIFF)).toBe(1);
    // …and the view on screen is the same node (scroll, open details, cursor kept).
    expect(document.querySelector("#app > .view")).toBe(before);
  });

  it("re-renders when a ticket in the queue changed", async () => {
    await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}-${Math.random()}`);
    await settle();
    const before = document.querySelector("#app > .view");
    queue[1] = { ...queue[1], updated_at: "2026-10-30T10:05:00Z", title: "Review 2 (redelivered)" };

    vi.advanceTimersByTime(9000);
    await settle(12);

    expect(document.querySelector("#app > .view")).not.toBe(before);
    expect(document.getElementById("app")!.textContent).toContain("Review 2 (redelivered)");
  });
});

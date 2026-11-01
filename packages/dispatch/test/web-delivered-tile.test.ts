// @vitest-environment jsdom
//
// The scoreboard's "Delivered today" is what its link shows (exploratory finding
// ui-explore/F-03): the tickets that landed today, which the Floor's lorry lists
// ("N despatched today"). It linked to the done list (every landing ever) and read
// "03" beside "On the pitch 4"; the figures are plain now (F-15).

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = (obj: unknown) =>
        new Response(JSON.stringify(obj), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (url.includes("/api/human-queue"))
        return json({
          items: [
            {
              kind: "decision",
              label: "Decision",
              reason: "Which?",
              ticket: null,
              decisionId: "d-1",
              severity: "human_required",
              since: new Date().toISOString(),
              waitedMs: 1000,
            },
          ],
          counts: { total: 1 },
        });
      if (url.includes("/api/dashboard"))
        return json({ summary: { ticketsByStatus: { done: 2 }, deliveredToday: 2 } });
      if (url.includes("/api/runs")) return json({ active: [], recent: [] });
      if (url.includes("/api/activity")) return json({ events: [], total: 0 });
      if (url.includes("/tickets")) return json({ tickets: [] });
      if (url.includes("/decisions")) return json({ decisions: [] });
      if (url.includes("/claims")) return json({ claims: [] });
      return json({});
    }),
  );
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const cell = (label: string) =>
  [...document.querySelectorAll<HTMLElement>(".scoreboard .kpi")].find(
    (k) => k.querySelector(".kpi-label")?.textContent === label,
  );

describe("web: Delivered today", () => {
  beforeEach(() => {
    vi.resetModules();
    stubFetch();
    document.body.innerHTML = `
      <div id="toast" class="toast" role="alert" hidden></div>
      <div class="shell">
        <header id="appbar" class="appbar" hidden></header>
        <main id="app" class="app"><p class="loading">Loading…</p></main>
        <nav id="bottomnav" class="bottomnav" hidden></nav>
      </div>`;
    location.hash = "#/overview";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("links to the Floor's lorry (today's landings), says so, and pads no figure", async () => {
    await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}-${Math.random()}`);
    for (let i = 0; i < 12; i++) await tick();
    const delivered = cell("Delivered today")!;
    expect(delivered.getAttribute("href")).toBe("#/floor");
    expect(delivered.title).toBe("2 tickets landed (done) today: the Floor's lorry shows them");
    expect(delivered.querySelector(".kpi-val")?.textContent).toBe("2");
    expect(cell("Need you")!.querySelector(".kpi-val")?.textContent).toBe("1");
  });
});

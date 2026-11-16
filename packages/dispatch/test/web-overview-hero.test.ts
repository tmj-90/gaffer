// @vitest-environment jsdom
//
// The Overview's hero says each number once (A-13, A-50, F-E4):
//  - how many need you is the headline's count; no Need-you cell repeats it;
//  - the sub line keeps only the queue's breakdown: the agents on the pitch and the
//    wage bill are the scoreboard cells' figures, not said again in words;
//  - on a phone the count stays and the blocked clauses stop at one, then "and N more
//    blocked" (a wide screen names two, then the rest as a count);
//  - "Delivered today" has a reference: "usual N", the median of the days before today
//    in the server's throughput series (none with too little history).

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const WEB = path.resolve(process.cwd(), "src/api/web");
const APP_JS = path.join(WEB, "app.js");

const BLOCKED = {
  id: "tk-10",
  number: 10,
  title: "Webhook delivery for task events",
  status: "blocked",
  updated_at: "2026-10-30T10:00:00Z",
};
const REVIEW = {
  id: "tk-12",
  number: 12,
  title: "Export tasks to CSV",
  status: "in_review",
  updated_at: "2026-10-30T10:00:00Z",
};
const MERGE = {
  id: "tk-14",
  number: 14,
  title: "Retry queue with backoff",
  status: "ready_for_merge",
  updated_at: "2026-10-30T10:00:00Z",
};
const item = (kind: string, t: { id: string; number: number; title: string; status: string }) => ({
  kind,
  label: kind,
  reason: kind === "parked" ? "rework_exhausted" : "please look",
  ticket: t,
  decisionId: null,
  severity: null,
  since: new Date(Date.now() - 60_000).toISOString(),
  waitedMs: 60_000,
});

let queue: { items: unknown[]; counts: Record<string, number> } = {
  items: [],
  counts: { total: 0 },
};
let tickets: unknown[] = [];
let claims: unknown[] = [];
let health: unknown = null;

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
      if (url.includes("/api/human-queue")) return json(queue);
      if (url.includes("/api/dashboard"))
        return json({
          summary: { ticketsByStatus: {}, activeClaims: claims.length, deliveredToday: 2 },
        });
      if (url.includes("/api/health")) return json(health);
      if (url.includes("/api/cost")) return json({ today_usd: 9.37 });
      if (url.includes("/settings"))
        return json({
          settings: [
            { key: "GAFFER_DAILY_BUDGET_USD", effective: "25" },
            { key: "GAFFER_CONCURRENCY", effective: "4" },
          ],
        });
      if (url.includes("/api/runs")) return json({ active: [], recent: [] });
      if (url.includes("/api/activity")) return json({ events: [], total: 0 });
      if (url.includes("/api/board")) return json(null);
      if (url.includes("/claims")) return json({ claims });
      if (url.match(/\/tickets\/tk-\d+$/)) return json({ ticket: {}, rework_trail: [] });
      if (url.includes("/tickets")) return json({ tickets });
      if (url.includes("/decisions")) return json({ decisions: [] });
      return json({});
    }),
  );
}

function mount(): void {
  document.body.innerHTML = `
    <div id="toast" class="toast" role="alert" hidden></div>
    <div class="shell">
      <header id="appbar" class="appbar" hidden></header>
      <main id="app" class="app"><p class="loading">Loading…</p></main>
      <nav id="bottomnav" class="bottomnav" hidden></nav>
    </div>`;
  location.hash = "#/overview";
}
const tick = () => new Promise((r) => setTimeout(r, 0));
async function boot(): Promise<void> {
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}-${Math.random()}`);
  for (let i = 0; i < 10; i++) await tick();
}
const hl = () => document.querySelector(".scoreboard h1.hl") as HTMLElement;

const BLOCKED2 = { ...BLOCKED, id: "tk-11", number: 11, title: "Retry webhook deliveries" };
const BLOCKED3 = { ...BLOCKED, id: "tk-13", number: 13, title: "Archive old tasks" };
const cell = (label: string) =>
  [...document.querySelectorAll<HTMLElement>(".scoreboard .kpi")].find(
    (k) => k.querySelector(".kpi-label")?.textContent === label,
  );

describe("web overview: the hero says each number once", () => {
  beforeEach(() => {
    vi.resetModules();
    stubFetch();
    mount();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
    queue = { items: [], counts: { total: 0 } };
    tickets = [];
    claims = [];
    health = null;
  });

  it("the count is the headline's; the sub line keeps only the queue's breakdown", async () => {
    tickets = [BLOCKED, REVIEW, MERGE];
    claims = [{ id: "c1", ticket_id: "tk-3", ticket_number: 3, ticket_title: "X", agent_id: "a" }];
    queue = {
      items: [item("parked", BLOCKED), item("review", REVIEW), item("awaiting_merge", MERGE)],
      counts: { total: 3 },
    };
    await boot();
    const labels = [...document.querySelectorAll(".scoreboard .kpi-label")].map(
      (n) => n.textContent,
    );
    expect(labels).toEqual(["On the pitch", "Delivered today", "Wage bill"]);
    expect(hl().querySelector(".hl-count")?.textContent).toBe("3 things need you.");
    const sub = document.querySelector(".scoreboard .hl-sub")?.textContent || "";
    expect(sub).toContain("1 diff awaits review");
    expect(sub).not.toMatch(/on the pitch/i);
    expect(sub).not.toMatch(/wage bill/i);
    expect(sub).not.toContain("$");
    // The figures the sub line dropped are the cells'.
    expect(cell("On the pitch")?.querySelector(".kpi-val")?.textContent).toBe("1/4");
    expect(cell("Wage bill")?.querySelector(".kpi-val")?.textContent).toBe("$9.37");
  });

  it("three blocked: two named on a wide screen, one on a phone, the rest as a count", async () => {
    tickets = [BLOCKED, BLOCKED2, BLOCKED3];
    queue = {
      items: [item("parked", BLOCKED), item("parked", BLOCKED2), item("parked", BLOCKED3)],
      counts: { total: 3 },
    };
    await boot();
    const blocks = [...hl().querySelectorAll(".hl-block")];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.classList.contains("hl-extra")).toBe(false);
    expect(blocks[1]!.classList.contains("hl-extra")).toBe(true);
    expect(hl().querySelector(".hl-more-phone")?.textContent).toBe("and 2 more blocked");
    expect(hl().querySelector(".hl-more-wide")?.textContent).toBe("and 1 more blocked");
    const css = readFileSync(path.join(WEB, "css/views/overview.css"), "utf8");
    const wide = css.slice(0, css.indexOf("@media (max-width: 760px)"));
    expect(wide).toMatch(/\.hl-more-phone \{\s*display: none;/);
  });

  it("calm: the squad's work is named without repeating the pitch count", async () => {
    claims = [
      {
        id: "c1",
        ticket_id: "tk-3",
        ticket_number: 3,
        ticket_title: "Webhook delivery",
        agent_id: "a",
      },
    ];
    await boot();
    const sub = document.querySelector(".scoreboard .hl-sub")?.textContent || "";
    expect(sub).toContain("Squad on Webhook delivery #3; 3 slots free");
    expect(sub).not.toMatch(/agents? on the pitch/);
  });

  it("Delivered today carries a usual day: the median of the days before today", async () => {
    // 13 past days (median 3) and today.
    health = {
      throughput: { series: [0, 1, 2, 3, 3, 3, 4, 5, 6, 2, 3, 4, 1, 2], last7: 0, prev7: 0 },
    };
    await boot();
    expect(cell("Delivered today")?.querySelector(".kpi-sub")?.textContent).toBe("usual 3");
  });

  it("no usual day with too little history", async () => {
    health = { throughput: { series: [1, 2, 2], last7: 0, prev7: 0 } };
    await boot();
    expect(cell("Delivered today")?.querySelector(".kpi-sub")).toBeNull();
  });
});

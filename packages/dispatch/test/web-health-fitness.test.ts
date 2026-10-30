// @vitest-environment jsdom
//
// DOM test for the Health view's physio room (src/api/web/app.js renderHealth):
//   - the Fitness test reads the squad's slots (claims vs GAFFER_CONCURRENCY), the
//     wage bill (today vs GAFFER_DAILY_BUDGET_USD) and the delivery line, each
//     number with its words;
//   - all-OK collapses to one sentence: "Fit to play." and no treatment table;
//   - something on the table leads the page and is listed as linked clauses.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const HEALTH = {
  total_usd: 10,
  cost_per_shipped_usd: 2,
  coverage: { coverage_pct: 100 },
  by_kind: [{ kind: "delivery", total_cost_usd: 10 }],
  daily_spend: [
    { date: "2026-10-28", total_cost_usd: 30 },
    { date: "2026-10-29", total_cost_usd: 4 },
  ],
  rework: { rework_cost_share_pct: 10, by_ticket: [{ ticket_id: "a" }] },
  duration: { total_ms: 120000, measured_calls: 2, avg_ms: 60000 },
  cycle_time: { median_days: 1, series: [] },
  throughput: { last7: 3, prev7: 1, series: [] },
  skills: { by_skill: [], overall_hit_rate_pct: null },
  recall: { available: false },
};

let tickets: unknown[] = [];
function stubFetch(summary: Record<string, unknown>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = (obj: unknown) =>
        new Response(JSON.stringify(obj), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (url.includes("/api/health")) return json(HEALTH);
      if (url.includes("/api/dashboard")) return json({ summary });
      if (url.includes("/api/cost"))
        return json({ total_usd: 10, today_usd: 4, today_estimated_usd: 0, ticket_count: 2 });
      if (url.includes("/claims"))
        return json({ claims: [{ status: "active" }, { status: "active" }] });
      if (url.includes("/api/settings"))
        return json({
          settings: [
            { key: "GAFFER_CONCURRENCY", effective: "3" },
            { key: "GAFFER_DAILY_BUDGET_USD", effective: "25" },
          ],
        });
      if (url.includes("/api/rework/bouncing")) return json({ bouncing: [] });
      if (url.includes("/api/runs")) return json({ active: [], recent: [] });
      if (url.includes("/tickets")) return json({ tickets });
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
  location.hash = "#/health";
}
const tick = () => new Promise((r) => setTimeout(r, 0));
async function loadApp(): Promise<void> {
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}-${Math.random()}`);
  for (let i = 0; i < 6; i++) await tick();
}
function ftCell(row: string, label: string): Element | undefined {
  const r = document.querySelector(`.ft-row[aria-label="${row}"]`);
  return Array.from(r?.querySelectorAll(".ft-cell") || []).find(
    (c) => c.querySelector(".ft-l")?.textContent === label,
  );
}

describe("web: Health — the physio room", () => {
  beforeEach(() => {
    vi.resetModules();
    mountShell();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("reads the fitness test from claims, settings, cost and health", async () => {
    stubFetch({ ticketsByStatus: { ready: 4 }, staleClaims: 0 });
    await loadApp();
    expect(ftCell("Squad", "In use")?.querySelector(".ft-v")?.textContent).toBe("2/3");
    expect(ftCell("Squad", "In use")?.textContent).toContain("1 free");
    expect(ftCell("Squad", "In use")?.querySelector(".band")?.getAttribute("aria-label")).toBe(
      "2 of 3 agent slots in use",
    );
    expect(ftCell("Squad", "Waiting")?.querySelector(".ft-v")?.textContent).toBe("4");
    expect(ftCell("Wage bill", "Spent today")?.querySelector(".ft-v")?.textContent).toBe("$4.00");
    expect(ftCell("Wage bill", "Spent today")?.textContent).toContain("of $25 a day");
    // One day in the ledger went past $25.
    expect(ftCell("Wage bill", "Days over")?.querySelector(".ft-v")?.textContent).toBe("1");
    expect(ftCell("Deliveries", "Rate")?.querySelector(".ft-v")?.textContent).toBe("3");
    expect(ftCell("Deliveries", "Reworked")?.querySelector(".ft-v")?.textContent).toBe("1");
  });

  it("collapses all-OK to one sentence and leaves the treatment table out", async () => {
    stubFetch({ ticketsByStatus: {}, staleClaims: 0, blocked: 0, openDecisions: 0 });
    await loadApp();
    expect(document.querySelector(".health-view h1")?.textContent).toBe("Fit to play.");
    expect(document.querySelector(".needs-hero")).toBeNull();
    expect(document.querySelector(".hl-clauses")).toBeNull();
  });

  it("leads with the treatment table and lists what is on it as links", async () => {
    stubFetch({ ticketsByStatus: { in_review: 2 }, blocked: 1, staleClaims: 0, openDecisions: 0 });
    await loadApp();
    // The headline counts what is on the table, the same sum its clauses and the
    // table's lines give (1 blocked + 2 to review = 3). It used to count the lines
    // ("2 things") while its clauses added up to 3.
    expect(document.querySelector(".health-view h1")?.textContent).toBe(
      "3 things on the treatment table.",
    );
    expect(document.querySelector(".needs-hero .panel-aux")?.textContent).toBe("3 things");
    const grid = document.querySelector(".hx-grid");
    expect(grid?.firstElementChild?.querySelector(".needs-hero")).not.toBeNull();
    const links = Array.from(document.querySelectorAll(".hl-clauses a")).map((a) => [
      a.textContent,
      a.getAttribute("href"),
    ]);
    expect(links).toEqual([
      ["1 blocked task", "#/work?status=blocked"],
      ["2 changes to review", "#/review"],
    ]);
    // Referee's marks, not line icons: a red square and a yellow card.
    expect(document.querySelector('.needs-item[data-sev="critical"] .g-blocked')).not.toBeNull();
    expect(document.querySelector('.needs-item[data-sev="waiting"] .ycard')).not.toBeNull();
  });

  it("counts each ticket once, under its worst complaint, with its tickets as links", async () => {
    // #6 is blocked and also held too long; #9 is only held. The table must not count #6 twice.
    tickets = [
      { id: "t6", number: 6, title: "Six", status: "blocked", updated_at: "2026-10-29T09:00:00Z" },
      { id: "t9", number: 9, title: "Nine", status: "draft", updated_at: "2026-10-20T09:00:00Z" },
    ];
    stubFetch({
      ticketsByStatus: { blocked: 1, draft: 1, ready: 2 },
      blocked: 1,
      staleClaims: 0,
      openDecisions: 0,
      stuckThresholdHours: 24,
      stuckTickets: [
        { id: "t9", number: 9, title: "Nine", status: "draft", stuckForMs: 9e8, since: "x" },
        { id: "t6", number: 6, title: "Six", status: "blocked", stuckForMs: 5e8, since: "y" },
      ],
    });
    await loadApp();
    expect(document.querySelector(".health-view h1")?.textContent).toBe(
      "2 things on the treatment table.",
    );
    const lines = Array.from(document.querySelectorAll(".needs-item")).map((li) => [
      li.querySelector(".ni-title")?.textContent,
      Array.from(li.querySelectorAll("a.ni-tk")).map((a) => a.getAttribute("href")),
    ]);
    expect(lines).toEqual([
      ["1 blocked task", ["#/ticket/t6"]],
      ["1 held too long", ["#/ticket/t9"]],
    ]);
    // Held too long is not a yellow card: yellow is "waits on your sign-off" only.
    expect(document.querySelector('.needs-item[data-sev="held"] .ycard')).toBeNull();
    // A full squad with work queued is not a yellow card either.
    expect(ftCell("Squad", "Waiting")?.querySelector(".ycard")).toBeNull();
    tickets = [];
  });

  it("collapses a source with nothing measured into one line, not an empty page", async () => {
    stubFetch({ ticketsByStatus: {}, staleClaims: 0, blocked: 0, openDecisions: 0 });
    await loadApp();
    expect(document.querySelector(".skill-panel")).toBeNull();
    expect(document.querySelector(".recall-panel")).toBeNull();
    const line = document.querySelector(".hx-unmeasured")?.textContent || "";
    expect(line).toMatch(/^Not measured yet: Skill hit-rate/);
    expect(line).toContain("Recall effectiveness");
    // The duplicates are gone: one cycle-time chart (inside the form guide), no
    // separate Flow efficiency or Progress by repository pages.
    expect(document.querySelectorAll(".form-guide .fg-chart").length).toBe(1);
    const titles = Array.from(document.querySelectorAll(".panel-title")).map((h) =>
      h.firstChild?.textContent?.trim(),
    );
    expect(titles).not.toContain("Cycle time");
    expect(titles).not.toContain("Flow efficiency");
    expect(titles).not.toContain("Progress by repository");
  });
});

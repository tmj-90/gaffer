// @vitest-environment jsdom
//
// The shared chart parts proven in a real view (dashboard visual pass, package P2): the
// Health form guide's cycle-time chart is a chartFigure + barChart (bars capped at 24px,
// nice ticks in a unit that fits: a 2-to-28-minute cycle reads in minutes, not "0.0
// days"; focusable bars; a table view), its Cycle time and Throughput cells carry the
// {t, v} sparkline at statCell size "row", and flow efficiency is a meter with no limit
// tick. A series the server did not serve draws no sparkline and reads "no data".

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");
const MIN = 60_000 / 86_400_000; // one minute, in days

let healthPayload: unknown;

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
      if (url.includes("/api/health")) return json(healthPayload);
      if (url.includes("/api/human-queue")) return json({ items: [], counts: { total: 0 } });
      if (url.includes("/api/runs")) return json({ active: [], recent: [] });
      if (url.includes("/api/dashboard"))
        return json({ summary: { ticketsByStatus: { done: 1 } } });
      if (url.includes("/api/activity")) return json({ events: [], total: 0 });
      if (url.includes("/api/cost")) return json(null);
      if (url.includes("/api/rework/bouncing")) return json({ bouncing: [] });
      if (url.includes("/tickets")) return json({ tickets: [] });
      if (url.includes("/decisions")) return json({ decisions: [] });
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
  for (let i = 0; i < 4; i++) await tick();
}
const cell = (label: string) =>
  [...document.querySelectorAll(".form-guide .kpi")].find(
    (k) => k.querySelector(".kpi-label")?.textContent === label,
  ) as HTMLElement | undefined;

describe("web: the form guide on the shared chart parts", () => {
  beforeEach(() => {
    stubFetch();
    mountShell();
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("draws the cycle chart as a chart figure with minute ticks, capped bars and a table view", async () => {
    const cycle = [...new Array(10).fill(0), 2 * MIN, 3 * MIN, 14 * MIN, 28.8 * MIN];
    healthPayload = {
      total_usd: 0,
      cycle_time: { median_days: 0.02, series: cycle },
      throughput: { last7: 4, prev7: 1, series: [0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 1] },
      flow_efficiency: { median_pct: 40, sample: 3 },
    };
    await loadApp();
    const fig = document.querySelector(".form-guide figure.chart-figure.fg-chart")!;
    expect(fig).not.toBeNull();
    expect(fig.querySelector("h3")?.textContent).toBe("Cycle time, by day");
    const bars = [...fig.querySelectorAll("path.bc-bar")];
    expect(bars.length).toBe(4);
    for (const b of bars) expect(Number(b.getAttribute("data-w"))).toBeLessThanOrEqual(24);
    expect(fig.querySelector("path.bc-bar.is-current")).not.toBeNull();
    const ticks = [...fig.querySelectorAll(".bc-ytick")].map((t) => t.textContent);
    expect(ticks.at(-1)).toMatch(/^\d+m$/);
    expect(fig.querySelectorAll(".bc-hit[tabindex='0']").length).toBe(1);
    (fig.querySelector("button.cf-toggle") as HTMLButtonElement).click();
    const rows = [...fig.querySelectorAll(".cf-table tbody tr")];
    expect(rows.length).toBe(14);
    expect(rows.at(-1)!.querySelector("td")?.textContent).toBe("28m");

    // The two daily series as {t, v} sparklines; every cell sized by statCell.
    const cyc = cell("Cycle time")!;
    expect(cyc.classList.contains("kpi--row")).toBe(true);
    expect(cyc.querySelector(".spark")?.getAttribute("aria-label")).toMatch(
      /^Cycle time, 14 days, /,
    );
    expect(cell("Throughput")!.querySelector(".spark")).not.toBeNull();
    // Flow efficiency has no limit, so its meter has no limit tick.
    const eff = document.querySelector(".form-guide .fg-eff .band")!;
    expect(eff.classList.contains("meter")).toBe(true);
    expect(eff.querySelector(".band-tick")).toBeNull();
    expect(eff.getAttribute("aria-label")).toBe(
      "Flow efficiency 40% of lead time with an agent working on the ticket",
    );
  });

  it("a series the server did not serve: no sparkline, and the days read no data", async () => {
    healthPayload = {
      total_usd: 0,
      cycle_time: { median_days: 0, series: [] },
      throughput: { last7: 0, prev7: 0, series: [] },
    };
    await loadApp();
    expect(cell("Cycle time")!.querySelector(".spark, .spark-svg")).toBeNull();
    expect(cell("Throughput")!.querySelector(".spark, .spark-svg")).toBeNull();
    const fig = document.querySelector(".form-guide .fg-chart")!;
    expect(fig.querySelectorAll("path.bc-bar").length).toBe(0);
    expect(fig.querySelector(".bc-hit")?.getAttribute("aria-label")).toMatch(/: no data$/);
  });
});

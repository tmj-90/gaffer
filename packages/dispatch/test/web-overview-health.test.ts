// @vitest-environment jsdom
//
// DOM test for the Overview cycle-time/throughput data-source consolidation
// (src/api/web/app.js renderOverview):
//   - The "Cycle time" and "Throughput" KPI cards now read the ONE authoritative
//     server-side definition from GET /api/health, NOT a client-side recompute.
//   - Proof: the ticket list carries a cycle that would compute to a DIFFERENT
//     number client-side; the card must show the /api/health value regardless.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");
const DAY = 86_400_000;

const zeros14 = () => new Array(14).fill(0);

// A health payload whose cycle-time/throughput deliberately differ from what the
// stubbed ticket list would produce client-side.
let healthPayload: unknown = {
  total_usd: 0,
  cycle_time: { median_days: 3.5, series: zeros14() },
  throughput: { last7: 9, prev7: 3, series: zeros14() },
};

// A single done ticket with a 10-day created→done span — if the client still
// recomputed cycle time, the card would read "10.0", not the health value.
let ticketsPayload: unknown = {
  tickets: [
    {
      id: "tk-1",
      number: 1,
      status: "done",
      created_at: new Date(Date.now() - 10 * DAY).toISOString(),
      updated_at: new Date(Date.now()).toISOString(),
    },
  ],
};

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
      if (url.includes("/tickets")) return json(ticketsPayload);
      if (url.includes("/decisions")) return json({ decisions: [] });
      if (url.includes("/api/audit")) return json({ available: false, entries: [] });
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
  location.hash = "#/overview";
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function loadApp(): Promise<void> {
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}-${Math.random()}`);
  await tick();
  await tick();
  await tick();
}

/** Find the .kpi-val text for the KPI card whose label matches. */
function kpiValue(label: string): string | null {
  const cards = Array.from(document.querySelectorAll(".kpi"));
  for (const card of cards) {
    if (card.querySelector(".kpi-label")?.textContent === label) {
      return card.querySelector(".kpi-val")?.textContent ?? null;
    }
  }
  return null;
}

describe("web: Overview cycle-time/throughput from /api/health", () => {
  beforeEach(() => {
    stubFetch();
    mountShell();
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("renders cycle-time and throughput from /api/health, not a client recompute", async () => {
    await loadApp();

    // Cycle time reads the server value (3.5), NOT the 10-day client cycle.
    expect(kpiValue("Cycle time")).toBe("3.5");
    // Throughput reads the server last7 (9), NOT the single stubbed done ticket.
    expect(kpiValue("Throughput")).toBe("9");
  });

  it("falls back to a zeroed shape when /api/health is unavailable", async () => {
    healthPayload = null;
    ticketsPayload = { tickets: [] };
    await loadApp();

    // With no health payload the cards still render (zeroed), never crashing.
    expect(kpiValue("Cycle time")).toBe("0.0");
    expect(kpiValue("Throughput")).toBe("0");

    // Restore for other tests.
    healthPayload = {
      total_usd: 0,
      cycle_time: { median_days: 3.5, series: zeros14() },
      throughput: { last7: 9, prev7: 3, series: zeros14() },
    };
    ticketsPayload = { tickets: [] };
  });
});

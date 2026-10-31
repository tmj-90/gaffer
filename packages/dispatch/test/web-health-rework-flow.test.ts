// @vitest-environment jsdom
//
// DOM test for what the Health view says about rework (third external review):
//   - the referee's Rework rate counts a ticket a REVIEWER sent back (not only the
//     runner's own retries) and says who can send a ticket back;
//   - the fixture is the review's: one ticket, $1, a review rejection, $3 → 1 of 1
//     merged tickets sent back, $3 (75%) on the attempts after the send-back.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const HEALTH = {
  total_usd: 4,
  shipped_count: 1,
  cost_per_shipped_usd: 4,
  coverage: { measured_count: 2, total_count: 2, coverage_pct: 100 },
  by_kind: [{ kind: "delivery", total_cost_usd: 4, count: 2 }],
  by_model: [],
  daily_spend: [{ date: "2026-10-30", total_cost_usd: 4 }],
  rework: {
    total_rework_cost_usd: 3,
    rework_cost_share_pct: 75,
    by_ticket: [
      {
        ticket: 1,
        rework_count: 1,
        review_send_backs: 1,
        runner_retries: 0,
        ticket_cost_usd: 4,
        rework_cost_usd: 3,
        rework_attempts: 1,
        basis: "attempt",
      },
    ],
  },
  duration: { total_ms: 0, measured_calls: 0, avg_ms: 0 },
  cycle_time: { median_days: 0.2, series: [] },
  throughput: { last7: 1, prev7: 0, series: [] },
  flow_efficiency: { median_pct: 100, sample: 1 },
  governance: {
    windowDays: 30,
    empty: false,
    mergeRate: { rate: 1, numerator: 1, denominator: 1 },
    reworkRate: { rate: 1, numerator: 1, denominator: 1 },
    unattendedSafeRate: { rate: null, numerator: 0, denominator: 0 },
    counts: {
      merged: 1,
      rejected: 0,
      reworked: 1,
      unattendedMerges: 0,
      unattendedReopened: 0,
      youngestUnattendedMergeAgeMs: null,
    },
  },
  skills: { by_skill: [], overall_hit_rate_pct: null },
  recall: { available: false },
};

let health: Record<string, unknown> = HEALTH;
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
      if (url.includes("/api/health")) return json(health);
      if (url.includes("/api/dashboard"))
        return json({ summary: { ticketsByStatus: { done: 1 }, staleClaims: 0 } });
      if (url.includes("/api/cost"))
        return json({ total_usd: 4, today_usd: 0, today_estimated_usd: 0, ticket_count: 1 });
      if (url.includes("/claims")) return json({ claims: [] });
      if (url.includes("/api/settings")) return json({ settings: [] });
      if (url.includes("/api/rework/bouncing")) return json({ bouncing: [] });
      if (url.includes("/api/runs")) return json({ active: [], recent: [] });
      if (url.includes("/tickets"))
        return json({ tickets: [{ id: "t1", number: 1, status: "done", title: "Export" }] });
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
  for (let i = 0; i < 8; i++) await tick();
}
function govTile(label: string): Element | undefined {
  return Array.from(document.querySelectorAll(".gov-tile")).find(
    (t) => t.querySelector(".gov-tile-label")?.textContent === label,
  );
}

describe("web: Health — rework a reviewer caused", () => {
  beforeEach(() => {
    vi.resetModules();
    health = HEALTH;
    mountShell();
    stubFetch();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("the referee's Rework rate reads 1 of 1 sent back, and says who sends tickets back", async () => {
    await loadApp();
    const tile = govTile("Rework rate");
    expect(tile?.querySelector(".gov-tile-val")?.textContent).toBe("100%");
    expect(tile?.querySelector(".gov-tile-sub")?.textContent).toBe(
      "1 of 1 merged in 30 days had been sent back first, by a reviewer, the tester or a failed gate",
    );
  });
});

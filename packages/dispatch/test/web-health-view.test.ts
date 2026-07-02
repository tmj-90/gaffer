// @vitest-environment jsdom
//
// DOM test for the SPA Health / ROI view (src/api/web/app.js renderHealth):
//   - renders the ROI KPI row from /api/health (cost/feature, skill hit-rate,
//     spend-by-kind, rework-cost share, measured-coverage %),
//   - surfaces the two newly-wired sources (skill hit-rate detail + recall trend),
//   - degrades gracefully when a source is unavailable (skills empty + recall
//     available:false) — clean "—" / "not wired" cells, never a broken card.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

// A fully-populated health payload (both dead sources wired).
const FULL_HEALTH: unknown = {
  total_usd: 2.0,
  ticket_count: 3,
  shipped_count: 2,
  cost_per_shipped_usd: 1.0,
  coverage: { measured_count: 8, total_count: 10, coverage_pct: 80 },
  by_kind: [
    { kind: "delivery", total_cost_usd: 1.4, count: 5 },
    { kind: "review", total_cost_usd: 0.6, count: 3 },
  ],
  by_model: [],
  daily_spend: [
    { date: "2025-01-10", total_cost_usd: 0.9 },
    { date: "2025-01-11", total_cost_usd: 1.1 },
  ],
  rework: { total_rework_cost_usd: 0.3, rework_cost_share_pct: 15, by_ticket: [] },
  duration: { total_ms: 0, measured_calls: 0, avg_ms: 0 },
  cycle_time: { median_days: 0, series: [] },
  throughput: { last7: 0, prev7: 0, series: [] },
  skills: {
    total_records: 4,
    total_selected: 10,
    total_applied: 7,
    overall_hit_rate_pct: 70,
    by_skill: [
      { skill: "run-tests", selected: 4, applied: 4, hit_rate_pct: 100 },
      { skill: "frontend-component", selected: 6, applied: 3, hit_rate_pct: 50 },
    ],
    last_record_at: "2025-01-11T10:00:00Z",
  },
  recall: {
    available: true,
    total: 4,
    clean: 3,
    reworked: 1,
    blocked: 0,
    effectiveness_pct: 75,
    items_adjusted: 9,
    by_day: [
      { date: "2025-01-10", clean: 2, reworked: 0, blocked: 0, total: 2, effectiveness_pct: 100 },
      { date: "2025-01-11", clean: 1, reworked: 1, blocked: 0, total: 2, effectiveness_pct: 50 },
    ],
    last_applied_at: "2025-01-11T10:00:00Z",
  },
  last_record_at: "2025-01-11T11:00:00Z",
};

// A degraded payload: no skill telemetry, Memory unwired.
const DEGRADED_HEALTH: unknown = {
  total_usd: 0,
  ticket_count: 0,
  shipped_count: 0,
  cost_per_shipped_usd: null,
  coverage: { measured_count: 0, total_count: 0, coverage_pct: 0 },
  by_kind: [],
  by_model: [],
  daily_spend: [],
  rework: { total_rework_cost_usd: 0, rework_cost_share_pct: 0, by_ticket: [] },
  duration: { total_ms: 0, measured_calls: 0, avg_ms: 0 },
  cycle_time: { median_days: 0, series: [] },
  throughput: { last7: 0, prev7: 0, series: [] },
  skills: {
    total_records: 0,
    total_selected: 0,
    total_applied: 0,
    overall_hit_rate_pct: null,
    by_skill: [],
    last_record_at: null,
  },
  recall: { available: false, reason: "Memory is not configured — set MEMORY_CLI_BIN." },
  last_record_at: null,
};

let healthPayload: unknown = FULL_HEALTH;

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
  await tick();
  await tick();
  await tick();
}

/** Find the .kpi-val text for the KPI card whose label matches. */
function kpiValue(label: string): string | null {
  for (const card of Array.from(document.querySelectorAll(".kpi"))) {
    if (card.querySelector(".kpi-label")?.textContent === label) {
      return card.querySelector(".kpi-val")?.textContent ?? null;
    }
  }
  return null;
}

describe("web: Health view", () => {
  beforeEach(() => {
    stubFetch();
    mountShell();
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
    healthPayload = FULL_HEALTH;
  });

  it("renders the ROI KPI row and both wired-source detail panels", async () => {
    healthPayload = FULL_HEALTH;
    await loadApp();

    // The view header names the surface.
    expect(document.querySelector(".health-view h1")?.textContent).toBe("Health");

    // ROI KPI row: five headline metrics from /api/health.
    expect(kpiValue("Cost / feature")).toBe("$1.000");
    expect(kpiValue("Skill hit-rate")).toBe("70");
    expect(kpiValue("Spend by kind")).toBe("70"); // delivery 1.4 / 2.0 = 70%
    expect(kpiValue("Rework cost")).toBe("15");
    expect(kpiValue("Measured coverage")).toBe("80");

    // Skill hit-rate detail lists the per-skill rows.
    const skillRows = document.querySelectorAll(".hrow");
    const names = Array.from(skillRows).map((r) => r.querySelector(".hrow-name")?.textContent);
    expect(names).toContain("run-tests");
    expect(names).toContain("frontend-component");

    // Recall-effectiveness panel is present with its figures + trend spark.
    const body = document.body.textContent ?? "";
    expect(body).toContain("Recall effectiveness");
    expect(body).toContain("Effectiveness");
    expect(document.querySelector(".health-spark svg")).not.toBeNull();
  });

  it("degrades cleanly when skills telemetry is empty and Memory is not wired", async () => {
    healthPayload = DEGRADED_HEALTH;
    await loadApp();

    // Cost/feature has no shipped divisor and skill hit-rate has no telemetry —
    // both render a clean em dash, not a broken card.
    expect(kpiValue("Cost / feature")).toBe("—");
    expect(kpiValue("Skill hit-rate")).toBe("—");
    expect(kpiValue("Spend by kind")).toBe("—");

    // The recall panel shows the "not wired" reason, never a crash.
    const body = document.body.textContent ?? "";
    expect(body).toContain("Recall effectiveness");
    expect(body).toMatch(/not wired|not configured/i);
    // No skill rows rendered; the empty-state note stands in.
    expect(document.querySelectorAll(".hrow").length).toBe(0);
    expect(body).toMatch(/No skill telemetry/i);
  });
});

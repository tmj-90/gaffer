// @vitest-environment jsdom
//
// DOM test for what the Health view says about rework (third external review):
//   - the referee's Rework rate counts a ticket a REVIEWER sent back (not only the
//     runner's own retries) and says who can send a ticket back;
//   - the fixture is the review's: one ticket, $1, a review rejection, $3 → 1 of 1
//     merged tickets sent back, $3 (75%) on the attempts after the send-back;
//   - flow efficiency claims only agent-working time: 11 minutes to merge-ready then a
//     week in the merge queue reads "<1%", with the week shown as the merge wait, and
//     with no server figure it reads "—" (never the old WIP ratio's 100%).

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
  flow_efficiency: { median_pct: 0.1, sample: 1 },
  waiting: {
    sample: 1,
    queue_pct: 99.9,
    queue_ms: 7 * 86_400_000 + 3 * 60_000,
    review_ms: 3 * 60_000,
    merge_wait_ms: 7 * 86_400_000,
    merge_wait_max_ms: 7 * 86_400_000,
    held_ms: 0,
    backlog_ms: 60_000,
  },
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

  it("flow efficiency counts only agent-working time and shows the week in the merge queue", async () => {
    await loadApp();
    const kpi = Array.from(document.querySelectorAll(".form-guide .kpi")).find(
      (k) => k.querySelector(".kpi-label")?.textContent === "Flow efficiency",
    );
    expect(kpi?.querySelector(".kpi-val")?.textContent).toBe("<1");
    expect(kpi?.querySelector(".kpi-sub")?.textContent).toBe("of lead time an agent worked");
    const eff = document.querySelector(".form-guide .fg-eff");
    expect(eff?.querySelector(".band")?.getAttribute("aria-label")).toBe(
      "Flow efficiency <1% of lead time with an agent working on the ticket",
    );
    expect(eff?.textContent).toContain("not how long anyone actively reviewed it");
    const rows = Array.from(eff?.querySelectorAll(".fg-wait > div") || []).map((d) => [
      d.querySelector("dt")?.textContent,
      d.querySelector("dd")?.firstChild?.textContent,
    ]);
    expect(rows).toContainEqual(["Waiting to merge", "7d 0h"]);
    expect(rows).toContainEqual(["In review or testing", "3m"]);
    expect(rows).toContainEqual(["Queued after work began", "100%"]);
    expect(eff?.querySelector(".fg-wait")?.getAttribute("aria-label")).toBe(
      "Where shipped tickets waited, the median",
    );
  });

  it("with no server figure, flow efficiency reads a dash, never the old WIP ratio's 100%", async () => {
    health = {
      ...HEALTH,
      flow_efficiency: { median_pct: null, sample: 0 },
      waiting: { sample: 0 },
    };
    await loadApp();
    const kpi = Array.from(document.querySelectorAll(".form-guide .kpi")).find(
      (k) => k.querySelector(".kpi-label")?.textContent === "Flow efficiency",
    );
    expect(kpi?.querySelector(".kpi-val")?.textContent).toBe("—");
    expect(document.querySelector(".form-guide .fg-eff")?.textContent).toContain(
      "No shipped ticket has a transition history yet.",
    );
  });
});

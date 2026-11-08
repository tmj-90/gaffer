// @vitest-environment jsdom
//
// DOM test for the Health view's "What each lane changed" card (D1): per judging lane, how
// often it differed from the person's decision, how often it was the only lane on a
// send-back and its cost per attempt; "no verdicts recorded" where a lane has none; and a
// footnote that recommends nothing and says safety lanes are never switched off.
// The harness below is the one web-health-view.test.ts uses (src/api/web/app.js renderHealth):
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

const LANE_VALUE = {
  measure: "lane_value",
  attempts: 5,
  attempts_with_person_decision: 4,
  send_backs: 4,
  send_backs_no_lane_caught: 1,
  lanes: [
    {
      lane: "agent-review",
      label: "Reviewer agent",
      safety: false,
      verdicts_recorded: 5,
      by_verdict: { approve: 4, changes: 1 },
      attempts_judged: 5,
      compared: 4,
      differed: 2,
      differed_lane_blocked: 0,
      differed_lane_passed: 2,
      unique_catches: 1,
      spend_usd: 0.5,
      ledger_calls: 5,
      ledger_attempts: 5,
      cost_per_attempt_usd: 0.1,
      note: null,
    },
    {
      lane: "security-review",
      label: "Security review",
      safety: true,
      verdicts_recorded: 2,
      by_verdict: { changes: 1, approve: 1 },
      attempts_judged: 2,
      compared: 2,
      differed: 0,
      differed_lane_blocked: 0,
      differed_lane_passed: 0,
      unique_catches: 1,
      spend_usd: 0.6,
      ledger_calls: 2,
      ledger_attempts: 2,
      cost_per_attempt_usd: 0.3,
      note: null,
    },
    {
      lane: "plan-debate",
      label: "Plan debate",
      safety: false,
      verdicts_recorded: 0,
      by_verdict: {},
      attempts_judged: 0,
      compared: 0,
      differed: 0,
      differed_lane_blocked: 0,
      differed_lane_passed: 0,
      unique_catches: 0,
      spend_usd: null,
      ledger_calls: 0,
      ledger_attempts: 0,
      cost_per_attempt_usd: null,
      note: "no verdicts recorded",
    },
  ],
  footnote:
    "Counts only, no recommendation: whether a lane is worth its cost is a person's call. The security review and the tester are safety lanes and are never switched off by telemetry.",
  limits: [],
};

const card = () => document.querySelector<HTMLElement>('[aria-label="What each lane changed"]');
const laneLine = (lane: string) =>
  card()?.querySelector<HTMLElement>(`li[data-lane="${lane}"]`)?.textContent ?? "";

describe("web: Health shows what each lane changed", () => {
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

  it("one line per lane with the server's counts, and the footnote", async () => {
    healthPayload = { ...(FULL_HEALTH as object), lane_value: LANE_VALUE };
    await loadApp();
    expect(card()).not.toBeNull();
    expect(card()!.textContent).toMatch(/5 attempts · 4 decided by a person/);
    expect(laneLine("agent-review")).toMatch(/5 verdicts/);
    expect(laneLine("agent-review")).toMatch(/differed from the person 2 of 4/);
    expect(laneLine("agent-review")).toMatch(/2 it passed and the person sent back/);
    expect(laneLine("agent-review")).toMatch(/only lane on 1 send-back/);
    expect(laneLine("agent-review")).toMatch(/\$0\.10 per attempt over 5/);
    expect(laneLine("security-review")).toMatch(/safety lane/);
    expect(laneLine("plan-debate")).toMatch(/Plan debate no verdicts recorded/);
    const foot = card()!.querySelector(".lane-value-foot")?.textContent ?? "";
    expect(foot).toMatch(/1 of 4 send-backs no lane asked for/);
    expect(foot).toMatch(/never switched off by telemetry/);
    expect(card()!.textContent).not.toMatch(/disable|turn off/i);
  });

  // BLINDING (review13/4): the eval judge's line says which decisions were made blind and
  // which after the person opened the judge's view.
  it("the eval judge's line splits blind decisions from those made after a reveal", async () => {
    const judge = {
      ...LANE_VALUE.lanes[0],
      lane: "eval-judge",
      label: "Eval judge",
      verdicts_recorded: 6,
      compared: 5,
      differed: 2,
      blinding: { blind: { compared: 3, differed: 2 }, revealed: { compared: 2, differed: 0 } },
    };
    healthPayload = {
      ...(FULL_HEALTH as object),
      lane_value: { ...LANE_VALUE, lanes: [...LANE_VALUE.lanes, judge] },
    };
    await loadApp();
    expect(laneLine("eval-judge")).toMatch(/blind decisions: differed 2 of 3/);
    expect(laneLine("eval-judge")).toMatch(
      /after the judge's view was opened: 0 of 2 \(the grade may have swayed those\)/,
    );
    // Other lanes carry no blinding line.
    expect(laneLine("agent-review")).not.toMatch(/blind decisions/);
  });

  it("an older server without the report shows no card", async () => {
    healthPayload = FULL_HEALTH;
    await loadApp();
    expect(card()).toBeNull();
  });
});

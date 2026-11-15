// @vitest-environment jsdom
//
// The rendered Health page as a whole (dashboard visual pass V1): the quality story first.
//   - at most two block heads (A-03: only the four measures keep one),
//   - every section heading is on the one scale (level 2, 3 or 4),
//   - the four measure tiles are the first thing in the scoreboard strip, all four,
//     each with its period chip, delta against the period before and weekly sparkline,
//   - no sparkline is fed fewer than 4 points (and none plots categories),
//   - the Referee's record window select repaints the four measures too.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");
const DAY = 86_400_000;

/** 12 UTC weeks ending this week; `v(i)` gives each week's fields (null for a gap). */
function weeks(v: (i: number) => Record<string, unknown>): Record<string, unknown>[] {
  const now = Date.now();
  const mon = now - ((new Date(now).getUTCDay() + 6) % 7) * DAY;
  return Array.from({ length: 12 }, (_, i) => {
    const t = new Date(mon - (11 - i) * 7 * DAY);
    return {
      week: `W${i}`,
      start: t.toISOString().slice(0, 10),
      partial: i === 11,
      ...v(i),
    };
  });
}

function months(): Record<string, unknown>[] {
  const d = new Date();
  return Array.from({ length: 6 }, (_, i) => {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - (5 - i), 1));
    return {
      month: m.toISOString().slice(0, 7),
      partial: i === 5,
      accepted: 10 + i,
      escaped: 0,
      rate_pct: 0,
      maturing: i >= 4,
    };
  });
}

function payload(windowDays: number): Record<string, unknown> {
  return {
    total_usd: 20,
    shipped_count: 30,
    cost_per_shipped_usd: 0.66,
    coverage: { measured_count: 10, total_count: 10, coverage_pct: 100 },
    by_kind: [
      { kind: "delivery", total_cost_usd: 14 },
      { kind: "review", total_cost_usd: 6 },
    ],
    // A category list and daily spend: the old ROI strip drew both as sparklines.
    daily_spend: [
      { date: "2026-11-01", total_cost_usd: 1 },
      { date: "2026-11-02", total_cost_usd: 2 },
      { date: "2026-11-03", total_cost_usd: 3 },
      { date: "2026-11-04", total_cost_usd: 4 },
      { date: "2026-11-05", total_cost_usd: 5 },
    ],
    rework: { total_rework_cost_usd: 1, rework_cost_share_pct: 5, by_ticket: [] },
    skills: {
      total_records: 5,
      total_selected: 40,
      total_applied: 20,
      overall_hit_rate_pct: 50,
      by_skill: [
        { skill: "a", selected: 12, applied: 6, hit_rate_pct: 50 },
        { skill: "b", selected: 12, applied: 12, hit_rate_pct: 100 },
        { skill: "c", selected: 8, applied: 2, hit_rate_pct: 25 },
        { skill: "d", selected: 8, applied: 0, hit_rate_pct: 0 },
      ],
    },
    recall: { available: false, reason: "Memory is not configured." },
    event_log: { chain_ok: true, events: 99, broken_at_seq: null, reason: null },
    cycle_time: { median_days: 2, p75_days: 3, p90_days: 4, series: [], series_n: [] },
    throughput: { last7: 3, prev7: 2, series: [] },
    first_pass: {
      done: 30,
      first_pass: 27,
      rate_pct: 90,
      window_days: windowDays,
      strict: { first_pass: 25, rate_pct: 83.3 },
      by_approver: { human: { done: 30, first_pass: 27, rate_pct: 90 } },
      previous: { done: 20, first_pass: 16, rate_pct: 80 },
      by_week: weeks((i) =>
        i < 3
          ? { done: 0, first_pass: 0, rate_pct: null }
          : { done: 5, first_pass: 4, rate_pct: 80 + i },
      ),
    },
    review_time: {
      window_days: windowDays,
      basis_note: "Decision time.",
      per_accepted_ticket: {
        n: 30,
        median_ms: 20 * 60_000,
        p75_ms: 25 * 60_000,
        p90_ms: 30 * 60_000,
      },
      previous: { per_accepted_ticket: { n: 20, median_ms: 30 * 60_000 } },
      // Only three weeks with a figure: too few for a sparkline.
      by_week: weeks((i) =>
        i < 9 ? { n: 0, median_ms: null } : { n: 4, median_ms: 60_000 * (20 + i) },
      ),
    },
    accepted_change: {
      window_days: windowDays,
      accepted_changes: 30,
      cost_per_accepted_change_usd: 0.5,
      attempts_per_accepted_change: 1.2,
      unattributed_usd: 2,
      by_outcome: {
        accepted: { tickets: 30, spend_usd: 12 },
        parked_or_failed: { tickets: 2, spend_usd: 3 },
      },
      previous: { accepted_changes: 4, cost_per_accepted_change_usd: 0.9 },
      by_week: weeks(() => ({ accepted: 3, spend_usd: 1.5, cost_per_accepted_change_usd: 0.5 })),
    },
    escaped_defects: {
      recorded: true,
      window_days: windowDays,
      accepted_changes: 30,
      escaped: 0,
      rate_pct: 0,
      upper_95_pct: 11.4,
      previous: { accepted_changes: 20, escaped: 1, rate_pct: 5 },
      maturing_days: 30,
      by_month: months(),
      note: "Counts only what a person filed.",
    },
    governance: {
      windowDays,
      empty: false,
      mergeRate: { rate: 0.9, numerator: 27, denominator: 30 },
      reworkRate: { rate: 0.1, numerator: 3, denominator: 30 },
      unattendedSafeRate: { rate: null, numerator: 0, denominator: 0 },
      counts: {},
    },
    lane_value: {
      attempts: 3,
      attempts_with_person_decision: 2,
      send_backs: 0,
      send_backs_no_lane_caught: 0,
      lanes: [
        {
          lane: "tester",
          label: "Tester",
          safety: true,
          verdicts_recorded: 3,
          compared: 2,
          differed: 1,
          differed_lane_blocked: 1,
          differed_lane_passed: 0,
          unique_catches: 0,
          cost_per_attempt_usd: 0.1,
          ledger_attempts: 3,
          note: null,
        },
      ],
      footnote: "Counts only.",
    },
    routing_scorecard: { min_n: 10, rows: 1, manifests: 1, cells: [], footnote: "Report only." },
    scout: {
      attempts: 2,
      tickets: 2,
      with_index_items: 1,
      named_only: 0,
      empty: 1,
      risk_raised: 0,
      first_pass: { index_items: { done: 1, first_pass: 1 } },
      limits: [],
    },
    code_index: { available: false, reason: "Memory is not configured." },
    last_record_at: null,
  };
}

const requests: string[] = [];
function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      const json = (obj: unknown) =>
        new Response(JSON.stringify(obj), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (url.includes("/api/health")) {
        const wd = Number(/window_days=(\d+)/.exec(url)?.[1] ?? 30);
        return json(payload(wd));
      }
      if (url.includes("/api/dashboard")) return json({ summary: { ticketsByStatus: {} } });
      if (url.includes("/api/runs")) return json({ active: [], recent: [] });
      if (url.includes("/tickets")) return json({ tickets: [] });
      if (url.includes("/decisions")) return json({ decisions: [] });
      if (url.includes("/api/rework/bouncing")) return json({ bouncing: [] });
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

const LABELS = [
  "First-pass acceptance",
  "Human review time",
  "Accepted-change cost",
  "Escaped-defect rate",
];

describe("web: the rendered Health page tells the quality story first", () => {
  beforeEach(() => {
    requests.length = 0;
    stubFetch();
    mountShell();
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("has at most two block heads, and the four measures keep one", async () => {
    await loadApp();
    const view = document.querySelector(".health-view")!;
    expect(view).not.toBeNull();
    const blocks = [...view.querySelectorAll(".panel-head.block")];
    expect(blocks.length).toBeLessThanOrEqual(2);
    expect(blocks.map((b) => b.querySelector(".panel-title")?.firstChild?.textContent)).toEqual([
      "The four measures",
    ]);
  });

  it("every section heading is level 2, 3 or 4 on the one scale", async () => {
    await loadApp();
    const view = document.querySelector(".health-view")!;
    expect(view.querySelectorAll("h5, h6").length).toBe(0);
    expect([...view.querySelectorAll("h1")].map((h) => h.className)).toEqual(["hl"]);
    const heads = [...view.querySelectorAll("h2, h3, h4")];
    expect(heads.length).toBeGreaterThan(10);
    for (const h of heads) {
      const lvl = Number(h.tagName.slice(1));
      const onScale = h.classList.contains(`ph-l${lvl}`) || !!h.closest(`.panel-head.ph-l${lvl}`);
      expect(onScale, `${h.tagName} "${h.textContent}" sits on the scale`).toBe(true);
    }
  });

  it("the four measure tiles are the first thing in the scoreboard, each with its period, delta and history", async () => {
    await loadApp();
    const board = document.querySelector(".physio-board")!;
    const strip = board.querySelector(".sb-cells")!;
    expect(strip.classList.contains("measure-strip")).toBe(true);
    const tiles = [...strip.children];
    expect(tiles.map((t) => t.getAttribute("aria-label"))).toEqual(LABELS);
    expect(tiles.every((t) => t.classList.contains("measure-tile"))).toBe(true);
    // No ROI cell, sparkline or cost per shipped on the board any more.
    expect(board.querySelector(".kpi")).toBeNull();
    // The strip says which window it shows; each tile has its chip.
    expect(board.querySelector(".measure-head")?.textContent).toContain(
      "last 30 days, against the 30 days before",
    );
    expect(tiles.map((t) => t.querySelector(".mt-period")?.textContent)).toEqual(
      Array(4).fill("last 30 days"),
    );
    // Deltas from `previous`, coloured by direction x good: first-pass up is better,
    // review time down is better; the cost's period before had 4: no delta, and it says why.
    const delta = (i: number) => tiles[i]!.querySelector(".mt-delta");
    expect(delta(0)?.classList.contains("is-better")).toBe(true);
    expect(delta(0)?.textContent).toContain("+10 pts better vs the 30 days before");
    expect(delta(1)?.classList.contains("is-better")).toBe(true);
    expect(delta(1)?.textContent).toContain("10m");
    expect(delta(2)).toBeNull();
    expect(tiles[2]!.querySelector(".mt-note")?.textContent).toContain(
      "No change shown: under 10 in one of the two periods.",
    );
    // Escaped defects at zero: the upper bound, and the maturing months marked.
    const esc = tiles[3]!.querySelector(".mt-note")?.textContent ?? "";
    expect(esc).toContain("None filed, but it could be up to 11% (the 95% upper bound).");
    expect(esc).toMatch(/Still maturing: \w{3} \d{4} and \w{3} \d{4}/);
    // The strict first-pass rate on its tile (F-E6).
    expect(tiles[0]!.querySelector(".mt-note")?.textContent).toContain(
      "83% counting the runner's own retries (25 of 30)",
    );
    // Weekly history as a sparkline named as UTC weeks.
    expect(tiles[0]!.querySelector(".spark")?.getAttribute("aria-label")).toMatch(
      /^First-pass acceptance, 12 UTC weeks, /,
    );
    // The event log is board small print.
    expect(board.querySelector(".physio-small")?.textContent).toBe(
      "Event log intact: 99 events chained",
    );
  });

  it("no sparkline is fed fewer than 4 points, and none plots categories", async () => {
    await loadApp();
    const view = document.querySelector(".health-view")!;
    // The old builder (categories drawn as if time) is gone from the page.
    expect(view.querySelector(".spark-svg, .kpi-spark svg.spark-svg")).toBeNull();
    const sparks = [...view.querySelectorAll(".spark")];
    expect(sparks.length).toBeGreaterThan(0);
    for (const s of sparks) {
      const d = s.querySelector(".spark-line")?.getAttribute("d") ?? "";
      const pts = (d.match(/[ML]/g) || []).length;
      expect(pts, s.getAttribute("aria-label") ?? "").toBeGreaterThanOrEqual(4);
    }
    // Review time has three weeks with a figure: no sparkline at all.
    expect(view.querySelector('[aria-label="Human review time"] .spark')).toBeNull();
  });

  it("the Referee's record window select repaints the four measures over the new window", async () => {
    await loadApp();
    expect(
      requests.filter((u) => u.includes("/api/health")).every((u) => u.includes("window_days=30")),
    ).toBe(true);
    const sel = document.querySelector<HTMLSelectElement>("#health-window")!;
    expect(sel).not.toBeNull();
    sel.value = "90";
    sel.dispatchEvent(new Event("change"));
    for (let i = 0; i < 6; i++) await tick();
    expect(requests.some((u) => u.includes("/api/health?window_days=90"))).toBe(true);
    const chips = [...document.querySelectorAll(".measure-strip .mt-period")].map(
      (c) => c.textContent,
    );
    expect(chips).toEqual(Array(4).fill("last 90 days"));
    expect(document.querySelector(".measure-head")?.textContent).toContain("last 90 days");
    expect(
      [...document.querySelectorAll(".gov-tile .mt-period")].map((c) => c.textContent),
    ).toContain("last 90 days");
  });

  it("two quick window changes: the older, slower read never repaints over the newer choice", async () => {
    await loadApp();
    // From here the 365-day read is slow and the 7-day read answers at once.
    let release365: () => void = () => {};
    const gate365 = new Promise<void>((r) => (release365 = r));
    const inner = globalThis.fetch as unknown as (u: RequestInfo | URL) => Promise<Response>;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("window_days=365")) await gate365;
        return inner(input);
      }),
    );
    const pick = (v: string) => {
      const sel = document.querySelector<HTMLSelectElement>("#health-window")!;
      sel.value = v;
      sel.dispatchEvent(new Event("change"));
    };
    pick("365");
    for (let i = 0; i < 3; i++) await tick();
    pick("7");
    for (let i = 0; i < 6; i++) await tick();
    release365();
    for (let i = 0; i < 6; i++) await tick();
    const chips = [...document.querySelectorAll(".measure-strip .mt-period")].map(
      (c) => c.textContent,
    );
    expect(chips).toEqual(Array(4).fill("last 7 days"));
    expect(document.querySelector(".measure-head")?.textContent).toContain("last 7 days");
    expect(
      [...document.querySelectorAll(".gov-tile .mt-period")].map((c) => c.textContent),
    ).toEqual(Array(3).fill("last 7 days"));
    expect(document.querySelector<HTMLSelectElement>("#health-window")!.value).toBe("7");
  });

  it("a window read that fails keeps the window showing, says so, and keeps the keyboard on the select", async () => {
    await loadApp();
    const inner = globalThis.fetch as unknown as (u: RequestInfo | URL) => Promise<Response>;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes("window_days=90")
          ? new Response("{}", { status: 500, headers: { "content-type": "application/json" } })
          : inner(input),
      ),
    );
    const sel = document.querySelector<HTMLSelectElement>("#health-window")!;
    sel.focus();
    sel.value = "90";
    sel.dispatchEvent(new Event("change"));
    for (let i = 0; i < 6; i++) await tick();
    // Measures and the referee's record still agree on the 30 days they show.
    expect(
      [...document.querySelectorAll(".measure-strip .mt-period")].map((c) => c.textContent),
    ).toEqual(Array(4).fill("last 30 days"));
    expect(
      [...document.querySelectorAll(".gov-tile .mt-period")].map((c) => c.textContent),
    ).toEqual(Array(3).fill("last 30 days"));
    expect(document.querySelector(".gov-emptystate")).toBeNull();
    expect(document.querySelector(".gov-failed")?.textContent).toBe(
      "Could not read the last 90 days; still showing the last 30 days.",
    );
    const now = document.querySelector<HTMLSelectElement>("#health-window")!;
    expect(now.value).toBe("30");
    expect(document.activeElement).toBe(now);
  });
});

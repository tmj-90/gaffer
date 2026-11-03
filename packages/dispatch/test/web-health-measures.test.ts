// @vitest-environment jsdom
//
// DOM test for the Health view's four top-level measures (Release A metrics package):
// first-pass acceptance, human review time (median), accepted-change cost and the
// escaped-defect rate, which counts only the regression links a person filed.
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

const MEASURES = {
  accepted_change: {
    measure: "all_attempts_over_accepted_changes",
    accepted_changes: 5,
    cost_per_accepted_change_usd: 1.25,
    attempts_per_accepted_change: 1.4,
  },
  first_pass: {
    measure: "first_pass_acceptance",
    done: 5,
    first_pass: 2,
    rate_pct: 40,
    strict: { first_pass: 1, rate_pct: 20 },
    by_approver: {
      human: { done: 3, first_pass: 1, rate_pct: 33.3 },
      agent: { done: 2, first_pass: 1, rate_pct: 50 },
      system: { done: 0, first_pass: 0, rate_pct: null },
    },
  },
  review_time: {
    measure: "human_review_time_per_accepted_ticket",
    basis: "mixed",
    basis_note: "Mixed: decision time where the Review view recorded an open.",
    per_accepted_ticket: { n: 3, median_ms: 50 * 60_000, p75_ms: 55 * 60_000, p90_ms: 58 * 60_000 },
    accepted_without_human_decision: 1,
    active: {
      basis: "last_open_to_decision_capped",
      cap_ms: 2 * 60 * 60_000,
      note: "Active (approximate)",
      per_accepted_ticket: { n: 2, median_ms: 12 * 60_000, p75_ms: null, p90_ms: null },
      per_round: { n: 3, median_ms: 9 * 60_000, p75_ms: null, p90_ms: null },
      capped_rounds: 0,
    },
  },
  escaped_defects: {
    measure: "escaped_defect_rate",
    recorded: true,
    window_days: 30,
    accepted_changes: 4,
    escaped: 1,
    rate_pct: 25,
    all_time: { accepted_changes: 5, escaped: 2, rate_pct: 40 },
    links: 3,
    filed_by: { human: 3, admin: 0 },
    note: "Counts only what a person filed: a later ticket linked as a regression of an accepted change (wg ticket regression-of, or the ticket page). Gaffer never guesses one from a revert or a red build.",
    limits: [],
  },
};

// An older server (before escaped-defect links existed).
const NOT_RECORDED = {
  recorded: false,
  rate_pct: null,
  note: "Not recorded yet: an escaped defect needs a human-filed link from the defect to the accepted change it escaped from, and Gaffer has none yet.",
};

function measure(label: string): { value: string; note: string } | null {
  const panel = document.querySelector('[aria-label="The four measures"]');
  if (!panel) return null;
  for (const cell of Array.from(panel.querySelectorAll(".measures-facts > div"))) {
    if (cell.querySelector("dt")?.textContent === label) {
      const dd = cell.querySelector("dd");
      const note = dd?.querySelector("small")?.textContent ?? "";
      return { value: (dd?.textContent ?? "").replace(note, "").trim(), note };
    }
  }
  return null;
}

describe("web: Health shows the four top-level measures", () => {
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

  it("first-pass acceptance, median human review time, accepted-change cost and escaped defects", async () => {
    healthPayload = { ...(FULL_HEALTH as object), ...MEASURES };
    await loadApp();
    const fp = measure("First-pass acceptance");
    expect(fp?.value).toBe("40%");
    expect(fp?.note).toMatch(/2 of 5 done/);
    expect(fp?.note).toMatch(/human-approved 33\.3% of 3/);
    const rt = measure("Human review time");
    expect(rt?.value).toBe("50m");
    expect(rt?.note).toMatch(/median of 3 accepted/);
    expect(rt?.note).toMatch(/p90 58m/);
    expect(rt?.note).toMatch(/Mixed/);
    expect(rt?.note).toMatch(/Active, approximate: median 12m per accepted ticket/);
    expect(rt?.note).toMatch(/capped at 2h/);
    const cost = measure("Accepted-change cost");
    expect(cost?.value).toBe("$1.25");
    expect(cost?.note).toMatch(/1\.4 attempts each/);
    const esc = measure("Escaped-defect rate");
    expect(esc?.value).toBe("25%");
    expect(esc?.note).toMatch(/1 of 4 accepted in the last 30 days linked to a later regression/);
    expect(esc?.note).toMatch(/40% all time/);
    expect(esc?.note).toMatch(/Counts only what a person filed/);
  });

  it("an older server that does not record escaped defects still says what is missing", async () => {
    healthPayload = { ...(FULL_HEALTH as object), ...MEASURES, escaped_defects: NOT_RECORDED };
    await loadApp();
    const esc = measure("Escaped-defect rate");
    expect(esc?.value).toBe("Not recorded yet");
    expect(esc?.note).toMatch(/human-filed link from the defect to the accepted change/);
  });

  it("an empty factory reads as no data, never as zero, escaped defects included", async () => {
    healthPayload = {
      ...(DEGRADED_HEALTH as object),
      first_pass: { ...MEASURES.first_pass, done: 0, first_pass: 0, rate_pct: null },
      review_time: {
        ...MEASURES.review_time,
        basis: "none",
        basis_note: "No accepted ticket has a human review decision yet.",
        per_accepted_ticket: { n: 0, median_ms: null, p75_ms: null, p90_ms: null },
      },
      escaped_defects: {
        ...MEASURES.escaped_defects,
        accepted_changes: 0,
        escaped: 0,
        rate_pct: null,
        all_time: { accepted_changes: 0, escaped: 0, rate_pct: null },
      },
    };
    await loadApp();
    expect(measure("First-pass acceptance")?.value).toBe("—");
    expect(measure("Human review time")?.value).toBe("—");
    expect(measure("Human review time")?.note).toMatch(
      /No accepted ticket has a human review decision yet/,
    );
    expect(measure("Accepted-change cost")?.value).toBe("—");
    expect(measure("Escaped-defect rate")?.value).toBe("—");
    expect(measure("Escaped-defect rate")?.note).toMatch(/0 of 0 accepted/);
  });
});

describe("web: Health shows the code index's coverage and the callers row's share", () => {
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

  it("per repo: files, exported symbols, imports resolved, test links, when built; the callers share", async () => {
    healthPayload = {
      ...(FULL_HEALTH as object),
      ...MEASURES,
      impact_callers: {
        opens: 5,
        known: 4,
        listed: 3,
        none_changed: 1,
        not_analysed: 0,
        listed_pct: 75,
      },
      code_index: {
        available: true,
        repos: [
          {
            repo: "svc",
            commit: "c0ffee1234",
            builtAt: "2026-11-03T01:00:00Z",
            mode: "incremental",
            stats: {
              files: 120,
              testFiles: 30,
              symbols: 900,
              exportedSymbols: 400,
              imports: 700,
              refs: 500,
              unresolved: 4,
              testLinks: 80,
              modulesWithTests: 60,
              capsHit: [],
            },
          },
        ],
      },
    };
    await loadApp();
    const panel = document.querySelector('[aria-label="Code index"]')!;
    expect(panel).not.toBeNull();
    const t = panel.textContent!.replace(/\s+/g, " ");
    expect(t).toContain(
      "listed callers in 3 of 4 review opens (1 had no changed symbol to list, 0 were not analysed); 1 earlier opens did not record it.",
    );
    expect(t).toContain(
      "120 files (30 tests) · 400 exported symbols · 500 imports resolved, 4 unresolved · 80 test links over 60 modules",
    );
    expect(t).toContain("at c0ffee12");
    expect(t).not.toMatch(/score|confiden/i);
  });

  it("memory not wired and nothing recorded say so", async () => {
    healthPayload = {
      ...(FULL_HEALTH as object),
      impact_callers: {
        opens: 0,
        known: 0,
        listed: 0,
        none_changed: 0,
        not_analysed: 0,
        listed_pct: null,
      },
      code_index: { available: false, reason: "Memory is not configured." },
    };
    await loadApp();
    const t = document.querySelector('[aria-label="Code index"]')!.textContent!;
    expect(t).toContain("No review open has recorded the callers row yet.");
    expect(t).toContain("Index coverage: Memory is not configured.");
  });
});

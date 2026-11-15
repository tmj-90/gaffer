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

/** A measure tile on the board: its figure, n line, note and definition. */
function measure(
  label: string,
): { value: string; n: string; note: string; def: string; small: boolean } | null {
  const tile = document.querySelector(`.measure-strip > .measure-tile[aria-label="${label}"]`);
  if (!tile) return null;
  return {
    value: tile.querySelector(".mt-val")?.textContent ?? "",
    n: tile.querySelector(".mt-n")?.textContent ?? "",
    note: tile.querySelector(".mt-note")?.textContent ?? "",
    def: tile.querySelector(".mt-def p")?.textContent ?? "",
    small: tile.classList.contains("is-small"),
  };
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

  it("says where the independent tester is off because no test command is registered", async () => {
    healthPayload = {
      ...(FULL_HEALTH as object),
      ...MEASURES,
      tester_lane: {
        mode: "auto",
        repos_without_test_command: ["taskflow-web"],
        notices: ["independent tester off: no test command registered for taskflow-web"],
      },
    };
    await loadApp();
    const notes = [...document.querySelectorAll(".measures-detail .measures-notice")].map(
      (n) => n.textContent,
    );
    expect(notes).toEqual(["independent tester off: no test command registered for taskflow-web"]);
  });

  it("says the runner's tester lane differs as a warning, ahead of the repository notices (lane-hook R1)", async () => {
    const split =
      "tester lane differs: the runner last routed with GAFFER_TESTING off (recorded 2026-11-03 09:00 UTC) and this dashboard reads auto.";
    healthPayload = {
      ...(FULL_HEALTH as object),
      ...MEASURES,
      tester_lane: {
        mode: "auto",
        repos_without_test_command: ["taskflow-web"],
        notices: [split, "independent tester off: no test command registered for taskflow-web"],
        runner: { mode: "off", at: "2026-11-03T09:00:00.000Z" },
        runner_differs: true,
      },
    };
    await loadApp();
    const notes = [...document.querySelectorAll(".measures-detail .measures-notice")];
    expect(notes.map((n) => n.textContent)).toEqual([
      split,
      "independent tester off: no test command registered for taskflow-web",
    ]);
    expect(notes[0]!.classList.contains("warn-text")).toBe(true);
    expect(notes[1]!.classList.contains("warn-text")).toBe(false);
  });

  it("first-pass acceptance, median human review time, accepted-change cost and escaped defects", async () => {
    healthPayload = { ...(FULL_HEALTH as object), ...MEASURES };
    await loadApp();
    // Each measure is a tile on the board (F-A1): the figure, its n line, and under 10
    // the rate greys and says the sample is small (F-A3).
    const fp = measure("First-pass acceptance");
    expect(fp?.value).toBe("40%");
    expect(fp?.n).toBe("2 of 5 with no send-back");
    expect(fp?.small).toBe(true);
    // The strict rate, served and never drawn before (F-A5, F-E6).
    expect(fp?.note).toMatch(/20% counting the runner's own retries \(1 of 5\)/);
    expect(fp?.note).toMatch(/Approved by a person: 1 of 3; by an agent: 1 of 2/);
    const rt = measure("Human review time");
    expect(rt?.value).toBe("50m");
    expect(rt?.n).toBe("n 3");
    expect(rt?.note).toMatch(/p75 55m, p90 58m/);
    expect(rt?.def).toMatch(/Mixed/);
    // The active time and the spans sit behind the tile, in the detail table.
    const spans = [...document.querySelectorAll(".measures-detail tbody tr")].map(
      (tr) => tr.textContent,
    );
    expect(spans.some((t) => /Active, approximate12m/.test(t ?? ""))).toBe(true);
    const cost = measure("Accepted-change cost");
    expect(cost?.value).toBe("$1.25");
    expect(cost?.note).toMatch(/1\.4 attempts per accepted change/);
    const esc = measure("Escaped-defect rate");
    expect(esc?.value).toBe("25%");
    expect(esc?.n).toBe("1 of 4 came back as a regression");
    expect(esc?.note).toMatch(/All time: 40% \(2 of 5\)/);
    expect(esc?.def).toMatch(/Counts only what a person filed/);
  });

  it("an older server that does not record escaped defects still says what is missing", async () => {
    healthPayload = { ...(FULL_HEALTH as object), ...MEASURES, escaped_defects: NOT_RECORDED };
    await loadApp();
    const esc = measure("Escaped-defect rate");
    expect(esc?.value).toBe("\u2014");
    expect(esc?.note).toMatch(/^Not recorded yet: an escaped defect needs a human-filed link/);
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
    expect(measure("First-pass acceptance")?.value).toBe("\u2014");
    expect(measure("First-pass acceptance")?.note).toBe("Nothing was accepted in this window.");
    expect(measure("Human review time")?.value).toBe("\u2014");
    expect(measure("Human review time")?.note).toMatch(
      /No accepted ticket has a human review decision yet/,
    );
    expect(measure("Accepted-change cost")?.value).toBe("\u2014");
    expect(measure("Escaped-defect rate")?.value).toBe("\u2014");
    expect(measure("Escaped-defect rate")?.note).toBe("Nothing was accepted in this window.");
    expect(document.querySelector(".measure-strip")?.textContent).not.toMatch(/\b0%/);
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
    // The callers share is a measure tile (k of n, a Wilson whisker), not a sentence (F-C4).
    const tile = panel.querySelector(".measure-tile")!;
    expect(tile.querySelector(".mt-val")?.textContent).toBe("75%");
    expect(tile.querySelector(".mt-n")?.textContent).toBe("3 of 4 review opens");
    expect(tile.querySelector(".mt-whisker")).not.toBeNull();
    expect(tile.classList.contains("is-small")).toBe(true); // 4 opens: too few, greyed
    expect(t).toContain(
      "1 had no changed symbol to list, 0 were not analysed; 1 earlier opens did not record it.",
    );
    // The per-repo coverage is a real table (A-36, F-C4), numbers right-aligned.
    const table = panel.querySelector("table.data-table")!;
    expect(panel.querySelector(".dt-wrap")?.classList.contains("dt-stack")).toBe(true);
    const heads = [...table.querySelectorAll("thead th")].map((th) => th.textContent);
    expect(heads).toEqual([
      "Repo",
      "Files",
      "Test files",
      "Exported symbols",
      "Imports resolved",
      "Unresolved",
      "Test links",
      "Modules with tests",
      "Built",
      "Commit",
    ]);
    const row = table.querySelector("tbody tr")!;
    expect(row.querySelector("th[scope=row]")?.textContent).toBe("svc");
    expect([...row.querySelectorAll("td.dt-num")].map((td) => td.textContent)).toEqual([
      "120",
      "30",
      "400",
      "500",
      "4",
      "80",
      "60",
    ]);
    expect(row.querySelector("code")?.textContent).toBe("c0ffee12");
    // A plain level-2 head: Health keeps its blocks for the sections it leads with (A-03).
    expect(panel.querySelector(".panel-head")?.className).toBe("panel-head ph-l2");
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
    const panel = document.querySelector('[aria-label="Code index"]')!;
    const t = panel.textContent!;
    expect(t).toContain("No review open has recorded the callers row yet.");
    expect(panel.querySelector(".measure-tile .mt-val")?.textContent).toBe("\u2014");
    expect(t).toContain("Index coverage: Memory is not configured.");
    // One quiet inline line, not a hand-rolled paragraph (A-42).
    expect(panel.querySelector(".empty-inline")?.textContent).toBe(
      "Index coverage: Memory is not configured.",
    );
  });
});

describe("Health: the pre-work scout card", () => {
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

  it("coverage, model scout runs and cost, and first-pass split by what the scout found", async () => {
    healthPayload = {
      ...(FULL_HEALTH as object),
      scout: {
        measure: "scout_coverage",
        attempts: 9,
        tickets: 7,
        with_index_items: 5,
        named_only: 3,
        empty: 1,
        index_status: { fresh: 6, missing: 3 },
        risk_raised: 2,
        model_scout: { runs: 2, kept_files: 5, dropped: 1, cost_usd: 0.0321, cost_unknown: 1 },
        first_pass: {
          index_items: { done: 4, first_pass: 3, rate_pct: 75 },
          named_only: { done: 2, first_pass: 1, rate_pct: 50 },
          nothing_found: { done: 0, first_pass: 0, rate_pct: null },
          no_record: { done: 10, first_pass: 6, rate_pct: 60 },
        },
        limits: ["the arms are observational"],
      },
    };
    await loadApp();
    const panel = document.querySelector('[aria-label="Pre-work scout"]')!;
    expect(panel).not.toBeNull();
    const t = panel.textContent!.replace(/\s+/g, " ");
    expect(t).toContain("9 delivery attempts scouted on 7 tickets. The risk was raised in 2.");
    // What each attempt started with: a thin segmented bar named in full (F-C3).
    const bar = panel.querySelector(".seg-bar")!;
    expect(bar.getAttribute("aria-label")).toBe(
      "What each scouted attempt started with: Index added files 5 (56%), Named files and stack frames only 3 (33%), Nothing found 1 (11%)",
    );
    expect([...panel.querySelectorAll(".seg-legend li")].map((li) => li.textContent)).toEqual([
      "Index added files 5",
      "Named files and stack frames only 3",
      "Nothing found 1",
    ]);
    // One money format: never "$0.0321" (A-31).
    expect(t).toContain(
      "Model scout: 2 runs, 5 files kept, 1 dropped as not in the checkout, $0.03 (1 of unknown cost).",
    );
    // First-pass by arm: a rate row each, the count beside the rate, a whisker (F-C3).
    const fig = (arm: string) =>
      panel.querySelector(`.meter-row[data-arm="${arm}"] .mr-fig`)?.textContent;
    // Under 10 done tickets an arm reads as its counts, greyed (no rate to compare).
    expect(fig("index_items")).toBe("3 of 4");
    expect(panel.querySelector('.meter-row[data-arm="index_items"]')!.classList).toContain(
      "is-small",
    );
    expect(fig("no_record")).toBe("60% · 6 of 10");
    expect(panel.querySelector('.meter-row[data-arm="index_items"] .mr-whisker')).not.toBeNull();
    // An arm with no done ticket is no row: it folds into one muted line.
    expect(panel.querySelector('.meter-row[data-arm="nothing_found"]')).toBeNull();
    expect(panel.querySelector(".scout-empty")?.textContent).toBe(
      "No done ticket yet: Nothing found.",
    );
    expect(t).toContain("not a controlled experiment");
    expect(t).not.toMatch(/recommend|score|confiden/i);
  });

  it("an older server sends no scout figures: no card", async () => {
    healthPayload = { ...(FULL_HEALTH as object) };
    await loadApp();
    expect(document.querySelector('[aria-label="Pre-work scout"]')).toBeNull();
  });
});

describe("Health: the routing scorecard card", () => {
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

  const rate = (value: number | null, n: number) => ({ value, n });
  it("n on every figure, too few to compare under the minimum, and the Routing line", async () => {
    healthPayload = {
      ...(FULL_HEALTH as object),
      routing_scorecard: {
        measure: "routing_scorecard",
        report_only: true,
        min_n: 10,
        rows: 30,
        manifests: 12,
        cells: [
          {
            provider: "claude-code",
            model: "model-a",
            role: "implement",
            risk: "low",
            stack: "node",
            n: 13,
            too_few: false,
            note: null,
            calls: 13,
            spend_usd: 7.7,
            estimated_usd: 0,
            estimated_rows: 0,
            unknown_rows: 1,
            submission_pct: rate(92.3, 13),
            rework_pct: rate(7.7, 13),
            first_pass_pct: rate(83.3, 12),
            attempts_per_accepted_change: rate(1.17, 12),
            cost_per_accepted_change_usd: rate(0.64, 12),
            escaped_defect_pct: rate(null, 4),
            tester_false_greens: rate(1, 12),
          },
          {
            provider: "claude-code",
            model: "model-b",
            role: "implement",
            risk: "low",
            stack: "node",
            n: 4,
            too_few: true,
            note: "too few to compare",
            calls: 4,
            spend_usd: null,
          },
        ],
        footnote: "Report only: no composite score, cells are never ranked.",
      },
      routing: {
        available: true,
        proposals: 0,
        line: "Routing: no registry change proposed. Report only.",
      },
    };
    await loadApp();
    const panel = document.querySelector('[aria-label="Routing scorecard"]')!;
    expect(panel).not.toBeNull();
    const t = panel.textContent!.replace(/\s+/g, " ");
    expect(t).toContain("30 ledger rows · 12 replay manifests · minimum n 10");
    // A real table (F-C1): th scope, numbers right-aligned, n under every rate.
    const table = panel.querySelector(".routing-implement table")!;
    expect([...table.querySelectorAll("thead th")].map((th) => th.textContent)).toEqual([
      "Model",
      "Risk",
      "Stack",
      "Attempts",
      "Submitted",
      "Rework",
      "First pass",
      "Attempts per accepted",
      "Cost per accepted",
      "Escaped",
      "Tester false greens",
      "Spend",
    ]);
    const rows = [...table.querySelectorAll("tbody tr")];
    // The cell under the minimum is no row: its rates would be noise.
    expect(rows.length).toBe(1);
    const cells = [...rows[0]!.children].map((c) => c.textContent);
    expect(rows[0]!.firstElementChild!.getAttribute("scope")).toBe("row");
    expect(cells).toEqual([
      "model-a",
      "low",
      "node",
      "13",
      "92%n 13",
      "7.7%n 13",
      "83%n 12",
      "1.17n 12",
      "$0.64n 12",
      "too few (n=4)",
      "1n 12",
      "$7.7013 calls, 1 of unknown cost left out",
    ]);
    expect(rows[0]!.children[4]!.classList.contains("dt-num")).toBe(true);
    expect(panel.querySelector(".routing-few")?.textContent).toBe(
      "Too few to compare (under 10): model-b · risk low · node (n 4).",
    );
    expect(t).toContain("Routing: no registry change proposed. Report only.");
    expect(t).not.toMatch(/recommend|best|winner|confiden/i);
  });

  it("an older server sends no scorecard: no card", async () => {
    healthPayload = { ...(FULL_HEALTH as object) };
    await loadApp();
    expect(document.querySelector('[aria-label="Routing scorecard"]')).toBeNull();
  });
});

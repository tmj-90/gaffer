// @vitest-environment jsdom
//
// DOM test for the SPA's Specs view (src/api/web/app.js): the spec LIST
// (#/specs) and the coverage TRACE detail (#/specs/:id). The detail reads the
// Dispatch API's GET /specs/:id/coverage read model and renders each clause →
// its covering ACs (satisfied vs open), the coverage GAPS (orphan clauses), the
// per-clause bounce counts, and the seeded-lore ratification status.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const SPECS = {
  specs: [
    {
      id: "spec-1",
      title: "Checkout redesign",
      brief: "Rework the checkout flow end to end.",
      clauses_json: JSON.stringify([
        { clause_id: "C-1", kind: "requirement", text: "Pay with a saved card" },
        { clause_id: "C-2", kind: "non-goal", text: "No crypto" },
      ]),
      status: "frozen",
      target_repo: "payments-svc",
      scope_node_id: "epic-42",
    },
  ],
};

const COVERAGE = {
  coverage: {
    spec_id: "spec-1",
    title: "Checkout redesign",
    status: "frozen",
    scope_node_id: "epic-42",
    gate_enabled: false,
    rollup: { total: 3, covered: 2, satisfied: 1, orphans: ["C-gap"] },
    clauses: [
      {
        clause_id: "C-green",
        kind: "requirement",
        text: "User can pay with a saved card",
        covering_acs: [
          {
            ac_id: "ac-1",
            ac_text: "pays with saved card",
            ac_status: "satisfied",
            satisfied: true,
            ticket_id: "t-1",
            ticket_number: 7,
            ticket_title: "Saved-card payment",
            ticket_status: "done",
          },
        ],
        covered: true,
        satisfied: true,
        orphan: false,
        bounce_count: 2,
        lore_status: "active",
      },
      {
        clause_id: "C-open",
        kind: "requirement",
        text: "Refunds processed within 24h",
        covering_acs: [
          {
            ac_id: "ac-2",
            ac_text: "refund within 24h",
            ac_status: "pending",
            satisfied: false,
            ticket_id: "t-2",
            ticket_number: 8,
            ticket_title: "Refund worker",
            ticket_status: "in_review",
          },
        ],
        covered: true,
        satisfied: false,
        orphan: false,
        bounce_count: 0,
        lore_status: "draft",
      },
      {
        clause_id: "C-gap",
        kind: "non-goal",
        text: "No crypto payments",
        rationale: "Out of scope for v1",
        covering_acs: [],
        covered: false,
        satisfied: false,
        orphan: true,
        bounce_count: 0,
        lore_status: "absent",
      },
    ],
  },
};

function stubFetch(overrides: Partial<Record<"specs" | "coverage", unknown>> = {}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      let body: unknown = {};
      if (url.includes("/coverage")) body = overrides.coverage ?? COVERAGE;
      else if (url.includes("/specs")) body = overrides.specs ?? SPECS;
      else if (url.includes("/repositories")) body = { repositories: [] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

function mountShell(hash: string): void {
  document.body.innerHTML = `
    <div id="toast" class="toast" role="alert" hidden></div>
    <div class="shell">
      <header id="appbar" class="appbar" hidden></header>
      <main id="app" class="app"><p class="loading">Loading…</p></main>
      <nav id="bottomnav" class="bottomnav" hidden></nav>
    </div>`;
  location.hash = hash;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function boot(): Promise<void> {
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
  await tick();
  await tick();
}

describe("web: Specs view", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });
  beforeEach(() => {
    vi.resetModules();
  });

  it("registers a Specs nav destination", async () => {
    stubFetch();
    mountShell("#/specs");
    await boot();
    const nav = Array.from(document.querySelectorAll("[data-area='specs']"));
    expect(nav.length).toBeGreaterThan(0);
  });

  it("lists specs with a status chip and clause count", async () => {
    stubFetch();
    mountShell("#/specs");
    await boot();
    const text = document.body.textContent || "";
    expect(text).toContain("Checkout redesign");
    expect(text).toContain("Frozen");
    expect(text).toContain("2 clauses");
    const card = document.querySelector(".spec-card[data-spec-id='spec-1']");
    expect(card).not.toBeNull();
  });

  it("renders a stats row and a scanner-frame thumbnail for each spec", async () => {
    stubFetch();
    mountShell("#/specs");
    await boot();

    // Stats row reuses KPI styling: total specs + coverage + gaps + updated.
    const stats = document.querySelector(".spec-stats");
    expect(stats).not.toBeNull();
    const statText = stats!.textContent || "";
    expect(statText).toContain("Total specs");
    expect(statText).toContain("Coverage");
    expect(statText).toContain("Gaps");
    // COVERAGE = covered(2)/total(3) ≈ 67%; GAPS = 1 orphan (from COVERAGE rollup).
    expect(statText).toContain("67");
    expect(statText).toContain("1");

    // Each card carries a scanner-frame thumbnail: four corner brackets + icon.
    const thumb = document.querySelector(".spec-card .spec-thumb");
    expect(thumb).not.toBeNull();
    expect(thumb!.querySelectorAll(".tc").length).toBe(4);
    expect(thumb!.querySelector(".spec-thumb-icon")).not.toBeNull();

    // A status dot accompanies the (retained) status label.
    expect(document.querySelector(".spec-card-status .scs-dot")).not.toBeNull();
    // The newest spec is the primary card (amber rail).
    expect(document.querySelector(".spec-card--primary")).not.toBeNull();
  });

  it("renders an empty state when there are no specs", async () => {
    stubFetch({ specs: { specs: [] } });
    mountShell("#/specs");
    await boot();
    expect(document.body.textContent || "").toContain("No specs yet");
  });

  it("renders the coverage trace: clauses, their ACs, and satisfied/open state", async () => {
    stubFetch();
    mountShell("#/specs/spec-1");
    await boot();
    const text = document.body.textContent || "";
    // Clause texts + their ACs are traced.
    expect(text).toContain("User can pay with a saved card");
    expect(text).toContain("pays with saved card");
    expect(text).toContain("Refunds processed within 24h");
    // A satisfied clause and an open clause render distinct states.
    expect(document.querySelector(".spec-clause[data-state='satisfied']")).not.toBeNull();
    expect(document.querySelector(".spec-clause[data-state='open']")).not.toBeNull();
    // The AC links to its ticket.
    expect(document.querySelector(".spec-ac-ticket")).not.toBeNull();
    expect(text).toContain("#7");
  });

  it("calls out coverage gaps (orphan clauses) with the gap report", async () => {
    stubFetch();
    mountShell("#/specs/spec-1");
    await boot();
    const gaps = document.querySelector(".coverage-gaps");
    expect(gaps).not.toBeNull();
    expect(gaps!.textContent || "").toContain("1 coverage gap");
    // The orphan clause block is marked and shown in the trace as a gap.
    const orphan = document.querySelector(".spec-clause[data-state='orphan']");
    expect(orphan).not.toBeNull();
    expect(orphan!.textContent || "").toContain("No crypto payments");
  });

  it("shows per-clause bounce counts and seeded-lore ratification status", async () => {
    stubFetch();
    mountShell("#/specs/spec-1");
    await boot();
    const text = document.body.textContent || "";
    // Bounce count on the green clause.
    expect(text).toContain("bounced 2×");
    // Lore status chips: active on the ratified clause, draft on the unratified.
    expect(text).toContain("lore: active");
    expect(text).toContain("lore: draft");
  });

  it("links the spec to its epic via the scope-node id", async () => {
    stubFetch();
    mountShell("#/specs/spec-1");
    await boot();
    const rollupText = document.body.textContent || "";
    // Rollup surfaces covered/satisfied/gaps.
    expect(document.querySelector(".spec-rollup")).not.toBeNull();
    expect(rollupText).toContain("Open epic");
    // The "Open epic" action targets the scope node.
    const openEpic = Array.from(document.querySelectorAll("button")).find((b) =>
      (b.textContent || "").includes("Open epic"),
    );
    expect(openEpic).toBeTruthy();
    openEpic!.click();
    await tick();
    expect(location.hash).toBe("#/epics/epic-42");
  });
});

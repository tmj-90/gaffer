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
        // A requirement: a non-goal or decision with no criterion is not a gap
        // (see "keeps non-goals, decisions and drafts quiet" below).
        clause_id: "C-gap",
        kind: "requirement",
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

  it("renders a clause form guide for each spec, and no KPI tile row", async () => {
    stubFetch();
    mountShell("#/specs");
    await boot();

    // Match Day: the KPI tile row (TOTAL SPECS / COVERAGE / GAPS / LAST UPDATED) is
    // gone. It repeated the head's counts in tracked-caps eyebrows (TOKENS §2) and
    // its COVERAGE was a client-side mean the server never gave.
    expect(document.querySelector(".spec-stats")).toBeNull();
    expect(document.querySelector(".view-specs .kpi")).toBeNull();

    // Match Day: the scanner-frame thumbnail (an icon tile, BRIEF §5) and the status
    // dot are gone. Each row now leads with the status mark + word and carries a
    // form guide: one square per clause, in order, coloured by its coverage state,
    // beside the sentence that states the same counts.
    const card = document.querySelector(".spec-card[data-spec-id='spec-1']")!;
    expect(card.querySelector(".spec-card-status")?.textContent).toContain("Frozen");
    const squares = Array.from(card.querySelectorAll(".spec-form .fg"));
    expect(squares.map((s) => s.className)).toEqual([
      "fg fg-satisfied",
      "fg fg-open",
      "fg fg-orphan",
    ]);
    expect(card.textContent || "").toContain("2 of 3 covered · 1 satisfied · 1 gap");
    // The row is a link to the spec's trace, and the newest spec is marked.
    expect(card.getAttribute("href")).toBe("#/specs/spec-1");
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

  it("links the spec to its campaign via the scope-node id", async () => {
    stubFetch();
    mountShell("#/specs/spec-1");
    await boot();
    // The lede states covered / satisfied / gaps once; the KPI tiles that repeated
    // it are gone. The action says "campaign", as the page's meta line does.
    expect(document.querySelector(".spec-rollup")).toBeNull();
    expect(document.querySelector(".spec-lede")?.textContent || "").toContain(
      "2 of its 3 clauses are covered by acceptance criteria, 1 already satisfied.",
    );
    const openEpic = Array.from(document.querySelectorAll("button")).find((b) =>
      (b.textContent || "").includes("Open campaign"),
    );
    expect(openEpic).toBeTruthy();
    openEpic!.click();
    await tick();
    expect(location.hash).toBe("#/epics/epic-42");
  });

  it("keeps non-goals, decisions and drafts quiet: no gap, no red", async () => {
    const quiet = JSON.parse(JSON.stringify(COVERAGE));
    quiet.coverage.clauses[2].kind = "non-goal";
    stubFetch({ coverage: quiet });
    mountShell("#/specs/spec-1");
    await boot();
    // A non-goal with no criterion is not a gap: no red block, a dashed square.
    expect(document.querySelector(".coverage-gaps")).toBeNull();
    expect(document.querySelector(".spec-clause.is-gap")).toBeNull();
    expect(document.querySelector(".spec-clauses .fg-none")).not.toBeNull();
    expect(document.querySelector(".spec-lede .is-red")).toBeNull();

    // A draft nothing covers yet says so once, calmly, and lists its clauses once.
    const draft = JSON.parse(JSON.stringify(COVERAGE));
    draft.coverage.status = "draft";
    draft.coverage.rollup = {
      total: 3,
      covered: 0,
      satisfied: 0,
      orphans: ["C-green", "C-open", "C-gap"],
    };
    for (const c of draft.coverage.clauses) {
      c.covering_acs = [];
      c.covered = false;
      c.satisfied = false;
      c.orphan = true;
      c.lore_status = "absent";
      c.bounce_count = 0;
    }
    vi.unstubAllGlobals();
    vi.resetModules();
    stubFetch({ coverage: draft });
    mountShell("#/specs/spec-1");
    await boot();
    expect(document.querySelector(".coverage-gaps")).toBeNull();
    expect(document.querySelectorAll(".spec-clause").length).toBe(3);
    expect(document.querySelectorAll(".spec-clause .sc-state").length).toBe(0);
    expect(document.querySelectorAll(".spec-clauses .fg-orphan").length).toBe(0);
    const board = document.querySelector(".spec-clauses")?.textContent || "";
    expect(document.querySelectorAll(".spec-uncovered").length).toBe(1);
    expect(board).toContain("Not covered yet");
    // Lore every clause shares is said once, not on every clause.
    expect(board).toContain("Lore: no clause is seeded yet.");
    expect(document.body.textContent || "").not.toContain("lore: absent");
  });
  it("calls a clause with only some criteria met 'partly met', never satisfied", async () => {
    // The server's clause.satisfied is true when ANY covering criterion is met; a
    // clause is proven only when ALL are, so 1 of 2 met reads "Partly met".
    const part = JSON.parse(JSON.stringify(COVERAGE));
    part.coverage.clauses[0].covering_acs.push({
      ac_id: "ac-3",
      ac_text: "charged exactly once",
      ac_status: "pending",
      satisfied: false,
      ticket_id: "t-3",
      ticket_number: 9,
      ticket_title: "Idempotent charge",
      ticket_status: "blocked",
    });
    stubFetch({ coverage: part });
    mountShell("#/specs/spec-1");
    await boot();
    const c = document.querySelector(".spec-clause[data-clause-id='C-green']")!;
    expect(c.getAttribute("data-state")).toBe("partial");
    expect(c.getAttribute("data-satisfied")).toBe("false");
    expect(c.textContent || "").toContain("Partly met · 1 of 2");
    expect(c.textContent || "").not.toContain("Satisfied");
    expect(document.querySelector(".spec-clause[data-state='satisfied']")).toBeNull();
    expect(document.querySelector(".spec-clauses .fg-partial")).not.toBeNull();
    expect(document.querySelector(".spec-clauses .fg-satisfied")).toBeNull();
    expect(document.querySelector(".spec-lede")?.textContent || "").toContain(
      "none fully proven yet: 1 partly met",
    );
    // The ticket number and its status sit together in one unit.
    const tk = c.querySelectorAll(".spec-ac-tk");
    expect(tk.length).toBe(2);
    expect(tk[1]!.querySelector(".spec-ac-ticket")?.textContent).toBe("#9");
    expect(tk[1]!.querySelector(".spec-ac-st")?.textContent).toBe("Blocked");

    vi.unstubAllGlobals();
    vi.resetModules();
    stubFetch({ coverage: part });
    mountShell("#/specs");
    await boot();
    const card = document.querySelector(".spec-card[data-spec-id='spec-1']")!;
    expect(card.textContent || "").toContain("2 of 3 covered · 0 satisfied · 1 partly met · 1 gap");
  });

  it("reads a frozen spec not built yet as 'not covered yet' everywhere, never as gaps", async () => {
    // Frozen, no campaign, nothing covering it: between "Freeze spec" and "Plan a
    // build from it". The squares, the board line, the lede and the list agree.
    const fresh = JSON.parse(JSON.stringify(COVERAGE));
    fresh.coverage.scope_node_id = null;
    fresh.coverage.rollup = {
      total: 3,
      covered: 0,
      satisfied: 0,
      orphans: ["C-green", "C-open", "C-gap"],
    };
    for (const c of fresh.coverage.clauses) {
      c.covering_acs = [];
      c.covered = false;
      c.satisfied = false;
      c.orphan = true;
    }
    const specs = JSON.parse(JSON.stringify(SPECS));
    specs.specs[0].scope_node_id = null;
    stubFetch({ coverage: fresh, specs });
    mountShell("#/specs/spec-1");
    await boot();
    expect(document.querySelector(".coverage-gaps")).toBeNull();
    expect(document.querySelectorAll(".spec-clauses .fg-orphan").length).toBe(0);
    expect(document.querySelectorAll(".spec-clauses .fg-none").length).toBe(3);
    expect(document.querySelectorAll(".spec-clause .sc-state").length).toBe(0);
    expect(document.querySelector(".spec-uncovered")?.textContent || "").toContain(
      "Not covered yet",
    );
    expect(document.querySelector(".spec-lede")?.textContent || "").toContain("Not covered yet");
    expect(document.querySelector(".spec-lede .is-red")).toBeNull();

    vi.unstubAllGlobals();
    vi.resetModules();
    stubFetch({ coverage: fresh, specs });
    mountShell("#/specs");
    await boot();
    const card = document.querySelector(".spec-card[data-spec-id='spec-1']")!;
    expect(card.classList.contains("has-gaps")).toBe(false);
    expect(card.querySelector(".fg-orphan")).toBeNull();
    expect(card.querySelector(".spec-card-words.is-red")).toBeNull();
    expect(card.textContent || "").toContain("Not covered yet");
  });
});

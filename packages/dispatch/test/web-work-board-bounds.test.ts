// @vitest-environment jsdom
//
// Work board fixes from the dashboard-logic audit:
//   - work-shipped-count-wrong: "Shipped" counted the failed (closed) area and
//     LIVE counted Done. One set of counts now feeds the header line, the flow
//     bar and the lane heads: Shipped = the Done lane, Failed = the closed area.
//   - board-unbounded-render: every Done card ever was rendered on every refresh.
//     Lanes are capped (Done shows the newest 25) while the lane head keeps the
//     TRUE count and links to the rest in the List view.
//   - mobile-overview-overflow (class collision): the lifecycle marks no longer
//     share `.pipeline` with the Overview's development-flow strip.
//   - hero-banners-below-fold: no `.view-hero` band above the board.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

type Card = Record<string, unknown>;
const card = (n: number, status: string, extra: Card = {}): Card => ({
  id: `t-${status}-${n}`,
  number: n,
  title: `Ticket ${n}`,
  status,
  priority: 1,
  risk_level: "low",
  updated_at: new Date(Date.UTC(2026, 9, 1) + n * 60_000).toISOString(),
  acTotal: 0,
  acSatisfied: 0,
  acEvidenced: 0,
  acEvidenceRequired: 0,
  repos: [],
  ...extra,
});

let board: unknown;

function json(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/board")) return json(board);
      if (url.includes("/repositories")) return json({ repositories: [] });
      if (url.includes("/scope/nodes")) return json({ nodes: [] });
      if (url.includes("/claims")) return json({ claims: [] });
      if (url.includes("/api/dashboard")) return json({ summary: { ticketsByStatus: {} } });
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
  location.hash = "#/work";
}
const tick = () => new Promise((r) => setTimeout(r, 0));
async function loadApp(): Promise<void> {
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}-${Math.random()}`);
  for (let i = 0; i < 8; i++) await tick();
}

const columns = (by: Record<string, Card[]>) =>
  [
    "draft",
    "ready",
    "in_progress",
    "blocked",
    "in_review",
    "in_testing",
    "ready_for_merge",
    "done",
  ].map((column) => ({ column, cards: by[column] || [] }));

describe("web: Work board counts and bounds", () => {
  beforeEach(() => {
    stubFetch();
    mountShell();
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("counts Shipped from the Done lane and Failed from the closed area", async () => {
    board = {
      columns: columns({
        in_progress: [card(1, "in_progress"), card(2, "in_progress"), card(3, "in_progress")],
        in_testing: [card(4, "in_testing")],
        ready_for_merge: [card(5, "ready_for_merge")],
        done: [card(6, "done"), card(7, "done")],
      }),
      closed: [card(8, "failed")],
      wontDo: [card(9, "cancelled")],
    };
    await loadApp();

    const bar = document.querySelector(".work-flow");
    expect(bar).not.toBeNull();
    const label = bar!.getAttribute("aria-label") || "";
    // Every lane is in the bar — including in testing and approved/merging.
    expect(label).toContain("In testing 1");
    expect(label).toContain("Approved · merging 1");
    // Shipped is the Done lane (2), never the failed ticket; Failed is its own count.
    expect(label).toContain("Shipped 2");
    expect(label).toContain("Failed 1");
    const segs = Array.from(document.querySelectorAll(".wf-seg")).map((s) =>
      s.getAttribute("title"),
    );
    expect(segs).toContain("Shipped: 2");
    expect(segs).toContain("Failed: 1");
    expect(segs).not.toContain("Shipped: 1");

    // The header line agrees: 7 tickets in lanes (5 live + 2 done), 1 failed. (A
    // count is tied to its lane name with a no-break space, so it never wraps alone.)
    const sub = (document.querySelector(".view-head .view-sub")?.textContent || "").replace(
      /\u00a0/g,
      " ",
    );
    expect(sub).toMatch(/^7 tickets in lanes:/);
    expect(sub).toContain("2 done");
    expect(sub).toContain("1 failed");
    expect(sub).toContain("1 won't do");
  });

  it("caps the Done lane at its newest 25 cards but keeps the true count", async () => {
    const done = Array.from({ length: 200 }, (_, i) => card(1000 + i, "done"));
    board = { columns: columns({ done }), closed: [], wontDo: [] };
    await loadApp();

    const lane = document.querySelector('[data-column="done"]')!;
    expect(lane.querySelectorAll(".board-card").length).toBe(25);
    expect(lane.querySelector(".board-col-count")?.textContent).toBe("200");
    // The newest first: #1199 is on the board, #1000 is not.
    const nums = Array.from(lane.querySelectorAll(".board-card .num")).map((n) => n.textContent);
    expect(nums[0]).toBe("#1199");
    expect(nums).not.toContain("#1000");
    // The rest is one link away in the List view, filtered to Done.
    const more = lane.querySelector("a.lane-more");
    expect(more?.getAttribute("href")).toBe("#/work?mode=list&status=done");
    expect(more?.textContent).toContain("200");
  });

  it("never draws the Overview's .pipeline class on Work, and no hero band", async () => {
    board = { columns: columns({ ready: [card(1, "ready")] }), closed: [], wontDo: [] };
    await loadApp();
    expect(document.querySelector("#app .view-hero")).toBeNull();
    expect(document.querySelector("#app .pipeline")).toBeNull();
    // Board cards no longer carry lifecycle marks: the lane a card sits in is its
    // stage (the comp's card drops them). The list keeps them as .pdots.
    expect(document.querySelector("#app .board-card")).not.toBeNull();
    expect(document.querySelector("#app .board-card .pdots")).toBeNull();
  });
});

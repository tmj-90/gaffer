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
const boardUrls: string[] = [];

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
      if (url.includes("/api/board")) {
        boardUrls.push(url);
        return json(board);
      }
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
    boardUrls.length = 0;
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
    // Every lane is in the bar — including in testing and ready for merge (the
    // board's lane name for ready_for_merge, as comp E's lane head reads).
    expect(label).toContain("In testing 1");
    expect(label).toContain("Ready for merge 1");
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

  it("stacks the phone lanes in urgency order in the DOM, so tab order matches the screen", async () => {
    // WCAG 2.4.3: the phone board used CSS `order`, so Tab and a screen reader met
    // Draft first while Blocked sat on top. The lanes are now rendered in that order.
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: q.includes("max-width: 760px"),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    board = {
      columns: columns({
        draft: [card(1, "draft")],
        ready: [card(2, "ready")],
        in_progress: [card(3, "in_progress")],
        blocked: [card(4, "blocked")],
        in_review: [card(5, "in_review")],
        done: [card(6, "done")],
      }),
      closed: [],
      wontDo: [],
    };
    await loadApp();
    const order = [...document.querySelectorAll<HTMLElement>("#app .board-col")].map(
      (n) => n.dataset.column,
    );
    // Lanes with work first, most urgent first; the empty lanes sink last.
    expect(order).toEqual([
      "blocked",
      "in_review",
      "in_progress",
      "ready",
      "draft",
      "done",
      "ready_for_merge",
      "in_testing",
    ]);
  });

  it("asks for a visible window and keeps every lane's TRUE size from the server counts", async () => {
    // Third external review: the unfiltered board shipped every historical ticket
    // (and failed outright at 32,767). Work now asks for a window per lane; the lane
    // heads, the header line and the closed area count from `counts`.
    const done = Array.from({ length: 200 }, (_, i) => card(40_000 - i, "done"));
    const ready = Array.from({ length: 200 }, (_, i) => card(1 + i, "ready"));
    const wontDo = Array.from({ length: 200 }, (_, i) => card(30_000 + i, "cancelled"));
    board = {
      columns: columns({ done, ready }),
      closed: [],
      wontDo,
      counts: {
        columns: {
          draft: 0,
          ready: 5_000,
          in_progress: 0,
          blocked: 0,
          in_review: 0,
          in_testing: 0,
          ready_for_merge: 0,
          done: 20_000,
        },
        closed: 0,
        wontDo: 5_000,
      },
      window: { limit: 200, offset: 0 },
    };
    await loadApp();
    expect(boardUrls.some((u) => /\/api\/board\?limit=200\b/.test(u))).toBe(true);
    const doneLane = document.querySelector('[data-column="done"]')!;
    expect(doneLane.querySelector(".board-col-count")?.textContent).toBe("20000");
    expect(doneLane.getAttribute("aria-label")).toBe("Done: 20000");
    expect(doneLane.querySelectorAll(".board-card").length).toBe(25);
    expect(doneLane.querySelector("a.lane-more")?.textContent).toBe(
      "Showing 25 of 20000 — see all in the list",
    );
    const readyLane = document.querySelector('[data-column="ready"]')!;
    expect(readyLane.querySelector(".board-col-count")?.textContent).toBe("5000");
    const sub = document.querySelector(".view-work .view-sub")?.textContent || "";
    expect(sub).toContain("25000 tickets in lanes");
    expect(sub).toContain("5000 won't do");
    expect(document.querySelector(".work-window-note")).toBeNull();
  });

  it("with a filter on a windowed board, says the filter covers the loaded window", async () => {
    const ready = Array.from({ length: 200 }, (_, i) => card(1 + i, "ready"));
    board = {
      columns: columns({ ready }),
      closed: [],
      wontDo: [],
      counts: {
        columns: {
          draft: 0,
          ready: 5_000,
          in_progress: 0,
          blocked: 0,
          in_review: 0,
          in_testing: 0,
          ready_for_merge: 0,
          done: 0,
        },
        closed: 0,
        wontDo: 0,
      },
      window: { limit: 200, offset: 0 },
    };
    location.hash = "#/work?q=Ticket%2012";
    await loadApp();
    const note = document.querySelector(".work-window-note");
    expect(note?.textContent).toBe(
      "Filters apply to the first 200 cards of each lane. The list searches every ticket.",
    );
    expect(note?.querySelector("a")?.getAttribute("href")).toBe("#/work?mode=list");
  });
});

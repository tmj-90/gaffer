// @vitest-environment jsdom
//
// DOM test for the Overview "Development flow" NODE PIPELINE and the enhanced
// "Needs your attention" severity rows (src/api/web/app.js renderOverview):
//   - The development flow renders as five stage nodes (Plan → Ready → Build →
//     Review → Deploy) whose counts come from summary.ticketsByStatus. A stage
//     with work is "active"; an empty stage is "dim".
//   - Needs-attention rows are severity-coded: blocked work is critical, review
//     queue / open decisions are waiting — each with a right-aligned action link.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const zeros14 = () => new Array(14).fill(0);

// draft:2 (Plan active) · ready:0 (dim) · in_progress:3 (Build active) ·
// in_review:1 (Review active) · done:5 (Deploy active) · blocked:1.
const ticketsByStatus = {
  draft: 2,
  ready: 0,
  in_progress: 3,
  in_review: 1,
  done: 5,
  blocked: 1,
};

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
      if (url.includes("/api/health"))
        return json({
          cycle_time: { median_days: 0, series: zeros14() },
          throughput: { last7: 0, prev7: 0, series: zeros14() },
        });
      if (url.includes("/api/human-queue")) return json({ items: [], counts: { total: 0 } });
      if (url.includes("/api/runs")) return json({ active: [], recent: [] });
      if (url.includes("/api/dashboard"))
        return json({
          summary: { ticketsByStatus, blocked: 1, openDecisions: 0, stuckTickets: [] },
        });
      if (url.includes("/api/activity")) return json({ events: [], total: 0 });
      if (url.includes("/api/cost")) return json(null);
      if (url.includes("/api/rework/bouncing")) return json({ bouncing: [] });
      if (url.includes("/tickets")) return json({ tickets: [] });
      if (url.includes("/decisions")) return json({ decisions: [] });
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
  location.hash = "#/overview";
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function loadApp(): Promise<void> {
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}-${Math.random()}`);
  await tick();
  await tick();
  await tick();
}

/** The count text for the pipeline node whose label matches. */
function nodeByLabel(label: string): Element | undefined {
  return Array.from(document.querySelectorAll(".pl-node")).find(
    (n) => n.querySelector(".pl-label")?.textContent === label,
  );
}

describe("web: Overview development-flow node pipeline", () => {
  beforeEach(() => {
    stubFetch();
    mountShell();
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("renders five stage nodes in order with counts from ticketsByStatus", async () => {
    await loadApp();

    const nodes = Array.from(document.querySelectorAll(".pl-node"));
    expect(nodes.length).toBe(5);
    expect(nodes.map((n) => n.querySelector(".pl-label")?.textContent)).toEqual([
      "Plan",
      "Ready",
      "Build",
      "Review",
      "Deploy",
    ]);

    // Counts fold the mapped statuses: Plan=draft, Build=in_progress, Deploy=done.
    expect(nodeByLabel("Plan")?.querySelector(".pl-count")?.textContent).toBe("2");
    expect(nodeByLabel("Build")?.querySelector(".pl-count")?.textContent).toBe("3");
    expect(nodeByLabel("Review")?.querySelector(".pl-count")?.textContent).toBe("1");
    expect(nodeByLabel("Deploy")?.querySelector(".pl-count")?.textContent).toBe("5");
  });

  it("marks stages with work active and empty stages dim", async () => {
    await loadApp();
    expect(nodeByLabel("Plan")?.classList.contains("active")).toBe(true);
    expect(nodeByLabel("Ready")?.classList.contains("dim")).toBe(true);
    expect(nodeByLabel("Deploy")?.classList.contains("active")).toBe(true);
    // Each node carries a distinct stage icon disc.
    expect(nodeByLabel("Plan")?.querySelector(".pl-disc svg")).not.toBeNull();
  });

  it("shows a LIVE badge on the pipeline panel", async () => {
    await loadApp();
    const live = document.querySelector(".pipeline-panel .pl-live");
    expect(live).not.toBeNull();
    expect(live?.textContent || "").toContain("LIVE");
  });
});

describe("web: Overview needs-attention severity rows", () => {
  beforeEach(() => {
    stubFetch();
    mountShell();
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("codes blocked work as critical with an action link, review as waiting", async () => {
    await loadApp();

    const critical = document.querySelector('.needs-item[data-sev="critical"]');
    expect(critical).not.toBeNull();
    expect(critical?.textContent || "").toContain("1 blocked task");
    // Critical row routes to the blocked queue via a right-aligned action link.
    const criticalLink = critical?.querySelector("a.ni-link") as HTMLAnchorElement | null;
    expect(criticalLink?.getAttribute("href")).toBe("#/work?status=blocked");
    expect(critical?.querySelector(".ni-action")?.textContent || "").toContain("View");

    // in_review:1 → a waiting row with a "Review" action.
    const waiting = document.querySelector('.needs-item[data-sev="waiting"]');
    expect(waiting).not.toBeNull();
    expect(waiting?.querySelector(".ni-action")?.textContent || "").toContain("Review");
  });
});

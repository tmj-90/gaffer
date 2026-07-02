// @vitest-environment jsdom
//
// DOM test for the Overview "What I own" lane (src/api/web/app.js):
//   - renders the human-owned queue from GET /api/human-queue (decisions with
//     reasons, review sign-offs, regulated ready-approvals / reviewer assignments),
//   - each row shows the reason, a ticket ref and how long it has waited, and links
//     to its ticket,
//   - shows a quiet empty state when nothing is owed.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

let humanQueuePayload: { items: unknown[]; counts: Record<string, number> } = {
  items: [],
  counts: { total: 0 },
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
      if (url.includes("/api/human-queue")) return json(humanQueuePayload);
      if (url.includes("/api/runs")) return json({ active: [], recent: [] });
      if (url.includes("/api/dashboard")) return json({ summary: { ticketsByStatus: {} } });
      if (url.includes("/api/activity")) return json({ events: [], total: 0 });
      if (url.includes("/api/cost")) return json(null);
      if (url.includes("/api/rework/bouncing")) return json({ bouncing: [] });
      if (url.includes("/tickets")) return json({ tickets: [] });
      if (url.includes("/decisions")) return json({ decisions: [] });
      if (url.includes("/api/audit")) return json({ available: false, entries: [] });
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

describe("web: What I own lane", () => {
  beforeEach(() => {
    stubFetch();
    mountShell();
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
    humanQueuePayload = { items: [], counts: { total: 0 } };
  });

  it("renders each owned item with its reason, ticket ref, wait and ticket link", async () => {
    humanQueuePayload = {
      items: [
        {
          kind: "decision",
          label: "Decision",
          reason: "Postgres or SQLite for the ledger?",
          ticket: { id: "tk-1", number: 12, title: "Ledger", status: "draft" },
          decisionId: "dec-1",
          severity: "human_required",
          since: new Date(Date.now() - 3_600_000).toISOString(),
          waitedMs: 3_600_000,
        },
        {
          kind: "review",
          label: "Review sign-off",
          reason: "please review",
          ticket: { id: "tk-2", number: 7, title: "Ship it", status: "in_review" },
          decisionId: null,
          severity: null,
          since: new Date(Date.now() - 120_000).toISOString(),
          waitedMs: 120_000,
        },
        {
          kind: "ready_approval",
          label: "Ready-approval",
          reason: "Regulated ticket — needs your ready-approval before it can enter the queue.",
          ticket: { id: "tk-3", number: 9, title: "Reg", status: "draft" },
          decisionId: null,
          severity: null,
          since: new Date(Date.now() - 600_000).toISOString(),
          waitedMs: 600_000,
        },
      ],
      counts: { total: 3, decisions: 1, reviews: 1, readyApprovals: 1, reviewerAssignments: 0 },
    };

    await loadApp();

    const panel = document.getElementById("what-i-own");
    expect(panel).not.toBeNull();
    expect(panel!.querySelector(".panel-title")?.textContent).toMatch(/what i own/i);
    // Count badge reflects the total owed.
    expect(panel!.querySelector(".panel-aux")?.textContent).toBe("3");

    const rows = panel!.querySelectorAll(".own-row");
    expect(rows).toHaveLength(3);

    // The decision row surfaces the REASON (not just a count) + its kind chip.
    const decisionRow = panel!.querySelector(".own-row--decision")!;
    expect(decisionRow.querySelector(".own-kind")?.textContent).toMatch(/decision/i);
    expect(decisionRow.querySelector(".own-reason")?.textContent).toBe(
      "Postgres or SQLite for the ledger?",
    );
    // Row links to its ticket.
    expect(decisionRow.getAttribute("href")).toBe("#/ticket/tk-1");
    // Ticket ref + a waited stamp are shown.
    expect(decisionRow.querySelector(".own-ref")?.textContent).toBe("#12");
    expect(decisionRow.querySelector(".own-age")?.textContent).toMatch(/waited/i);

    // Review + regulated approval rows are present and distinctly styled.
    expect(panel!.querySelector(".own-row--review")).not.toBeNull();
    expect(panel!.querySelector(".own-row--ready_approval")).not.toBeNull();
  });

  it("shows a quiet empty state when nothing is owed", async () => {
    humanQueuePayload = { items: [], counts: { total: 0 } };
    await loadApp();

    const panel = document.getElementById("what-i-own");
    expect(panel).not.toBeNull();
    expect(panel!.querySelector(".own-row")).toBeNull();
    const empty = panel!.querySelector(".empty-state");
    expect(empty).not.toBeNull();
    expect(empty!.textContent).toMatch(/nothing is waiting on you/i);
  });
});

// @vitest-environment jsdom
//
// Match Day Overview states (jsdom):
//   - a failed read draws the Overview's own failure page: the dark scoreboard
//     says what happened in one sentence, quotes the server, shows no number it
//     could not read, and offers Try again (not the generic "That page could not load.");
//   - the loading skeleton is shaped like the Overview (scoreboard, Team Sheet,
//     pitch) and carries no figure;
//   - the Match report is commentary: from → to read from the ticket's own event
//     payload, a claim said once (not as a claim AND a move), book-keeping events
//     left off the commentary but kept in the folded full log.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { batchedReads } from "./helpers/batchedReads.js";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const AT = "2026-10-29T18:56:04";
const EVENTS = [
  {
    id: "e-claim",
    entity_type: "ticket",
    entity_id: "tk-27",
    event_type: "claim.created",
    actor_type: "agent",
    actor_id: "ag-2",
    created_at: `${AT}.644Z`,
    ticket_number: 27,
    ticket_title: "Ban floats on money",
  },
  {
    id: "e-move",
    entity_type: "ticket",
    entity_id: "tk-27",
    event_type: "ticket.transitioned",
    actor_type: "agent",
    actor_id: "ag-2",
    created_at: `${AT}.643Z`,
    ticket_number: 27,
    ticket_title: "Ban floats on money",
  },
  {
    id: "e-evidence",
    entity_type: "ticket",
    entity_id: "tk-27",
    event_type: "evidence.recorded",
    actor_type: "agent",
    actor_id: "ag-2",
    created_at: "2026-10-29T18:50:00.000Z",
    ticket_number: 27,
    ticket_title: "Ban floats on money",
  },
];

let dashboardFails = false;

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      batchedReads(async (input: RequestInfo | URL) => {
        const url = String(input);
        const json = (obj: unknown, status = 200) =>
          new Response(JSON.stringify(obj), {
            status,
            headers: { "content-type": "application/json" },
          });
        if (url.includes("/api/dashboard")) {
          if (dashboardFails)
            return json({ error: { code: "INTERNAL", message: "database is locked" } }, 500);
          return json({ summary: { ticketsByStatus: {} } });
        }
        if (url.includes("/api/human-queue")) return json({ items: [], counts: { total: 0 } });
        if (url.includes("/api/runs")) return json({ active: [], recent: [] });
        if (url.includes("/api/activity")) return json({ events: EVENTS, total: EVENTS.length });
        if (url.includes("/api/board")) return json(null);
        if (url.includes("/agents"))
          return json({ agents: [{ id: "ag-2", display_name: "crew-delivery-02" }] });
        if (url.includes("/tickets/tk-27"))
          return json({
            ticket: { id: "tk-27", number: 27, status: "claimed" },
            events: [
              {
                id: "e-move",
                event_type: "ticket.transitioned",
                payload_json: JSON.stringify({ from: "ready", to: "claimed" }),
              },
            ],
            repositories: [],
            scopes: [],
          });
        if (url.includes("/tickets"))
          return json({
            tickets: [
              {
                id: "tk-27",
                number: 27,
                title: "Ban floats on money",
                status: "claimed",
                updated_at: `${AT}.644Z`,
              },
            ],
          });
        if (url.includes("/decisions")) return json({ decisions: [] });
        return json({});
      }),
    ),
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
  for (let i = 0; i < 6; i++) await tick();
}

describe("web: the Overview's loading, failure and match report", () => {
  beforeEach(() => {
    stubFetch();
    mountShell();
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
    dashboardFails = false;
  });

  it("a failed read keeps the scoreboard dark, quotes the server and offers Try again", async () => {
    dashboardFails = true;
    await loadApp();
    const page = document.querySelector("#app .ov-error");
    expect(page).not.toBeNull();
    expect(page!.querySelector(".scoreboard h1")?.textContent).toMatch(
      /couldn.t make up the scoreboard/i,
    );
    expect(page!.textContent).toContain("database is locked");
    expect(page!.textContent).toContain("INTERNAL");
    // No figure it could not read: every counter is blank.
    const vals = [...page!.querySelectorAll(".kpi-val")].map((n) => n.textContent);
    expect(vals).toHaveLength(4);
    for (const v of vals) expect(v).not.toMatch(/\d/);
    const retry = [...page!.querySelectorAll("button")].find((b) => b.textContent === "Try again");
    expect(retry).toBeTruthy();
    expect(document.querySelector("#app")?.textContent).not.toMatch(/That page could not load/);
  });

  it("the loading skeleton is the Overview's shape and shows no number", async () => {
    await loadApp();
    const mod = document.querySelector("#app .view-overview");
    expect(mod).not.toBeNull();
    // Re-enter the route with a read that never answers: the skeleton stays up.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    location.hash = "#/work";
    await tick();
    location.hash = "#/overview";
    for (let i = 0; i < 4; i++) await tick();
    const sk = document.querySelector("#app .sk-overview");
    expect(sk).not.toBeNull();
    expect(sk!.getAttribute("aria-busy")).toBe("true");
    expect(sk!.querySelector(".scoreboard")).not.toBeNull();
    expect(sk!.querySelector(".what-i-own")).not.toBeNull();
    expect(sk!.querySelector("svg.pitch")).not.toBeNull();
    expect(sk!.querySelector("#what-i-own, #tactics")).toBeNull();
    for (const v of sk!.querySelectorAll(".kpi-val")) expect(v.textContent).not.toMatch(/\d/);
  });

  it("the match report says a claim once, reads from → to from the payload, folds book-keeping", async () => {
    await loadApp();
    const report = document.querySelector("#app .report");
    expect(report).not.toBeNull();
    const rows = [...report!.querySelectorAll(".mr-list .mr-row")];
    // claim.created + its move in the same second read as ONE line; evidence is left off.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.querySelector(".mr-ref")?.textContent).toBe("#27");
    expect(rows[0]!.querySelector(".mr-what")?.textContent).toMatch(/Ready\s*→\s*Claimed/);
    expect(rows[0]!.querySelector(".mr-who")?.textContent).toContain("crew-delivery-02");
    // Every event, book-keeping included, is still one click away.
    const all = report!.querySelector("details.mr-all");
    expect(all).not.toBeNull();
    expect(all!.querySelectorAll(".feed-row")).toHaveLength(3);
  });
});

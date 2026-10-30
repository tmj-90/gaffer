// @vitest-environment jsdom
//
// The Floor (#/floor, src/api/web/app.js): the factory floor drawn from the
// Overview's own reads. One parcel per open ticket at its station in lifecycle
// order, a robot in the agent's shirt number on every live claim, the jam bay's
// hazard tape and beacon lit by a blocked ticket, today's despatches on the
// lorry, sentence aria-labels, and the quiet floor's empty state.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const ago = (min: number) => new Date(Date.now() - min * 60e3).toISOString();

const CLUB = {
  name: "Factory FC",
  short_name: "FFC",
  kit_primary: null,
  kit_secondary: null,
  name_effective: "Factory FC",
  short_name_effective: "FFC",
  updated_by: null,
  updated_at: null,
};
const AGENTS = [
  {
    agent_id: "ag-1",
    display_name: null,
    display_name_effective: "Delivery 1",
    default_display_name: "Delivery 1",
    shirt_number: null,
    role: "delivery",
    registered_name: "crew-delivery-01",
    agent_type: "coding_agent",
    status: "active",
  },
  {
    agent_id: "ag-2",
    display_name: "Kev",
    display_name_effective: "Kev",
    default_display_name: "Delivery 2",
    shirt_number: 9,
    role: "delivery",
    registered_name: "crew-delivery-02",
    agent_type: "coding_agent",
    status: "active",
  },
];

type T = { id: string; number: number; title: string; status: string; updated_at: string };
const tk = (number: number, status: string, title = `Ticket ${number}`, min = 5): T => ({
  id: `tk-${number}`,
  number,
  title,
  status,
  updated_at: ago(min),
});

type Payload = {
  tickets: T[];
  claims?: unknown[];
  items?: unknown[];
  events?: Record<string, unknown[]>;
  today?: number;
};

function stubFetch(p: Payload) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = (obj: unknown, status = 200) =>
        new Response(JSON.stringify(obj), {
          status,
          headers: { "content-type": "application/json" },
        });
      const pathOnly = new URL(url, "http://x").pathname;
      if (url.includes("/api/whoami")) return json({ capability: "full" });
      if (url.includes("/api/squad")) return json({ club: CLUB, agents: AGENTS });
      if (url.includes("/api/club")) return json({ club: CLUB });
      if (url.includes("/api/board"))
        return json({
          columns: [{ key: "all", cards: p.tickets.map((t) => ({ ...t, repos: [] })) }],
          closed: [],
          wontDo: [],
        });
      const m = /^\/tickets\/(tk-\d+)$/.exec(pathOnly);
      if (m) {
        const t = p.tickets.find((x) => x.id === m[1]);
        return json({
          ticket: t,
          events: (p.events && p.events[m[1]!]) || [],
          repositories: [],
          scopes: [],
        });
      }
      if (url.includes("/claims")) return json({ claims: p.claims || [] });
      if (url.includes("/agents"))
        return json({
          agents: AGENTS.map((a) => ({ id: a.agent_id, display_name: a.registered_name })),
        });
      if (url.includes("/api/dashboard"))
        return json({ summary: { ticketsByStatus: {}, deliveredToday: 1 } });
      if (url.includes("/api/human-queue"))
        return json({ items: p.items || [], counts: { total: (p.items || []).length } });
      if (url.includes("/api/cost")) return json({ today_usd: p.today ?? 4.1, total_usd: 9 });
      if (url.includes("/api/settings"))
        return json({
          settings: [
            { key: "GAFFER_DAILY_BUDGET_USD", value: "20", effective: "20" },
            { key: "GAFFER_CONCURRENCY", value: "3", effective: "3" },
          ],
        });
      if (url.includes("/api/runs")) return json({ active: [], recent: [] });
      if (url.includes("/api/activity")) return json({ events: [], total: 0 });
      if (url.includes("/decisions")) return json({ decisions: [] });
      if (url.includes("/scope/nodes")) return json({ nodes: [] });
      if (url.includes("/tickets")) return json({ tickets: p.tickets });
      return json({});
    }),
  );
}

function mountShell(hash: string): void {
  document.body.innerHTML = `
    <div id="toast" class="toast" role="alert" hidden></div>
    <div id="sr-status"></div>
    <div class="shell">
      <header id="appbar" class="appbar" hidden></header>
      <main id="app" class="app"><p class="loading">Loading…</p></main>
      <nav id="bottomnav" class="bottomnav" hidden></nav>
    </div>`;
  location.hash = hash;
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function until<R>(fn: () => R | null | undefined | false, n = 120): Promise<R> {
  for (let i = 0; i < n; i++) {
    const v = fn();
    if (v) return v;
    await tick();
  }
  throw new Error("condition not met");
}
const boot = () => import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}-${Math.random()}`);
const floorReady = () => until(() => document.querySelector(".view-floor"));

/** A full floor: one ticket in every status, Kev (No. 9) on #3, #7 blocked. */
const FULL: Payload = {
  tickets: [
    tk(1, "draft"),
    tk(2, "ready"),
    tk(3, "in_progress", "Wire the invoice totals"),
    tk(4, "in_review", "Fix the login redirect"),
    tk(5, "in_testing"),
    tk(6, "ready_for_merge"),
    tk(7, "blocked", "Repeat orders"),
    tk(8, "done", "Shipped today", 30),
    tk(9, "done", "Shipped long ago", 60 * 24 * 3),
    tk(10, "cancelled"),
    tk(11, "refining"),
  ],
  claims: [
    {
      ticket_id: "tk-3",
      ticket_number: 3,
      agent_id: "ag-2",
      agent_display_name: "crew-delivery-02",
      expires_at: new Date(Date.now() + 600e3).toISOString(),
    },
  ],
  items: [
    {
      kind: "parked",
      ticket: { id: "tk-7", number: 7, title: "Repeat orders" },
      reason: "tests fail",
    },
  ],
  events: {
    "tk-4": [
      { event_type: "claim.created", actor_id: "ag-2", actor_type: "agent", created_at: ago(40) },
    ],
    "tk-8": [
      {
        event_type: "ticket.transitioned",
        payload_json: JSON.stringify({ from: "ready_for_merge", to: "done" }),
        created_at: ago(30),
      },
    ],
    "tk-9": [
      {
        event_type: "ticket.transitioned",
        payload_json: JSON.stringify({ from: "ready_for_merge", to: "done" }),
        created_at: ago(60 * 24 * 3),
      },
    ],
  },
};

describe("web: the Floor", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("draws one parcel per open ticket at its station, in lifecycle order, and a Floor nav entry after Squad", async () => {
    stubFetch(FULL);
    mountShell("#/floor");
    await boot();
    const view = await floorReady();
    expect(view.querySelector(".view-head h1")?.textContent).toBe("Floor");
    expect(view.querySelector(".view-sub")?.textContent).toBe(
      "The factory floor: every ticket as a parcel moving station to station, every agent a robot on the one it holds.",
    );
    const parcels = (status: string) =>
      view.querySelectorAll(`svg.fl-svg a.fl-parcel[data-status="${status}"]`).length;
    for (const s of ["draft", "refining", "ready", "in_progress", "in_review", "in_testing"])
      expect(parcels(s), s).toBe(1);
    expect(parcels("ready_for_merge")).toBe(1);
    expect(parcels("blocked")).toBe(1);
    // Done today rides the lorry; older done work and cancelled tickets are not on the floor.
    expect(parcels("done")).toBe(1);
    expect(view.querySelector('a.fl-parcel[data-n="9"]')).toBeNull();
    expect(view.querySelector('a.fl-parcel[data-n="10"]')).toBeNull();
    // The station list reads the lifecycle in order, with its counts.
    const rows = [...view.querySelectorAll<HTMLElement>(".fl-stations li")];
    expect(rows.map((r) => r.dataset.station)).toEqual([
      "drawing",
      "stores",
      "assembly",
      "inspection",
      "testrig",
      "loading",
      "despatch",
      "jam",
    ]);
    const n = (k: string) =>
      view.querySelector(`.fl-stations li[data-station="${k}"] .fl-st-n`)?.textContent;
    expect(n("drawing")).toBe("2");
    expect(n("inspection")).toBe("1");
    expect(n("despatch")).toBe("1");
    // Each parcel is a link to its ticket, read as a sentence.
    const review = view.querySelector<SVGAElement>('a.fl-parcel[data-n="4"]')!;
    expect(review.getAttribute("href")).toBe("#/ticket/tk-4");
    expect(review.getAttribute("aria-label")).toBe(
      "#4 Fix the login redirect, in review, delivered by Kev (No. 9)",
    );
    // The nav: Floor sits right after Squad.
    const areas = [...document.querySelectorAll<HTMLElement>("#appbar .nav-link")].map(
      (a) => a.dataset.area,
    );
    expect(areas.indexOf("floor")).toBe(areas.indexOf("squad") + 1);
    expect(
      document.querySelector('#appbar .nav-link[data-area="floor"]')?.getAttribute("aria-current"),
    ).toBe("page");
  });

  it("a blocked ticket lights the jam bay: hazard tape, the beacon on, a red tag", async () => {
    stubFetch(FULL);
    mountShell("#/floor");
    await boot();
    const view = await floorReady();
    expect(view.querySelector(".fl-jam.is-jammed")).not.toBeNull();
    expect(view.querySelector(".fl-jam .fl-hazard")).not.toBeNull();
    expect(view.querySelector(".fl-beacon.is-on")).not.toBeNull();
    expect(view.querySelector(".fl-tag-danger .fl-tag-text")?.textContent).toBe("#7");
    expect(view.querySelector('a.fl-parcel[data-n="7"]')?.getAttribute("aria-label")).toBe(
      "#7 Repeat orders, blocked, needs you",
    );
  });

  it("an empty jam bay keeps its beacon dark", async () => {
    stubFetch({ tickets: [tk(2, "ready")] });
    mountShell("#/floor");
    await boot();
    const view = await floorReady();
    expect(view.querySelector(".fl-jam.is-jammed")).toBeNull();
    expect(view.querySelector(".fl-beacon")).not.toBeNull();
    expect(view.querySelector(".fl-beacon.is-on")).toBeNull();
  });

  it("a live claim puts a robot on a bench wearing the agent's shirt number", async () => {
    stubFetch(FULL);
    mountShell("#/floor");
    await boot();
    const view = await floorReady();
    const bots = view.querySelectorAll("a.fl-robot");
    expect(bots.length).toBe(1);
    const bot = bots[0]!;
    expect(bot.getAttribute("data-n")).toBe("3");
    expect(bot.getAttribute("data-agent")).toBe("ag-2");
    // The squad's No. 9, not the index scheme's 02 from crew-delivery-02.
    expect(bot.querySelector(".fl-bot-no")?.textContent).toBe("9");
    expect(bot.getAttribute("aria-label")).toBe(
      "#3 Wire the invoice totals, in progress, Kev (No. 9) on it",
    );
    expect(bot.getAttribute("href")).toBe("#/ticket/tk-3");
    // The bench list names the same agent with the same shirt.
    const row = view.querySelector(".fl-bench li")!;
    expect(row.textContent).toContain("Kev");
    expect(row.querySelector(".shirt-no")?.textContent).toBe("9");
  });

  it("a stale claim puts no robot on the floor", async () => {
    stubFetch({
      ...FULL,
      claims: [
        {
          ticket_id: "tk-3",
          ticket_number: 3,
          agent_id: "ag-2",
          agent_display_name: "crew-delivery-02",
          expires_at: ago(10),
        },
      ],
    });
    mountShell("#/floor");
    await boot();
    const view = await floorReady();
    expect(view.querySelectorAll("a.fl-robot").length).toBe(0);
    expect(view.querySelector('a.fl-parcel[data-n="3"]')?.getAttribute("aria-label")).toBe(
      "#3 Wire the invoice totals, in progress",
    );
  });

  it("the spend tank reads today's wage bill against the daily budget", async () => {
    stubFetch(FULL);
    mountShell("#/floor");
    await boot();
    const view = await floorReady();
    expect(view.querySelector(".fl-tank")?.getAttribute("aria-label")).toBe(
      "Spend tank: $4.10 of today's $20 budget (21%).",
    );
    expect(view.querySelector(".fl-tank-fuel")).not.toBeNull();
  });

  it("a quiet floor says so in the club's voice", async () => {
    stubFetch({ tickets: [tk(9, "done", "Old", 60 * 24 * 3)], today: 0 });
    mountShell("#/floor");
    await boot();
    const view = await floorReady();
    expect(view.querySelector(".fl-quiet .es-title")?.textContent).toBe(
      "The floor is quiet: no tickets in play. Plan a build to start the shift.",
    );
    expect(view.querySelector('.fl-quiet a[href="#/create"]')).not.toBeNull();
    expect(view.querySelectorAll("a.fl-parcel").length).toBe(0);
    expect(view.querySelector(".fl-bench p")?.textContent).toBe(
      "No robot is on the floor: 3 benches free.",
    );
  });
});

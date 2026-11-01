// @vitest-environment jsdom
//
// Tactics board crowding (src/api/web/app.js pitchBoard): two or more agents on
// tickets in the same repo and stage share a cell. On the phone (portrait) board
// a channel is narrow, and the counters used to stack along the stage axis so
// one agent's shirt sat on the other counter's disc, hiding its ticket number.
// Every counter's number must stay clear of every other counter's shirt and
// disc, in both orientations, with a few repos (wide channels) and with many
// (narrow ones).

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { batchedReads } from "./helpers/batchedReads.js";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const ago = (min: number) => new Date(Date.now() - min * 60e3).toISOString();

type T = { id: string; number: number; status: string; repo: string; agent?: string };

function stubFetch(tickets: T[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      batchedReads(async (input: RequestInfo | URL) => {
        const url = String(input);
        const json = (obj: unknown) =>
          new Response(JSON.stringify(obj), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        if (url.includes("/api/dashboard")) return json({ summary: { ticketsByStatus: {} } });
        if (url.includes("/api/human-queue")) return json({ items: [], counts: { total: 0 } });
        if (url.includes("/api/runs")) return json({ active: [], recent: [] });
        if (url.includes("/api/activity")) return json({ events: [], total: 0 });
        if (url.includes("/api/board")) return json(null);
        if (url.includes("/claims"))
          return json({
            claims: tickets
              .filter((t) => t.agent)
              .map((t) => ({
                ticket_id: t.id,
                ticket_number: t.number,
                agent_id: "ag-" + t.agent,
                agent_display_name: t.agent,
              })),
          });
        const one = url.match(/\/tickets\/(tk-\d+)/);
        const hit = one && tickets.find((t) => t.id === one[1]);
        if (hit)
          return json({
            ticket: { id: hit.id, number: hit.number, status: hit.status },
            events: [],
            repositories: [{ name: hit.repo, access: "write" }],
            scopes: [],
          });
        if (url.includes("/tickets"))
          return json({
            tickets: tickets.map((t) => ({
              id: t.id,
              number: t.number,
              title: `Ticket ${t.number}`,
              status: t.status,
              updated_at: ago(5),
            })),
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

type Box = { x0: number; y0: number; x1: number; y1: number };
const meets = (a: Box, b: Box) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

/** Each counter's ticket number box, and the boxes its disc and shirt cover. */
function counters(svg: Element) {
  return [...svg.querySelectorAll("a.counter")].map((a) => {
    const disc = a.querySelector("circle.disc")!;
    const cx = Number(disc.getAttribute("cx")),
      cy = Number(disc.getAttribute("cy")),
      r = Number(disc.getAttribute("r"));
    const fs = parseFloat((a.querySelector(".disc-n") as SVGElement).style.fontSize);
    const n = a.querySelector(".disc-n")!.textContent!.length;
    // The number's glyphs: about 0.55em a digit wide, cap height about 0.7em.
    const num = {
      x0: cx - (n * fs * 0.55) / 2,
      x1: cx + (n * fs * 0.55) / 2,
      y0: cy + fs * 0.34 - fs * 0.7,
      y1: cy + fs * 0.34,
    };
    const covers: Box[] = [{ x0: cx - r, y0: cy - r, x1: cx + r, y1: cy + r }];
    const g = a.querySelector(".agent-on > g[transform]");
    if (g) {
      const m = g
        .getAttribute("transform")!
        .match(/translate\(([-\d.]+) ([-\d.]+)\) scale\(([\d.]+)\)/)!;
      const [tx, ty, s] = [Number(m[1]), Number(m[2]), Number(m[3])];
      covers.push({ x0: tx, y0: ty, x1: tx + 40 * s, y1: ty + 40 * s });
    }
    return { label: a.getAttribute("aria-label")!, num, covers };
  });
}

async function boards(tickets: T[]) {
  stubFetch(tickets);
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}-${Math.random()}`);
  for (let i = 0; i < 10; i++) await tick();
  return ["landscape", "portrait"].map((o) => {
    const svg = document.querySelector(`#tactics svg.pitch-${o}`);
    expect(svg, o).not.toBeNull();
    return { o, svg: svg! };
  });
}

function expectNumbersClear(tickets: T[], o: string, svg: Element) {
  const cs = counters(svg);
  expect(cs, o).toHaveLength(tickets.length);
  for (const c of cs)
    for (const d of cs) {
      if (c === d) continue;
      for (const b of d.covers)
        expect(meets(c.num, b), `${o}: ${d.label} covers the number of ${c.label}`).toBe(false);
    }
}

describe("web: tactics board, agents sharing a cell", () => {
  beforeEach(() => {
    mountShell();
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("two agents in one repo and stage sit side by side, not on each other (4 repos)", async () => {
    const tickets: T[] = [
      {
        id: "tk-6",
        number: 6,
        status: "in_progress",
        repo: "billing-api",
        agent: "crew-delivery-01",
      },
      {
        id: "tk-12",
        number: 12,
        status: "in_progress",
        repo: "billing-api",
        agent: "crew-delivery-03",
      },
      { id: "tk-23", number: 23, status: "ready", repo: "billing-api" },
      { id: "tk-24", number: 24, status: "ready", repo: "billing-api" },
      { id: "tk-8", number: 8, status: "ready", repo: "inventory-sync" },
      { id: "tk-21", number: 21, status: "ready", repo: "web-storefront" },
      { id: "tk-13", number: 13, status: "ready", repo: "notify-worker" },
    ];
    for (const { o, svg } of await boards(tickets)) expectNumbersClear(tickets, o, svg);
  });

  it("three agents in one cell of a narrow channel (6 repos) keep every number clear", async () => {
    const repos = ["a-api", "b-api", "c-api", "d-api", "e-api", "f-api"];
    const tickets: T[] = [
      { id: "tk-1", number: 1, status: "in_progress", repo: "a-api", agent: "crew-delivery-01" },
      { id: "tk-2", number: 2, status: "in_progress", repo: "a-api", agent: "crew-delivery-02" },
      { id: "tk-3", number: 3, status: "in_progress", repo: "a-api", agent: "crew-delivery-03" },
      ...repos.slice(1).map((r, i) => ({
        id: `tk-${10 + i}`,
        number: 10 + i,
        status: "ready",
        repo: r,
      })),
    ];
    for (const { o, svg } of await boards(tickets)) expectNumbersClear(tickets, o, svg);
  });
});

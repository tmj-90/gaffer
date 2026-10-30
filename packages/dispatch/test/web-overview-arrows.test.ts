// @vitest-environment jsdom
//
// Tactics board chalk arrows (src/api/web/app.js pitchBoard): every ticket that
// moved in the arrow window gets its arrow, including one whose first move in the
// window started off the pitch:
//   - blocked → ready → claimed → in_progress draws from Ready (the first stage
//     it stood on), not nothing because "blocked" has no place on the pitch;
//   - blocked → ready alone (an Unblock) comes on from the touchline;
//   - ready → claimed still draws from Ready.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const ago = (min: number) => new Date(Date.now() - min * 60e3).toISOString();

const MOVES: Record<string, { status: string; moves: [string, string, number][] }> = {
  "tk-6": {
    status: "in_progress",
    moves: [
      ["blocked", "ready", 140],
      ["ready", "claimed", 6],
      ["claimed", "in_progress", 5],
    ],
  },
  "tk-9": { status: "ready", moves: [["blocked", "ready", 20]] },
  "tk-5": { status: "claimed", moves: [["ready", "claimed", 30]] },
};

const num = (id: string) => Number(id.slice(3));

function events(id: string) {
  return MOVES[id].moves.map(([from, to, min], i) => ({
    id: `${id}-e${i}`,
    entity_type: "ticket",
    entity_id: id,
    event_type: "ticket.transitioned",
    actor_type: "human",
    actor_id: "you",
    created_at: ago(min),
    payload_json: JSON.stringify({ from, to }),
    ticket_number: num(id),
    ticket_title: `Ticket ${num(id)}`,
  }));
}

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
      if (url.includes("/api/dashboard")) return json({ summary: { ticketsByStatus: {} } });
      if (url.includes("/api/human-queue")) return json({ items: [], counts: { total: 0 } });
      if (url.includes("/api/runs")) return json({ active: [], recent: [] });
      if (url.includes("/api/activity")) {
        const all = Object.keys(MOVES).flatMap(events);
        return json({ events: all, total: all.length });
      }
      if (url.includes("/api/board")) return json(null);
      const one = url.match(/\/tickets\/(tk-\d+)/);
      if (one && MOVES[one[1]])
        return json({
          ticket: { id: one[1], number: num(one[1]), status: MOVES[one[1]].status },
          events: events(one[1]),
          repositories: [{ name: "billing-api", access: "write" }],
          scopes: [],
        });
      if (url.includes("/tickets"))
        return json({
          tickets: Object.entries(MOVES).map(([id, t]) => ({
            id,
            number: num(id),
            title: `Ticket ${num(id)}`,
            status: t.status,
            updated_at: ago(5),
          })),
        });
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

describe("web: tactics board chalk arrows", () => {
  beforeEach(() => {
    stubFetch();
    mountShell();
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("draws a move for every ticket that moved, even one whose first move began off the pitch", async () => {
    await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}-${Math.random()}`);
    for (let i = 0; i < 8; i++) await tick();
    for (const o of ["landscape", "portrait"]) {
      const svg = document.querySelector(`#tactics svg.pitch-${o}`);
      expect(svg, o).not.toBeNull();
      expect(svg!.querySelectorAll(".counter"), o).toHaveLength(3);
      expect(svg!.querySelectorAll(".arrows path.arrow"), o).toHaveLength(3);
    }
  });
});

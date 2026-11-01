// @vitest-environment jsdom
//
// exploratory finding api-robustness/F13 (review follow-up): the server answers a
// ?since past the end of the log with an `event: reset` frame whose `id` is the latest
// seq, so the dashboard's cursor moves back. The client kept its old cursor when that
// id was 0 (an empty log after a restore), because it read the id with `Number(..) ||`.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const streamUrls: string[] = [];
let frames: string[] = [];

function json(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  streamUrls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/events/stream")) {
        streamUrls.push(url);
        const body = frames.shift() ?? "";
        // Each stream sends its frames and ends, so the client reconnects.
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (url.includes("/specs")) return json({ specs: [] });
      if (url.includes("/api/dashboard")) return json({ summary: { ticketsByStatus: {} } });
      return json({});
    }),
  );
  document.body.innerHTML = `
    <div id="toast" class="toast" role="alert" hidden></div>
    <div class="shell">
      <header id="appbar" class="appbar" hidden></header>
      <main id="app" class="app"><p class="loading">Loading…</p></main>
      <nav id="bottomnav" class="bottomnav" hidden></nav>
    </div>`;
  location.hash = "#/specs";
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle(n = 12): Promise<void> {
  for (let i = 0; i < n; i++) await tick();
}
/** Reconnect now (the app restarts the stream when the tab becomes visible). */
async function reconnect(): Promise<void> {
  document.dispatchEvent(new Event("visibilitychange"));
  await settle();
}

describe("web: the live stream cursor follows the server's reset frame", () => {
  it("a reset to seq 0 moves the cursor back to 0", async () => {
    frames = [
      "retry: 3000\n: connected seq=9\n\nid: 9\nevent: work_event\ndata: {}\n\n",
      ": since=9 is past the latest event seq 0; resuming from 0\nid: 0\nevent: reset\ndata: {}\n\n",
    ];
    await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}-${Math.random()}`);
    await settle();
    expect(streamUrls[0]).toMatch(/\/api\/events\/stream$/);
    await reconnect();
    expect(streamUrls[1]).toMatch(/\?since=9$/);
    await reconnect();
    expect(streamUrls[2]).toMatch(/\?since=0$/);
  });
});

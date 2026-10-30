// @vitest-environment jsdom
//
// live-lamp-hardcoded (dashboard-logic audit): the header's "LIVE · Factory
// online" lamp was static and kept ticking with the API dead, and a network
// failure surfaced as the browser's raw "Failed to fetch".
//
// Now the header line is driven by real responses: "Data as of HH:MM" after a
// successful read; "Offline · data from HH:MM" with data-state=offline once a
// call cannot reach the server; and api() turns a network failure or a non-JSON
// proxy page into one plain sentence with a code (never "Failed to fetch").

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

let mode: "up" | "down" | "html" = "up";

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
      if (url.includes("/api/events/stream")) throw new TypeError("Failed to fetch");
      if (mode === "down") throw new TypeError("Failed to fetch");
      if (mode === "html")
        return new Response("<html><body>502 Bad Gateway</body></html>", {
          status: 502,
          headers: { "content-type": "text/html" },
        });
      if (url.includes("/specs")) return json({ specs: [] });
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
  location.hash = "#/specs";
}
const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) await tick();
}
const lamp = () => document.querySelector<HTMLElement>(".rail-status");

describe("web: header data freshness comes from real responses", () => {
  beforeEach(() => {
    mode = "up";
    stubFetch();
    mountShell();
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("says when the data was read, then Offline when the factory stops answering", async () => {
    await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}-${Math.random()}`);
    await settle();
    expect(lamp()).not.toBeNull();
    // The stream is down (stubbed) but reads succeed: an honest "Data as of".
    expect(lamp()!.dataset.state).toBe("polling");
    expect(lamp()!.textContent).toMatch(/Data as of \d{2}:\d{2}/);
    expect(lamp()!.textContent).not.toMatch(/LIVE|online/i);

    // The factory goes away: the next read fails.
    mode = "down";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await settle();
    expect(lamp()!.dataset.state).toBe("offline");
    expect(lamp()!.textContent).toMatch(/Offline · data from \d{2}:\d{2}/);
    expect(document.body.classList.contains("is-offline")).toBe(true);
    // The failure is one plain sentence, never the browser's raw message.
    expect(document.body.textContent).not.toContain("Failed to fetch");
    expect(document.getElementById("app")!.textContent).toContain("Can't reach the factory");
  });

  it("turns a non-JSON proxy page into a coded, readable error", async () => {
    await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}-${Math.random()}`);
    await settle();
    mode = "html";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await settle();
    const text = document.getElementById("app")!.textContent || "";
    expect(text).toContain("answered 502 with a page that isn't data");
    expect(text).not.toMatch(/SyntaxError|Unexpected token/);
  });
});

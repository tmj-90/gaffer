// @vitest-environment jsdom
//
// The command palette finds a ticket by its number: "#7" + Enter opens ticket #7,
// even when typed before the palette's ticket list has loaded (the list used to be
// re-rendered unfiltered on load, so Enter opened Overview), and the exact number
// ranks ahead of fuzzy hits such as #17. Found by the browser scenario suite S3.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const ticket = (n: number) => ({
  id: `tkt-${n}`,
  number: n,
  title: `Ticket number ${n}`,
  status: "ready",
  risk_level: "low",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
});

let releaseTickets: () => void = () => {};

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (/\/tickets(\?|$)/.test(url)) {
        // Hold the palette's ticket list until the test has typed.
        await new Promise<void>((r) => (releaseTickets = r));
        return new Response(JSON.stringify({ tickets: [ticket(17), ticket(7)] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("web: the command palette opens a ticket by number", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("'#7' typed before the list loads, then Enter, opens #7 (not Overview, not #17)", async () => {
    document.body.innerHTML = `
      <div id="toast" class="toast" role="alert" hidden></div>
      <div class="shell">
        <header id="appbar" class="appbar" hidden></header>
        <main id="app" class="app"><p class="loading">Loading…</p></main>
        <nav id="bottomnav" class="bottomnav" hidden></nav>
      </div>`;
    location.hash = "#/settings";
    stubFetch();
    await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
    await tick();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }),
    );
    await tick();
    const input = document.querySelector<HTMLInputElement>(".palette-input")!;
    expect(input).toBeTruthy();
    input.value = "#7";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    releaseTickets();
    for (let i = 0; i < 6; i++) await tick();
    const first = document.querySelector(".palette-item.active .pi-label")?.textContent ?? "";
    expect(first).toBe("#7 Ticket number 7");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await tick();
    expect(location.hash).toBe("#/ticket/tkt-7");
  });
});

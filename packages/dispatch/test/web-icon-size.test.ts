// @vitest-environment jsdom
//
// settings-access-giant-icon (dashboard-logic audit): icon() set no width or
// height, so an icon whose class only set colour (Settings › Access `.ar-ico`)
// stretched to the full flex row — an 830px padlock with its heading squeezed
// into a ~12px column. Every icon now carries width/height attributes (20 by
// default); CSS may still resize it.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

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
      if (url.includes("/api/whoami"))
        return json({ actor: { id: "dispatch-api" }, capability: "full", via: "shared" });
      if (url.includes("/api/principals")) return json({ principals: [] });
      if (url.includes("/api/settings"))
        return json({
          settings: [
            {
              key: "DISPATCH_ALLOW_AGENT_APPROVE",
              value: "0",
              envLocked: false,
              type: "boolean",
              group: "autonomy",
              label: "Agents may approve reviews",
            },
          ],
        });
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
  location.hash = "#/settings";
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("web: every icon is sized", () => {
  beforeEach(() => {
    stubFetch();
    mountShell();
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("gives every 24-grid icon width and height attributes, incl. the Access lock", async () => {
    await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}-${Math.random()}`);
    for (let i = 0; i < 10; i++) await tick();
    const icons = Array.from(document.querySelectorAll('svg[viewBox="0 0 24 24"]'));
    expect(icons.length).toBeGreaterThan(0);
    for (const svg of icons) {
      expect(Number(svg.getAttribute("width")), svg.outerHTML.slice(0, 80)).toBeGreaterThan(0);
      expect(Number(svg.getAttribute("height"))).toBeLessThanOrEqual(48);
    }
    // The panel that rendered an 830px lock. The boot room's Access panel now
    // opens on a kit-colour title block (no padlock icon beside its heading), so
    // the check is that it rendered and every icon left in it is sized.
    const access = document.querySelector(".access-panel");
    expect(access).not.toBeNull();
    expect(access!.querySelector(".panel-head.block .panel-title")?.textContent).toBe("Access");
    for (const svg of Array.from(access!.querySelectorAll("svg"))) {
      expect(Number(svg.getAttribute("width"))).toBeGreaterThan(0);
      expect(Number(svg.getAttribute("width"))).toBeLessThanOrEqual(48);
    }
    // Every settings-note clock and lock badge carries its size too.
    const clock = document.querySelector(".settings-note-ico");
    expect(clock).not.toBeNull();
    expect(clock!.getAttribute("width")).toBe("16");
  });
});

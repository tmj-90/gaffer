// @vitest-environment jsdom
//
// DOM smoke test for the SPA's "Plan a build" bottom sheet (src/api/web/app.js).
//
// Regression guard for the mobile bug where the Plan-a-build panel would not
// open: the dominant root cause was the lazily-created, body-appended sheet/
// palette scrims keeping pointer-events:auto while closed, covering the whole
// viewport and swallowing the trigger tap. This test drives the real wiring —
// render the (empty) Epics view, click "Plan a build", and assert the panel
// opens above the page chrome and is dismissible by tapping the scrim.

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Resolve from the repo root (vitest cwd) — under the jsdom environment
// import.meta.url is an http:// URL, so file URL helpers can't be used here.
const APP_DIR = path.resolve(process.cwd(), "src/api/web");
const APP_JS = path.join(APP_DIR, "app.js");
const STYLES_CSS = path.join(APP_DIR, "styles.css");

/** Minimal API responses the boot path (router → renderEpics) needs. */
function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("/scope/nodes")
        ? { nodes: [] }
        : url.includes("/tickets")
          ? { tickets: [] }
          : {};
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

/** Build the index.html shell the module expects (#app, #appbar, #bottomnav). */
function mountShell(): void {
  document.body.innerHTML = `
    <div id="toast" class="toast" role="alert" hidden></div>
    <div class="shell">
      <header id="appbar" class="appbar" hidden></header>
      <main id="app" class="app"><p class="loading">Loading…</p></main>
      <nav id="bottomnav" class="bottomnav" hidden></nav>
    </div>`;
  location.hash = "#/epics";
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("web: Plan-a-build panel (mobile bottom sheet)", () => {
  beforeEach(() => {
    stubFetch();
    mountShell();
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("opens the docked panel when the Plan-a-build trigger is clicked, then closes on scrim tap", async () => {
    // Importing app.js boots the SPA: buildChrome() + router() render the Epics view.
    await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
    await tick(); // let the async router() settle the fetched (empty) Epics view

    // The empty Epics view exposes a "Plan a build" trigger.
    const triggers = Array.from(document.querySelectorAll("button")).filter((b) =>
      b.textContent?.includes("Plan a build"),
    );
    expect(triggers.length).toBeGreaterThan(0);

    // No scrim should exist until the panel is first opened.
    expect(document.querySelector(".pb-scrim")).toBeNull();

    // Tap it — the panel must open.
    triggers[0]!.click();
    await tick();

    const scrim = document.querySelector(".pb-scrim");
    expect(scrim).not.toBeNull();
    expect(scrim!.classList.contains("open")).toBe(true);

    const panel = scrim!.querySelector(".pb-panel");
    expect(panel).not.toBeNull();
    // The panel carries its dialog semantics and a close control.
    expect(panel!.getAttribute("role")).toBe("dialog");
    expect(panel!.querySelector('button[aria-label="Close"]')).not.toBeNull();
    // It opens above the fixed appbar (z 40) / bottomnav (z 45): scrim is z 60+.

    // Dismissible by tapping the scrim (clicking the panel must NOT close it).
    (panel as HTMLElement).click();
    await tick();
    expect(scrim!.classList.contains("open")).toBe(true);

    (scrim as HTMLElement).click();
    await tick();
    expect(scrim!.classList.contains("open")).toBe(false);
  });

  it("guards the lazily-created overlay scrims against swallowing taps when closed", () => {
    // Root-cause guard: a closed full-viewport scrim must drop pointer-events,
    // otherwise it covers the page and blocks every tap (incl. Plan a build).
    const css = readFileSync(STYLES_CSS, "utf8");
    for (const sel of [".sheet-scrim", ".palette-scrim", ".pb-scrim"]) {
      const block = css.slice(css.indexOf(sel + " {"));
      const rule = block.slice(0, block.indexOf("}"));
      expect(rule, `${sel} must set pointer-events:none while closed`).toMatch(
        /pointer-events:\s*none/,
      );
    }
    // …and re-enable them only when open.
    expect(css).toMatch(/\.sheet-scrim\.open\s*\{[^}]*pointer-events:\s*auto/);
    expect(css).toMatch(/\.palette-scrim\.open\s*\{[^}]*pointer-events:\s*auto/);
  });
});

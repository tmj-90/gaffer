// @vitest-environment jsdom
//
// DOM test for the SPA Settings view (src/api/web/app.js):
//   - renders grouped settings sections,
//   - shows an env-locked setting read-only with a "set by env" badge,
//   - Save POSTs the editable (non-locked) values back.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const SETTINGS = [
  {
    key: "DISPATCH_ALLOW_AGENT_APPROVE",
    value: "0",
    envLocked: false,
    type: "boolean",
    group: "autonomy",
    label: "Agents may approve reviews",
  },
  {
    key: "MAX_TICKS",
    value: "20",
    envLocked: false,
    type: "int",
    group: "budget",
    label: "Max ticks (run)",
  },
  {
    key: "GAFFER_PLAN_DEBATE",
    value: "1",
    envLocked: true,
    type: "boolean",
    group: "planning-debate",
    label: "Plan debate",
  },
  {
    key: "GAFFER_PLAN_DEBATE_MODELS",
    value: "a,b",
    envLocked: false,
    type: "csv",
    group: "planning-debate",
    label: "Debate models",
  },
];

let lastPost: { url: string; body: unknown } | null = null;

function stubFetch(): void {
  lastPost = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/api/settings") && method === "POST") {
        lastPost = { url, body: JSON.parse(String(init?.body ?? "{}")) };
        return new Response(
          JSON.stringify({ settings: SETTINGS, written: ["MAX_TICKS"], rejected: [], ignored: [] }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (url.includes("/api/settings")) {
        return new Response(JSON.stringify({ settings: SETTINGS }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
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

describe("web: Settings view", () => {
  beforeEach(() => {
    stubFetch();
    mountShell();
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("renders grouped settings, env-locked read-only, and saves editable values", async () => {
    await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
    await tick();

    // Grouped sections appear (Autonomy + Budget + Planning debate cards).
    const groupTitles = Array.from(document.querySelectorAll(".settings-group h2")).map(
      (h) => h.textContent,
    );
    expect(groupTitles).toContain("Autonomy");
    expect(groupTitles).toContain("Budget & caps");
    expect(groupTitles).toContain("Planning debate");

    // The standing "next tick" note is present.
    expect(document.querySelector(".settings-note")?.textContent).toMatch(/next tick/i);

    // Each known setting has a row.
    const rows = document.querySelectorAll(".setting-row");
    expect(rows.length).toBe(SETTINGS.length);

    // The env-locked setting renders read-only with a "set by env" badge.
    const lockedRow = Array.from(rows).find(
      (r) => r.querySelector(".setting-key")?.textContent === "GAFFER_PLAN_DEBATE",
    ) as HTMLElement;
    expect(lockedRow.classList.contains("is-locked")).toBe(true);
    expect(lockedRow.querySelector(".badge.env-locked")?.textContent).toMatch(/set by env/i);
    const lockedInput = lockedRow.querySelector("input") as HTMLInputElement;
    expect(lockedInput.disabled).toBe(true);
    // No checkbox/switch editor was registered for the locked boolean.
    expect(lockedRow.querySelector(".switch")).toBeNull();

    // Flip the editable boolean (autonomy) and edit the int (MAX_TICKS).
    const autonomyRow = Array.from(rows).find(
      (r) => r.querySelector(".setting-key")?.textContent === "DISPATCH_ALLOW_AGENT_APPROVE",
    ) as HTMLElement;
    const toggle = autonomyRow.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(toggle).not.toBeNull();
    toggle.checked = true;

    const maxRow = Array.from(rows).find(
      (r) => r.querySelector(".setting-key")?.textContent === "MAX_TICKS",
    ) as HTMLElement;
    const maxInput = maxRow.querySelector('input[type="number"]') as HTMLInputElement;
    maxInput.value = "99";

    // Submit the form → POST /api/settings.
    const form = document.querySelector(".settings-form") as HTMLFormElement;
    form.requestSubmit();
    await tick();
    await tick();

    expect(lastPost).not.toBeNull();
    const body = lastPost!.body as { settings: Record<string, string> };
    // Editable values are sent; the env-locked key is NOT in the payload.
    expect(body.settings.DISPATCH_ALLOW_AGENT_APPROVE).toBe("1");
    expect(body.settings.MAX_TICKS).toBe("99");
    expect(body.settings).not.toHaveProperty("GAFFER_PLAN_DEBATE");
  });
});

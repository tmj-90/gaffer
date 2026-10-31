// @vitest-environment jsdom
//
// The dashboard's first live run sets a dollar cap. A live tick with neither
// GAFFER_DAILY_BUDGET_USD nor GAFFER_BUDGET_USD is refused by the runner
// (runner/lib/budget.sh gaffer_spend_cap_ok), so the Work view's "Poll for work"
// asks for a daily budget (prefilled $5) and saves it BEFORE it fires the poll.
// With a cap already set, the poll fires straight away; Cancel fires nothing.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

interface Call {
  method: string;
  url: string;
  body: unknown;
}
let calls: Call[] = [];
let settings: Record<string, string> = {};
let envLocked: Set<string> = new Set();

function settingRows() {
  return ["GAFFER_DAILY_BUDGET_USD", "GAFFER_BUDGET_USD", "MAX_TICKS_PER_DAY"].map((key) => ({
    key,
    value: settings[key] ?? "",
    effective: settings[key] ?? "",
    source: settings[key] ? "file" : "default",
    envLocked: envLocked.has(key),
    type: "string",
    group: "budget",
    label: key,
  }));
}

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ method, url, body });
      const json = (obj: unknown) =>
        new Response(JSON.stringify(obj), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (url.includes("/api/settings")) {
        if (method === "POST") {
          const written: string[] = [];
          for (const [k, v] of Object.entries(
            (body as { settings: Record<string, string> }).settings,
          )) {
            if (envLocked.has(k)) continue;
            settings[k] = v;
            written.push(k);
          }
          return json({ settings: settingRows(), written, rejected: [], ignored: [], invalid: [] });
        }
        return json({ settings: settingRows() });
      }
      if (url.includes("/poll-work"))
        return json({ polled: true, readyCount: 1, run: { runId: null } });
      if (url.includes("/api/runs")) return json({ active: [], recent: [] });
      if (url.includes("/api/dashboard")) return json({ summary: { ticketsByStatus: {} } });
      if (url.includes("/tickets")) return json({ tickets: [] });
      if (url.includes("/decisions")) return json({ decisions: [] });
      if (url.includes("/api/activity")) return json({ events: [], total: 0 });
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
  location.hash = "#/work";
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) await tick();
}

async function loadApp(): Promise<void> {
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}-${Math.random()}`);
  await settle();
}

function pollButton(): HTMLButtonElement {
  const btn = [...document.querySelectorAll("button")].find((b) =>
    /poll for work/i.test(b.textContent || ""),
  );
  expect(btn, "the Work view has a Poll for work button").toBeTruthy();
  return btn as HTMLButtonElement;
}
const polls = () => calls.filter((c) => c.method === "POST" && c.url.includes("/poll-work"));
const sheet = () => document.querySelector(".sheet.open") as HTMLElement | null;

describe("web: the first live poll sets a dollar cap", () => {
  beforeEach(() => {
    calls = [];
    settings = {};
    envLocked = new Set();
    stubFetch();
    mountShell();
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("asks for a daily budget, saves it, then polls", async () => {
    await loadApp();
    pollButton().click();
    await settle();
    expect(polls()).toHaveLength(0);
    const s = sheet();
    expect(s, "a sheet opens").not.toBeNull();
    expect(s!.querySelector("#sheet-title")?.textContent).toBe("Set a daily budget");
    const input = s!.querySelector("#spend-cap-usd") as HTMLInputElement;
    expect(input.value).toBe("5");
    expect(document.activeElement).toBe(input);
    (s!.querySelector("form") as HTMLFormElement).requestSubmit();
    await settle(12);
    const save = calls.find((c) => c.method === "POST" && c.url.includes("/api/settings"));
    expect(save?.body).toEqual({ settings: { GAFFER_DAILY_BUDGET_USD: "5" } });
    expect(polls()).toHaveLength(1);
    expect(sheet()).toBeNull();
    expect(document.getElementById("toast")?.textContent).toMatch(/tick fired|\$5 a day/i);
  });

  it("refuses a budget of 0 and saves nothing", async () => {
    await loadApp();
    pollButton().click();
    await settle();
    const s = sheet()!;
    const input = s.querySelector("#spend-cap-usd") as HTMLInputElement;
    input.value = "0";
    (s.querySelector("form") as HTMLFormElement).requestSubmit();
    await settle();
    expect(s.querySelector(".form-error")?.textContent).toMatch(/above \$0/);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("Cancel leaves the factory unpolled and the settings untouched", async () => {
    await loadApp();
    pollButton().click();
    await settle();
    const cancel = [...sheet()!.querySelectorAll("button")].find(
      (b) => b.textContent === "Cancel",
    ) as HTMLButtonElement;
    cancel.click();
    await settle();
    expect(sheet()).toBeNull();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("polls straight away when a cap is already set", async () => {
    settings = { GAFFER_BUDGET_USD: "20" };
    await loadApp();
    pollButton().click();
    await settle();
    expect(sheet()).toBeNull();
    expect(polls()).toHaveLength(1);
  });

  it("leaves an environment-set cap to the runner (no sheet)", async () => {
    envLocked = new Set(["GAFFER_DAILY_BUDGET_USD"]);
    await loadApp();
    pollButton().click();
    await settle();
    expect(sheet()).toBeNull();
    expect(polls()).toHaveLength(1);
  });
});

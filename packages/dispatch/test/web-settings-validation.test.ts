// @vitest-environment jsdom
//
// The Settings form refuses an invalid value inline and says which field blocks Save
// (exploratory findings ui-workflows/F2 and F11). A non-numeric daily budget used to
// save ("Saved 1 setting") and then read as no cap at all; a Concurrent ticks of -3
// blocked Save for every field with only the browser's own bubble, and nothing said why.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const SETTINGS = [
  {
    key: "GAFFER_DAILY_BUDGET_USD",
    value: "5",
    effective: "5",
    source: "file",
    envLocked: false,
    type: "number",
    group: "budget",
    label: "Daily budget (USD)",
  },
  {
    key: "MAX_TICKS",
    value: "",
    effective: "",
    source: "default",
    envLocked: false,
    type: "int",
    group: "budget",
    label: "Max ticks (run)",
  },
  {
    key: "GAFFER_CONCURRENCY",
    value: "",
    effective: "",
    source: "default",
    envLocked: false,
    type: "int",
    min: 1,
    group: "execution",
    label: "Concurrent ticks",
  },
];

let posts: Array<Record<string, string>> = [];

function stubFetch(): void {
  posts = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const json = (obj: unknown) =>
        new Response(JSON.stringify(obj), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (url.includes("/api/settings") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          settings: Record<string, string>;
        };
        posts.push(body.settings);
        return json({
          settings: SETTINGS,
          written: Object.keys(body.settings),
          rejected: [],
          ignored: [],
          invalid: [],
        });
      }
      if (url.includes("/api/settings")) return json({ settings: SETTINGS });
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

function row(key: string): HTMLElement {
  return document.getElementById(`set-${key}`) as HTMLElement;
}

function setValue(key: string, value: string): HTMLInputElement {
  const input = row(key).querySelector("input") as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return input;
}

async function save(): Promise<void> {
  (document.querySelector(".settings-form") as HTMLFormElement).requestSubmit();
  await tick();
  await tick();
}

describe("web: Settings form validation", () => {
  beforeEach(() => {
    stubFetch();
    mountShell();
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("a non-numeric daily budget is refused inline, names the field, and posts nothing", async () => {
    await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
    await tick();
    const input = setValue("GAFFER_DAILY_BUDGET_USD", "abc");
    await save();
    expect(posts).toEqual([]);
    const err = row("GAFFER_DAILY_BUDGET_USD").querySelector(".setting-error");
    expect(err?.textContent).toMatch(/number of 0 or more/);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById("toast")?.textContent).toMatch(/Daily budget \(USD\)/);

    // Fixed, it saves (and the inline message goes).
    setValue("GAFFER_DAILY_BUDGET_USD", "2.50");
    await save();
    expect(posts).toEqual([{ GAFFER_DAILY_BUDGET_USD: "2.50" }]);
    expect(row("GAFFER_DAILY_BUDGET_USD").querySelector(".setting-error")).toBeNull();
  });

  it("Concurrent ticks below 1 says which field blocks Save, instead of silently posting nothing", async () => {
    await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
    await tick();
    setValue("MAX_TICKS", "30");
    for (const bad of ["-3", "0"]) {
      setValue("GAFFER_CONCURRENCY", bad);
      await save();
      expect(posts, bad).toEqual([]);
      expect(row("GAFFER_CONCURRENCY").querySelector(".setting-error")?.textContent, bad).toMatch(
        /whole number of 1 or more/,
      );
      expect(document.getElementById("toast")?.textContent, bad).toMatch(/Concurrent ticks/);
    }
    setValue("GAFFER_CONCURRENCY", "2");
    await save();
    expect(posts).toEqual([{ MAX_TICKS: "30", GAFFER_CONCURRENCY: "2" }]);
  });
});

describe("web: a value only the server can judge is still named on its row (exploratory finding ui-workflows/F11)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("a webhook URL the server refuses (422) is marked on its row, not only in the toast", async () => {
    const WEBHOOK = {
      key: "GAFFER_NOTIFY_WEBHOOK_URL",
      value: "",
      effective: "",
      source: "default",
      envLocked: false,
      type: "string",
      secret: true,
      configured: false,
      group: "notifications",
      label: "Webhook URL",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url.includes("/api/settings") && method === "POST")
          return new Response(
            JSON.stringify({
              error: {
                code: "VALIDATION_ERROR",
                message: "Not saved: Webhook URL is not an allowed webhook address.",
                details: {
                  invalid: [
                    {
                      key: "GAFFER_NOTIFY_WEBHOOK_URL",
                      label: "Webhook URL",
                      problem: "is not an allowed webhook address",
                    },
                  ],
                },
              },
            }),
            { status: 422, headers: { "content-type": "application/json" } },
          );
        return new Response(JSON.stringify({ settings: [...SETTINGS, WEBHOOK] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    mountShell();
    vi.resetModules();
    await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
    for (let i = 0; i < 4; i++) await tick();
    const r = row("GAFFER_NOTIFY_WEBHOOK_URL");
    const replace = [...r.querySelectorAll("button")].find((b) =>
      /Set|Replace/.test(b.textContent ?? ""),
    );
    replace?.click();
    const box = r.querySelector(
      'input[type="text"], input[type="password"], input:not([type])',
    ) as HTMLInputElement;
    box.value = "http://127.0.0.1:9/hook";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    await save();
    for (let i = 0; i < 6; i++) await tick();
    expect(document.getElementById("toast")?.textContent).toMatch(/Webhook URL/);
    expect(r.querySelector(".setting-error")?.textContent).toMatch(
      /Webhook URL is not an allowed webhook address/,
    );
    expect(box.getAttribute("aria-invalid")).toBe("true");
  });
});

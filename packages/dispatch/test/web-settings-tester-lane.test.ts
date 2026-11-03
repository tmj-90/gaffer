// @vitest-environment jsdom
//
// TESTER FIRST review: the tester lane's switch (GAFFER_TESTING) on the Settings view.
// Unset is the adaptive default (on where a test command is registered), so the switch
// says Auto, an untouched Save writes nothing, and moving it writes an explicit on or off.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const row = (value: string, effective = value) => ({
  key: "GAFFER_TESTING",
  value,
  effective,
  envLocked: false,
  type: "boolean",
  group: "autonomy",
  label: "Independent black-box testing",
});
const OTHER = {
  key: "MAX_TICKS",
  value: "20",
  effective: "20",
  envLocked: false,
  type: "int",
  group: "budget",
  label: "Max ticks (run)",
};

let settings: unknown[] = [];
let lastPost: { settings: Record<string, string> } | null = null;

function stubFetch(): void {
  lastPost = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (url.includes("/api/settings") && method === "POST") {
        lastPost = JSON.parse(String(init?.body ?? "{}"));
        return json({ settings, written: [], rejected: [], ignored: [] });
      }
      if (url.includes("/api/settings")) return json({ settings });
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

async function open(rows: unknown[]) {
  settings = rows;
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}${Math.random()}`);
  await tick();
  const r = Array.from(document.querySelectorAll(".setting-row")).find(
    (x) => x.querySelector(".setting-key")?.textContent === "GAFFER_TESTING",
  ) as HTMLElement;
  const input = r.querySelector('input[type="checkbox"]') as HTMLInputElement;
  const word = () => r.querySelector(".switch-word")?.textContent;
  const save = async () => {
    (document.querySelector(".settings-form") as HTMLFormElement).requestSubmit();
    await tick();
    await tick();
  };
  const flip = () => {
    input.checked = !input.checked;
    input.dispatchEvent(new Event("change"));
  };
  return { input, word, save, flip };
}

describe("web: the tester lane switch says Auto for the default", () => {
  beforeEach(() => {
    stubFetch();
    mountShell();
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("unset reads Auto, not Off, and an untouched Save does not switch it off", async () => {
    const s = await open([row(""), OTHER]);
    expect(s.input.checked).toBe(false);
    expect(s.word()).toBe("Auto");
    (document.querySelector('.setting-row input[type="number"]') as HTMLInputElement).value = "21";
    await s.save();
    expect(lastPost?.settings.MAX_TICKS).toBe("21");
    expect(lastPost?.settings).not.toHaveProperty("GAFFER_TESTING");
  });

  it("moving it on and back off writes an explicit off", async () => {
    const s = await open([row(""), OTHER]);
    s.flip();
    expect(s.word()).toBe("On");
    s.flip();
    expect(s.word()).toBe("Off");
    await s.save();
    expect(lastPost?.settings.GAFFER_TESTING).toBe("0");
  });

  it("an explicit 0 reads Off and 1 reads On", async () => {
    expect((await open([row("0"), OTHER])).word()).toBe("Off");
    document.body.innerHTML = "";
    mountShell();
    vi.resetModules();
    expect((await open([row("1"), OTHER])).word()).toBe("On");
  });
});

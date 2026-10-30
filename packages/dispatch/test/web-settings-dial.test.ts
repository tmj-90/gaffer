// @vitest-environment jsdom
//
// DOM test for the boot room's team instructions (src/api/web/app.js): the
// autonomy dial IS the GAFFER_MODE setting (moving it changes the select, counts
// as one unsaved change and saves only that key), the formation previews who
// plays each gate under the new mode (a value set in settings.json is kept), the
// Go/No-Go appears only when raising the dial, and the save bar names the change.
// Also: an address under #/ that names no page renders the 404 page, not the
// Overview.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const S = (
  key: string,
  value: string,
  effective: string,
  source: string,
  type: string,
  group: string,
  label: string,
  extra: Record<string, unknown> = {},
) => ({ key, value, effective, source, envLocked: false, type, group, label, ...extra });

const SETTINGS = [
  S("GAFFER_MODE", "graduated", "graduated", "file", "string", "autonomy", "Autonomy mode", {
    choices: ["supervised", "lite", "graduated", "autonomous", "strict"],
  }),
  S("REVIEW_MODE", "", "agent", "mode", "string", "autonomy", "Review mode", {
    choices: ["human", "agent", "both"],
  }),
  S("DISPATCH_ALLOW_AGENT_APPROVE", "", "0", "mode", "boolean", "autonomy", "Agents may approve"),
  S("MERGE_ON_AGENT_REVIEW", "", "0", "mode", "boolean", "autonomy", "Auto-merge on agent review"),
  S("MEMORY_AUTO_APPROVE", "", "0", "mode", "boolean", "autonomy", "Auto-approve memory drafts"),
  S("GAFFER_TESTING", "1", "1", "file", "boolean", "autonomy", "Independent testing"),
  // Set in settings.json: the mode cannot turn it on.
  S("AUTO_MERGE", "0", "0", "file", "boolean", "delivery", "Auto-merge on approval"),
  S("GAFFER_AUTO_PUSH", "", "0", "mode", "boolean", "delivery", "Push after merge"),
  S("GAFFER_DAILY_BUDGET_USD", "25", "25", "file", "string", "budget", "Daily budget (USD)"),
  S("GAFFER_REQUIRE_CI", "", "", "default", "boolean", "delivery", "Require CI"),
];

let lastPost: { url: string; body: { settings: Record<string, string> } } | null = null;

function stubFetch(): void {
  lastPost = null;
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
        lastPost = { url, body: JSON.parse(String(init?.body ?? "{}")) };
        return json({ settings: SETTINGS, written: ["GAFFER_MODE"], rejected: [], ignored: [] });
      }
      if (url.includes("/api/settings")) return json({ settings: SETTINGS });
      return json({});
    }),
  );
}

function mountShell(hash: string): void {
  document.body.innerHTML = `
    <div id="toast" class="toast" role="alert" hidden></div>
    <div class="shell">
      <header id="appbar" class="appbar" hidden></header>
      <main id="app" class="app"><p class="loading">Loading…</p></main>
      <nav id="bottomnav" class="bottomnav" hidden></nav>
    </div>`;
  location.hash = hash;
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function boot(): Promise<void> {
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}-${Math.random()}`);
  for (let i = 0; i < 4; i++) await tick();
}

const spot = (gate: string) =>
  document.querySelector(`.fp-spot[href="#set-${gate}"]`) as HTMLAnchorElement;

describe("web: the boot room's team instructions", () => {
  beforeEach(() => {
    stubFetch();
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("the dial reads the saved mode and draws who plays each gate", async () => {
    mountShell("#/settings");
    await boot();
    const picked = document.querySelector(".dial-input:checked") as HTMLInputElement;
    expect(picked.value).toBe("graduated");
    expect(document.querySelector(".dial-stop.is-picked .dial-now")?.textContent).toBe("Now");
    // graduated: the reviewer agent runs (squad), you approve, merge and push.
    expect(spot("REVIEW_MODE").className).toContain("who-squad");
    expect(spot("DISPATCH_ALLOW_AGENT_APPROVE").className).toContain("who-you");
    expect(spot("GAFFER_TESTING").className).toContain("who-squad");
    // No change table and no Go/No-Go while the dial sits on the saved mode.
    expect(document.querySelector(".ti-table")).toBeNull();
    expect(document.querySelector(".gng")).toBeNull();
    expect(document.querySelector(".boot-dirty")?.textContent).toBe("No unsaved changes.");
  });

  it("raising the dial previews the mode, shows Go/No-Go, and saves only GAFFER_MODE", async () => {
    mountShell("#/settings");
    await boot();
    const up = document.querySelector('.dial-input[value="autonomous"]') as HTMLInputElement;
    up.checked = true;
    up.dispatchEvent(new Event("change", { bubbles: true }));
    await tick();
    const select = document.querySelector("#set-GAFFER_MODE select") as HTMLSelectElement;
    expect(select.value).toBe("autonomous");
    // The formation previews the new posture; a moving gate says so.
    expect(spot("DISPATCH_ALLOW_AGENT_APPROVE").className).toContain("who-squad");
    expect(spot("DISPATCH_ALLOW_AGENT_APPROVE").className).toContain("is-moving");
    expect(spot("GAFFER_AUTO_PUSH").className).toContain("who-squad");
    // The change table says AUTO_MERGE stays off: it is set in settings.json.
    const table = document.querySelector(".ti-table")!;
    const autoMerge = Array.from(table.querySelectorAll("tbody tr")).find((r) =>
      (r.textContent || "").includes("Auto-merge on approval"),
    )!;
    expect(autoMerge.textContent).toContain("kept from settings.json");
    // Raising it shows the Go/No-Go: testing and the budget are Go, CI is No-go.
    const gng = document.querySelector(".gng")!;
    expect(gng.querySelectorAll(".is-go").length).toBe(2);
    expect(gng.querySelectorAll(".is-nogo").length).toBe(1);
    // One unsaved change, named in the save bar and marked on its row.
    expect(document.querySelector(".boot-dirty")?.textContent).toContain("1 unsaved change");
    expect(document.querySelector(".boot-dirty")?.textContent).toContain("Autonomy mode");
    expect(document.querySelector("#set-GAFFER_MODE")?.classList.contains("is-dirty")).toBe(true);
    (document.querySelector(".settings-form") as HTMLFormElement).requestSubmit();
    await tick();
    await tick();
    expect(lastPost!.body.settings).toEqual({ GAFFER_MODE: "autonomous" });
  });

  it("lowering the dial shows the change but no Go/No-Go; back to the saved mode is clean", async () => {
    mountShell("#/settings");
    await boot();
    const down = document.querySelector('.dial-input[value="supervised"]') as HTMLInputElement;
    down.checked = true;
    down.dispatchEvent(new Event("change", { bubbles: true }));
    await tick();
    expect(document.querySelector(".ti-table")).not.toBeNull();
    expect(document.querySelector(".gng")).toBeNull();
    expect(spot("REVIEW_MODE").className).toContain("who-you");
    const back = document.querySelector('.dial-input[value="graduated"]') as HTMLInputElement;
    back.checked = true;
    back.dispatchEvent(new Event("change", { bubbles: true }));
    await tick();
    expect(document.querySelector(".boot-dirty")?.textContent).toBe("No unsaved changes.");
    expect(document.querySelector(".ti-table")).toBeNull();
  });

  it("switch rows say On/Off and where the value comes from", async () => {
    mountShell("#/settings");
    await boot();
    const row = document.querySelector("#set-DISPATCH_ALLOW_AGENT_APPROVE")!;
    expect(row.querySelector(".switch-word")?.textContent).toBe("Off");
    expect(row.querySelector(".setting-src")?.textContent).toBe("from the graduated mode");
    expect(document.querySelector("#set-GAFFER_TESTING .setting-src")?.textContent).toBe(
      "set in settings.json",
    );
  });

  it("an unknown #/ address renders the 404 page with one way back", async () => {
    mountShell("#/no-such-page");
    await boot();
    const view = document.querySelector(".view-error")!;
    expect(view).not.toBeNull();
    expect(view.querySelector("h1")?.textContent).toBe("No page at #/no-such-page");
    expect(view.querySelector(".err-code")?.textContent).toBe("404");
    expect(view.querySelector('a.btn.primary[href="#/overview"]')).not.toBeNull();
    expect(document.title).toBe("Page not found · Gaffer");
  });
});

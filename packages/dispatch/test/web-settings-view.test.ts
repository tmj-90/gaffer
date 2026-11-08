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
  {
    key: "GAFFER_MODE",
    value: "graduated",
    envLocked: false,
    type: "string",
    group: "autonomy",
    label: "Autonomy mode",
    choices: ["supervised", "graduated", "autonomous", "strict"],
  },
];

// The isolation posture GET /api/settings carries (runner/gaffer sandbox-status, stubbed).
const SANDBOX_ROW = {
  key: "STRICT_MODE",
  value: "",
  envLocked: false,
  type: "boolean",
  group: "sandbox",
  label: "Strict execution sandbox",
};
const ISOLATION = {
  available: {
    provider: "docker",
    available: true,
    required: true,
    optedOut: false,
    missing: "",
    fix: "",
  },
  missing: {
    provider: "docker",
    available: false,
    required: true,
    optedOut: false,
    missing: "Docker is installed but its daemon is not reachable",
    fix: "start the docker daemon (or give this user access to it)",
  },
  optedOut: {
    provider: "sandbox-exec",
    available: false,
    required: false,
    optedOut: true,
    missing: "this is Linux, where sandbox-exec does not exist, and Docker is not installed",
    fix: "install Docker, then run `gaffer setup` again",
  },
} as const;
let isolation: unknown = undefined;

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
        const body =
          isolation === undefined
            ? { settings: SETTINGS }
            : { settings: [...SETTINGS, SANDBOX_ROW], isolation };
        return new Response(JSON.stringify(body), {
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
    isolation = undefined;
  });

  // The Sandbox group's read-only isolation line, for the three postures the probe reports.
  const isolationLine = async (posture: unknown): Promise<HTMLElement> => {
    isolation = posture;
    await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
    await tick();
    const group = document.querySelector("#grp-sandbox") as HTMLElement;
    expect(group, "the Sandbox group renders").not.toBeNull();
    const line = group.querySelector(".settings-isolation") as HTMLElement;
    expect(line, "the Sandbox group shows the isolation line").not.toBeNull();
    // Read-only: a status line, never an input.
    expect(line.querySelector("input, select, button")).toBeNull();
    return line;
  };

  it("shows the isolation line: provider available and required", async () => {
    const line = await isolationLine(ISOLATION.available);
    expect(line.dataset.state).toBe("available");
    expect(line.textContent).toMatch(/Isolation: docker, available/);
    expect(line.textContent).toMatch(/Required: every agent runs inside it/);
    expect(line.textContent).not.toMatch(/Fix:/);
  });

  it("shows the isolation line: provider missing, with what is missing and the fix", async () => {
    const line = await isolationLine(ISOLATION.missing);
    expect(line.dataset.state).toBe("missing");
    expect(line.textContent).toMatch(
      /docker, missing \(Docker is installed but its daemon is not reachable\)/,
    );
    expect(line.textContent).toMatch(/live runs refuse to launch agents/);
    expect(line.textContent).toMatch(/Fix: start the docker daemon/);
  });

  it("shows the isolation line: opted out in the environment", async () => {
    const line = await isolationLine(ISOLATION.optedOut);
    expect(line.dataset.state).toBe("opted-out");
    expect(line.textContent).toMatch(
      /Opted out: GAFFER_STRICT_REQUIRE=0 is set in the environment/,
    );
    expect(line.textContent).toMatch(/agents run without an OS sandbox/);
    expect(line.textContent).toMatch(/Fix: install Docker/);
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

  it("renders an enum setting as a dropdown of its choices and saves the picked value", async () => {
    await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
    await tick();

    const modeRow = Array.from(document.querySelectorAll(".setting-row")).find(
      (r) => r.querySelector(".setting-key")?.textContent === "GAFFER_MODE",
    ) as HTMLElement;
    const select = modeRow.querySelector("select") as HTMLSelectElement;
    expect(select, "enum should render a <select>, not a text input").not.toBeNull();
    expect(modeRow.querySelector('input[type="text"]')).toBeNull();

    // Options are the leading "default" plus each choice; current value is selected.
    const optionValues = Array.from(select.options).map((o) => o.value);
    expect(optionValues).toEqual(["", "supervised", "graduated", "autonomous", "strict"]);
    expect(select.value).toBe("graduated");

    // Pick a different mode and save → the chosen value is POSTed.
    select.value = "strict";
    const form = document.querySelector(".settings-form") as HTMLFormElement;
    form.requestSubmit();
    await tick();
    await tick();

    const body = lastPost!.body as { settings: Record<string, string> };
    expect(body.settings.GAFFER_MODE).toBe("strict");
  });
});

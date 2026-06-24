// @vitest-environment jsdom
//
// DOM test for the shared target selector (src/api/web/app.js) and its two
// consumers: the Settings "Idle loops" panel (multi-select picker, node →
// repo-name resolution on save) and the plan-build "Extend existing" picker
// (single-select, repos AND scopes). The selector is module-internal, so it is
// exercised through the rendered SPA the way a user reaches it.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const REPOS = {
  repositories: [
    { id: "r1", name: "api" },
    { id: "r2", name: "web" },
  ],
};

const NODES = {
  nodes: [
    { id: "n1", name: "Checkout", type: "epic" },
    { id: "n2", name: "Platform", type: "system" },
  ],
};

// Checkout (n1) links exactly the `api` repo; Platform (n2) links both.
const NODE_REPOS: Record<string, { repos: Array<{ name: string }> }> = {
  n1: { repos: [{ name: "api" }] },
  n2: { repos: [{ name: "api" }, { name: "web" }] },
};

const IDLE_LOOPS = {
  idle_loops: {
    configured: true,
    mode: "create_draft_tickets",
    loops: [
      { key: "idle_coverage", label: "Coverage", enabled: false, repos: [] },
      { key: "idle_test_quality", label: "Test quality", enabled: true, repos: ["api"] },
      { key: "idle_documentation", label: "Documentation", enabled: false, repos: [] },
      { key: "idle_dependencies", label: "Dependencies", enabled: false, repos: [] },
      { key: "idle_security_hotspot", label: "Security hotspots", enabled: false, repos: [] },
      { key: "idle_feature_backlog", label: "Feature backlog", enabled: false, repos: [] },
    ],
  },
};

const SETTINGS = {
  settings: [
    {
      key: "GAFFER_IDLE_MODE",
      label: "Idle loop mode",
      group: "idle-loops",
      type: "string",
      value: "create_draft_tickets",
      envLocked: false,
      help: "What idle loops do with their findings.",
    },
  ],
};

/** Records each PUT /api/idle-loops body so tests can assert the resolved repos. */
const idlePutCalls: Array<{ method: string; body: unknown }> = [];

function stubFetch(overrides: { idleLoops?: unknown } = {}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      let body: unknown = {};
      if (url.includes("/api/idle-loops")) {
        if (method === "PUT") {
          idlePutCalls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : {} });
          body = { idle_loops: overrides.idleLoops ?? IDLE_LOOPS.idle_loops };
        } else {
          body = overrides.idleLoops ? { idle_loops: overrides.idleLoops } : IDLE_LOOPS;
        }
      } else if (url.includes("/api/settings")) {
        body = SETTINGS;
      } else if (url.includes("/scope/repos")) {
        const m = /[?&]node=([^&]+)/.exec(url);
        const id = m ? decodeURIComponent(m[1]!) : "";
        body = NODE_REPOS[id] ?? { repos: [] };
      } else if (url.includes("/scope/nodes")) {
        body = NODES;
      } else if (url.includes("/repositories")) {
        body = REPOS;
      } else if (url.includes("/tickets")) {
        body = { tickets: [] };
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
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
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
  await tick();
  await tick();
}

describe("web: Settings Idle-loops panel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });
  beforeEach(() => {
    vi.resetModules();
    idlePutCalls.length = 0;
  });

  it("renders the Idle loops panel with a row + toggle per scan loop", async () => {
    stubFetch();
    mountShell("#/settings");
    await boot();
    const text = document.body.textContent || "";
    expect(text).toContain("Idle loops");
    expect(text).toContain("Coverage");
    expect(text).toContain("Security hotspots");
    expect(text).toContain("Feature backlog");
    // One row per known idle loop (6 of them).
    expect(document.querySelectorAll(".idle-loop-row").length).toBe(6);
    // The "applies next tick" banner is present in the panel.
    expect(document.querySelector(".idle-loops-note")).not.toBeNull();
  });

  it("each idle-loop picker lists repos AND scopes as checkboxes", async () => {
    stubFetch();
    mountShell("#/settings");
    await boot();
    const panel = document.querySelector(".idle-loops-group")!;
    expect(panel.textContent).toContain("Repos");
    expect(panel.textContent).toContain("Scopes");
    const labels = Array.from(panel.querySelectorAll(".target-picker-check")).map(
      (l) => l.textContent || "",
    );
    expect(labels.some((l) => l.includes("api"))).toBe(true);
    expect(labels.some((l) => l.includes("web"))).toBe(true);
    expect(labels.some((l) => l.includes("Checkout"))).toBe(true);
  });

  it("reflects a saved repo scope as a checked repo target", async () => {
    stubFetch();
    mountShell("#/settings");
    await boot();
    // idle_test_quality is scoped to ["api"] — its `api` checkbox should be checked.
    const rows = Array.from(document.querySelectorAll(".idle-loop-row"));
    const tqRow = rows.find((r) => (r.textContent || "").includes("idle_test_quality"))!;
    const apiCheck = Array.from(
      tqRow.querySelectorAll<HTMLInputElement>(".target-picker-check input"),
    ).find((i) => (i.closest(".target-picker-check")?.textContent || "") === "api");
    expect(apiCheck).toBeDefined();
    expect(apiCheck!.checked).toBe(true);
  });

  it("resolves a selected scope node to its repo NAMES on save (PUT body)", async () => {
    stubFetch();
    mountShell("#/settings");
    await boot();
    // In the first loop (idle_coverage) tick the "Platform" scope (links api + web).
    const rows = Array.from(document.querySelectorAll(".idle-loop-row"));
    const covRow = rows.find((r) => (r.textContent || "").includes("idle_coverage"))!;
    const platformCheck = Array.from(
      covRow.querySelectorAll<HTMLInputElement>(".target-picker-check input"),
    ).find((i) => (i.closest(".target-picker-check")?.textContent || "").includes("Platform"))!;
    platformCheck.checked = true;
    platformCheck.dispatchEvent(new Event("change", { bubbles: true }));
    await tick();

    // Save.
    const saveBtn = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".idle-loops-group button"),
    ).find((b) => (b.textContent || "").includes("Save idle loops"))!;
    saveBtn.click();
    await tick();
    await tick();

    expect(idlePutCalls.length).toBeGreaterThan(0);
    const put = idlePutCalls[idlePutCalls.length - 1]!;
    const loops = (put.body as { loops: Array<{ key: string; repos: string[] }> }).loops;
    const coverage = loops.find((l) => l.key === "idle_coverage")!;
    // The node selection expanded to its two linked repo NAMES (order-insensitive).
    expect(coverage.repos.sort()).toEqual(["api", "web"]);
  });

  it("renders a clean empty state when crew.yaml is not configured", async () => {
    stubFetch({
      idleLoops: {
        configured: false,
        mode: "",
        loops: [{ key: "idle_coverage", label: "Coverage", enabled: false, repos: [] }],
      },
    });
    mountShell("#/settings");
    await boot();
    const panel = document.querySelector(".idle-loops-group")!;
    expect(panel.textContent).toContain("Crew config not found");
    // No editable rows when unconfigured.
    expect(document.querySelectorAll(".idle-loop-row").length).toBe(0);
  });
});

describe("web: plan-build Extend picker", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });
  beforeEach(() => {
    vi.resetModules();
  });

  it("offers repos AND scopes in the Extend target picker", async () => {
    stubFetch();
    mountShell("#/epics");
    await boot();

    // Open the plan-build panel via its primary button (lives in the Epics view).
    const planBtn = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      (b.textContent || "").includes("Plan a build"),
    )!;
    expect(planBtn).toBeDefined();
    planBtn.click();
    await tick();
    await tick(); // let the lazy repos/nodes load settle

    // Switch to "Extend existing".
    const extendRadio = document.querySelector<HTMLInputElement>(
      "input[name='pb-mode'][value='extend']",
    )!;
    expect(extendRadio).not.toBeNull();
    extendRadio.checked = true;
    extendRadio.dispatchEvent(new Event("change", { bubbles: true }));
    await tick();
    await tick();

    // The shared single-select picker is present with Repos + Scopes optgroups.
    const select = document.querySelector<HTMLSelectElement>(
      ".pb-extend-field .target-picker-select",
    );
    expect(select).not.toBeNull();
    const groups = Array.from(select!.querySelectorAll("optgroup")).map((g) => g.label);
    expect(groups).toContain("Repos");
    expect(groups).toContain("Scopes");
    const optionText = (select!.textContent || "").toString();
    expect(optionText).toContain("api");
    expect(optionText).toContain("web");
    expect(optionText).toContain("Checkout");
  });
});

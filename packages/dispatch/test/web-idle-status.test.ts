// @vitest-environment jsdom
//
// The Settings → Idle loops status line "says exactly what the next idle tick will
// do" (docs/FEATURES.md). It used to read only the panel's checkboxes: it said
// "will run N lanes" (the tick runs ONE lane per tick, rotating), ignored the
// runner's GAFFER_MAINTENANCE / GAFFER_IDLE_MODE / IDLE_DRAFT_WHEN_IDLE overrides,
// and never mentioned a lane's prerequisite (the coverage lane answers no_repos
// without a repo coverage_command). This drives the rendered SPA like a user.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

interface Loop {
  key: string;
  label: string;
  enabled: boolean;
  repos: string[];
  maintenanceLane?: boolean;
  auditCommand?: string | null;
}
interface Scenario {
  maintenance: boolean;
  loops: Loop[];
  settings?: Record<string, string>;
  repos?: Array<{ id: string; name: string; coverage_command?: string | null }>;
}

const idlePutCalls: Array<Record<string, unknown>> = [];

function lane(key: string, label: string, enabled: boolean, extra: Partial<Loop> = {}): Loop {
  return { key, label, enabled, repos: [], maintenanceLane: true, ...extra };
}

function stubFetch(sc: Scenario): void {
  // renderSettings shows an empty state (and no idle panel) when the settings list
  // is empty, so every scenario carries one harmless baseline row.
  const settings = Object.entries({ MAX_TICKS: "5", ...(sc.settings ?? {}) }).map(
    ([key, effective]) => ({
      key,
      label: key,
      group: "idle-loops",
      type: "string",
      value: "",
      effective,
      source: "env",
      envLocked: true,
    }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      let body: unknown = {};
      if (url.includes("/api/idle-loops")) {
        if (method === "PUT") idlePutCalls.push(JSON.parse(String(init?.body ?? "{}")));
        body = {
          idle_loops: {
            configured: true,
            mode: "create_draft_tickets",
            loops: sc.loops,
            maintenance: { enabled: sc.maintenance },
            selfImprove: { enabled: false, repos: [], maxRisk: "low", maxReadyPerRun: 1 },
          },
        };
      } else if (url.includes("/api/settings")) {
        body = { settings };
      } else if (url.includes("/scope/nodes")) {
        body = { nodes: [] };
      } else if (url.includes("/repositories")) {
        body = { repositories: sc.repos ?? [{ id: "r1", name: "api" }] };
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

async function render(sc: Scenario): Promise<string> {
  stubFetch(sc);
  document.body.innerHTML = `
    <div id="toast" class="toast" role="alert" hidden></div>
    <div class="shell">
      <header id="appbar" class="appbar" hidden></header>
      <main id="app" class="app"><p class="loading">Loading…</p></main>
      <nav id="bottomnav" class="bottomnav" hidden></nav>
    </div>`;
  location.hash = "#/settings";
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}-${Math.random()}`);
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  return document.querySelector('[data-testid="idle-status"]')?.textContent ?? "";
}

describe("web: Idle loops status line reflects the runner's effective behaviour", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });
  beforeEach(() => {
    vi.resetModules();
    idlePutCalls.length = 0;
  });

  it("says one lane per idle tick, rotating (not 'runs N lanes')", async () => {
    const text = await render({
      maintenance: true,
      loops: [
        lane("idle_security_hotspot", "Security hotspots", true),
        lane("idle_tech_debt", "Tech debt", true),
      ],
    });
    expect(text).toMatch(/ONE of the 2 enabled lanes, rotating/);
    expect(text).not.toMatch(/will run 2 lanes/);
  });

  it("GAFFER_MAINTENANCE=0 is the kill switch whatever the panel says", async () => {
    const text = await render({
      maintenance: true,
      loops: [lane("idle_security_hotspot", "Security hotspots", true)],
      settings: { GAFFER_MAINTENANCE: "0" },
    });
    expect(text).toMatch(/GAFFER_MAINTENANCE=0/);
    expect(text).toMatch(/skip maintenance/);
  });

  it("GAFFER_MAINTENANCE=0 with IDLE_DRAFT_WHEN_IDLE=1 says the legacy scan still runs every lane", async () => {
    // tick.sh skips the lane under GAFFER_MAINTENANCE=0 but still falls through to the
    // legacy `fg idle` scan over every enabled lane (live: TICK_RESULT=idle_drafted).
    const text = await render({
      maintenance: true,
      loops: [
        lane("idle_security_hotspot", "Security hotspots", true),
        lane("idle_documentation", "Documentation", true),
      ],
      settings: { GAFFER_MAINTENANCE: "0", IDLE_DRAFT_WHEN_IDLE: "1" },
    });
    expect(text).toMatch(/GAFFER_MAINTENANCE=0 skips the maintenance lane/);
    expect(text).toMatch(/IDLE_DRAFT_WHEN_IDLE=1/);
    expect(text).toMatch(/runs ALL 2 enabled lanes in one pass/);
    expect(text).toMatch(/filed as drafts/);
    expect(text).not.toMatch(/skip maintenance entirely/);
  });

  it("maintenance on with only the feature backlog says only the backlog runs", async () => {
    const text = await render({
      maintenance: true,
      loops: [
        lane("idle_security_hotspot", "Security hotspots", false),
        {
          key: "idle_feature_backlog",
          label: "Feature backlog",
          enabled: true,
          repos: [],
          maintenanceLane: false,
        },
      ],
    });
    expect(text).toMatch(
      /No scan lane is enabled, so each idle tick runs only the feature backlog/,
    );
    expect(text).not.toMatch(/ONE of the 0 enabled lanes/);
    expect(text).not.toMatch(/do nothing/);
  });

  it("GAFFER_MAINTENANCE=1 with no lane enabled says the tick does nothing", async () => {
    const text = await render({
      maintenance: false,
      loops: [lane("idle_security_hotspot", "Security hotspots", false)],
      settings: { GAFFER_MAINTENANCE: "1" },
    });
    expect(text).toMatch(/GAFFER_MAINTENANCE=1 forces the lane on/);
    expect(text).toMatch(/no lane is enabled/);
  });

  it("GAFFER_IDLE_MODE=create_ready_tickets is called out instead of 'filed as drafts'", async () => {
    const text = await render({
      maintenance: true,
      loops: [lane("idle_security_hotspot", "Security hotspots", true)],
      settings: { GAFFER_IDLE_MODE: "create_ready_tickets" },
    });
    expect(text).toMatch(/filed READY, past the human gate/);
    expect(text).not.toMatch(/filed as drafts/);
  });

  it("IDLE_DRAFT_WHEN_IDLE=1 with maintenance off runs every enabled lane (legacy)", async () => {
    const text = await render({
      maintenance: false,
      loops: [
        lane("idle_security_hotspot", "Security hotspots", true),
        lane("idle_documentation", "Documentation", true),
      ],
      settings: { IDLE_DRAFT_WHEN_IDLE: "1" },
    });
    expect(text).toMatch(/IDLE_DRAFT_WHEN_IDLE=1/);
    expect(text).toMatch(/ALL 2 enabled lanes/);
    expect(text).not.toMatch(/will not run until you turn it on/);
  });

  it("names the coverage lane's missing coverage_command, and clears it when a repo has one", async () => {
    const missing = await render({
      maintenance: true,
      loops: [lane("idle_coverage", "Coverage", true)],
      repos: [{ id: "r1", name: "api", coverage_command: null }],
    });
    expect(missing).toMatch(/coverage lane needs a repo with a coverage command/);
    vi.unstubAllGlobals();
    vi.resetModules();
    const present = await render({
      maintenance: true,
      loops: [lane("idle_coverage", "Coverage", true)],
      repos: [{ id: "r1", name: "api", coverage_command: "pnpm coverage" }],
    });
    expect(present).not.toMatch(/needs a repo with a coverage command/);
  });

  it("the dependency lane shows its audit command and saves it with the loop row", async () => {
    await render({
      maintenance: true,
      loops: [lane("idle_dependencies", "Dependencies", true, { auditCommand: null })],
    });
    const status = document.querySelector('[data-testid="idle-status"]')?.textContent ?? "";
    expect(status).toMatch(/Without an audit command/);
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="idle-dependencies-audit"]',
    )!;
    expect(input).not.toBeNull();
    input.value = "pnpm outdated --json";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(document.querySelector('[data-testid="idle-status"]')?.textContent ?? "").not.toMatch(
      /Without an audit command/,
    );
    const save = Array.from(document.querySelectorAll("button")).find((b) =>
      /Save idle loops/.test(b.textContent ?? ""),
    )!;
    save.click();
    for (let i = 0; i < 10 && idlePutCalls.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 0));
    }
    const body = idlePutCalls[0] as {
      loops: Array<{ key: string; audit_command?: string | null }>;
    };
    expect(body.loops.find((l) => l.key === "idle_dependencies")?.audit_command).toBe(
      "pnpm outdated --json",
    );
  });
});

// @vitest-environment jsdom
//
// DOM test for the Overview "Running now" panel (src/api/web/app.js):
//   - renders active runs (kind · repo · elapsed · spinner),
//   - renders the recently-finished tail with a "view log" control,
//   - shows a quiet empty state when nothing is running or recent.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

// Mutable per-test runs payload the stubbed /api/runs returns.
let runsPayload: { active: unknown[]; recent: unknown[] } = { active: [], recent: [] };

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = (obj: unknown) =>
        new Response(JSON.stringify(obj), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (url.includes("/api/runs")) return json(runsPayload);
      if (url.includes("/api/dashboard")) return json({ summary: { ticketsByStatus: {} } });
      if (url.includes("/api/activity")) return json({ events: [], total: 0 });
      if (url.includes("/decisions")) return json({ decisions: [] });
      if (url.includes("/api/audit")) return json({ available: false, entries: [] });
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
  location.hash = "#/overview";
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function loadApp(): Promise<void> {
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}-${Math.random()}`);
  // Overview render + the panel's immediate first poll both resolve on microtasks.
  await tick();
  await tick();
  await tick();
}

describe("web: Running now panel", () => {
  beforeEach(() => {
    stubFetch();
    mountShell();
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
    runsPayload = { active: [], recent: [] };
  });

  it("renders active runs and a finished run with a view-log control", async () => {
    runsPayload = {
      active: [
        {
          id: "run-active-1",
          kind: "product_owner",
          repo: "gaffer",
          status: "running",
          started_at: new Date(Date.now() - 42_000).toISOString(),
          ended_at: null,
          log_path: null,
        },
      ],
      recent: [
        {
          id: "run-done-1",
          kind: "onboard",
          repo: "crew",
          status: "succeeded",
          started_at: new Date(Date.now() - 120_000).toISOString(),
          ended_at: new Date(Date.now() - 60_000).toISOString(),
          log_path: "/tmp/runs/run-done-1.log",
        },
      ],
    };

    await loadApp();

    const panel = document.getElementById("running-now");
    expect(panel).not.toBeNull();
    expect(panel!.querySelector("h2")?.textContent).toMatch(/running now/i);

    // The active run row: kind label, repo, and a live spinner.
    const activeRow = panel!.querySelector(".run-active");
    expect(activeRow).not.toBeNull();
    expect(activeRow!.querySelector(".run-kind")?.textContent).toMatch(/suggest work/i);
    expect(activeRow!.querySelector(".run-repo")?.textContent).toBe("gaffer");
    expect(activeRow!.querySelector(".run-spinner")).not.toBeNull();

    // The finished run row: a status badge + a working "view log" button.
    const doneRow = panel!.querySelector(".run-done");
    expect(doneRow).not.toBeNull();
    expect(doneRow!.textContent).toMatch(/succeeded/i);
    const viewLog = doneRow!.querySelector(".run-viewlog") as HTMLButtonElement;
    expect(viewLog).not.toBeNull();
    expect(viewLog.textContent).toMatch(/view log/i);
  });

  it("opens the captured log in a sheet when 'view log' is clicked", async () => {
    runsPayload = {
      active: [],
      recent: [
        {
          id: "run-done-2",
          kind: "merge",
          repo: null,
          status: "failed",
          started_at: new Date(Date.now() - 30_000).toISOString(),
          ended_at: new Date(Date.now() - 10_000).toISOString(),
          log_path: "/tmp/runs/run-done-2.log",
        },
      ],
    };

    await loadApp();

    // Make the log fetch return some captured text.
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (input: RequestInfo) => {
        const url = String(input);
        if (url.includes("/log")) {
          return new Response("merge conflict on app.js", {
            status: 200,
            headers: { "content-type": "text/plain" },
          });
        }
        return new Response(JSON.stringify(runsPayload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );

    const viewLog = document.querySelector(".run-viewlog") as HTMLButtonElement;
    expect(viewLog).not.toBeNull();
    viewLog.click();
    await tick();
    await tick();

    const pre = document.querySelector(".run-log-pre");
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toContain("merge conflict on app.js");
  });

  it("renders a quiet empty state when nothing is running or recent", async () => {
    runsPayload = { active: [], recent: [] };
    await loadApp();

    const panel = document.getElementById("running-now");
    expect(panel).not.toBeNull();
    expect(panel!.querySelector(".run-row")).toBeNull();
    const empty = panel!.querySelector(".empty-state");
    expect(empty).not.toBeNull();
    expect(empty!.textContent).toMatch(/nothing running/i);
  });
});

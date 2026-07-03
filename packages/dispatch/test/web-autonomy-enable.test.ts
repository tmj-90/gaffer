// @vitest-environment jsdom
//
// DOM test for the Graduated Autonomy enable flow in the Settings view (Spec 2,
// Phase 3): a recommendation renders an Enable action; clicking it reveals an
// EXPLICIT CONFIRM step (with the evidence still visible); confirming POSTs the
// policy with confirm:true. Also covers the active-policies one-click OFF.

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
];

const REC = {
  repoId: "repo-1",
  repoName: "api-repo",
  riskLevel: "low",
  gate: "approve",
  recommendation: "auto",
  confidence: 0.95,
  reasons: ["approved 38 of 40 low-risk reviews in api-repo", "95% agreement across 40 decisions"],
  headline: "approved 38/40 low-risk reviews in api-repo — consider auto-approve for risk=low",
};

let lastPost: { url: string; body: any } | null = null;
let policies: any[] = [];

function stubFetch(recs: any[]): void {
  lastPost = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (url.includes("/api/autonomy/policy") && method === "POST") {
        lastPost = { url, body: JSON.parse(String(init?.body ?? "{}")) };
        return json({ policy: { ...lastPost.body, mode: lastPost.body.mode } });
      }
      if (url.includes("/api/autonomy/policies")) return json({ policies });
      if (url.includes("/api/autonomy/recommendations")) return json({ recommendations: recs });
      if (url.includes("/api/settings")) return json({ settings: SETTINGS });
      if (url.includes("/api/idle-loops")) return json({});
      if (url.includes("/repositories")) return json({ repositories: [] });
      if (url.includes("/scope/nodes")) return json({ nodes: [] });
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

function findButton(text: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find((b) =>
    b.textContent?.toLowerCase().includes(text.toLowerCase()),
  ) as HTMLButtonElement | undefined;
}

describe("web: Graduated Autonomy enable flow", () => {
  beforeEach(() => {
    policies = [];
    mountShell();
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("renders a recommendation with an Enable action; Enable → Confirm → POST with confirm:true", async () => {
    stubFetch([REC]);
    await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
    await tick();
    await tick();

    // The suggestion + its evidence render.
    const panel = document.querySelector(".autonomy-recs");
    expect(panel).not.toBeNull();
    expect(panel!.textContent).toContain("api-repo");
    expect(panel!.textContent).toContain("95% agreement across 40 decisions");

    // Enable is present; clicking it does NOT immediately POST — it reveals a confirm.
    const enable = findButton("enable");
    expect(enable, "an Enable action should render").toBeDefined();
    enable!.click();
    await tick();
    expect(lastPost, "clicking Enable must not POST — confirmation is required").toBeNull();
    expect(document.querySelector(".ar-confirm"), "a confirm step should appear").not.toBeNull();

    // Confirming POSTs the policy with mode=auto + confirm:true.
    const confirm = findButton("confirm");
    expect(confirm).toBeDefined();
    confirm!.click();
    await tick();
    await tick();

    expect(lastPost).not.toBeNull();
    expect(lastPost!.url).toContain("/api/autonomy/policy");
    expect(lastPost!.body).toMatchObject({
      repo_id: "repo-1",
      risk_level: "low",
      gate: "approve",
      mode: "auto",
      confirm: true,
    });
  });

  it("shows active policies with a one-click OFF that POSTs mode=off", async () => {
    policies = [
      {
        id: "p1",
        repo_id: "repo-1",
        repo_name: "api-repo",
        risk_level: "low",
        gate: "approve",
        mode: "auto",
        enabled_by: "tom",
        enabled_at: "2026-01-01T00:00:00Z",
      },
    ];
    stubFetch([]);
    await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
    await tick();
    await tick();

    const activePanel = document.querySelector(".autonomy-policies");
    expect(activePanel, "the active-autonomy panel should render").not.toBeNull();
    expect(activePanel!.textContent).toContain("api-repo");
    expect(activePanel!.textContent).toContain("enabled by tom");

    const off = findButton("turn off");
    expect(off).toBeDefined();
    off!.click();
    await tick();
    await tick();

    expect(lastPost).not.toBeNull();
    expect(lastPost!.body).toMatchObject({
      repo_id: "repo-1",
      risk_level: "low",
      gate: "approve",
      mode: "off",
    });
  });
});

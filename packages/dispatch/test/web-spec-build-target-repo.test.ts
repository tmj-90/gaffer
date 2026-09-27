// @vitest-environment jsdom
//
// DOM test for the "Author a spec" panel (src/api/web/app.js): the spec the human
// creates must name its TARGET REPO. The freeze seeds every clause into Memory as
// draft lore tagged with `spec.target_repo`; the delivery primer surfaces lore per
// repo (`memory search --repo <name>`), so a spec created WITHOUT a target repo
// seeded clauses no delivery agent could ever see. Regression from a live audit:
// the panel never sent `target_repo`.
//
// Drives the real panel: open → brief → (stubbed) spec-author reply → pick the
// target repo in the draft card → Create spec → assert the POST /specs body.
// Then Freeze → "Build the tickets from this spec" → the plan-build panel opens in
// "Extend existing" mode targeting that repo (so decompose takes the brownfield
// path for it instead of scaffolding a new repo).

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const REPOS = {
  repositories: [
    { id: "r-web", name: "web" },
    { id: "r-api", name: "api" },
  ],
};

const AUTHORED = {
  phase: "spec",
  spec: {
    clauses: [
      { clause_id: "c1", kind: "requirement", text: "User can pay with a saved card" },
      { clause_id: "c2", kind: "non-goal", text: "No crypto payments", rationale: "v1 scope" },
    ],
  },
};

/** Every mutating call the panel makes, in order. */
const posts: Array<{ path: string; body: Record<string, unknown> }> = [];

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      const reqBody = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      if (method === "POST") posts.push({ path, body: reqBody });
      let body: unknown = {};
      let status = 200;
      if (path.startsWith("/repositories")) body = REPOS;
      else if (path === "/spec-build") body = AUTHORED;
      else if (path === "/specs" && method === "POST") {
        status = 201;
        body = {
          spec: {
            id: "spec-1",
            status: "draft",
            title: reqBody.title,
            target_repo: reqBody.target_repo ?? null,
            clauses: AUTHORED.spec.clauses,
          },
        };
      } else if (path === "/specs/spec-1/freeze") {
        body = {
          spec: {
            id: "spec-1",
            status: "frozen",
            title: "Checkout redesign",
            target_repo:
              (posts.find((p) => p.path === "/specs")?.body.target_repo as string) ?? null,
            clauses: AUTHORED.spec.clauses,
          },
        };
      } else if (path.startsWith("/specs")) body = { specs: [] };
      else if (path.startsWith("/scope/nodes")) body = { nodes: [] };
      else if (path.startsWith("/plan-sessions/active")) body = { session: null };
      else if (path.startsWith("/plan-sessions")) body = { session: { id: "ps-1" } };
      else if (path.startsWith("/tickets")) body = { tickets: [] };
      return new Response(JSON.stringify(body), {
        status,
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
async function settle(n = 6): Promise<void> {
  for (let i = 0; i < n; i++) await tick();
}

async function boot(): Promise<void> {
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
  await settle();
}

/** The spec panel is the pb-panel labelled "Author a spec" (plan-build is a sibling). */
function specPanel(): HTMLElement {
  const panel = document.querySelector('.pb-panel[aria-label="Author a spec"]');
  expect(panel).not.toBeNull();
  return panel as HTMLElement;
}

async function openPanelAndAuthor(): Promise<HTMLElement> {
  const trigger = Array.from(document.querySelectorAll("button")).find((b) =>
    /Author a spec/.test(b.textContent || ""),
  );
  expect(trigger).toBeDefined();
  trigger!.click();
  await settle();
  const panel = specPanel();
  const input = panel.querySelector("textarea.pb-input") as HTMLTextAreaElement;
  input.value = "Redesign checkout so a saved card can pay";
  (panel.querySelector("form.pb-composer") as HTMLFormElement).requestSubmit();
  await settle(10);
  expect(panel.querySelector(".sb-draft")).not.toBeNull();
  return panel;
}

describe("web: Author-a-spec panel passes target_repo", () => {
  beforeEach(() => {
    vi.resetModules();
    posts.length = 0;
    stubFetch();
    mountShell("#/specs");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("offers the known repos as the spec's target and sends the pick as target_repo on Create", async () => {
    await boot();
    const panel = await openPanelAndAuthor();

    const repoSel = panel.querySelector("select.sb-target-repo") as HTMLSelectElement;
    expect(repoSel).not.toBeNull();
    const names = Array.from(repoSel.options).map((o) => o.value);
    expect(names).toEqual(["", "web", "api"]);

    repoSel.value = "web";
    repoSel.dispatchEvent(new Event("change"));
    (panel.querySelector("button.sb-create") as HTMLButtonElement).click();
    await settle(10);

    const create = posts.find((p) => p.path === "/specs");
    expect(create).toBeDefined();
    expect(create!.body.target_repo).toBe("web");
    expect(create!.body.clauses).toHaveLength(2);
    // The created (locked) card still shows the chosen target.
    const locked = panel.querySelector("select.sb-target-repo") as HTMLSelectElement;
    expect(locked.value).toBe("web");
    expect(locked.disabled).toBe(true);
  });

  it("omits target_repo entirely for an org-wide spec (no repo picked)", async () => {
    await boot();
    const panel = await openPanelAndAuthor();
    (panel.querySelector("button.sb-create") as HTMLButtonElement).click();
    await settle(10);
    const create = posts.find((p) => p.path === "/specs");
    expect(create).toBeDefined();
    expect("target_repo" in create!.body).toBe(false);
  });

  it("carries the frozen spec's target repo into Plan-a-build as the extend target", async () => {
    await boot();
    const panel = await openPanelAndAuthor();
    const repoSel = panel.querySelector("select.sb-target-repo") as HTMLSelectElement;
    repoSel.value = "api";
    repoSel.dispatchEvent(new Event("change"));
    (panel.querySelector("button.sb-create") as HTMLButtonElement).click();
    await settle(10);
    (panel.querySelector("button.sb-freeze") as HTMLButtonElement).click();
    await settle(10);
    expect(posts.some((p) => p.path === "/specs/spec-1/freeze")).toBe(true);

    (panel.querySelector("button.sb-build") as HTMLButtonElement).click();
    await settle(10);
    // Plan-a-build opened in "Extend existing" mode with the repo pre-selected.
    const pb = document.querySelector('.pb-panel[aria-label="Plan a build"]');
    expect(pb).not.toBeNull();
    const extendRadio = pb!.querySelector(
      'input[type="radio"][value="extend"]',
    ) as HTMLInputElement;
    expect(extendRadio?.checked).toBe(true);
    const picker = pb!.querySelector("select.target-picker-select") as HTMLSelectElement;
    expect(picker).not.toBeNull();
    expect(picker.value).toBe("repo:api");
  });
});

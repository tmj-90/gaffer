// @vitest-environment jsdom
//
// The Memory view's "Onboard a repo" sheet onboards what the person asked for
// (exploratory finding ui-workflows/F3). The "Registered repo" select comes pre-set to
// the repo the view shows, and the submit read `repoSel.value || pathInput.value`, so a
// typed path was ignored and the pre-selected repo was re-onboarded: a sizeable one-off
// (several minutes and model calls) and another intake decision each time. A typed path
// now wins (typing resets the select), and onboarding a repo that already has a digest
// asks first, naming the cost.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const REPOS = [
  { id: "r1", name: "taskflow-mini", local_path: "/work/taskflow-mini" },
  { id: "r2", name: "notes-mini", local_path: "/work/notes-mini" },
];
const DIGEST = {
  available: true,
  digest: {
    repo: "taskflow-mini",
    overview: "A task list.",
    structure: "src/",
    conventions: "none",
    stack: "node",
    meta: { updatedAt: "2026-06-20T10:00:00Z", source: "onboard" },
  },
};

const onboardCalls: unknown[] = [];

function stubFetch(digestFor: (repo: string) => unknown = () => DIGEST): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      let body: unknown = {};
      if (url.includes("/repos/onboard")) {
        onboardCalls.push(init?.body ? JSON.parse(String(init.body)) : {});
        body = { onboarding: true, repo: "x", run: { started: true, pid: 1 } };
      } else if (url.includes("/api/memory/digest/")) {
        body = digestFor(decodeURIComponent(url.split("/api/memory/digest/")[1] ?? ""));
      } else if (url.includes("/api/memory/features/")) body = { available: true, features: [] };
      else if (url.includes("/api/memory/lore")) body = { available: true, lore: [] };
      else if (url.includes("/repositories")) body = { repositories: REPOS };
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
const ticks = async (n = 8) => {
  for (let i = 0; i < n; i++) await tick();
};

async function openSheet(): Promise<HTMLFormElement> {
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
  await ticks();
  const btn = document.querySelector(".view-head-actions button") as HTMLButtonElement;
  expect(btn.textContent).toContain("Onboard a repo");
  btn.click();
  await tick();
  const form = document.querySelector(".sheet.open form.form-grid") as HTMLFormElement | null;
  expect(form).not.toBeNull();
  return form!;
}

function submit(form: HTMLFormElement): void {
  if (typeof form.requestSubmit === "function") form.requestSubmit();
  else form.dispatchEvent(new Event("submit", { cancelable: true }));
}

function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("web: the Onboard a repo sheet onboards what was asked for (exploratory finding ui-workflows/F3)", () => {
  beforeEach(() => {
    vi.resetModules();
    onboardCalls.length = 0;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("a typed path wins over the pre-selected repo, and typing resets the select", async () => {
    stubFetch();
    mountShell("#/memory/taskflow-mini");
    const form = await openSheet();
    const sel = form.querySelector("select") as HTMLSelectElement;
    expect(sel.value).toBe("taskflow-mini");
    const input = form.querySelector('input[name="onboard-path"]') as HTMLInputElement;
    type(input, "/work/brand-new-repo");
    expect(sel.value).toBe("");
    submit(form);
    await ticks();
    expect(onboardCalls).toEqual([{ repo: "/work/brand-new-repo" }]);
    expect(document.getElementById("toast")?.textContent).toContain("/work/brand-new-repo");
  });

  it("re-onboarding a repo that has a digest asks first, naming the cost; nothing is posted until confirmed", async () => {
    stubFetch();
    mountShell("#/memory/taskflow-mini");
    const form = await openSheet();
    submit(form);
    await ticks();
    expect(onboardCalls).toEqual([]);
    const sheet = document.querySelector(".sheet.open")?.textContent ?? "";
    expect(sheet).toContain("taskflow-mini");
    expect(sheet).toMatch(/several minutes/);
    expect(sheet).toMatch(/model calls/);
    const go = document.querySelector(".sheet.open .confirm-submit") as HTMLButtonElement;
    expect(go.textContent).toContain("Re-onboard taskflow-mini");
    go.click();
    await ticks();
    expect(onboardCalls).toEqual([{ repo: "taskflow-mini" }]);
  });

  it("a typed path that is a registered repo's checkout is a re-onboard too", async () => {
    stubFetch();
    mountShell("#/memory/taskflow-mini");
    const form = await openSheet();
    const input = form.querySelector('input[name="onboard-path"]') as HTMLInputElement;
    type(input, "/work/notes-mini/");
    submit(form);
    await ticks();
    expect(onboardCalls).toEqual([]);
    expect(document.querySelector(".sheet.open .confirm-submit")?.textContent).toContain(
      "Re-onboard notes-mini",
    );
  });

  it("a registered repo with no digest yet onboards at once (its first onboard)", async () => {
    stubFetch((repo) => (repo === "notes-mini" ? { available: true, digest: null } : DIGEST));
    mountShell("#/memory/taskflow-mini");
    const form = await openSheet();
    const sel = form.querySelector("select") as HTMLSelectElement;
    sel.value = "notes-mini";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    submit(form);
    await ticks();
    expect(onboardCalls).toEqual([{ repo: "notes-mini" }]);
  });
});

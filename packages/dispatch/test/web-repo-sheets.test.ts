// @vitest-environment jsdom
//
// The repo page asks in the club's sheet, never a native dialog: the default
// branch's Edit opens a one-field form (an empty value is refused in place, an
// unchanged one sends nothing), and Hide repo asks in a confirm sheet. A native
// window.prompt / window.confirm is unstyled, untranslatable and blocks the page.
// Found by the browser scenario suite S14.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const REPO = {
  id: "repo-1",
  name: "billing-api",
  local_path: "/srv/billing-api",
  default_branch: "main",
  remote_url: null,
  risk_level: "low",
  hidden: 0,
};

type Call = { method: string; url: string; body: unknown };
let calls: Call[] = [];
function json(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
function stubFetch(): void {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (method !== "GET") return json({ ok: true });
      if (url.includes("/repositories")) return json({ repositories: [REPO] });
      if (url.includes("/scopes")) return json({ scopes: [] });
      if (url.includes("/scope/nodes")) return json({ nodes: [] });
      if (url.includes("/api/board")) return json({ columns: [], closed: [], wontDo: [] });
      return json({});
    }),
  );
}
const tick = () => new Promise((r) => setTimeout(r, 0));
async function boot(): Promise<void> {
  document.body.innerHTML = `
    <div id="toast" class="toast" role="alert" hidden></div>
    <div class="shell">
      <header id="appbar" class="appbar" hidden></header>
      <main id="app" class="app"><p class="loading">Loading…</p></main>
      <nav id="bottomnav" class="bottomnav" hidden></nav>
    </div>`;
  location.hash = `#/repo/${REPO.id}`;
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}-${Math.random()}`);
  for (let i = 0; i < 8; i++) await tick();
}
const posts = (part: string) => calls.filter((c) => c.method !== "GET" && c.url.includes(part));
const sheet = () => document.querySelector(".sheet.open");

describe("web: the repo page asks in the shared sheet, not a native dialog", () => {
  beforeEach(() => {
    vi.resetModules();
    stubFetch();
    for (const name of ["prompt", "confirm"])
      vi.stubGlobal(
        name,
        vi.fn(() => {
          throw new Error(`window.${name} must not be used`);
        }),
      );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("Edit default branch opens a one-field sheet that saves the new branch", async () => {
    await boot();
    const edit = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Edit default branch for billing-api"]',
    )!;
    expect(edit).toBeTruthy();
    edit.focus();
    edit.click();
    expect(sheet()?.querySelector("#sheet-title")?.textContent).toBe(
      "Default branch for billing-api",
    );
    const input = sheet()!.querySelector<HTMLInputElement>(".value-sheet-input")!;
    expect(input.value).toBe("main");
    expect(document.activeElement).toBe(input);
    const form = sheet()!.querySelector<HTMLFormElement>("form.value-sheet")!;

    // Unchanged: nothing is sent, the sheet closes, focus goes back to Edit.
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await tick();
    expect(posts("/default-branch")).toHaveLength(0);
    expect(sheet()).toBeNull();
    expect(document.activeElement).toBe(edit);

    // Empty: refused in place.
    edit.click();
    const input2 = sheet()!.querySelector<HTMLInputElement>(".value-sheet-input")!;
    input2.value = "  ";
    sheet()!
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await tick();
    expect(posts("/default-branch")).toHaveLength(0);
    expect(input2.getAttribute("aria-invalid")).toBe("true");
    expect(sheet()!.querySelector(".act-hint.is-error")?.textContent).toBe(
      "Default branch cannot be empty.",
    );

    input2.value = "trunk";
    input2.dispatchEvent(new Event("input", { bubbles: true }));
    sheet()!
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    for (let i = 0; i < 4; i++) await tick();
    expect(posts("/repos/repo-1/default-branch").map((c) => c.body)).toEqual([
      { default_branch: "trunk" },
    ]);
    expect(sheet()).toBeNull();
  });

  it("Hide repo asks in a confirm sheet; Cancel sends nothing, Hide repo hides it", async () => {
    await boot();
    const hide = () =>
      [...document.querySelectorAll<HTMLButtonElement>("#app button")].find(
        (b) => b.textContent === "Hide repo",
      )!;
    hide().click();
    expect(sheet()?.querySelector("#sheet-title")?.textContent).toBe("Hide billing-api");
    expect(sheet()?.querySelector(".act-intro")?.textContent).toContain("Hidden repos page");
    [...sheet()!.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent === "Cancel")!
      .click();
    expect(posts("/hidden")).toHaveLength(0);
    hide().click();
    sheet()!.querySelector<HTMLButtonElement>(".confirm-submit")!.click();
    for (let i = 0; i < 4; i++) await tick();
    expect(posts("/repos/repo-1/hidden").map((c) => c.body)).toEqual([{ hidden: true }]);
    expect(location.hash).toBe("#/factory");
  });
});

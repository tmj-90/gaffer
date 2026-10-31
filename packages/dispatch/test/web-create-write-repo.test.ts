// @vitest-environment jsdom
//
// #/create, One ticket: Create waits for a write repo. With nothing attached the
// button is aria-disabled (still focusable) and the line under it says to attach a
// write repo, before anyone presses it; attaching one with write access releases
// it, and a read-only repo does not. Found by the browser scenario suites (the
// button looked enabled and the error only came after the press).

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

type Call = { method: string; url: string };
let calls: Call[] = [];
function stubFetch(): void {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ method: (init?.method || "GET").toUpperCase(), url });
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (url.includes("/repo-suggestions")) return json({ suggestions: [] });
      if (url.includes("/scope/nodes")) return json({ nodes: [] });
      if (url.includes("/repositories"))
        return json({ repositories: [{ id: "r1", name: "billing-api" }] });
      if (url.includes("/plan-sessions")) return json({ session: null });
      if (url.includes("/tickets")) return json({ tickets: [] });
      return json({});
    }),
  );
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("web: #/create holds Create until a write repo is attached", () => {
  beforeEach(() => {
    vi.resetModules();
    stubFetch();
    // jsdom has no layout: the refusal scrolls the selector into view.
    Element.prototype.scrollIntoView = () => {};
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("says what is missing up front and releases Create once a write repo is on", async () => {
    document.body.innerHTML = `
      <div id="toast" class="toast" role="alert" hidden></div>
      <div class="shell">
        <header id="appbar" class="appbar" hidden></header>
        <main id="app" class="app"><p class="loading">Loading…</p></main>
        <nav id="bottomnav" class="bottomnav" hidden></nav>
      </div>`;
    location.hash = "#/create";
    await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
    for (let i = 0; i < 8; i++) await tick();

    const form = document.querySelector("#one-ticket form")!;
    const create = [...form.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "Create ticket",
    )!;
    const hint = () => document.getElementById(create.getAttribute("aria-describedby")!)!;
    expect(create.getAttribute("aria-disabled")).toBe("true");
    expect(create.disabled, "still focusable").toBe(false);
    expect(hint().hidden).toBe(false);
    expect(hint().textContent).toContain("Attach a write repo first");

    // Pressing it anyway still explains, and sends nothing.
    form.querySelector<HTMLInputElement>(
      'input[placeholder="Short, action-oriented title"]',
    )!.value = "Skip expired cards";
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await tick();
    expect(calls.filter((c) => c.method === "POST" && /\/tickets$/.test(c.url))).toHaveLength(0);
    expect(form.querySelector<HTMLElement>(".form-error")!.hidden).toBe(false);

    const [repoSel, accessSel] = [
      ...form.querySelectorAll<HTMLSelectElement>(".selector-add-repo select"),
    ];
    const add = [...form.querySelectorAll<HTMLButtonElement>(".selector-add-repo button")].find(
      (b) => b.textContent === "Add",
    )!;
    // A read-only repo is not a delivery target: Create stays held.
    repoSel!.value = "r1";
    accessSel!.value = "read";
    add.click();
    expect(create.getAttribute("aria-disabled")).toBe("true");
    // Switch it to write: Create is released, the hint and the old error go.
    const writeBtn = [...form.querySelectorAll<HTMLButtonElement>(".segmented button")].find(
      (b) => b.textContent === "write",
    )!;
    writeBtn.click();
    expect(create.getAttribute("aria-disabled")).toBe("false");
    expect(hint().hidden).toBe(true);
    expect(form.querySelector<HTMLElement>(".form-error")!.hidden).toBe(true);
  });
});

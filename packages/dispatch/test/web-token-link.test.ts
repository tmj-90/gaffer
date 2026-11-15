// @vitest-environment jsdom
//
// F4: a `?token=` link never replaces the stored dashboard sign-in silently. A scoped
// teammate's link (or a junk one) used to overwrite the operator's token at boot, so
// later approvals were attributed to the teammate, or the operator was simply logged
// out. Now, with a DIFFERENT token stored, the stored one is kept, the URL is scrubbed,
// and a prompt asks to switch, Keep current being the default and primary action. With
// no token stored, or the same one, the link is adopted as before.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");
const KEY = "wg_api_token";
let authHeaders: string[] = [];

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
const tick = () => new Promise((r) => setTimeout(r, 0));

async function boot(url: string): Promise<void> {
  document.body.innerHTML = `
    <div id="toast" class="toast" role="alert" hidden></div>
    <div class="shell">
      <header id="appbar" class="appbar" hidden></header>
      <main id="app" class="app"><p class="loading">Loading…</p></main>
      <nav id="bottomnav" class="bottomnav" hidden></nav>
    </div>`;
  history.replaceState(null, "", url);
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}-${Math.random()}`);
  for (let i = 0; i < 20; i++) await tick();
}
const prompt = () => document.getElementById("token-switch");

describe("web: a ?token= link never silently replaces the stored sign-in", () => {
  beforeEach(() => {
    vi.resetModules();
    authHeaders = [];
    localStorage.clear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/healthz") return json({ status: "ok", auth: true });
        const auth = new Headers(init?.headers).get("authorization") ?? "";
        if (url.includes("/api/whoami")) authHeaders.push(auth);
        if (url.includes("/api/whoami"))
          return json({ capability: "full", actor: { type: "human", id: "api" } });
        if (url.includes("/api/events/stream")) return new Response(null, { status: 204 });
        return json({});
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    document.body.innerHTML = "";
    history.replaceState(null, "", "/");
  });

  it("a different token: the stored one stays, the URL is scrubbed, a prompt asks (Keep current first)", async () => {
    localStorage.setItem(KEY, "operator-token");
    await boot("/?token=teammate-token&x=1#/overview");
    expect(localStorage.getItem(KEY)).toBe("operator-token");
    expect(location.search).toBe("?x=1");
    expect(location.hash).toBe("#/overview");
    expect(authHeaders[0]).toBe("Bearer operator-token");
    const p = prompt();
    expect(p).not.toBeNull();
    expect(p!.getAttribute("role")).toBe("alertdialog");
    expect(p!.textContent).toContain("This link carries a different sign-in. Switch to it?");
    const buttons = [...p!.querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent)).toEqual(["Keep current", "Switch"]);
    expect(buttons[0]!.className).toContain("primary");
    expect(document.activeElement).toBe(buttons[0]);
    buttons[0]!.click();
    expect(prompt()).toBeNull();
    expect(localStorage.getItem(KEY)).toBe("operator-token");
  });

  it("Escape keeps the current sign-in too", async () => {
    localStorage.setItem(KEY, "operator-token");
    await boot("/?token=teammate-token");
    prompt()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(prompt()).toBeNull();
    expect(localStorage.getItem(KEY)).toBe("operator-token");
  });

  it("Switch stores the link's token", async () => {
    localStorage.setItem(KEY, "operator-token");
    await boot("/?token=teammate-token");
    const swap = [...prompt()!.querySelectorAll("button")].find((b) => b.textContent === "Switch")!;
    swap.click();
    expect(localStorage.getItem(KEY)).toBe("teammate-token");
  });

  it("no token stored: the link's token is adopted, no prompt", async () => {
    await boot("/?token=phone-token");
    expect(localStorage.getItem(KEY)).toBe("phone-token");
    expect(location.search).toBe("");
    expect(prompt()).toBeNull();
    expect(authHeaders[0]).toBe("Bearer phone-token");
  });

  it("the same token: no prompt, URL scrubbed", async () => {
    localStorage.setItem(KEY, "same");
    await boot("/?token=same");
    expect(prompt()).toBeNull();
    expect(localStorage.getItem(KEY)).toBe("same");
    expect(location.search).toBe("");
  });
});

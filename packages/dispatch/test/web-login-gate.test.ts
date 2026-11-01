// @vitest-environment jsdom
//
// The members' entrance asks for nothing it cannot have (exploratory finding
// ui-explore/F-05). With no token the gate used to boot the whole dashboard behind
// it: GET /api/squad, /api/whoami, /api/events/stream and every view read answered
// 401, each a "Failed to load resource" console error. Now the public /healthz says
// whether a token is wanted and the gate is drawn at once; a stored token is checked
// with ONE whoami before anything else is sent.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

let sent: string[] = [];
let authOn = true;
const validToken = "right";

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      sent.push(url);
      if (url === "/healthz") return json({ status: "ok", auth: authOn });
      const auth = new Headers(init?.headers).get("authorization");
      if (authOn && auth !== `Bearer ${validToken}`)
        return json(
          { error: { code: "UNAUTHORIZED", message: "Missing or invalid bearer token." } },
          401,
        );
      if (url.includes("/api/whoami"))
        return json({ capability: "full", actor: { type: "human", id: "api" } });
      if (url.includes("/api/events/stream")) return new Response(null, { status: 204 });
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
  location.hash = "#/overview";
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}-${Math.random()}`);
  for (let i = 0; i < 20; i++) await tick();
}

describe("web: the login gate sends no data call it cannot have", () => {
  beforeEach(() => {
    vi.resetModules();
    sent = [];
    authOn = true;
    localStorage.clear();
    stubFetch();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    document.body.innerHTML = "";
  });

  it("no token: only the public /healthz is asked, and the gate is drawn", async () => {
    await boot();
    expect(document.querySelector("form.login-gate")).not.toBeNull();
    expect(document.querySelector(".login-error")).toBeNull();
    expect(sent).toEqual(["/healthz"]);
    expect(document.getElementById("appbar")!.hidden).toBe(true);
  });

  it("a wrong token: one whoami says so, and nothing else is sent", async () => {
    localStorage.setItem("wg_api_token", "wrong");
    await boot();
    expect(document.querySelector("form.login-gate")).not.toBeNull();
    expect(document.querySelector(".login-error")?.textContent).toContain("rejected");
    expect(sent).toEqual(["/api/whoami"]);
  });

  it("the right token: whoami first, then the dashboard starts", async () => {
    localStorage.setItem("wg_api_token", "right");
    await boot();
    expect(document.querySelector("form.login-gate")).toBeNull();
    expect(sent[0]).toBe("/api/whoami");
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.filter((u) => u === "/api/whoami")).toHaveLength(1);
  });

  it("a server with no token configured: no gate, the dashboard starts", async () => {
    authOn = false;
    await boot();
    expect(document.querySelector("form.login-gate")).toBeNull();
    expect(sent[0]).toBe("/healthz");
    expect(sent.length).toBeGreaterThan(1);
  });
});

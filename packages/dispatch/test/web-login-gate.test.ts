// @vitest-environment jsdom
//
// The members' entrance asks for nothing it cannot have (exploratory finding
// ui-explore/F-05). With no token the gate used to boot the whole dashboard behind
// it: GET /api/squad, /api/whoami, /api/events/stream and every view read answered
// 401, each a "Failed to load resource" console error. Now the public /healthz says
// whether a token is wanted and the gate is drawn at once; a stored token is checked
// with ONE whoami before anything else is sent. Review follow-ups: a token revoked
// while the page is open leaves the page quiet behind the gate, and a failed gate
// whoami is not waited for again by the first view.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

let sent: string[] = [];
let authOn = true;
let validToken = "right";
let whoamiStatus = 200;

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
        return whoamiStatus === 200
          ? json({ capability: "read", actor: { type: "human", id: "api" } })
          : json({ error: { code: "INTERNAL", message: "boom" } }, whoamiStatus);
      if (url.includes("/api/events/stream")) return new Response(null, { status: 204 });
      return json({});
    }),
  );
}
/** The first whoami answers 500, every later one 200 (read). */
function stubFetchOnce500ThenRead(): void {
  const inner = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const r = await inner(input, init);
      if (String(input).includes("/api/whoami")) whoamiStatus = 200;
      return r;
    }),
  );
}
/** The first whoami answers as stubbed (500); every later one never answers. */
function stubFetchWhoamiHangsAfterFirst(): void {
  const inner = globalThis.fetch;
  let n = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/whoami") && ++n > 1) {
        sent.push(String(input));
        return new Promise<Response>(() => {});
      }
      return inner(input, init);
    }),
  );
}
let tick = () => new Promise((r) => setTimeout(r, 0));
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
    validToken = "right";
    whoamiStatus = 200;
    localStorage.clear();
    stubFetch();
  });
  afterEach(() => {
    vi.useRealTimers();
    tick = () => new Promise((r) => setTimeout(r, 0));
    vi.unstubAllGlobals();
    localStorage.clear();
    document.body.innerHTML = "";
    document.body.className = "";
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
  it("a token revoked while the page is open: the gate once, then the page goes quiet", async () => {
    // Review finding: the interval refresh and the live stream's reconnects kept asking
    // behind the gate (about 80 refused reads a minute), each drawing the gate again.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    tick = () => vi.advanceTimersByTimeAsync(0);
    localStorage.setItem("wg_api_token", "right");
    await boot();
    expect(document.querySelector("form.login-gate")).toBeNull();
    validToken = "rotated"; // revoked server-side
    await vi.advanceTimersByTimeAsync(10_000); // one interval refresh, one stream reconnect
    expect(document.querySelector("form.login-gate")).not.toBeNull();
    expect(document.querySelector(".login-error")?.textContent).toContain("rejected");
    const typed = document.querySelector<HTMLInputElement>("#login-token")!;
    typed.value = "half-typed";
    const asked = sent.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent.slice(asked)).toEqual([]);
    expect(document.querySelector<HTMLInputElement>("#login-token")!.value).toBe("half-typed");
  });

  it("a gate whoami that fails: the views do not wait for a second one, asked in the background", async () => {
    // Review finding: the views waited for a second whoami after the gate's had failed,
    // so a slow one held "Loading…" for 30 s (two 15 s read timeouts) instead of 15.
    localStorage.setItem("wg_api_token", "right");
    whoamiStatus = 500;
    stubFetchWhoamiHangsAfterFirst();
    await boot();
    expect(document.querySelector("form.login-gate")).toBeNull();
    expect(sent.filter((u) => u === "/api/whoami")).toHaveLength(2);
    // The Overview drew (not its loading skeleton) while the second whoami still hangs.
    expect(document.querySelector("#app > .view-overview")).not.toBeNull();
    expect(document.querySelector("#app > .skeleton-view")).toBeNull();
    expect(document.body.classList.contains("is-read-only")).toBe(false);
  });

  it("a gate whoami that fails once: the background one switches a read token's controls off", async () => {
    localStorage.setItem("wg_api_token", "right");
    whoamiStatus = 500;
    stubFetchOnce500ThenRead();
    await boot();
    expect(document.body.classList.contains("is-read-only")).toBe(true);
    expect(document.getElementById("ro-strip")?.hidden).toBe(false);
  });
});

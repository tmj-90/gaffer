// @vitest-environment jsdom
//
// SEALED PRINCIPALS in the dashboard: Settings shows "N sign-ins were created before
// signing. Review and re-sign." with the list, and the operator re-signs from there (one
// row, or every one whose creation is on record). A principal's session sees the list
// and no button (the server refuses its re-sign anyway). Nothing shows when every sign-in
// is signed.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const UNSIGNED = [
  {
    id: "p1",
    name: "old-ci",
    capability: "full",
    actor_type: "human",
    actor_id: "old-ci",
    created_at: "2026-01-02T00:00:00.000Z",
    created_by: "tom",
    scoped: false,
    failure: "unsigned",
    detail: "it carries no signature",
    creation_event: "ev1",
  },
  {
    id: "p2",
    name: "old-ops",
    capability: "full",
    actor_type: "admin",
    actor_id: "ops",
    created_at: "2026-01-03T00:00:00.000Z",
    created_by: "tom",
    scoped: true,
    failure: "unsigned",
    detail: "it carries no signature",
    creation_event: "ev2",
  },
  {
    id: "p3",
    name: "ghost",
    capability: "full",
    actor_type: "admin",
    actor_id: "ghost",
    created_at: "2026-01-04T00:00:00.000Z",
    created_by: "tom",
    scoped: false,
    failure: "unsigned",
    detail: "it carries no signature",
    creation_event: null,
  },
];

let unsigned: unknown[] = [];
let whoami: unknown = { capability: "full", actor: { type: "human", id: "tom" }, principal: null };
let posts: Array<{ url: string; body: unknown }> = [];

function stubFetch(): void {
  posts = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (url.includes("/api/principal-signatures/resign") && method === "POST") {
        posts.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
        return json({ resigned: [{ id: "p1", name: "old-ci", event_id: "e" }], skipped: [] });
      }
      if (url.includes("/api/principal-signatures")) return json({ unsigned });
      if (url.includes("/api/whoami")) return json(whoami);
      if (url.includes("/api/settings"))
        return json({
          settings: [
            {
              key: "MAX_TICKS",
              value: "20",
              envLocked: false,
              type: "int",
              group: "budget",
              label: "Max ticks (run)",
            },
          ],
        });
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

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

describe("web: the unsigned sign-ins callout in Settings", () => {
  beforeEach(() => {
    stubFetch();
    mountShell();
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
    unsigned = [];
    whoami = { capability: "full", actor: { type: "human", id: "tom" }, principal: null };
  });

  it("names every unsigned sign-in and re-signs one, or all with a creation on record", async () => {
    unsigned = UNSIGNED;
    await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
    await settle();
    const box = document.querySelector('[data-testid="unsigned-principals"]') as HTMLElement;
    expect(box, "the callout renders").not.toBeNull();
    expect(box.textContent).toMatch(
      /3 sign-ins were created before signing\. Review and re-sign\./,
    );
    for (const n of ["old-ci", "old-ops", "ghost"]) {
      expect(box.querySelector(`[data-principal="${n}"]`), n).not.toBeNull();
    }
    expect(box.querySelector('[data-principal="ghost"]')!.textContent).toMatch(
      /no creation on record/,
    );
    const one = box.querySelector('[data-principal="old-ci"] button') as HTMLButtonElement;
    one.click();
    await settle();
    expect(posts[0]!.body).toEqual({ names: ["p1"] });
    const all = [...box.querySelectorAll("button")].find((b) =>
      /Re-sign all 2/.test(b.textContent ?? ""),
    ) as HTMLButtonElement;
    expect(all, "the re-sign-all button counts only rows with a creation on record").toBeTruthy();
    all.click();
    await settle();
    expect(posts[1]!.body).toEqual({ all: true });
  });

  it("a principal's session sees the list and no button", async () => {
    unsigned = UNSIGNED.slice(0, 1);
    whoami = {
      capability: "full",
      actor: { type: "human", id: "alice" },
      principal: { id: "a", name: "alice" },
    };
    await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
    await settle();
    const box = document.querySelector('[data-testid="unsigned-principals"]') as HTMLElement;
    expect(box.textContent).toMatch(/1 sign-in was created before signing/);
    expect(box.querySelector("button")).toBeNull();
  });

  it("shows nothing when every sign-in is signed", async () => {
    await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
    await settle();
    expect(document.querySelector("#app")!.textContent).not.toMatch(/Loading/);
    expect(document.querySelector('[data-testid="unsigned-principals"]')).toBeNull();
    expect((document.querySelector("#principal-signatures") as HTMLElement).hidden).toBe(true);
  });
});

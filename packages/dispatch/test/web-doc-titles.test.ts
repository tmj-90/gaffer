// @vitest-environment jsdom
//
// Browser-tab titles + the login gate's wording (src/api/web/app.js). Every route
// has a VIEW_TITLES entry (create / hidden used to fall back to "Gaffer · Gaffer"),
// detail views refine the title once their data loads (the comment promised it; no
// call ever passed a detail, so every ticket tab read "Ticket · Gaffer"), and the
// login gate names the product and where the token comes from.

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");
const SRC = readFileSync(APP_JS, "utf8");

/** The keys of a top-level `const NAME = { … };` object literal in app.js. */
function objectKeys(name: string): string[] {
  const m = new RegExp(`\\nconst ${name} = \\{([\\s\\S]*?)\\n\\};`).exec(SRC);
  if (!m) throw new Error(`const ${name} not found in app.js`);
  return [...m[1]!.matchAll(/^\s+([a-z]+):/gm)].map((k) => k[1]!);
}

function stubFetch(routes: Record<string, { status?: number; body: unknown }>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input).replace(/^https?:\/\/[^/]+/, "");
      const hit = Object.entries(routes).find(([k]) => url.startsWith(k));
      const { status = 200, body } = hit ? hit[1] : { body: {} };
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
async function boot(): Promise<void> {
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}-${Math.random()}`);
  for (let i = 0; i < 6; i++) await tick();
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.title = "";
});

describe("web: tab titles", () => {
  it("every route in VIEWS has a VIEW_TITLES entry", () => {
    const views = objectKeys("VIEWS");
    const titles = new Set(objectKeys("VIEW_TITLES"));
    expect(views.length).toBeGreaterThan(10);
    expect(views.filter((v) => !titles.has(v))).toEqual([]);
  });

  it("#/create reads 'Plan a build · Gaffer', never 'Gaffer · Gaffer'", async () => {
    stubFetch({});
    mountShell("#/create");
    await boot();
    expect(document.title).toBe("Plan a build · Gaffer");
  });

  it("a ticket tab carries the ticket's number and title once it loads", async () => {
    stubFetch({
      "/tickets/abc": {
        body: {
          ticket: { id: "abc", number: 12, title: "Add login", status: "draft", priority: "p2" },
          acceptance_criteria: [],
          blocking_decisions: [],
          events: [],
        },
      },
    });
    mountShell("#/ticket/abc");
    await boot();
    expect(document.title).toBe("#12 Add login · Gaffer");
  });
});

describe("web: login gate", () => {
  it("names Gaffer and says where the token comes from", async () => {
    stubFetch({ "/": { status: 401, body: { ok: false, code: "UNAUTHORIZED" } } });
    mountShell("#/overview");
    await boot();
    const gate = document.querySelector(".login-gate");
    expect(gate).not.toBeNull();
    // The match-ticket gate names the club on its stub and heads the form
    // "Members’ entrance"; the point is that it says Gaffer, never Dispatch.
    expect(gate!.querySelector("h1")).not.toBeNull();
    expect(gate!.textContent ?? "").toContain("Gaffer");
    expect(gate!.textContent ?? "").not.toContain("Dispatch");
    const hint = gate!.querySelector(".login-hint")!.textContent ?? "";
    expect(hint).toContain("gaffer dashboard");
    expect(hint).toContain("dashboard-token");
    expect(hint).not.toContain("terminal that started");
  });
});

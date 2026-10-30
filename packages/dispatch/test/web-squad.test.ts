// @vitest-environment jsdom
//
// The club and the squad in the dashboard (src/api/web/app.js): the header crest
// carries the club's short name and its name from /api/club and, with a full
// token, opens "Name your club", whose Save PATCHes /api/club (a 422 is shown in
// the form); the tactics board's shirt wears the agent's shirt number and is
// labelled with its display name; the Squad page renames an agent in place and
// says who holds a taken number (409); a read token sees the crest and the squad
// but no editor at all.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const ago = (min: number) => new Date(Date.now() - min * 60e3).toISOString();

type Call = { method: string; url: string; body: unknown };
type Reply = { status?: number; body: unknown };

const CLUB = {
  name: "Factory FC",
  short_name: "FFC",
  kit_primary: "#1d4ed8",
  kit_secondary: "#ffffff",
  name_effective: "Factory FC",
  short_name_effective: "FFC",
  updated_by: "dispatch-api",
  updated_at: ago(60),
};

const AGENTS = () => [
  {
    agent_id: "ag-1",
    display_name: null,
    display_name_effective: "Delivery 1",
    default_display_name: "Delivery 1",
    shirt_number: null,
    role: "delivery",
    registered_name: "crew-delivery-01",
    agent_type: "coding_agent",
    status: "active",
    max_risk: "high",
    last_seen_at: ago(3),
    created_at: ago(600),
    updated_at: ago(3),
  },
  {
    agent_id: "ag-2",
    display_name: "Kev",
    display_name_effective: "Kev",
    default_display_name: "Delivery 2",
    shirt_number: 9,
    role: "delivery",
    registered_name: "crew-delivery-02",
    agent_type: "coding_agent",
    status: "active",
    max_risk: "high",
    last_seen_at: ago(1),
    created_at: ago(500),
    updated_at: ago(1),
  },
];

let calls: Call[] = [];
/** Replies queued for writes, keyed "METHOD /path" (first in, first out). */
let writes: Record<string, Reply[]> = {};

function stubFetch(capability: "full" | "read", extra: (url: string) => unknown = () => null) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init && init.method) || "GET";
      const body = init && init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      const json = (obj: unknown, status = 200) =>
        new Response(JSON.stringify(obj), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (method !== "GET") {
        const path = new URL(url, "http://x").pathname;
        const q = writes[`${method} ${path}`] || [];
        const r = q.shift();
        return r ? json(r.body, r.status ?? 200) : json({ error: { code: "NOPE" } }, 500);
      }
      if (url.includes("/api/whoami"))
        return json({ capability, actor: { type: "human", id: "operator" } });
      if (url.includes("/api/club")) return json({ club: CLUB });
      if (url.includes("/api/squad")) return json({ club: CLUB, agents: AGENTS() });
      if (url.includes("/api/board")) return json(null);
      const hit = extra(url);
      if (hit) return json(hit);
      if (url.includes("/api/dashboard")) return json({ summary: { ticketsByStatus: {} } });
      if (url.includes("/api/human-queue")) return json({ items: [], counts: { total: 0 } });
      if (url.includes("/api/runs")) return json({ active: [], recent: [] });
      if (url.includes("/api/activity")) return json({ events: [], total: 0 });
      if (url.includes("/decisions")) return json({ decisions: [] });
      return json({});
    }),
  );
}

/**
 * Mount the shell at `hash` and wait for the hashchange it fires: the app's own
 * hashchange handler closes an open sheet, so a late event would shut the club
 * sheet under the test (a flake seen under a loaded suite).
 */
async function mountShell(hash: string): Promise<void> {
  document.body.innerHTML = `
    <div id="toast" class="toast" role="alert" hidden></div>
    <div class="shell">
      <header id="appbar" class="appbar" hidden></header>
      <main id="app" class="app"><p class="loading">Loading…</p></main>
      <nav id="bottomnav" class="bottomnav" hidden></nav>
    </div>`;
  if (location.hash === hash) return;
  const changed = new Promise((r) => window.addEventListener("hashchange", r, { once: true }));
  location.hash = hash;
  await changed;
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function until<T>(fn: () => T | null | undefined | false, n = 60): Promise<T> {
  for (let i = 0; i < n; i++) {
    const v = fn();
    if (v) return v;
    await tick();
  }
  throw new Error("condition not met");
}
const boot = () => import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}-${Math.random()}`);

describe("web: the club and the squad", () => {
  beforeEach(() => {
    vi.resetModules();
    writes = {};
    document.documentElement.removeAttribute("style");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("the crest shows the club from /api/club, wears its kit, and its editor PATCHes the club", async () => {
    stubFetch("full");
    await mountShell("#/squad");
    await boot();
    const btn = await until(() => document.querySelector<HTMLButtonElement>("button.crest-btn"));
    expect(document.querySelector(".brand-name")?.textContent).toBe("Factory FC");
    expect(btn.querySelector(".crest-t")?.textContent).toBe("FFC");
    expect(btn.getAttribute("aria-label")).toContain("Name your club");
    // The club's kit drives the kit tokens; a dark blue keeps white text on it.
    const root = document.documentElement.style;
    expect(root.getPropertyValue("--claret")).toBe("#1d4ed8");
    expect(root.getPropertyValue("--sky")).toBe("#ffffff");
    expect(root.getPropertyValue("--on-claret")).toBe("");

    btn.click();
    const sheet = await until(() => document.querySelector(".sheet.open"));
    expect(sheet.querySelector("#sheet-title")?.textContent).toBe("Name your club");
    const name = sheet.querySelector<HTMLInputElement>("input.club-name-in")!;
    const short = sheet.querySelector<HTMLInputElement>("input.club-short-in")!;
    const prim = sheet.querySelectorAll<HTMLInputElement>("input.club-kit-in")[0]!;
    expect(name.value).toBe("Factory FC");
    name.value = "Real Factory FC";
    name.dispatchEvent(new Event("input"));
    short.value = "RFC";
    short.dispatchEvent(new Event("input"));
    // A kit too light for white text: the preview flips the text on it to ink.
    prim.value = "#ffe600";
    prim.dispatchEvent(new Event("input"));
    const preview = sheet.querySelector<HTMLElement>(".club-preview")!;
    expect(preview.style.getPropertyValue("--claret")).toBe("#ffe600");
    expect(preview.style.getPropertyValue("--on-claret")).toBe("var(--counter-ink)");
    expect(preview.querySelector(".cp-name")?.textContent).toBe("Real Factory FC");
    expect(preview.querySelector(".crest-t")?.textContent).toBe("RFC");
    expect(sheet.querySelector(".club-note")?.textContent).toMatch(/light kit/i);

    const form = sheet.querySelector("form.club-form")!;
    // A refusal is shown in the form, and nothing closes.
    writes["PATCH /api/club"] = [
      {
        status: 422,
        body: {
          error: { code: "VALIDATION_ERROR", message: "name must be at most 60 characters" },
        },
      },
      {
        body: {
          club: {
            ...CLUB,
            name: "Real Factory FC",
            short_name: "RFC",
            kit_primary: "#ffe600",
            name_effective: "Real Factory FC",
            short_name_effective: "RFC",
          },
          changed: ["name", "short_name", "kit_primary"],
        },
      },
    ];
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    const err = await until(() => {
      const e = sheet.querySelector<HTMLElement>(".club-err");
      return e && !e.hidden ? e : null;
    });
    expect(err.textContent).toBe("name must be at most 60 characters");
    expect(document.querySelector(".sheet.open")).not.toBeNull();

    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await until(() => !document.querySelector(".sheet.open"));
    const patches = calls.filter((c) => c.method === "PATCH");
    expect(patches).toHaveLength(2);
    // Only what the operator touched: the secondary kit is left as it was.
    expect(patches[1]?.body).toEqual({
      name: "Real Factory FC",
      short_name: "RFC",
      kit_primary: "#ffe600",
    });
    expect(document.querySelector(".brand-name")?.textContent).toBe("Real Factory FC");
    expect(document.querySelector(".brand .crest-t")?.textContent).toBe("RFC");
    expect(root.getPropertyValue("--claret")).toBe("#ffe600");
    expect(root.getPropertyValue("--on-claret")).toBe("var(--counter-ink)");
  });

  it("a shirt on the tactics board wears the agent's number and is labelled with its name", async () => {
    const tickets = [{ id: "tk-1", number: 12, status: "in_progress", repo: "billing-api" }];
    stubFetch("full", (url) => {
      if (url.includes("/claims"))
        return {
          claims: [
            {
              ticket_id: "tk-1",
              ticket_number: 12,
              agent_id: "ag-2",
              agent_display_name: "crew-delivery-02",
            },
          ],
        };
      if (url.includes("/agents"))
        return { agents: [{ id: "ag-2", display_name: "crew-delivery-02" }] };
      if (/\/tickets\/tk-1/.test(url))
        return {
          ticket: { id: "tk-1", number: 12, status: "in_progress" },
          events: [],
          repositories: [{ name: "billing-api", access: "write" }],
          scopes: [],
        };
      if (url.includes("/tickets"))
        return {
          tickets: tickets.map((t) => ({ ...t, title: "Invoice totals", updated_at: ago(5) })),
        };
      return null;
    });
    await mountShell("#/overview");
    await boot();
    const counter = await until(() => document.querySelector("#tactics a.counter.has-agent"));
    // The squad says No. 9 "Kev", not the index scheme's 02 from crew-delivery-02.
    expect(counter.querySelector(".agent-on .shirt-no")?.textContent).toBe("9");
    expect(counter.getAttribute("aria-label")).toContain("Kev (No. 9) on it");
    expect(counter.querySelector("title")?.textContent).toContain("Kev (No. 9) on it");
    // Squad & form names the agent the same way.
    const sq = document.querySelector(".squad .sq-name");
    expect(sq?.textContent).toContain("Kev");
  });

  it("the Squad page renames an agent inline and names the holder of a taken number", async () => {
    stubFetch("full");
    await mountShell("#/squad");
    await boot();
    const rows = await until(() => {
      const r = document.querySelectorAll(".sq-table tbody tr");
      return r.length === 2 ? r : null;
    });
    const row = rows[0] as HTMLElement;
    expect(row.dataset.id).toBe("ag-1");
    // A default name is a placeholder until renamed.
    const dn = row.querySelector(".sq-dn")!;
    expect(dn.classList.contains("is-default")).toBe(true);
    expect(dn.textContent).toContain("Delivery 1");
    expect(row.querySelector(".c-reg")?.textContent).toBe("crew-delivery-01");
    expect(rows[1]!.querySelector(".sq-num")?.textContent).toBe("9");

    row.querySelector<HTMLButtonElement>("button.sq-rename")!.click();
    const nameIn = row.querySelector<HTMLInputElement>("input.sq-name-in")!;
    const noIn = row.querySelector<HTMLInputElement>("input.sq-no-in")!;
    expect(nameIn.value).toBe("");
    expect(nameIn.placeholder).toBe("Delivery 1");
    expect(nameIn.maxLength).toBe(40);

    // Out of range never leaves the page.
    noIn.value = "120";
    row.querySelector<HTMLButtonElement>("button.sq-save")!.click();
    await tick();
    expect(row.querySelector(".sq-err")?.textContent).toMatch(/1 to 99/);
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);

    // 9 is Kev's: the 409 names him, in the row.
    writes["PATCH /api/squad/agents/ag-1"] = [
      {
        status: 409,
        body: {
          error: {
            code: "DUPLICATE",
            message: "Shirt number 9 is already worn by Kev.",
            details: { shirt_number: 9, agent_id: "ag-2" },
          },
        },
      },
      {
        body: {
          agent: {
            ...AGENTS()[0],
            display_name: "Alan",
            display_name_effective: "Alan",
            shirt_number: 7,
          },
          changed: ["display_name", "shirt_number"],
        },
      },
    ];
    nameIn.value = "Alan";
    noIn.value = "9";
    row.querySelector<HTMLButtonElement>("button.sq-save")!.click();
    const err = await until(() => {
      const e = row.querySelector<HTMLElement>(".sq-err");
      return e && !e.hidden && /taken/.test(e.textContent || "") ? e : null;
    });
    expect(err.textContent).toBe("That number is taken by Kev.");
    expect(noIn.getAttribute("aria-invalid")).toBe("true");

    noIn.value = "7";
    row.querySelector<HTMLButtonElement>("button.sq-save")!.click();
    await until(() => !row.classList.contains("is-editing"));
    const patches = calls.filter((c) => c.method === "PATCH");
    expect(patches.map((p) => new URL(p.url, "http://x").pathname)).toEqual([
      "/api/squad/agents/ag-1",
      "/api/squad/agents/ag-1",
    ]);
    expect(patches[1]?.body).toEqual({ display_name: "Alan", shirt_number: 7 });
    expect(row.querySelector(".sq-dn")?.textContent).toBe("Alan");
    expect(row.querySelector(".sq-num")?.textContent).toBe("7");
    expect(row.querySelector(".shirt-no")?.textContent).toBe("7");
  });

  it("a read token sees the crest and the squad, but no editor anywhere", async () => {
    stubFetch("read");
    await mountShell("#/squad");
    await boot();
    await until(() => document.querySelectorAll(".sq-table tbody tr").length === 2);
    await until(() => document.querySelector(".brand-name")?.textContent === "Factory FC");
    expect(document.querySelector(".brand .crest-t")?.textContent).toBe("FFC");
    expect(document.querySelector("button.crest-btn")).toBeNull();
    expect(document.querySelector(".crest-btn.is-static")).not.toBeNull();
    expect(document.querySelector(".sq-rename")).toBeNull();
    expect(document.querySelector(".sq-club-btn")).toBeNull();
    expect(document.querySelector(".sq-readonly")?.textContent).toMatch(/read token/);
    // Clicking the badge opens nothing; no write is ever attempted.
    (document.querySelector(".crest-btn") as HTMLElement).click();
    await tick();
    expect(document.querySelector(".sheet.open")).toBeNull();
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });
});

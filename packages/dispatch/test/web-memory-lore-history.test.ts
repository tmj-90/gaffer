// @vitest-environment jsdom
//
// Memory, lore: every row has a History disclosure (every earlier version, newest
// first, read on first open from GET /api/memory/lore/:id/history; it was
// `memory history <id>` in a terminal only), and a search box narrows the rows shown
// in place. Found by the browser scenario suite S9 (F134).

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const row = (id: string, title: string, summary: string, status: string, tags: string[]) => ({
  id,
  title,
  summary,
  status,
  confidence: "high",
  source: "manual",
  repos: ["sample-repo"],
  tags,
  stale: false,
  flagged: false,
});
const PAGE = {
  available: true,
  lore: [
    row("aaaa2222", "Hash with argon2id", "No bcrypt.", "active", ["security"]),
    row("bbbb3333", "Prefer server components", "Default to RSC.", "active", ["react"]),
    row("cccc4444", "Pin the argon2 cost", "Memory cost 64 MiB.", "draft", ["security"]),
  ],
  total: 9,
  limit: 50,
  offset: 0,
};
const HISTORY = {
  available: true,
  id: "aaaa2222",
  current: {
    version: 2,
    status: "active",
    at: "2026-10-02T09:00:00Z",
    title: "Hash with argon2id",
    summary: "No bcrypt.",
  },
  versions: [
    {
      version: 1,
      status: "draft",
      at: "2026-10-01T09:00:00Z",
      title: "Hash passwords",
      summary: "Use bcrypt.",
    },
  ],
};
let historyCalls: string[] = [];

function stubFetch(): void {
  historyCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      let body: unknown = {};
      if (/\/api\/memory\/lore\/[^/]+\/history$/.test(url)) {
        historyCalls.push(url.replace(/^https?:\/\/[^/]+/, ""));
        body = url.includes("bbbb3333") ? { ...HISTORY, id: "bbbb3333", versions: [] } : HISTORY;
      } else if (url.includes("/api/memory/lore")) body = PAGE;
      else if (url.includes("/api/memory/digest/")) body = { available: true, digest: null };
      else if (url.includes("/api/memory/features/")) body = { available: true, features: [] };
      else if (url.includes("/repositories"))
        body = { repositories: [{ id: "r1", name: "sample-repo" }] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
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
  location.hash = "#/memory/sample-repo";
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}-${Math.random()}`);
  for (let i = 0; i < 6; i++) await tick();
}
const rowOf = (id: string) =>
  document.querySelector<HTMLElement>(`.lore-row[data-lore-id="${id}"]`)!;
const shown = () =>
  [...document.querySelectorAll<HTMLElement>(".lore-row")]
    .filter((r) => !r.hidden)
    .map((r) => r.dataset.loreId);

describe("web: Memory lore history and search", () => {
  beforeEach(() => {
    vi.resetModules();
    stubFetch();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("History reads the versions on first open, newest first, and only once", async () => {
    await boot();
    const box = rowOf("aaaa2222").querySelector<HTMLDetailsElement>("details.lore-history")!;
    expect(box.querySelector("summary")?.textContent).toBe("History");
    expect(historyCalls).toHaveLength(0);
    box.open = true;
    box.dispatchEvent(new Event("toggle"));
    for (let i = 0; i < 4; i++) await tick();
    expect(historyCalls).toEqual(["/api/memory/lore/aaaa2222/history"]);
    const versions = [...box.querySelectorAll(".lore-version")];
    expect(versions.map((v) => v.querySelector(".lv-head")?.textContent?.slice(0, 12))).toEqual([
      "v2 · current",
      "v1 · draft ·",
    ]);
    // An earlier title that differs is shown; the earlier summary is shown.
    expect(versions[1]!.textContent).toContain("Hash passwords");
    expect(versions[1]!.textContent).toContain("Use bcrypt.");
    box.open = false;
    box.dispatchEvent(new Event("toggle"));
    box.open = true;
    box.dispatchEvent(new Event("toggle"));
    await tick();
    expect(historyCalls).toHaveLength(1);
  });

  it("a record never edited says so", async () => {
    await boot();
    const box = rowOf("bbbb3333").querySelector<HTMLDetailsElement>("details.lore-history")!;
    box.open = true;
    box.dispatchEvent(new Event("toggle"));
    for (let i = 0; i < 4; i++) await tick();
    expect(box.textContent).toContain("No earlier versions");
  });

  it("the search box narrows the rows shown in place, every word must match", async () => {
    await boot();
    const input = document.querySelector<HTMLInputElement>(".lore-search-input")!;
    expect(document.querySelector(`label[for="${input.id}"]`)?.textContent).toBe("Search lore");
    const count = document.querySelector<HTMLElement>(".lore-search-count")!;
    expect(count.hidden).toBe(true);
    const type = (v: string) => {
      input.value = v;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    type("argon2");
    expect(shown()).toEqual(["cccc4444", "aaaa2222"]); // drafts group first
    expect(count.textContent).toContain("2 of the 3 records shown match");
    expect(count.textContent).toContain("the store holds 9");
    type("security cost");
    expect(shown()).toEqual(["cccc4444"]);
    // A group left with no row hides its heading.
    type("react");
    expect(shown()).toEqual(["bbbb3333"]);
    const visibleHeadings = [...document.querySelectorAll<HTMLElement>(".lore-list h3")].filter(
      (h) => !h.hidden,
    );
    expect(visibleHeadings).toHaveLength(1);
    type("");
    expect(shown()).toHaveLength(3);
    expect(count.hidden).toBe(true);
  });
});

// @vitest-environment jsdom
//
// DOM test for the Memory view's club-wide read (src/api/web/app.js): with no
// repo in the address it opens the repo whose lore draft is newest (not simply
// the first repo), every repo tab with drafts carries its count, the drafts are
// grouped first under "Awaiting your signature" with only the first Approve as
// the primary, and the strip's "Drafts await you" agrees with the tab.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const lore = (id: string, status: string, repo: string, title: string) => ({
  id,
  title,
  summary: `${title}.`,
  status,
  confidence: "medium",
  source: null,
  repos: [repo],
  tags: [],
  stale: false,
  flagged: false,
  kind: "convention",
});

// Newest first, as the server lists them: the newest draft belongs to web-shop.
const DRAFTS = [
  lore("d1", "draft", "web-shop", "Copy only in the shop"),
  lore("d2", "draft", "billing", "Pence, never floats"),
  lore("d3", "draft", "web-shop", "Server components first"),
];
const REPO_PAGE = (repo: string) => [
  ...DRAFTS.filter((l) => l.repos.includes(repo)),
  lore(`a-${repo}`, "active", repo, "An active rule"),
];
const loreCalls: string[] = [];

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      let body: unknown = {};
      if (url.includes("/repositories"))
        body = {
          repositories: [
            { id: "1", name: "billing" },
            { id: "2", name: "web-shop" },
          ],
        };
      else if (url.includes("/api/memory/digest/")) body = { available: true, digest: null };
      else if (url.includes("/api/memory/features/")) body = { available: true, features: [] };
      else if (url.includes("/api/memory/lore")) {
        loreCalls.push(url);
        const q = new URL(url, "http://x").searchParams;
        const repo = q.get("repo");
        const items = repo ? REPO_PAGE(repo) : q.get("status") === "draft" ? DRAFTS : [...DRAFTS];
        body = { available: true, lore: items, total: items.length, limit: 50, offset: 0 };
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("web: Memory view, the club-wide read", () => {
  beforeEach(() => {
    vi.resetModules();
    loreCalls.length = 0;
    stubFetch();
    document.body.innerHTML = `
      <div id="toast" class="toast" role="alert" hidden></div>
      <div class="shell">
        <header id="appbar" class="appbar" hidden></header>
        <main id="app" class="app"></main>
        <nav id="bottomnav" class="bottomnav" hidden></nav>
      </div>`;
    location.hash = "#/memory";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("opens the repo with the newest draft and counts drafts on every tab", async () => {
    await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
    for (let i = 0; i < 4; i++) await tick();
    // One club-wide drafts read, then the card's read for the chosen repo.
    expect(loreCalls[0]).toContain("status=draft");
    expect(loreCalls.at(-1)).toContain("repo=web-shop");
    const current = document.querySelector(".mem-repo[aria-current='page']");
    expect(current?.textContent).toContain("web-shop");
    const tabs = Array.from(document.querySelectorAll(".mem-repo"));
    const n = (name: string) =>
      tabs.find((t) => t.textContent?.includes(name))?.querySelector(".mem-repo-n")?.textContent;
    expect(n("web-shop")).toBe("2");
    expect(n("billing")).toBe("1");
    // The strip agrees with the tab, and says one more waits elsewhere.
    const cell = document.querySelector(".mem-stats .kpi") as HTMLElement;
    expect(cell.querySelector(".kpi-val")?.textContent).toBe("2");
    expect(cell.textContent).toContain("1 more waiting in other repos");
    // Drafts are grouped first; only the first Approve is the primary.
    const groups = Array.from(document.querySelectorAll(".lore-group")).map((g) =>
      g.firstChild?.textContent?.trim(),
    );
    expect(groups).toEqual(["Awaiting your signature", "On the record"]);
    const approves = Array.from(document.querySelectorAll("button.lore-approve"));
    expect(approves).toHaveLength(2);
    expect(approves[0]!.classList.contains("primary")).toBe(true);
    expect(approves[1]!.classList.contains("primary")).toBe(false);
    // The view carries a data signature, so an unchanged refresh keeps the DOM.
    expect((document.querySelector(".view-memory") as HTMLElement).dataset.sig).toBeTruthy();
  });
});

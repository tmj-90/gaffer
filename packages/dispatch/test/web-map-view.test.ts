// @vitest-environment jsdom
//
// DOM test for the Map (src/api/web/app.js renderFactory): the scouting map's live
// overlay. Each ground shows the repos that play there and its live tickets as
// counters, read from the board (repos per ticket), each repo's scope links and,
// for tickets linked to a ground directly (campaign members), the ticket detail.
// Below it, "Who plays where" tallies each mapped repo and "Free agents" lists the
// unmapped repos with the onboarding entry.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const NODES = [
  { id: "n-club", name: "Fernhill", type: "factory", risk_level: "medium" },
  { id: "n-pay", name: "Payments", type: "service", risk_level: "high", owner: "pay" },
  { id: "n-epic", name: "Repeat orders", type: "epic", risk_level: "medium" },
];
const EDGES = [{ id: "e1", from_node_id: "n-club", to_node_id: "n-pay", relation: "contains" }];
const REPOS = [
  { id: "r-bill", name: "billing-api", stack: "node", default_branch: "main", test_command: "t" },
  { id: "r-free", name: "loose-repo", stack: "go", default_branch: "main", local_path: "/x" },
];
const card = (id: string, number: number, status: string, repo?: string) => ({
  id,
  number,
  title: `Ticket ${number}`,
  status,
  priority: 1,
  repos: repo ? [{ id: repo, name: repo === "r-bill" ? "billing-api" : repo }] : [],
});
const BOARD = {
  columns: [
    { column: "draft", cards: [card("t1", 1, "draft", "r-bill")] },
    { column: "in_progress", cards: [card("t2", 2, "in_progress", "r-bill")] },
    { column: "blocked", cards: [card("t3", 3, "blocked", "r-bill")] },
    { column: "in_review", cards: [card("t4", 4, "in_review")] },
    { column: "done", cards: [card("t5", 5, "done", "r-bill")] },
  ],
  closed: [],
  wontDo: [],
  readyForMerge: [],
};

function stubFetch(unmapped: unknown[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = (obj: unknown) =>
        new Response(JSON.stringify(obj), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (url.includes("/scope/nodes")) return json({ nodes: NODES });
      if (url.includes("/scope/edges")) return json({ edges: EDGES });
      if (url.includes("/scope/unmapped-repos")) return json({ repositories: unmapped });
      if (url.includes("/scope/repos?repo=r-bill"))
        return json({
          scopes: [{ ...NODES[1], relation: "owns", default_access: "write" }],
        });
      if (url.includes("/scope/repos")) return json({ scopes: [] });
      if (url.includes("/repositories")) return json({ repositories: REPOS });
      if (url.includes("/api/board")) return json(BOARD);
      // #4 has no repo but belongs to the campaign directly.
      const m = url.match(/\/tickets\/(t\d)$/);
      if (m)
        return json({
          ticket: { id: m[1] },
          scopes: m[1] === "t4" ? [{ id: "n-epic", name: "Repeat orders", type: "epic" }] : [],
          dependencies: [],
          events: [],
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
  location.hash = "#/factory";
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function loadApp(): Promise<void> {
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}-${Math.random()}`);
  for (let i = 0; i < 8; i++) await tick();
}

/** The desktop graph's card for a ground. */
function ground(name: string): Element | undefined {
  return Array.from(document.querySelectorAll(".graph .scope-gnode")).find(
    (n) => n.querySelector(".sg-name")?.textContent === name,
  );
}

describe("web: Map view (the scouting map)", () => {
  beforeEach(() => {
    vi.resetModules();
    mountShell();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("puts each live ticket on the grounds its repo plays at, carded by state", async () => {
    stubFetch([REPOS[1]]);
    await loadApp();
    const pay = ground("Payments");
    expect(pay).toBeDefined();
    // billing-api plays at Payments: its kit is on the card.
    expect(pay!.querySelector(".sg-repos")?.textContent).toContain("billing-api");
    // Live: #3 blocked first, then #2 in progress; the draft and the done ticket are not shown.
    const nums = Array.from(pay!.querySelectorAll(".mag .mag-n")).map((n) => n.textContent);
    expect(nums).toEqual(["3", "2"]);
    expect(pay!.querySelector(".mag.is-red .mag-red")).not.toBeNull();
    expect(pay!.querySelector(".sg-words")?.textContent).toBe("1 blocked · 1 in play");
    // The ground's name is the one link; counters are not links (no nested controls).
    expect(pay!.querySelectorAll("a").length).toBe(1);
    expect(pay!.querySelector("a")?.getAttribute("href")).toBe("#/node/n-pay");
  });

  it("counts a ticket linked to a campaign directly, with a yellow card when it awaits review", async () => {
    stubFetch([]);
    await loadApp();
    const epic = ground("Repeat orders");
    const mag = epic!.querySelector(".mag");
    expect(mag?.textContent).toBe("4");
    expect(mag?.classList.contains("is-yellow")).toBe(true);
    expect(mag?.querySelector(".ycard")).not.toBeNull();
    expect(epic!.querySelector(".sg-words")?.textContent).toBe("1 in play · 1 to review");
    // The club holds everything live (3 tickets), without counters.
    const club = ground("Fernhill");
    expect(club!.querySelector(".sg-club b")?.textContent).toBe("3");
    expect(club!.querySelectorAll(".mag").length).toBe(0);
  });

  it("tallies mapped repos in Who plays where and lists free agents with the onboard entry", async () => {
    stubFetch([REPOS[1]]);
    await loadApp();
    const reg = document.querySelector(".map-register");
    const row = reg!.querySelector('tr.repo-row[data-repo-id="r-bill"]');
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain("Payments");
    // Blocked 1 · In play 1 · To review 0 (the review ticket has no repo).
    const counts = Array.from(row!.querySelectorAll(".reg-n")).map((n) => n.textContent);
    expect(counts).toEqual(["1", "1", "0"]);
    // The unmapped repo is a free agent, not in the register.
    expect(reg!.querySelector('[data-repo-id="r-free"]')).toBeNull();
    const free = document.querySelector("[data-section='unmapped']");
    expect(free!.querySelector('[data-repo-id="r-free"]')).not.toBeNull();
    expect(free!.querySelector("button.repo-hide-btn")).not.toBeNull();
    // Onboarding is reachable from the Map.
    const onboard = Array.from(document.querySelectorAll("button")).find((b) =>
      /Onboard a repo/.test(b.textContent || ""),
    );
    expect(onboard).toBeDefined();
    onboard!.click();
    expect(document.querySelector('.sheet.open input[name="onboard-path"]')).not.toBeNull();
  });

  it("filters grounds and repo rows from the search box", async () => {
    stubFetch([REPOS[1]]);
    await loadApp();
    const input = document.querySelector('input[aria-label="Search the Map"]') as HTMLInputElement;
    input.value = "billing";
    input.dispatchEvent(new Event("input"));
    // Payments matches by the repo that plays there; the campaign does not.
    expect(ground("Payments")!.classList.contains("is-dim")).toBe(false);
    expect(ground("Repeat orders")!.classList.contains("is-dim")).toBe(true);
    const free = document.querySelector('[data-section="unmapped"] tr.repo-row') as HTMLElement;
    expect(free.hidden).toBe(true);
  });
});

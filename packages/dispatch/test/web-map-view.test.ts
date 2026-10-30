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

const NODES: Array<Record<string, string>> = [
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
      const one = url.match(/\/scope\/nodes\/(n-[a-z]+)$/);
      if (one)
        return json({
          node: NODES.find((n) => n.id === one[1]),
          repos:
            one[1] === "n-pay"
              ? [{ id: "r-bill", name: "billing-api", relation: "owns", default_access: "write" }]
              : [],
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

function mountShell(hash = "#/factory"): void {
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
    // The ground's name links to its page. Each counter is its own link to the
    // ticket (siblings, never nested), with a label that says what it is: the
    // review asked for this, as the tactics board's counters on the Overview are
    // links, and a title= alone left touch and keyboard users at a dead end.
    expect(pay!.querySelector("a.sg-name")?.getAttribute("href")).toBe("#/node/n-pay");
    const mags = Array.from(pay!.querySelectorAll("a.mag"));
    expect(mags.map((a) => a.getAttribute("href"))).toEqual(["#/ticket/t3", "#/ticket/t2"]);
    expect(mags[0]!.getAttribute("aria-label")).toBe("#3 Blocked: Ticket 3");
    expect(pay!.querySelector("a a, [aria-hidden='true'] a")).toBeNull();
  });

  it("counts a ticket linked to a campaign directly, with a yellow card when it awaits review", async () => {
    stubFetch([]);
    await loadApp();
    const epic = ground("Repeat orders");
    const mag = epic!.querySelector(".mag");
    expect(mag?.textContent).toBe("4");
    expect(mag?.classList.contains("is-yellow")).toBe(true);
    expect(mag?.querySelector(".ycard")).not.toBeNull();
    // A change waiting on you opens in Review.
    expect(mag?.getAttribute("href")).toBe("#/review/t4");
    // Each ticket is counted once, so the words add up to the counters: the review
    // ticket is "to review", not also "in play" (it used to read "1 in play · 1 to
    // review" for one counter).
    expect(epic!.querySelector(".sg-words")?.textContent).toBe("1 to review");
    // The club holds everything live (3 tickets), without counters, and its words add up.
    const club = ground("Fernhill");
    expect(club!.querySelector(".sg-club b")?.textContent).toBe("3");
    expect(club!.querySelectorAll(".mag").length).toBe(0);
    expect(club!.querySelector(".sg-words")?.textContent).toBe(
      "1 blocked · 1 to review · 1 in play",
    );
  });

  it("tallies mapped repos in Who plays where and lists free agents with the onboard entry", async () => {
    stubFetch([REPOS[1]]);
    await loadApp();
    const reg = document.querySelector(".map-register");
    const row = reg!.querySelector('tr.repo-row[data-repo-id="r-bill"]');
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain("Payments");
    // Blocked 1 · To review 0 · In play 1 (the review ticket has no repo). The columns
    // now run in the order of the card's words (worst first), so the counts list
    // reads Blocked, To review, In play.
    const counts = Array.from(row!.querySelectorAll(".reg-n")).map((n) => n.textContent);
    expect(counts).toEqual(["1", "0", "1"]);
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

  it("counts a paused ticket in the dugout, so the tallies add up", async () => {
    BOARD.columns.push({ column: "paused", cards: [card("t6", 6, "paused", "r-bill")] });
    try {
      stubFetch([REPOS[1]]);
      await loadApp();
      const pay = ground("Payments");
      const nums = Array.from(pay!.querySelectorAll(".mag .mag-n")).map((n) => n.textContent);
      // Worst first: blocked, then paused, then in play.
      expect(nums).toEqual(["3", "6", "2"]);
      expect(pay!.querySelector(".mag.is-paused .mag-pause")).not.toBeNull();
      expect(pay!.querySelector(".sg-words")?.textContent).toBe("1 blocked · 1 paused · 1 in play");
      const row = document.querySelector('.map-register tr.repo-row[data-repo-id="r-bill"]');
      // Blocked · To review · Paused · In play
      expect(Array.from(row!.querySelectorAll(".reg-n")).map((n) => n.textContent)).toEqual([
        "1",
        "0",
        "1",
        "1",
      ]);
    } finally {
      BOARD.columns.pop();
    }
  });

  it("shows the server's implicit repo scope as the free agent, not as a ground outside", async () => {
    NODES.push({
      id: "n-impl",
      name: "repo:loose-repo",
      type: "external_dependency",
      risk_level: "medium",
      description: "Implicit single-repo scope for unmapped repo 'loose-repo'.",
    });
    try {
      stubFetch([REPOS[1]]);
      await loadApp();
      expect(ground("repo:loose-repo")).toBeUndefined();
      expect(document.body.textContent).not.toContain("Outside the ground");
      expect(document.querySelector(".view-head .view-sub")?.textContent).toMatch(/^3 grounds/);
      const free = document.querySelector("[data-section='unmapped']");
      expect(free!.querySelector('[data-repo-id="r-free"]')).not.toBeNull();
    } finally {
      NODES.pop();
    }
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
    // What the search found is said in a live region; a search that finds nothing says so.
    const found = document.querySelector(".map-found");
    expect(found?.getAttribute("role")).toBe("status");
    expect(found?.textContent).toContain("match “billing”");
    input.value = "zzzz";
    input.dispatchEvent(new Event("input"));
    expect(found?.textContent).toBe(
      "Nothing on the map matches “zzzz”. Try a ground, a repo or an owner.",
    );
  });

  it("counts a ground's own page from the same source as its card on the Map", async () => {
    // The campaign holds #4 only through the ticket's own scope link (no repo plays
    // there). Its page used to read /tickets?repo= for its repos, found none, and
    // showed zeros while its card showed #4 to review.
    stubFetch([]);
    mountShell("#/node/n-epic");
    await loadApp();
    const stat = (label: string) =>
      Array.from(document.querySelectorAll(".gr-stats .kpi"))
        .find((k) => k.querySelector(".kpi-label")?.textContent === label)
        ?.querySelector(".kpi-val")?.textContent;
    expect(stat("Live")).toBe("1");
    expect(stat("To review")).toBe("1");
    expect(stat("Blocked")).toBe("0");
    const fixtures = document.querySelector('[aria-label="Fixtures"]');
    expect(Array.from(fixtures!.querySelectorAll(".mag-n")).map((n) => n.textContent)).toEqual([
      "4",
    ]);
    expect(document.querySelector(".gr-count")?.textContent).toContain("1 to review");
  });

  it("counts the club's page over every ticket, as its card does", async () => {
    stubFetch([]);
    mountShell("#/node/n-club");
    await loadApp();
    const vals = Array.from(document.querySelectorAll(".gr-stats .kpi")).map(
      (k) =>
        `${k.querySelector(".kpi-label")?.textContent} ${k.querySelector(".kpi-val")?.textContent}`,
    );
    // live 3 = #3 blocked + #4 to review + #2 in play; #5 done; #1 on the bench.
    expect(vals).toEqual(["Live 3", "Blocked 1", "To review 1", "In play 1", "Done 1", "Bench 1"]);
    expect(document.body.textContent).not.toContain("No tickets reference this repo");
  });
});

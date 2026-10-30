// @vitest-environment jsdom
//
// The Match Day Work view:
//   - a board card is an <article>: its title is the one link and Move / the repo /
//     the by-hand action are buttons beside it, never inside a link (BRIEF §4);
//   - the yellow card follows the server's human queue (the Overview's team sheet),
//     not a guess from the status;
//   - the number-or-title filter narrows the board in place, with true lane counts;
//   - the list is a league table, most urgent first, then by number.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

type Card = Record<string, unknown>;
const card = (n: number, status: string, extra: Card = {}): Card => ({
  id: `t-${n}`,
  number: n,
  title: `Ticket ${n}`,
  status,
  priority: 1,
  risk_level: "low",
  updated_at: new Date(Date.UTC(2026, 9, 1) + n * 60_000).toISOString(),
  acTotal: 2,
  acSatisfied: 1,
  acEvidenced: 0,
  acEvidenceRequired: 0,
  repos: [{ id: "r1", name: "billing-api" }],
  claim: null,
  humanOwner: null,
  lastReviewFeedback: null,
  blockingCount: 0,
  ...extra,
});
const columns = (by: Record<string, Card[]>) =>
  [
    "draft",
    "ready",
    "in_progress",
    "blocked",
    "in_review",
    "in_testing",
    "ready_for_merge",
    "done",
  ].map((column) => ({ column, cards: by[column] || [] }));

let board: unknown;
let tickets: Card[] = [];
let queue: unknown = { items: [] };

function json(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/board")) return json(board);
      if (url.includes("/api/human-queue")) return json(queue);
      if (url.includes("/tickets")) return json({ tickets });
      if (url.includes("/repositories")) return json({ repositories: [] });
      if (url.includes("/scope/nodes")) return json({ nodes: [] });
      if (url.includes("/claims")) return json({ claims: [] });
      if (url.includes("/api/dashboard")) return json({ summary: { ticketsByStatus: {} } });
      return json({});
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
async function loadApp(): Promise<void> {
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}-${Math.random()}`);
  for (let i = 0; i < 8; i++) await tick();
}

describe("web: the Match Day Work view", () => {
  beforeEach(() => {
    stubFetch();
    vi.resetModules();
    queue = { items: [] };
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("builds cards as articles with the title as the only link", async () => {
    board = {
      columns: columns({ ready: [card(1, "ready")], blocked: [card(2, "blocked")] }),
      closed: [],
      wontDo: [],
    };
    mountShell("#/work");
    await loadApp();
    const cards = [...document.querySelectorAll("#app .board-card")];
    expect(cards.length).toBe(2);
    for (const c of cards) {
      expect(c.tagName).toBe("ARTICLE");
      expect(c.querySelectorAll("a").length).toBe(1);
      // no control nested in the link
      expect(c.querySelector("a button, a a")).toBeNull();
    }
    const ready = document.querySelector('[data-column="ready"] .board-card')!;
    expect(ready.querySelector(".card-move-btn")?.textContent).toContain("Move");
    expect(ready.querySelector(".card-human-btn.take-myself")).not.toBeNull();
    expect(ready.querySelector(".ac-progress")?.textContent).toBe("AC 1/2");
  });

  it("shows the yellow card for what the human queue lists, not for every status", async () => {
    board = {
      columns: columns({ in_review: [card(3, "in_review")], blocked: [card(4, "blocked")] }),
      closed: [],
      wontDo: [],
    };
    queue = { items: [{ kind: "review", label: "Review sign-off", ticket: { id: "t-3" } }] };
    mountShell("#/work");
    await loadApp();
    const review = document.querySelector('[data-column="in_review"] .board-card')!;
    expect(review.classList.contains("needs")).toBe(true);
    expect(review.querySelector(".card-needs")?.getAttribute("aria-label")).toBe(
      "Needs you: Review sign-off",
    );
    // An in-review card opens its review.
    expect(review.querySelector(".card-link")?.getAttribute("href")).toBe("#/review/t-3");
    const blocked = document.querySelector('[data-column="blocked"] .board-card')!;
    expect(blocked.querySelector(".card-needs")).toBeNull();
  });

  it("filters by number or title in place and keeps the lane counts true", async () => {
    board = {
      columns: columns({
        ready: [card(10, "ready", { title: "Partial refunds" }), card(11, "ready")],
        done: [card(12, "done", { title: "Refund export" })],
      }),
      closed: [],
      wontDo: [],
    };
    mountShell("#/work");
    await loadApp();
    const input = document.querySelector<HTMLInputElement>("#app .work-q")!;
    input.value = "refund";
    input.dispatchEvent(new Event("input"));
    await new Promise((r) => setTimeout(r, 40));
    expect(document.querySelectorAll("#app .board-card").length).toBe(2);
    expect(document.querySelector('[data-column="ready"] .board-col-count')?.textContent).toBe("1");
    expect(location.hash).toBe("#/work?q=refund");
    input.value = "#11";
    input.dispatchEvent(new Event("input"));
    await new Promise((r) => setTimeout(r, 40));
    const nums = [...document.querySelectorAll("#app .board-card .num")].map((n) => n.textContent);
    expect(nums).toEqual(["#11"]);
  });

  it("lists every ticket as a league table, most urgent first", async () => {
    board = { columns: columns({}), closed: [], wontDo: [] };
    tickets = [
      card(5, "done"),
      card(2, "ready"),
      card(9, "blocked"),
      card(1, "in_review"),
      card(7, "blocked"),
    ];
    mountShell("#/work?mode=list");
    await loadApp();
    const nums = [...document.querySelectorAll("#app .wl-row .wl-num")].map((n) => n.textContent);
    expect(nums).toEqual(["#7", "#9", "#1", "#2", "#5"]);
    expect(document.querySelector("#app .wl-row .pdots")).not.toBeNull();
    expect(document.querySelector(".work-mode [aria-pressed='true']")?.textContent).toBe("List");
  });
});

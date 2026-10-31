// @vitest-environment jsdom
//
// Won't do is offered wherever the state machine allows it from the board and the
// ticket page: a Work card's Move menu carries "Won't do…" (ready -> cancelled is a
// legal move, but the card only offered lanes), and a ready or failed ticket's page
// has the Won't do button. Both open the one reason sheet and post /wont-do. A
// claimed card has no menu at all: an agent owns it. Found by the browser suites.

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
  updated_at: "2026-10-01T00:00:00Z",
  acTotal: 1,
  acSatisfied: 0,
  acEvidenced: 0,
  acEvidenceRequired: 0,
  repos: [],
  claim: null,
  humanOwner: null,
  lastReviewFeedback: null,
  blockingCount: 0,
  ...extra,
});
const columns = (by: Record<string, Card[]>) =>
  ["draft", "ready", "in_progress", "blocked", "in_review", "done"].map((column) => ({
    column,
    cards: by[column] || [],
  }));

type Call = { method: string; url: string; body: unknown };
let calls: Call[] = [];
let board: unknown;
let ticketStatus = "ready";

function json(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
function stubFetch(): void {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (method !== "GET") return json({ ok: true });
      if (url.includes("/api/board")) return json(board);
      if (url.includes("/api/human-queue")) return json({ items: [] });
      if (url.includes("/claimability"))
        return json({ ticketId: "t-4", ready: true, blockers: [], warnings: [] });
      if (url.includes("/work-repos"))
        return json({
          work_repos: { writeRepos: [], readOnlyRepos: [], testRepos: [], deniedRepos: [] },
        });
      if (url.includes("/repo-suggestions")) return json({ suggestions: [] });
      if (url.includes("/tickets/t-4"))
        return json({
          ticket: {
            ...card(4, ticketStatus),
            description: "",
            policy_pack: "solo_loose",
            attempt_count: 0,
            created_at: "2026-10-01T00:00:00Z",
          },
          acceptance_criteria: [],
          repositories: [],
          scopes: [],
          blocking_decisions: [],
          dependencies: [],
          evidence: [],
          events: [],
          rework_trail: [],
        });
      if (url.includes("/tickets")) return json({ tickets: [] });
      if (url.includes("/repositories")) return json({ repositories: [] });
      if (url.includes("/scope/nodes")) return json({ nodes: [] });
      if (url.includes("/claims")) return json({ claims: [] });
      if (url.includes("/api/runs")) return json({ active: [], recent: [] });
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
const posts = (part: string) => calls.filter((c) => c.method !== "GET" && c.url.includes(part));
const openSheet = () => document.querySelector(".sheet.open");

describe("web: Won't do is offered on Work cards and on a ready ticket", () => {
  beforeEach(() => {
    stubFetch();
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("a ready card's Move menu ends in Won't do…, which asks for a reason and posts /wont-do", async () => {
    board = {
      columns: columns({
        ready: [card(1, "ready")],
        in_progress: [card(2, "in_progress", { claim: { agentId: "a1" } })],
      }),
      closed: [],
      wontDo: [],
    };
    mountShell("#/work");
    await loadApp();
    const moveBtn = document.querySelector<HTMLButtonElement>(
      '[data-column="ready"] .board-card .card-move-btn',
    )!;
    expect(moveBtn).toBeTruthy();
    moveBtn.click();
    const items = [...document.querySelectorAll<HTMLButtonElement>(".movemenu .movemenu-item")];
    expect(items.map((b) => b.textContent)).toEqual(["Draft", "Won't do…"]);
    items[1]!.click();
    expect(document.querySelector(".movemenu")).toBeNull();
    expect(openSheet()?.querySelector("#sheet-title")?.textContent).toBe("Won't do #1");
    const input = openSheet()!.querySelector<HTMLTextAreaElement>(".reject-reason-input")!;
    input.value = "Covered by #9";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    openSheet()!.querySelector<HTMLButtonElement>(".reject-submit")!.click();
    for (let i = 0; i < 4; i++) await tick();
    expect(posts("/tickets/t-1/wont-do").map((c) => c.body)).toEqual([{ reason: "Covered by #9" }]);
    expect(posts("/move")).toHaveLength(0);
    // A claimed card offers no Move menu: an agent owns it.
    expect(
      document.querySelector('[data-column="in_progress"] .board-card .card-move-btn'),
    ).toBeNull();
  });

  it.each(["ready", "failed"])("a %s ticket's page offers Won't do", async (status) => {
    ticketStatus = status;
    mountShell("#/ticket/t-4");
    await loadApp();
    const btn = [...document.querySelectorAll<HTMLButtonElement>("#app button")].find(
      (b) => b.textContent?.trim() === "Won't do",
    );
    expect(btn, `Won't do on a ${status} ticket`).toBeDefined();
    btn!.click();
    expect(openSheet()?.querySelector("#sheet-title")?.textContent).toBe("Won't do #4");
  });
});

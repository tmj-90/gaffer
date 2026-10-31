// @vitest-environment jsdom
//
// The headline gives the work the lead (external UI review, fix 2).
//  - "#10 is blocked." made the reader look down to learn what #10 was. The scoreboard's
//    headline now leads with the ticket's title ("Webhook delivery … is blocked"), the
//    number kept as the muted reference after it.
//  - The same rule for every headline / scoreboard sentence that named a ticket by
//    number first: the first thing waiting, an approved-but-unmerged change, the squad's
//    tickets, the Fitness board's recurring injuries, the Review page's "moved on" card.
//  - On a phone "3 things need you" is said once (the Team Sheet keeps it): the
//    headline's count and the scoreboard's Need-you cell give way to what is not
//    already on screen.

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const WEB = path.resolve(process.cwd(), "src/api/web");
const APP_JS = path.join(WEB, "app.js");

const BLOCKED = {
  id: "tk-10",
  number: 10,
  title: "Webhook delivery for task events",
  status: "blocked",
  updated_at: "2026-10-30T10:00:00Z",
};
const REVIEW = {
  id: "tk-12",
  number: 12,
  title: "Export tasks to CSV",
  status: "in_review",
  updated_at: "2026-10-30T10:00:00Z",
};
const MERGE = {
  id: "tk-14",
  number: 14,
  title: "Retry queue with backoff",
  status: "ready_for_merge",
  updated_at: "2026-10-30T10:00:00Z",
};
const item = (kind: string, t: { id: string; number: number; title: string; status: string }) => ({
  kind,
  label: kind,
  reason: kind === "parked" ? "rework_exhausted" : "please look",
  ticket: t,
  decisionId: null,
  severity: null,
  since: new Date(Date.now() - 60_000).toISOString(),
  waitedMs: 60_000,
});

let queue: { items: unknown[]; counts: Record<string, number> } = {
  items: [],
  counts: { total: 0 },
};
let tickets: unknown[] = [];
let claims: unknown[] = [];

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = (obj: unknown) =>
        new Response(JSON.stringify(obj), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (url.includes("/api/human-queue")) return json(queue);
      if (url.includes("/api/dashboard"))
        return json({ summary: { ticketsByStatus: {}, activeClaims: claims.length } });
      if (url.includes("/api/runs")) return json({ active: [], recent: [] });
      if (url.includes("/api/activity")) return json({ events: [], total: 0 });
      if (url.includes("/api/board")) return json(null);
      if (url.includes("/claims")) return json({ claims });
      if (url.match(/\/tickets\/tk-\d+$/)) return json({ ticket: {}, rework_trail: [] });
      if (url.includes("/tickets")) return json({ tickets });
      if (url.includes("/decisions")) return json({ decisions: [] });
      return json({});
    }),
  );
}

function mount(): void {
  document.body.innerHTML = `
    <div id="toast" class="toast" role="alert" hidden></div>
    <div class="shell">
      <header id="appbar" class="appbar" hidden></header>
      <main id="app" class="app"><p class="loading">Loading…</p></main>
      <nav id="bottomnav" class="bottomnav" hidden></nav>
    </div>`;
  location.hash = "#/overview";
}
const tick = () => new Promise((r) => setTimeout(r, 0));
async function boot(): Promise<void> {
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}-${Math.random()}`);
  for (let i = 0; i < 10; i++) await tick();
}
const hl = () => document.querySelector(".scoreboard h1.hl") as HTMLElement;

describe("web overview: the headline leads with the work", () => {
  beforeEach(() => {
    vi.resetModules();
    stubFetch();
    mount();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
    queue = { items: [], counts: { total: 0 } };
    tickets = [];
    claims = [];
  });

  it("the reviewer's case: 'Webhook delivery … is blocked', #10 muted after the work", async () => {
    tickets = [BLOCKED, REVIEW, MERGE];
    queue = {
      items: [item("parked", BLOCKED), item("review", REVIEW), item("awaiting_merge", MERGE)],
      counts: { total: 3 },
    };
    await boot();
    const block = hl().querySelector(".hl-block") as HTMLElement;
    expect(block, "a headline clause for the blocked ticket").toBeTruthy();
    // The clause opens on the title, not the number.
    expect(block.textContent?.trim()).toMatch(/^Webhook delivery\b/);
    expect(block.textContent).toContain("is blocked");
    // No sentence of the headline opens on the number.
    expect(hl().textContent).not.toMatch(/(?:^|[.!]\s+)#10\b/);
    // The number is still there, as the muted reference after the title.
    const ref = block.querySelector(".hl-ref") as HTMLElement;
    expect(ref?.textContent).toBe("#10");
    const what = block.querySelector(".hl-what") as HTMLElement;
    expect(what.compareDocumentPosition(ref) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The full title stays on the clause.
    expect(block.getAttribute("title")).toBe("Webhook delivery for task events");
    // The sub line names the approved change by its work too.
    const sub = document.querySelector(".scoreboard .hl-sub")?.textContent || "";
    expect(sub).toContain("Retry queue with backoff #14 approved, not merged");
    expect(sub).not.toMatch(/(?:^|·\s*)#14\b/);
  });

  it("with nothing parked, the first change waiting leads, named by its work", async () => {
    tickets = [REVIEW];
    queue = { items: [item("review", REVIEW)], counts: { total: 1 } };
    await boot();
    const lead = hl().querySelector(".hl-block") as HTMLElement;
    expect(lead?.textContent).toBe("Export tasks to CSV #12 awaits your sign-off.");
    expect(lead.getAttribute("href")).toBe("#/review/tk-12");
  });

  it("the full title, never cut at a stop word: 'Add retry with backoff' stays whole", async () => {
    const t = { ...REVIEW, title: "Add retry with backoff" };
    tickets = [t];
    queue = { items: [item("review", t)], counts: { total: 1 } };
    await boot();
    const lead = hl().querySelector(".hl-block") as HTMLElement;
    expect(lead?.querySelector(".hl-what")?.textContent).toBe("Add retry with backoff");
    expect(lead?.textContent).toBe("Add retry with backoff #12 awaits your sign-off.");
  });

  it("a long title is cut by length only, at a word boundary, with an ellipsis", async () => {
    const t = {
      ...REVIEW,
      title: "Deliver webhooks for task events with retries and backoff to every subscriber",
    };
    tickets = [t];
    queue = { items: [item("review", t)], counts: { total: 1 } };
    await boot();
    const lead = hl().querySelector(".hl-block") as HTMLElement;
    const what = lead?.querySelector(".hl-what")?.textContent ?? "";
    expect(what.endsWith("…")).toBe(true);
    const shown = what.slice(0, -1);
    // A prefix of the title ending on a whole word, and longer than any stop-word cut.
    expect(t.title.startsWith(shown)).toBe(true);
    expect(t.title.charAt(shown.length)).toBe(" ");
    expect(shown).toContain("with retries");
    expect(lead.getAttribute("title")).toBe(t.title);
  });

  it("a trailing run id or date is reference, not the work", async () => {
    const t = { ...REVIEW, title: "Tech-debt hotspots: taskflow-mini (2026-10-31)" };
    tickets = [t];
    queue = { items: [item("review", t)], counts: { total: 1 } };
    await boot();
    const lead = hl().querySelector(".hl-block") as HTMLElement;
    expect(lead?.textContent).toBe("Tech-debt hotspots: taskflow-mini #12 awaits your sign-off.");
    expect(lead.getAttribute("title")).toBe(t.title);
  });

  it("nothing needs you: the squad's tickets are named by their work", async () => {
    claims = [
      {
        id: "c1",
        ticket_id: "tk-3",
        ticket_number: 3,
        ticket_title: "Webhook delivery for task events",
        agent_id: "a1",
      },
    ];
    await boot();
    expect(hl().textContent).toContain("Nothing needs you.");
    const sub = document.querySelector(".scoreboard .hl-sub")?.textContent || "";
    expect(sub).toContain("on Webhook delivery for task events #3");
  });

  it("on a phone the count is said once: the Team Sheet keeps it", async () => {
    tickets = [BLOCKED, REVIEW];
    queue = { items: [item("parked", BLOCKED), item("review", REVIEW)], counts: { total: 2 } };
    await boot();
    // The Team Sheet carries the count …
    expect(document.querySelector("#what-i-own .panel-aux")?.textContent).toBe("needs you · 2");
    // … and the other two spots are marked so the phone layout can drop them.
    expect(hl().querySelector(".hl-count")?.textContent).toBe("2 things need you.");
    const needsCell = document.querySelector(".scoreboard .sb-cells .kpi.sc-needs");
    expect(needsCell?.textContent).toContain("Need you");
    const css = readFileSync(path.join(WEB, "css/views/overview.css"), "utf8");
    const phone = css.slice(css.indexOf("@media (max-width: 760px)"));
    expect(phone).toMatch(/\.hl:has\(\.hl-block\) > \.hl-count \{\s*display: none;/);
    expect(phone).toMatch(/\.sb-cells \.kpi\.sc-needs \{\s*display: none;/);
    // The phone order is unchanged: the Team Sheet comes before the pitch.
    const sheet = document.getElementById("what-i-own") as HTMLElement;
    const pitch = document.querySelector(".tactics") as HTMLElement;
    expect(sheet.compareDocumentPosition(pitch) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

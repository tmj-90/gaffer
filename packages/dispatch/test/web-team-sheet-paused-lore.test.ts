// @vitest-environment jsdom
//
// The Team Sheet lists a paused delivery and the lore drafts awaiting approval
// (exploratory finding ui-explore/F-04), each with one action: a paused row's
// Continue… opens Continue / Stop, the lore row opens Memory, where each draft has
// its Approve and Reject.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

let posted: string[] = [];
function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? "GET") !== "GET") posted.push(`${init?.method} ${url}`);
      const json = (obj: unknown) =>
        new Response(JSON.stringify(obj), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (url.includes("/api/human-queue"))
        return json({
          items: [
            {
              kind: "paused",
              label: "Paused",
              reason: "The delivery hit the turn cap after 999 turns mid-way.",
              ticket: { id: "t-5", number: 5, title: "Capped one", status: "paused" },
              decisionId: null,
              severity: null,
              suggestedAction: "continue",
              since: new Date(Date.now() - 600_000).toISOString(),
              waitedMs: 600_000,
            },
            {
              kind: "lore_drafts",
              label: "Lore drafts",
              reason: "2 lore drafts await your approval in Memory.",
              ticket: null,
              decisionId: null,
              severity: null,
              loreDrafts: 2,
              since: new Date().toISOString(),
              waitedMs: 0,
            },
          ],
          counts: { total: 2, paused: 1, loreDrafts: 2 },
        });
      if (url.includes("/continue")) return json({ ticket_id: "t-5", resume_requested: true });
      if (url.includes("/api/dashboard"))
        return json({ summary: { ticketsByStatus: { paused: 1 }, deliveredToday: 0 } });
      if (url.includes("/api/runs")) return json({ active: [], recent: [] });
      if (url.includes("/api/activity")) return json({ events: [], total: 0 });
      if (url.includes("/tickets")) return json({ tickets: [] });
      if (url.includes("/decisions")) return json({ decisions: [] });
      if (url.includes("/claims")) return json({ claims: [] });
      return json({});
    }),
  );
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("web: the Team Sheet's paused and lore rows", () => {
  beforeEach(() => {
    vi.resetModules();
    posted = [];
    stubFetch();
    document.body.innerHTML = `
      <div id="toast" class="toast" role="alert" hidden></div>
      <div class="shell">
        <header id="appbar" class="appbar" hidden></header>
        <main id="app" class="app"><p class="loading">Loading…</p></main>
        <nav id="bottomnav" class="bottomnav" hidden></nav>
      </div>`;
    location.hash = "#/overview";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("a paused row offers Continue…, which continues it; the lore row opens Memory", async () => {
    await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}-${Math.random()}`);
    for (let i = 0; i < 12; i++) await tick();
    const paused = document.querySelector<HTMLElement>('#what-i-own .own-row[data-kind="paused"]')!;
    expect(paused.querySelector(".own-kind")?.textContent).toContain("Paused");
    expect(paused.querySelector(".own-title a")?.getAttribute("href")).toBe("#/ticket/t-5");
    const act = paused.querySelector<HTMLButtonElement>("button.own-act")!;
    expect(act.textContent).toBe("Continue…");
    act.click();
    await tick();
    const sheet = document.querySelector(".sheet.open")!;
    const buttons = [...sheet.querySelectorAll<HTMLButtonElement>(".act-actions button")].map(
      (b) => b.textContent,
    );
    expect(buttons).toEqual(["Continue", "Stop", "Cancel"]);
    sheet.querySelector<HTMLButtonElement>(".act-actions button")!.click();
    for (let i = 0; i < 6; i++) await tick();
    expect(posted).toEqual(["POST /tickets/t-5/continue"]);

    const lore = document.querySelector<HTMLElement>(
      '#what-i-own .own-row[data-kind="lore_drafts"]',
    )!;
    expect(lore.querySelector(".own-kind")?.textContent).toContain("Lore drafts");
    const open = lore.querySelector<HTMLAnchorElement>("a.own-act")!;
    expect(open.getAttribute("href")).toBe("#/memory");
    expect(open.getAttribute("aria-label")).toBe("Open Memory: 2 lore drafts to approve");
    expect(lore.querySelector(".own-age")).toBeNull();
  });
});

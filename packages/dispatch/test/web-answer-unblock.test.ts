// @vitest-environment jsdom
//
// Team Sheet, Answer…: the agent that asked parked its ticket (Blocked), and an
// answer does not move it back. After the answer the same sheet says so and offers
// "Unblock #N → Ready" (a human presses it; nothing moves on its own). While other
// decisions still hold the ticket it says that instead, and a ticket that is not
// blocked just gets the "Answered" toast. Found by the browser scenario suite S6.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

type Call = { method: string; url: string; body: unknown };
let calls: Call[] = [];
let ticketStatus = "blocked";
let stillWaiting: unknown[] = [];

const QUEUE = {
  items: [
    {
      kind: "decision",
      label: "Decision",
      reason: "Keep insertion order or sort?",
      ticket: { id: "tk-1", number: 12, title: "List tasks", status: "blocked" },
      decisionId: "dec-1",
      severity: "human_required",
      since: new Date(Date.now() - 60_000).toISOString(),
      waitedMs: 60_000,
    },
  ],
  counts: { total: 1, decisions: 1 },
};

function stubFetch(): void {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const json = (obj: unknown) =>
        new Response(JSON.stringify(obj), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (method !== "GET") return json({ ok: true });
      if (url.includes("/api/human-queue")) return json(QUEUE);
      if (url.includes("/api/runs")) return json({ active: [], recent: [] });
      if (url.includes("/api/dashboard")) return json({ summary: { ticketsByStatus: {} } });
      if (url.includes("/api/activity")) return json({ events: [], total: 0 });
      if (url.includes("/api/cost")) return json(null);
      if (url.includes("/api/rework/bouncing")) return json({ bouncing: [] });
      if (/\/tickets\/tk-1$/.test(url))
        return json({
          ticket: { id: "tk-1", number: 12, title: "List tasks", status: ticketStatus },
          blocking_decisions: stillWaiting,
        });
      if (url.includes("/tickets")) return json({ tickets: [] });
      if (url.includes("/decisions"))
        return json({
          decisions: [{ id: "dec-1", title: "Order", question: "Keep insertion order or sort?" }],
        });
      if (url.includes("/api/audit")) return json({ available: false, entries: [] });
      return json({});
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
  location.hash = "#/overview";
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}-${Math.random()}`);
  for (let i = 0; i < 8; i++) await tick();
}
const sheet = () => document.querySelector(".sheet.open");
const sheetButton = (text: string) =>
  [...(sheet()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
    (b) => b.textContent === text,
  );
async function answer(text: string): Promise<void> {
  document.querySelector<HTMLButtonElement>("#what-i-own button.own-act")!.click();
  const box = sheet()!.querySelector<HTMLTextAreaElement>("textarea[name=answer]")!;
  box.value = text;
  sheetButton("Answer")!.click();
  for (let i = 0; i < 6; i++) await tick();
}
const posts = (part: string) => calls.filter((c) => c.method === "POST" && c.url.includes(part));

describe("web: answering a decision on a parked ticket offers the Unblock", () => {
  beforeEach(() => {
    vi.resetModules();
    ticketStatus = "blocked";
    stillWaiting = [];
    stubFetch();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("offers 'Unblock #12 → Ready' in the same sheet, and moves it only when pressed", async () => {
    await boot();
    await answer("Keep insertion order");
    expect(posts("/decisions/dec-1/resolve")[0]!.body).toMatchObject({
      status: "accepted",
      answer: "Keep insertion order",
    });
    expect(sheet()?.querySelector("#sheet-title")?.textContent).toBe("Unblock #12?");
    expect(sheet()?.querySelector(".act-intro")?.textContent).toContain("is still Blocked");
    const go = sheetButton("Unblock #12 → Ready")!;
    expect(go).toBeTruthy();
    expect(document.activeElement).toBe(go);
    expect(posts("/move"), "nothing moves until the human presses it").toHaveLength(0);
    go.click();
    for (let i = 0; i < 4; i++) await tick();
    expect(posts("/tickets/tk-1/move").map((c) => c.body)).toEqual([{ to: "ready" }]);
    expect(sheet()).toBeNull();
    expect(document.getElementById("toast")?.textContent).toContain("Unblocked #12");
  });

  it("'Not now' closes it without moving the ticket", async () => {
    await boot();
    await answer("Sort them");
    sheetButton("Not now")!.click();
    expect(sheet()).toBeNull();
    expect(posts("/move")).toHaveLength(0);
  });

  it("says the ticket still waits on another decision instead of offering the Unblock", async () => {
    stillWaiting = [{ id: "dec-2" }];
    await boot();
    await answer("Keep insertion order");
    expect(sheet()?.querySelector("#sheet-title")?.textContent).toBe("#12 is still blocked");
    expect(sheet()?.querySelector(".act-intro")?.textContent).toContain("1 more decision");
    expect(sheetButton("Unblock #12 → Ready")).toBeUndefined();
  });

  it("a ticket that is not blocked just gets the Answered toast", async () => {
    ticketStatus = "ready";
    await boot();
    await answer("Keep insertion order");
    expect(sheet()).toBeNull();
    expect(document.getElementById("toast")?.textContent).toContain("Answered.");
  });
});

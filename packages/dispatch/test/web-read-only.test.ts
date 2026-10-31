// @vitest-environment jsdom
//
// A read token (GET /api/whoami capability "read") can look at everything and
// change nothing: the server refuses every write. So the dashboard does not offer
// one. One strip under the header says so; Settings' editors and Save, Poll for
// work, a card's Move and by-hand buttons, a ticket's actions and the Team Sheet's
// act buttons are switched off with a title that says why (the Squad page already
// hid its editors). A full token sees none of it. Found by the browser suite S13.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");
const TITLE = "Read-only access: this token can look, not change anything.";

let capability = "read";
const READY = {
  id: "t-1",
  number: 1,
  title: "Ticket 1",
  status: "ready",
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
};

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
      if (url.includes("/api/whoami"))
        return json({ capability, actor: { type: "human", id: "viewer" } });
      if (url.includes("/api/settings"))
        return json({
          settings: [
            {
              key: "MAX_TICKS",
              value: "20",
              envLocked: false,
              type: "int",
              group: "budget",
              label: "Max ticks (run)",
            },
          ],
        });
      if (url.includes("/api/board"))
        return json({
          columns: ["draft", "ready", "in_progress", "done"].map((column) => ({
            column,
            cards: column === "ready" ? [READY] : [],
          })),
          closed: [],
          wontDo: [],
        });
      if (url.includes("/api/human-queue"))
        return json({
          items: [
            {
              kind: "parked",
              label: "Parked",
              reason: "Rework exhausted",
              ticket: { id: "t-2", number: 2, title: "Parked one", status: "blocked" },
              decisionId: null,
              severity: null,
              since: new Date().toISOString(),
              waitedMs: 1000,
            },
          ],
          counts: { total: 1 },
        });
      if (/\/tickets\/t-1$/.test(url))
        return json({
          ticket: { ...READY, description: "", policy_pack: "solo_loose", attempt_count: 0 },
          acceptance_criteria: [],
          repositories: [],
          scopes: [],
          blocking_decisions: [],
          dependencies: [],
          evidence: [],
          events: [],
          rework_trail: [],
        });
      if (url.includes("/claimability"))
        return json({ ticketId: "t-1", ready: true, blockers: [], warnings: [] });
      if (url.includes("/work-repos"))
        return json({
          work_repos: { writeRepos: [], readOnlyRepos: [], testRepos: [], deniedRepos: [] },
        });
      if (url.includes("/repo-suggestions")) return json({ suggestions: [] });
      if (url.includes("/api/runs")) return json({ active: [], recent: [] });
      if (url.includes("/tickets")) return json({ tickets: [] });
      if (url.includes("/repositories")) return json({ repositories: [] });
      if (url.includes("/scope/nodes")) return json({ nodes: [] });
      if (url.includes("/claims")) return json({ claims: [] });
      if (url.includes("/decisions")) return json({ decisions: [] });
      if (url.includes("/api/dashboard")) return json({ summary: { ticketsByStatus: {} } });
      return json({});
    }),
  );
}
const tick = () => new Promise((r) => setTimeout(r, 0));
async function boot(hash: string): Promise<void> {
  document.body.innerHTML = `
    <div id="toast" class="toast" role="alert" hidden></div>
    <div class="shell">
      <header id="appbar" class="appbar" hidden></header>
      <main id="app" class="app"><p class="loading">Loading…</p></main>
      <nav id="bottomnav" class="bottomnav" hidden></nav>
    </div>`;
  location.hash = hash;
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}-${Math.random()}`);
  for (let i = 0; i < 12; i++) await tick();
}
const byText = (text: string, root: ParentNode = document) =>
  [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === text,
  );
const isOff = (b: HTMLButtonElement | undefined | null) =>
  Boolean(b && b.disabled && b.title === TITLE);

describe("web: a read token sees read-only controls", () => {
  beforeEach(() => {
    vi.resetModules();
    capability = "read";
    stubFetch();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("Settings: one strip says so; the editors and Save are off, the search still works", async () => {
    await boot("#/settings");
    const strip = document.getElementById("ro-strip")!;
    expect(strip.hidden).toBe(false);
    expect(strip.getAttribute("role")).toBe("status");
    expect(strip.textContent).toContain("Read-only access.");
    expect(document.querySelectorAll(".ro-strip")).toHaveLength(1);
    const save = [...document.querySelectorAll<HTMLButtonElement>("#app button")].find((b) =>
      b.textContent?.includes("Save changes"),
    );
    expect(isOff(save)).toBe(true);
    const editor = document.querySelector<HTMLInputElement>(
      '#app .setting-row input:not([type="search"])',
    );
    expect(editor?.disabled).toBe(true);
    const find = document.querySelector<HTMLInputElement>(".boot-index input");
    expect(find?.disabled).toBe(false);
  });

  it("Work: Poll for work, Move and the by-hand button are off, and a card does not drag", async () => {
    await boot("#/work");
    expect(isOff(byText("Poll for work"))).toBe(true);
    const card = document.querySelector<HTMLElement>('[data-column="ready"] .board-card')!;
    expect(isOff(card.querySelector<HTMLButtonElement>(".card-move-btn"))).toBe(true);
    expect(isOff(card.querySelector<HTMLButtonElement>(".card-human-btn"))).toBe(true);
    expect(card.getAttribute("draggable")).toBeNull();
  });

  it("a ticket's actions are off and Add a criterion is not offered", async () => {
    await boot("#/ticket/t-1");
    expect(isOff(byText("Won't do"))).toBe(true);
    expect(document.querySelector(".tk-add-ac")).toBeNull();
    expect(document.querySelector(".repo-panel")?.textContent).toContain("read-only access");
  });

  it("the Team Sheet's act button is off", async () => {
    await boot("#/overview");
    expect(isOff(document.querySelector<HTMLButtonElement>("#what-i-own button.own-act"))).toBe(
      true,
    );
  });

  it("a full token sees no strip and live controls", async () => {
    capability = "full";
    stubFetch();
    await boot("#/work");
    expect(document.getElementById("ro-strip")).toBeNull();
    expect(byText("Poll for work")?.disabled).toBe(false);
  });
});

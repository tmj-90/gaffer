// @vitest-environment jsdom
//
// A held or partly-landed approved ticket: "Your move" says what the hold says, and the
// hold's advice names an action the page offers (exploratory finding
// ui-workflows/F6). Before, every ready_for_merge ticket read "The merge runner has it.
// Merge now runs it again if it is held up" (also when nothing would land it), the
// moved-since-review hold said "Move it back to review" with no such action on the page,
// and Merge now on a held ticket toasted "Merge started".

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const HELD = {
  kind: "held",
  hold: "moved_since_review",
  label: "Held · moved since review",
  detail:
    "The branch moved since the review approved it; no landing path merges commits nobody reviewed. Moved: taskflow-mini.",
};
const PARTLY = {
  kind: "partly_landed",
  hold: null,
  label: "Approved · partly landed",
  detail:
    "notes-mini landed; taskflow-mini not yet landed (pending, still on the delivery branch). Nothing lands the rest on its own (the merge policy holds this approval now): Merge now lands the rest; a landed repo is never merged again, and the ticket is done when every repository has landed.",
};

function ticket(landing: unknown) {
  return {
    id: "tkt-2",
    number: 2,
    title: "Add archive helper",
    description: "d",
    status: "ready_for_merge",
    risk_level: "low",
    policy_pack: "solo_loose",
    priority: 0,
    attempt_count: 0,
    branch_name: "gaffer/ticket-2",
    pr_url: null,
    can_be_tested: 0,
    test_contract: null,
    delivery_budget_usd: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    landing_state: landing,
  };
}

const posts: Array<{ path: string; body: unknown }> = [];

function stubFetch(t: ReturnType<typeof ticket>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input).replace(/^https?:\/\/[^/]+/, "");
      const method = (init?.method ?? "GET").toUpperCase();
      let body: unknown;
      if (method === "POST") {
        posts.push({ path: url, body: init?.body ? JSON.parse(String(init.body)) : null });
        if (url.endsWith("/merge"))
          body = { ticket: t, merge: { triggered: true, pid: 1, runId: "r1" } };
        else body = { ticket_id: t.id, status: "in_review", event_id: "e9" };
      } else if (url.includes(`/tickets/${t.id}/diff`)) body = { ticketId: t.id, repos: [] };
      else if (url.includes(`/tickets/${t.id}/work-repos`))
        body = {
          writeRepos: [],
          readOnlyRepos: [],
          testRepos: [],
          deniedRepos: [],
          suggestedRepos: [],
          rejectedRepos: [],
        };
      else if (url.startsWith(`/tickets/${t.id}`))
        body = {
          ticket: t,
          acceptance_criteria: [],
          repositories: [],
          scopes: [],
          blocking_decisions: [],
          dependencies: [],
          evidence: [],
          events: [],
          rework_trail: [],
        };
      else body = { tickets: [t], runs: [], active: [], recent: [] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

function mountShell(id: string): void {
  document.body.innerHTML = `
    <div id="toast" class="toast" role="alert" hidden></div>
    <div class="shell">
      <header id="appbar" class="appbar" hidden></header>
      <main id="app" class="app"><p class="loading">Loading…</p></main>
      <nav id="bottomnav" class="bottomnav" hidden></nav>
    </div>`;
  location.hash = `#/ticket/${id}`;
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const ticks = async (n = 8) => {
  for (let i = 0; i < n; i++) await tick();
};
async function boot(): Promise<void> {
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
  await ticks();
}
const moveText = () => document.querySelector(".tk-move .tk-move-t")?.textContent ?? "";
const button = (label: string) =>
  [...document.querySelectorAll(".tk-move button")].find((b) => b.textContent === label) as
    HTMLButtonElement | undefined;

describe("web: a held or partly-landed ticket's Your move (exploratory finding ui-workflows/F6)", () => {
  beforeEach(() => {
    vi.resetModules();
    posts.length = 0;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("moved since review: the words match the hold and Back to review is on the page", async () => {
    const t = ticket(HELD);
    stubFetch(t);
    mountShell(t.id);
    await boot();
    expect(moveText()).not.toMatch(/merge runner has it/i);
    expect(moveText()).toMatch(/held/i);
    expect(moveText()).toContain("Back to review");
    const back = button("Back to review");
    expect(back).toBeTruthy();
    back!.click();
    await tick();
    const box = document.querySelector(".sheet.open textarea") as HTMLTextAreaElement;
    box.value = "taskflow-mini moved since review";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    (document.querySelector(".sheet.open form") as HTMLFormElement).requestSubmit();
    await ticks();
    const reopen = posts.find((p) => p.path === `/tickets/${t.id}/reopen-for-review`);
    expect(reopen).toBeTruthy();
    expect(reopen!.body).toMatchObject({
      reason: "taskflow-mini moved since review",
      cause: "moved_since_review",
    });
    expect(String((reopen!.body as { resolution?: string }).resolution)).not.toBe("");
  });

  it("Merge now on a held ticket says it is held, not 'Merge started'", async () => {
    const t = ticket(HELD);
    stubFetch(t);
    mountShell(t.id);
    await boot();
    button("Merge now")!.click();
    await ticks();
    const toast = document.getElementById("toast")?.textContent ?? "";
    expect(toast).not.toMatch(/Merge started/);
    expect(toast).toMatch(/held/i);
  });

  it("partly landed: the words say what landed and that Merge now lands the rest", async () => {
    const t = ticket(PARTLY);
    stubFetch(t);
    mountShell(t.id);
    await boot();
    expect(moveText()).not.toMatch(/merge runner has it/i);
    expect(moveText()).toMatch(/partly landed/i);
    expect(moveText()).toContain("Merge now lands the rest");
    expect(button("Back to review")).toBeUndefined();
  });

  it("waiting for Merge now: nothing claims the merge runner has it", async () => {
    const t = ticket({
      kind: "waiting_for_merge",
      hold: null,
      label: "Approved · waiting for Merge now",
      detail: "Auto-merge on approval is off: it lands when someone presses Merge now.",
    });
    stubFetch(t);
    mountShell(t.id);
    await boot();
    expect(moveText()).not.toMatch(/merge runner has it/i);
    expect(moveText()).toMatch(/Merge now/);
  });
});

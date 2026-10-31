// @vitest-environment jsdom
//
// Match Day: every reason is collected in the club's reason sheet, never in a
// native window.prompt, and the sheet behaves like a dialog.
//  - Won't do / Send back to rework / Stop / Reject repo on the ticket page open the
//    sheet; it names the ticket and confirms with the verb that opened it.
//  - Esc gives focus back to the button that opened it.
//  - A route change closes it: a Send back written for #6 must never stay over the
//    next page, where confirming would act on a ticket the reader has left.
//  - The boundary's "Add a repo…" offers only repos not already on the boundary, so
//    it cannot silently turn a confirmed write into a read; taking the only write
//    repo off write asks first.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const T = {
  id: "tkt-6",
  number: 6,
  title: "Skip the charge when the saved card has expired",
  description: "",
  status: "blocked",
  risk_level: "medium",
  policy_pack: "team_light",
  priority: 5,
  attempt_count: 0,
  branch_name: "gaffer/ticket-6",
  pr_url: null,
  can_be_tested: 0,
  test_contract: null,
  delivery_budget_usd: null,
  created_at: "2026-10-27T10:30:00Z",
  updated_at: "2026-10-29T11:48:00Z",
};

type Call = { method: string; url: string; body: unknown };
let calls: Call[] = [];
function stubFetch(status = "blocked"): void {
  const ticket = { ...T, status };
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      let body: unknown;
      if (method !== "GET") body = { ok: true, ticket };
      else if (url.includes("/claimability"))
        body = { ticketId: ticket.id, ready: true, blockers: [], warnings: [] };
      else if (url.includes("/work-repos"))
        body = {
          work_repos: {
            writeRepos: [{ id: "r1", name: "billing-api", access: "write", relation: "confirmed" }],
            readOnlyRepos: [],
            testRepos: [],
            deniedRepos: [],
          },
        };
      else if (url.includes("/repo-suggestions")) body = { suggestions: [] };
      else if (url.includes("/repositories"))
        body = {
          repositories: [
            { id: "r1", name: "billing-api" },
            { id: "r2", name: "web-storefront" },
          ],
        };
      else if (url.includes("/api/runs")) body = { active: [], recent: [] };
      else if (url.includes(`/tickets/${ticket.id}`))
        body = {
          ticket,
          acceptance_criteria: [],
          repositories: [],
          scopes: [],
          blocking_decisions: [],
          dependencies: [],
          evidence: [],
          events: [],
          rework_trail: [],
        };
      else if (url.includes("/agents")) body = { agents: [] };
      else body = { tickets: [ticket] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}
function mount(hash: string): void {
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
async function boot(): Promise<void> {
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
  for (let i = 0; i < 8; i++) await tick();
}
const button = (text: string, root: ParentNode = document) =>
  Array.from(root.querySelectorAll("button")).find((b) => b.textContent?.trim() === text) as
    HTMLButtonElement | undefined;
const openSheet = () => document.querySelector(".sheet.open");
const posts = (part: string) => calls.filter((c) => c.method !== "GET" && c.url.includes(part));

describe("web: reasons are asked in the club's sheet, not window.prompt", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal(
      "prompt",
      vi.fn(() => {
        throw new Error("window.prompt must not be used");
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("Won't do on a blocked ticket opens a sheet that names #6 and needs a reason", async () => {
    stubFetch("blocked");
    mount(`#/ticket/${T.id}`);
    await boot();
    const trigger = button("Won't do");
    expect(trigger, "Won't do is offered on a blocked ticket").toBeDefined();
    trigger!.focus();
    trigger!.click();
    expect(openSheet()?.querySelector("#sheet-title")?.textContent).toBe("Won't do #6");
    expect(openSheet()?.querySelector(".rs-ticket")?.textContent).toContain(T.title);
    const submit = openSheet()!.querySelector<HTMLButtonElement>(".reject-submit")!;
    expect(submit.textContent).toBe("Won't do");
    expect(submit.getAttribute("aria-disabled"), "held until there is a reason").toBe("true");
    submit.click();
    await tick();
    expect(posts("/wont-do"), "an empty reason sends nothing").toHaveLength(0);
    expect(openSheet()?.querySelector(".act-hint.is-error")?.textContent).toContain(
      "Write a reason first",
    );
    // Focus starts in the reason box.
    expect(document.activeElement?.classList.contains("reject-reason-input")).toBe(true);

    const input = openSheet()!.querySelector<HTMLTextAreaElement>(".reject-reason-input")!;
    input.value = "Covered by #9";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    submit.click();
    for (let i = 0; i < 4; i++) await tick();
    const sent = posts("/wont-do");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toEqual({ reason: "Covered by #9" });
    expect(openSheet()).toBeNull();
  });

  it("Esc closes the sheet and gives focus back to the button that opened it", async () => {
    stubFetch("blocked");
    mount(`#/ticket/${T.id}`);
    await boot();
    const trigger = button("Won't do")!;
    trigger.focus();
    trigger.click();
    expect(openSheet()).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(openSheet()).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(posts("/wont-do")).toHaveLength(0);
  });

  it("a route change closes an open reason sheet, so it never acts on the page you left", async () => {
    stubFetch("blocked");
    mount(`#/ticket/${T.id}`);
    await boot();
    button("Won't do")!.click();
    expect(openSheet()).not.toBeNull();
    location.hash = "#/specs";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await tick();
    expect(openSheet(), "the #6 sheet must not survive the navigation").toBeNull();
    expect(posts("/wont-do")).toHaveLength(0);
  });

  it("Stop on a paused delivery asks in the sheet; the reason is optional", async () => {
    stubFetch("paused");
    mount(`#/ticket/${T.id}`);
    await boot();
    button("Stop")!.click();
    expect(openSheet()?.querySelector("#sheet-title")?.textContent).toBe("Stop #6");
    // It says what actually happens: cancelled now, the worktree reaped next tick.
    expect(button("Stop")!.title).toContain("its worktree is removed on the next tick");
    expect(button("Stop")!.title).not.toMatch(/tear/i);
    expect(openSheet()!.querySelector(".act-intro")?.textContent).toContain(
      "Its worktree is removed on the next tick.",
    );
    const submit = openSheet()!.querySelector<HTMLButtonElement>(".reject-submit")!;
    expect(submit.getAttribute("aria-disabled")).toBeNull();
    submit.click();
    for (let i = 0; i < 4; i++) await tick();
    expect(posts("/stop")).toHaveLength(1);
    expect(posts("/stop")[0]!.body).toEqual({});
    expect(document.getElementById("toast")?.textContent).toContain(
      "its worktree is removed on the next tick",
    );
  });

  it("Add a repo offers only repos not already on the boundary", async () => {
    stubFetch("ready");
    mount(`#/ticket/${T.id}`);
    await boot();
    const form = document.querySelector(".repo-panel .add-repo-form")!;
    const options = Array.from(form.querySelectorAll("select")[0]!.querySelectorAll("option")).map(
      (o) => o.textContent,
    );
    // billing-api is already the write repo: offering it here would re-set its access.
    expect(options).not.toContain("billing-api");
    expect(options).toContain("web-storefront");
  });

  it("taking the only write repo off write asks first, and Keep write changes nothing", async () => {
    stubFetch("ready");
    mount(`#/ticket/${T.id}`);
    await boot();
    const sel = document.querySelector<HTMLSelectElement>(".repo-panel select.access-select")!;
    sel.value = "read";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    await tick();
    expect(posts("/repo-access"), "no silent downgrade").toHaveLength(0);
    expect(sel.value, "the select shows the access the ticket still has").toBe("write");
    expect(openSheet()?.querySelector("#sheet-title")?.textContent).toBe(
      "Take billing-api off write?",
    );
    button("Keep write", openSheet()!)!.click();
    await tick();
    expect(posts("/repo-access")).toHaveLength(0);

    sel.value = "read";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    button("Set to read", openSheet()!)!.click();
    for (let i = 0; i < 4; i++) await tick();
    expect(posts("/repo-access")).toHaveLength(1);
    expect(posts("/repo-access")[0]!.body).toMatchObject({ repo_id: "r1", access: "read" });
  });

  it("Reject on a boundary repo asks for the reason in the sheet", async () => {
    stubFetch("ready");
    mount(`#/ticket/${T.id}`);
    await boot();
    button("Reject", document.querySelector(".repo-panel")!)!.click();
    expect(openSheet()?.querySelector("#sheet-title")?.textContent).toBe("Reject billing-api");
    const input = openSheet()!.querySelector<HTMLTextAreaElement>(".reject-reason-input")!;
    input.value = "This change does not touch it";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    openSheet()!.querySelector<HTMLButtonElement>(".reject-submit")!.click();
    for (let i = 0; i < 4; i++) await tick();
    expect(posts("/repo-access")[0]!.body).toMatchObject({
      repo_id: "r1",
      access: "none",
      relation: "rejected",
      reasons: ["This change does not touch it"],
    });
  });
});

// @vitest-environment jsdom
//
// Match Day: the season (Epics) and the Plan-a-build page (#/create).
//  - The acceptance ticket is always the Final, even when its dependency depth
//    would put it in an earlier round; a held campaign says so with the one action.
//  - #/create hosts the same Plan-a-build panel inline (not a modal), beside the
//    one-ticket form, and gives it back to its sheet when the operator leaves.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const EPIC = {
  id: "epic-1",
  type: "epic",
  name: "Repeat orders",
  description: "Repeat a past order.",
};
const T = (n: number, status: string, extra: Record<string, unknown> = {}) => ({
  id: `t-${n}`,
  number: n,
  title: extra.title ?? `Ticket ${n}`,
  status,
  updated_at: "2026-10-29T10:00:00.000Z",
  ...extra,
});
const TICKETS = [
  T(1, "done"),
  T(2, "blocked", { title: "Charge the saved card" }),
  T(3, "draft", { title: "Acceptance: Repeat orders", acceptance: 1 }),
  // Two ready tickets: #4 waits on the held #2, #5 waits on nothing.
  T(4, "ready", { title: "Reserve stock" }),
  T(5, "ready", { title: "Remind the shopper" }),
];
const DEPS: Record<string, { depends_on_ticket_id: string; number: number; satisfied: boolean }[]> =
  {
    "t-2": [{ depends_on_ticket_id: "t-1", number: 1, satisfied: true }],
    // Depth 1, the same round as #2 — but it is the acceptance ticket, so it is the Final.
    "t-3": [{ depends_on_ticket_id: "t-1", number: 1, satisfied: true }],
    "t-4": [{ depends_on_ticket_id: "t-2", number: 2, satisfied: false }],
  };

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      const m = url.match(/\/tickets\/(t-\d+)$/);
      if (m) {
        const t = TICKETS.find((x) => x.id === m[1])!;
        return json({
          ticket: t,
          scopes: [EPIC],
          dependencies: DEPS[t.id] || [],
          repositories: [{ name: "billing-api", access: "write" }],
          rework_trail: [],
          events: [],
        });
      }
      if (url.includes("/scope/nodes")) return json({ nodes: [EPIC] });
      if (url.includes("/tickets")) return json({ tickets: TICKETS });
      if (url.includes("/repositories")) return json({ repositories: [] });
      if (url.includes("/plan-sessions")) return json({ session: null });
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
async function settle(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) await tick();
}

describe("web: Match Day season and Plan-a-build page", () => {
  beforeEach(() => {
    stubFetch();
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("pins the acceptance ticket to the Final and names the hold with its action", async () => {
    mountShell("#/epics");
    await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
    await settle();

    const final = document.querySelector(".ep-round.is-final");
    expect(final).not.toBeNull();
    expect(final!.querySelector(".ep-round-name")?.textContent).toBe("Final");
    expect(final!.querySelector(".dag-node")?.textContent).toContain("#3");
    // #2 holds the campaign: a red card in the block, and Unblock on the page.
    expect(document.querySelector(".epic-card .ep-flag")?.textContent).toContain("Held");
    const unblock = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent === "Unblock #2…",
    );
    expect(unblock).toBeTruthy();
    // One ticket card per ticket (the phone layout no longer duplicates them).
    expect(document.querySelectorAll(".dag-node").length).toBe(5);
    // Next fixture: only a ready ticket whose dependencies are all done. #4 is
    // ready but waits on the held #2, so naming it would contradict its own card.
    const next = document.querySelector(".epic-next")?.textContent || "";
    expect(next).toContain("#5 Remind the shopper");
    expect(next).not.toContain("#4");
  });

  it("hosts Plan a build inline on #/create and hands it back to the sheet on leaving", async () => {
    mountShell("#/create");
    await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
    await settle();

    const panel = document.querySelector(".cr-plan .pb-panel") as HTMLElement | null;
    expect(panel).not.toBeNull();
    expect(panel!.classList.contains("pb-inline")).toBe(true);
    expect(panel!.getAttribute("role")).toBe("region");
    expect(panel!.hasAttribute("aria-modal")).toBe(false);
    expect((panel!.querySelector('button[aria-label="Close"]') as HTMLElement).hidden).toBe(true);
    // The one-ticket form sits beside it, with the regression's hooks.
    expect(
      document.querySelector('#one-ticket input[placeholder="Short, action-oriented title"]'),
    ).not.toBeNull();

    location.hash = "#/epics";
    await settle();
    // The page hands the SAME panel element back to its scrim. An earlier test's
    // module instance may still own a scrim of its own (it keeps its window
    // listeners), so follow the element, not "the last scrim in the document".
    const back = panel!;
    expect(back.closest(".pb-scrim")).not.toBeNull();
    expect(back.getAttribute("role")).toBe("dialog");
    expect(back.classList.contains("pb-inline")).toBe(false);

    // And the season's Plan a build opens it as the sheet again.
    const trigger = Array.from(document.querySelectorAll(".view-head button")).find((b) =>
      (b.textContent || "").includes("Plan a build"),
    ) as HTMLButtonElement;
    trigger.click();
    await tick();
    expect(back.closest(".pb-scrim")!.classList.contains("open")).toBe(true);
  });
});

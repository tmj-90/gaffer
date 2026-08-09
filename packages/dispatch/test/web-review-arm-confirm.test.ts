// @vitest-environment jsdom
//
// DOM test for the review-gate ARM/CONFIRM approve + visible-cursor-on-load UX.
//
// The review queue binds a global keydown handler (j/k move, a approve, r
// reject). Previously a SINGLE `a` approved+merged the focused card — but on
// view load no card visibly carried the cursor, so the operator could approve an
// "invisible" selection with one mis-keyed press. The fix:
//   1. on load, exactly one card visibly carries the cursor highlight
//      (`.card-accent`) before any key is pressed;
//   2. the first `a` only ARMS the focused card (a visible `.card-armed` confirm
//      state, no approve POST); a second `a` within the window approves;
//   3. arming is cancelled by Escape, by moving the cursor (j/k), or by the
//      window elapsing.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const TICKETS = [
  {
    id: "tkt-1",
    number: 7,
    title: "Ship the thing",
    status: "in_review",
    risk_level: "low",
    branch_name: "feat/x",
    pr_url: null,
  },
  {
    id: "tkt-2",
    number: 8,
    title: "Ship the other thing",
    status: "in_review",
    risk_level: "low",
    branch_name: "feat/y",
    pr_url: null,
  },
];

type Call = { method: string; url: string };
let calls: Call[] = [];

/** Stub the Review endpoints. Every ticket diff loads with a REAL, non-empty
 *  change so the approve path is genuinely approvable (otherwise the fail-closed
 *  guard would mask the arm/confirm behaviour). */
function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      calls.push({ method, url });
      let payload: unknown = {};
      if (url.includes("/tickets/") && url.endsWith("/diff")) {
        const id = url.includes("tkt-2") ? "tkt-2" : "tkt-1";
        payload = {
          ticketId: id,
          repos: [
            {
              repo: "svc",
              branch: "feat/x",
              baseBranch: "main",
              diff: "diff --git a/x b/x\n--- a/x\n+++ b/x\n+real change\n",
              files: 1,
              additions: 1,
              deletions: 0,
              truncated: false,
            },
          ],
        };
      } else if (url.includes("/review/approve")) payload = { ok: true };
      else if (url.includes("/review/reject")) payload = { ok: true };
      else if (url.match(/\/tickets\/tkt-\d$/)) {
        const id = url.includes("tkt-2") ? "tkt-2" : "tkt-1";
        const t = TICKETS.find((x) => x.id === id);
        payload = { ...t, acceptance_criteria: [], evidence: [], events: [] };
      } else if (url.includes("/tickets")) payload = { tickets: TICKETS };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

function mountShell(): void {
  document.body.innerHTML = `
    <div id="toast" class="toast" role="alert" hidden></div>
    <div class="shell">
      <header id="appbar" class="appbar" hidden></header>
      <main id="app" class="app"><p class="loading">Loading…</p></main>
      <nav id="bottomnav" class="bottomnav" hidden></nav>
    </div>`;
  location.hash = "#/review";
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tick = () => wait(0);

async function bootReview(): Promise<void> {
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
  await tick();
  await tick();
  await tick();
}

function pressKey(key: string): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

function approveCalls(): Call[] {
  return calls.filter((c) => c.method === "POST" && c.url.includes("/review/approve"));
}
function cards(): HTMLElement[] {
  // Review cards carry data-review-idx; other panels also use `.card`.
  return Array.from(document.querySelectorAll(".card[data-review-idx]")) as HTMLElement[];
}

describe("web review gate: visible cursor on load + arm/confirm approve", () => {
  beforeEach(() => {
    calls = [];
    mountShell();
    vi.resetModules();
    stubFetch();
  });
  afterEach(async () => {
    document.getElementById("app")?.replaceChildren();
    await tick();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("on load, exactly one card visibly carries the cursor highlight before any key", async () => {
    await bootReview();
    const accented = document.querySelectorAll(".card-accent");
    expect(accented, "exactly one card carries .card-accent on load").toHaveLength(1);
    expect(accented[0]).toBe(cards()[0]);
    // Nothing is armed until `a` is pressed.
    expect(document.querySelector(".card-armed")).toBeNull();
  });

  it("a single `a` ARMS the focused card (visible state, no approve POST)", async () => {
    await bootReview();
    pressKey("a");
    await tick();
    expect(approveCalls(), "a single `a` must not approve").toHaveLength(0);
    const armed = document.querySelectorAll(".card-armed");
    expect(armed, "the focused card is armed").toHaveLength(1);
    expect(armed[0]).toBe(cards()[0]);
  });

  it("a second `a` within the window approves the armed card", async () => {
    await bootReview();
    pressKey("a"); // arm
    await tick();
    pressKey("a"); // confirm
    await tick();
    const approved = approveCalls();
    expect(approved, "second `a` approves").toHaveLength(1);
    expect(approved[0]!.url).toContain("/tickets/tkt-1/review/approve");
  });

  it("Escape cancels the arm (a following `a` only re-arms, no approve)", async () => {
    await bootReview();
    pressKey("a"); // arm
    await tick();
    pressKey("Escape"); // cancel
    expect(document.querySelector(".card-armed"), "Escape disarms").toBeNull();
    pressKey("a"); // arms again, does NOT approve
    await tick();
    expect(approveCalls(), "after Escape, `a` re-arms not approves").toHaveLength(0);
    expect(document.querySelector(".card-armed")).not.toBeNull();
  });

  it("moving the cursor with j cancels the arm", async () => {
    await bootReview();
    pressKey("a"); // arm card 0
    await tick();
    expect(document.querySelector(".card-armed")).not.toBeNull();
    pressKey("j"); // move cursor → disarm
    expect(document.querySelector(".card-armed"), "j cancels the arm").toBeNull();
    pressKey("a"); // arms the NEW focused card, does not approve
    await tick();
    expect(approveCalls(), "after j, `a` re-arms not approves").toHaveLength(0);
  });

  it("the arm window elapsing cancels the arm", async () => {
    await bootReview();
    pressKey("a"); // arm
    await tick();
    expect(document.querySelector(".card-armed")).not.toBeNull();
    await wait(3100); // window (3000ms) elapses
    expect(document.querySelector(".card-armed"), "timeout disarms").toBeNull();
    pressKey("a"); // arms again, does not approve
    await tick();
    expect(approveCalls(), "after timeout, `a` re-arms not approves").toHaveLength(0);
  }, 6000);
});

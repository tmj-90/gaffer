// @vitest-environment jsdom
//
// DOM regression test for the review-gate MODAL KEY GUARD (hard-gate bug).
//
// The review surface binds a GLOBAL keydown handler for its queue shortcuts
// (j/k move, a approve+merge, r reject). The reject-reason dialog, however, is
// appended to `document.body` — NOT the app/view container the review
// MutationObserver watches — so that global handler never detaches while a
// reject is in flight. Its only bail list was INPUT/TEXTAREA/SELECT, so once
// focus moved to a reject-reason CHIP (a <button>), pressing `a` fired
// approve()+merge on `cards[cursor]` — potentially a DIFFERENT ticket than the
// one being rejected. That is a reject-to-approve path through the exact human
// gate this product exists to protect.
//
// The fix makes the gate handler bail whenever ANY modal is open (single
// `isModalOpen()` source of truth — reject dialog, command palette, detail
// sheet, move-menu). This test asserts:
//   1. with the reject dialog open + a chip focused, `a` and `r` fire ZERO
//      approve/reject POSTs (the reject flow stays the only reachable action);
//   2. NEGATIVE CONTROL: with no modal open, `a` still approves as designed.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const TICKET = {
  id: "tkt-1",
  number: 7,
  title: "Ship the thing",
  status: "in_review",
  risk_level: "low",
  branch_name: "feat/x",
  pr_url: null,
};

type Call = { method: string; url: string; body: unknown };
let calls: Call[] = [];

/** Stub the Review endpoints and record every call so a test can assert which
 *  mutating endpoints (approve / reject) were hit. The diff loads with a REAL,
 *  non-empty change so the Approve path is genuinely approvable (otherwise the
 *  approve guard would fail-closed and mask the modal-guard behaviour). */
function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      let payload: unknown = {};
      if (url.includes("/tickets/") && url.endsWith("/diff"))
        payload = {
          ticketId: TICKET.id,
          repos: [
            {
              repo: "svc",
              branch: "feat/x",
              baseBranch: "main",
              diff: "diff --git a/x b/x\n+real change\n",
              files: 1,
              additions: 1,
              deletions: 0,
              truncated: false,
            },
          ],
        };
      else if (url.includes(`/tickets/${TICKET.id}/review/approve`)) payload = { ok: true };
      else if (url.includes(`/tickets/${TICKET.id}/review/reject`)) payload = { ok: true };
      else if (url.includes(`/tickets/${TICKET.id}`))
        payload = { ...TICKET, acceptance_criteria: [], evidence: [], events: [] };
      else if (url.includes("/tickets")) payload = { tickets: [TICKET] };
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

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Boot the SPA fresh and let the async Review render + diff load settle. */
async function bootReview(): Promise<void> {
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
  await tick(); // router() → renderReview() (fetches tickets + details)
  await tick(); // the async diff load resolves + applyDiffState fires
  await tick();
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === text,
  ) as HTMLButtonElement | undefined;
}

function pressKey(key: string): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

function approveCalls(): Call[] {
  return calls.filter((c) => c.method === "POST" && c.url.includes("/review/approve"));
}
function rejectCalls(): Call[] {
  return calls.filter((c) => c.method === "POST" && c.url.includes("/review/reject"));
}

describe("web review gate: global j/k/a/r shortcuts are suppressed while a modal is open", () => {
  beforeEach(() => {
    calls = [];
    mountShell();
    vi.resetModules();
    stubFetch();
  });
  afterEach(async () => {
    // Emptying the #app container (rather than wiping <body> wholesale) mutates
    // the container the review MutationObserver watches, so its global keydown
    // handler detaches — otherwise a prior test's handler leaks onto `document`
    // and double-fires the next test's shortcuts. Flush a tick for the observer.
    document.getElementById("app")?.replaceChildren();
    await tick();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
    document.querySelectorAll(".reject-scrim, .palette-scrim, .sheet-scrim").forEach((n) =>
      n.remove(),
    );
  });

  it("HARD GATE: `a`/`r` on a focused reject-reason chip fire NO approve/reject POST", async () => {
    await bootReview();

    // Open the reject dialog and move focus onto a preset reason chip (a <button>,
    // which the old INPUT/TEXTAREA/SELECT-only bail list did NOT cover).
    buttonByText("Send back to rework")!.click();
    const chip = document.querySelector(".reject-chip") as HTMLButtonElement | null;
    expect(chip, "the reject dialog should render preset reason chips").not.toBeNull();
    chip!.focus();
    expect(document.activeElement, "focus should be on the chip button").toBe(chip);

    // The gate shortcuts must be inert: `a` must NOT approve+merge the queued
    // ticket, and `r` must NOT stack a second reject.
    pressKey("a");
    pressKey("r");
    await tick();

    expect(approveCalls(), "`a` must not approve/merge while the reject dialog is open").toHaveLength(
      0,
    );
    // No reject POST either — the reason was never confirmed, so the reject flow
    // stays the ONLY reachable action (dialog still open, exactly one instance).
    expect(rejectCalls()).toHaveLength(0);
    expect(document.querySelectorAll(".reject-dialog"), "`r` must not open a second dialog").toHaveLength(
      1,
    );
  });

  it("NEGATIVE CONTROL: with no modal open, `a` approves+merges the queued ticket as designed", async () => {
    await bootReview();

    // No dialog open, focus on <body> — the gate shortcut should work.
    expect(document.querySelector(".reject-scrim")).toBeNull();
    pressKey("a");
    await tick();

    const approved = approveCalls();
    expect(approved, "`a` should approve the queued ticket when no modal is open").toHaveLength(1);
    expect(approved[0].url).toContain(`/tickets/${TICKET.id}/review/approve`);
  });
});

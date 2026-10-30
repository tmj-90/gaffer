// @vitest-environment jsdom
//
// router-stale-render-race (dashboard-logic audit): a slow view's render must
// never land under the URL the operator has since moved to. Before the fix,
// router() mounted whatever render resolved last, so a slow Review under the
// Specs URL showed live Approve buttons, and its document-level j/k/a/r handler
// stayed attached to a queue that was not on screen.
//
// Proof: /tickets?status=in_review resolves only after the Specs view has
// rendered. #app must keep the Specs content, and pressing `r` must not open the
// (hidden) Review card's reject dialog.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

let releaseReview: (() => void) | null = null;
const posts: string[] = [];

function json(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init && init.method && init.method !== "GET") posts.push(`${init.method} ${url}`);
      if (url.includes("/tickets?status=in_review")) {
        // Hold the review queue until the test releases it (after Specs rendered).
        await new Promise<void>((resolve) => {
          releaseReview = resolve;
        });
        return json({
          tickets: [
            {
              id: "rv-1",
              number: 41,
              title: "Slow review ticket",
              status: "in_review",
              risk_level: "low",
              updated_at: "2026-10-30T10:00:00Z",
            },
          ],
        });
      }
      if (url.includes("/tickets/rv-1/diff")) return json({ repos: [] });
      if (url.includes("/tickets/rv-1"))
        return json({ ticket: { id: "rv-1" }, acceptance_criteria: [], evidence: [], events: [] });
      if (url.includes("/specs")) return json({ specs: [] });
      if (url.includes("/api/dashboard")) return json({ summary: { ticketsByStatus: {} } });
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
async function settle(n = 6): Promise<void> {
  for (let i = 0; i < n; i++) await tick();
}

describe("web: router discards a superseded render", () => {
  beforeEach(() => {
    posts.length = 0;
    releaseReview = null;
    stubFetch();
    mountShell("#/review");
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("keeps the Specs view when a slower Review render resolves after it", async () => {
    await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}-${Math.random()}`);
    await settle();
    // The operator moves on before the review queue answers.
    location.hash = "#/specs";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await settle();
    expect(document.getElementById("app")!.textContent).toContain("No specs yet");

    // Now the slow Review render resolves…
    expect(releaseReview).not.toBeNull();
    releaseReview!();
    await settle(12);

    const appText = document.getElementById("app")!.textContent || "";
    // …and is discarded: the URL says Specs, so #app shows Specs.
    expect(appText).toContain("No specs yet");
    expect(appText).not.toContain("Slow review ticket");
    expect(document.querySelector("#app [data-review-idx]")).toBeNull();

    // The discarded queue's keyboard handler is gone: `r` opens no reject dialog.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true }));
    await settle();
    expect(document.querySelector(".reject-scrim, .reject-dialog")).toBeNull();
    expect(posts).toEqual([]);
  });
});

// @vitest-environment jsdom
//
// REWORK LOOP DOM test: the board card surfaces the rework state so a human never
// wonders "what happened to this ticket?".
//   • a ticket being reworked in place (in_progress, code=reworking) shows
//     "Reworking · attempt N/M" + the latest failure — it never looks "gone";
//   • a ticket parked after the loop exhausted (blocked, code=rework_exhausted)
//     shows "Rework exhausted" + the reason on the VISIBLE blocked column.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

// A card mid-rework: still in the in_progress column, surfacing the attempt.
const REWORKING_CARD = {
  id: "tkt-rw",
  number: 88,
  title: "Deliver the widget",
  status: "in_progress",
  priority: 0,
  risk_level: "medium",
  updated_at: "2026-01-02T00:00:00Z",
  acTotal: 2,
  acSatisfied: 1,
  acEvidenced: 0,
  acEvidenceRequired: 0,
  blockingCount: 0,
  claim: null,
  lastReviewFeedback: {
    reason: "tests: expected 3 to be 4",
    reviewer: "system",
    at: "2026-01-02T00:00:00Z",
    code: "reworking",
    attempt: 2,
    maxAttempts: 3,
  },
};

// A card parked after the rework loop exhausted: VISIBLE in the blocked column.
const EXHAUSTED_CARD = {
  id: "tkt-ex",
  number: 89,
  title: "Stubborn ticket",
  status: "blocked",
  priority: 0,
  risk_level: "high",
  updated_at: "2026-01-02T00:00:00Z",
  acTotal: 1,
  acSatisfied: 0,
  acEvidenced: 0,
  acEvidenceRequired: 0,
  blockingCount: 0,
  claim: null,
  lastReviewFeedback: {
    reason: "definition-of-done failed after 3 attempts (branch preserved)",
    reviewer: "system",
    at: "2026-01-02T00:00:00Z",
    code: "rework_exhausted",
    attempt: 3,
    maxAttempts: 3,
  },
};

function emptyColumns() {
  return [
    { column: "draft", cards: [] },
    { column: "ready", cards: [] },
    { column: "in_progress", cards: [REWORKING_CARD] },
    { column: "blocked", cards: [EXHAUSTED_CARD] },
    { column: "in_review", cards: [] },
    { column: "in_testing", cards: [] },
    { column: "ready_for_merge", cards: [] },
    { column: "done", cards: [] },
  ];
}

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      let body: unknown;
      if (url.includes("/api/board"))
        body = { columns: emptyColumns(), closed: [], wontDo: [], readyForMerge: [] };
      else if (url.includes("/repositories")) body = { repositories: [] };
      else if (url.includes("/scope/nodes")) body = { nodes: [] };
      else body = {};
      return new Response(JSON.stringify(body), {
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
  location.hash = `#/work`;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function bootBoard(): Promise<void> {
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
  await tick();
  await tick();
  await tick();
}

describe("rework loop web: the board card surfaces the rework state", () => {
  beforeEach(() => {
    mountShell();
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("shows 'Reworking · attempt 2/3' + the latest failure on an in-flight card", async () => {
    stubFetch();
    await bootBoard();

    const inProgress = document.querySelector('[data-column="in_progress"]');
    expect(inProgress).toBeTruthy();
    const text = inProgress?.textContent ?? "";
    expect(text).toContain("Reworking");
    expect(text).toContain("attempt 2/3");
    // the actual failure detail rides along so a human sees WHY without opening it
    expect(text).toContain("expected 3 to be 4");

    // it carries the reworking style hook (distinct from a plain review rejection)
    expect(inProgress?.querySelector(".card-reworking")).toBeTruthy();
    // and it is NOT styled/labelled as a plain human "Rejected"
    expect(text).not.toContain("Rejected:");
  });

  it("shows 'Rework exhausted' on the VISIBLE blocked column when the loop is spent", async () => {
    stubFetch();
    await bootBoard();

    const blocked = document.querySelector('[data-column="blocked"]');
    expect(blocked).toBeTruthy();
    const text = blocked?.textContent ?? "";
    expect(text).toContain("Rework exhausted");
    expect(text).toContain("attempt 3/3");
    expect(text).toContain("branch preserved");
    expect(blocked?.querySelector(".card-rework-exhausted")).toBeTruthy();
    // the parked ticket is a real, visible card (a human can find it)
    expect(blocked?.querySelector("a.board-card")).toBeTruthy();
  });
});

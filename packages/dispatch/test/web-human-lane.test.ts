// @vitest-environment jsdom
//
// TRACK-2b DOM test: the board renders the operator's OWN in-flight work distinctly
// from the agent's. A human-owned in_progress card shows a "By hand" marker (never an
// agent claim) + a "Hand back" action; a plain ready card offers "I'll do this by
// hand". This is what lets an operator see their own WIP apart from the agent's.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

// A ticket the human took "by hand": in_progress, humanOwner set, NO agent claim.
const HUMAN_CARD = {
  id: "tkt-mine",
  number: 42,
  title: "I'm doing this myself",
  status: "in_progress",
  priority: 0,
  risk_level: "medium",
  updated_at: "2026-01-02T00:00:00Z",
  acTotal: 1,
  acSatisfied: 0,
  acEvidenced: 0,
  acEvidenceRequired: 0,
  blockingCount: 0,
  claim: null,
  humanOwner: "tom",
  lastReviewFeedback: null,
};

// An agent-claimed ticket in the same column: a claim, NO humanOwner.
const AGENT_CARD = {
  id: "tkt-agent",
  number: 43,
  title: "Agent is on it",
  status: "in_progress",
  priority: 0,
  risk_level: "medium",
  updated_at: "2026-01-02T00:00:00Z",
  acTotal: 1,
  acSatisfied: 0,
  acEvidenced: 0,
  acEvidenceRequired: 0,
  blockingCount: 0,
  claim: {
    agentId: "agent-xyz",
    agentDisplayName: "Claude",
    expiresAt: "2099-01-01T00:00:00Z",
    stale: false,
  },
  humanOwner: null,
  lastReviewFeedback: null,
};

// A plain ready ticket: offers "I'll do this by hand".
const READY_CARD = {
  id: "tkt-ready",
  number: 44,
  title: "Up for grabs",
  status: "ready",
  priority: 0,
  risk_level: "low",
  updated_at: "2026-01-02T00:00:00Z",
  acTotal: 1,
  acSatisfied: 0,
  acEvidenced: 0,
  acEvidenceRequired: 0,
  blockingCount: 0,
  claim: null,
  humanOwner: null,
  lastReviewFeedback: null,
};

function columns() {
  return [
    { column: "draft", cards: [] },
    { column: "ready", cards: [READY_CARD] },
    { column: "in_progress", cards: [HUMAN_CARD, AGENT_CARD] },
    { column: "blocked", cards: [] },
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
        body = { columns: columns(), closed: [], wontDo: [], readyForMerge: [] };
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

describe("TRACK-2b web: the board shows human WIP distinctly", () => {
  beforeEach(() => {
    mountShell();
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("renders a 'By hand' marker on the human-owned card (not an agent claim)", async () => {
    stubFetch();
    await bootBoard();

    const inProgress = document.querySelector('[data-column="in_progress"]');
    expect(inProgress).toBeTruthy();

    // The human card carries the distinct marker + the owner.
    const marker = inProgress?.querySelector(".card-human-owned");
    expect(marker).toBeTruthy();
    expect(marker?.textContent).toContain("By hand");
    expect(marker?.textContent).toContain("tom");

    // ...and offers a hand-back action.
    expect(inProgress?.querySelector(".card-human-btn.hand-back")).toBeTruthy();
  });

  it("keeps the agent-claimed card as an agent claim (no human marker)", async () => {
    stubFetch();
    await bootBoard();

    // Exactly one human marker in the in_progress column (the human card), not two.
    const inProgress = document.querySelector('[data-column="in_progress"]');
    expect(inProgress?.querySelectorAll(".card-human-owned").length).toBe(1);
    // The agent card still renders its agent claim chip.
    expect(inProgress?.querySelector(".card-claim")).toBeTruthy();
  });

  it("offers 'I'll do this by hand' on a plain ready card", async () => {
    stubFetch();
    await bootBoard();

    const ready = document.querySelector('[data-column="ready"]');
    const takeBtn = ready?.querySelector(".card-human-btn.take-myself");
    expect(takeBtn).toBeTruthy();
    expect(takeBtn?.textContent).toContain("by hand");
  });
});

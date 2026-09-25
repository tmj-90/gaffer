// @vitest-environment jsdom
//
// TRACE: the ticket view's event timeline shows the runner tick (correlation_id)
// each event was written in, so an operator can see which events belong to one
// tick and jump to `dispatch events list --correlation <id>`. Events without a
// correlation id (pre-trace rows, human edits outside a tick) show no chip.
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const TICKET = {
  id: "tkt-trace",
  number: 12,
  title: "Traced work",
  description: "d",
  status: "in_review",
  risk_level: "low",
  policy_pack: "solo_loose",
  priority: 0,
  attempt_count: 0,
  branch_name: null,
  pr_url: null,
  can_be_tested: 0,
  test_contract: null,
  delivery_budget_usd: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const EVENTS = [
  {
    id: "e1",
    entity_type: "ticket",
    entity_id: TICKET.id,
    actor_type: "human",
    actor_id: "op",
    event_type: "ticket.created",
    payload_json: null,
    correlation_id: null,
    created_at: "2026-01-01T00:00:00Z",
  },
  {
    id: "e2",
    entity_type: "ticket",
    entity_id: TICKET.id,
    actor_type: "agent",
    actor_id: "gaffer-factory",
    event_type: "ticket.transitioned",
    payload_json: JSON.stringify({ from: "ready", to: "claimed" }),
    correlation_id: "20260925T170000Z.4242",
    created_at: "2026-01-01T00:01:00Z",
  },
  {
    id: "e3",
    entity_type: "ticket",
    entity_id: TICKET.id,
    actor_type: "agent",
    actor_id: "gaffer-factory",
    event_type: "ticket.transitioned",
    payload_json: JSON.stringify({ from: "claimed", to: "in_review" }),
    correlation_id: "20260925T170000Z.4242",
    created_at: "2026-01-01T00:02:00Z",
  },
];

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      let body: unknown;
      if (url.includes(`/tickets/${TICKET.id}/diff`)) body = { ticketId: TICKET.id, repos: [] };
      else if (url.includes(`/tickets/${TICKET.id}/claimability`))
        body = { ticketId: TICKET.id, ready: true, blockers: [], warnings: [] };
      else if (url.includes(`/tickets/${TICKET.id}/work-repos`))
        body = {
          writeRepos: [],
          readOnlyRepos: [],
          testRepos: [],
          deniedRepos: [],
          suggestedRepos: [],
          rejectedRepos: [],
        };
      else if (url.includes(`/tickets/${TICKET.id}`))
        body = {
          ticket: TICKET,
          acceptance_criteria: [],
          repositories: [],
          scopes: [],
          blocking_decisions: [],
          dependencies: [],
          evidence: [],
          events: EVENTS,
          rework_trail: [],
        };
      else body = { tickets: [TICKET] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("web: ticket timeline shows the tick each event was written in", () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = `
      <div id="toast" class="toast" role="alert" hidden></div>
      <div class="shell">
        <header id="appbar" class="appbar" hidden></header>
        <main id="app" class="app"><p class="loading">Loading…</p></main>
        <nav id="bottomnav" class="bottomnav" hidden></nav>
      </div>`;
    location.hash = `#/ticket/${TICKET.id}`;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("renders a tick chip for correlated events only, naming the CLI trail", async () => {
    stubFetch();
    await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
    await tick();
    await tick();
    await tick();
    const items = Array.from(document.querySelectorAll(".timeline li"));
    expect(items).toHaveLength(3);
    const chips = Array.from(document.querySelectorAll(".timeline .ev-tick"));
    expect(chips).toHaveLength(2);
    expect(chips.every((c) => c.textContent === "tick 20260925T170000Z.4242")).toBe(true);
    expect(chips[0]!.getAttribute("title")).toContain(
      "dispatch events list --correlation 20260925T170000Z.4242",
    );
    // The human-created event (no correlation id) shows no chip.
    expect(items[0]!.querySelector(".ev-tick")).toBeNull();
  });
});

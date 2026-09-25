// @vitest-environment jsdom
//
// MACHINE-CHECKABLE AC — the ticket-detail "Add AC" form carries an optional
// `check_command` (a shell command the RUNNER executes in the delivery worktree).
// Proves the field exists, is sent only when filled, and that the rendered AC list
// labels a checked AC (and marks a runner-verified one).

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const TICKET = {
  id: "tkt-ac",
  number: 11,
  title: "Checked work",
  description: "deliver it",
  status: "draft",
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

interface Captured {
  url: string;
  method: string;
  body: unknown;
}

function stubFetch(acs: unknown[], captured: Captured[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method !== "GET") {
        captured.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
        return new Response(JSON.stringify({ ok: true }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
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
          acceptance_criteria: acs,
          repositories: [],
          scopes: [],
          blocking_decisions: [],
          dependencies: [],
          evidence: [],
          events: [],
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

function mountShell(): void {
  document.body.innerHTML = `
    <div id="toast" class="toast" role="alert" hidden></div>
    <div class="shell">
      <header id="appbar" class="appbar" hidden></header>
      <main id="app" class="app"><p class="loading">Loading…</p></main>
      <nav id="bottomnav" class="bottomnav" hidden></nav>
    </div>`;
  location.hash = `#/ticket/${TICKET.id}`;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function bootDetail(): Promise<void> {
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
  await tick();
  await tick();
  await tick();
}

describe("web: ticket-detail Add-AC form — check_command", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("renders a check-command input and POSTs it with the criterion when filled", async () => {
    const captured: Captured[] = [];
    mountShell();
    stubFetch([], captured);
    await bootDetail();
    const text = document.querySelector<HTMLInputElement>(
      'input[placeholder="New acceptance criterion…"]',
    );
    const check = document.querySelector<HTMLInputElement>('input[name="check_command"]');
    expect(text).not.toBeNull();
    expect(check).not.toBeNull();
    text!.value = "unit tests pass";
    check!.value = "  npm test  ";
    text!.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await tick();
    await tick();
    const post = captured.find((c) => c.url.includes("/acceptance-criteria"));
    expect(post).toBeDefined();
    expect(post!.body).toEqual({ text: "unit tests pass", check_command: "npm test" });
  });

  it("omits check_command when the field is left empty", async () => {
    const captured: Captured[] = [];
    mountShell();
    stubFetch([], captured);
    await bootDetail();
    const text = document.querySelector<HTMLInputElement>(
      'input[placeholder="New acceptance criterion…"]',
    )!;
    text.value = "prose only";
    text.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await tick();
    await tick();
    const post = captured.find((c) => c.url.includes("/acceptance-criteria"));
    expect(post!.body).toEqual({ text: "prose only" });
  });

  it("labels a checked AC in the list and marks a runner-verified one", async () => {
    mountShell();
    stubFetch(
      [
        {
          id: "ac1",
          text: "tests pass",
          status: "satisfied",
          verification_method: null,
          evidence_required: 0,
          verified_by: "runner:check",
          check_command: "npm test",
        },
        {
          id: "ac2",
          text: "looks right",
          status: "pending",
          verification_method: "manual review",
          evidence_required: 0,
          verified_by: null,
          check_command: null,
        },
      ],
      [],
    );
    await bootDetail();
    const metas = [...document.querySelectorAll(".ac-meta")].map((n) => n.textContent ?? "");
    expect(metas.some((m) => m.includes("check: npm test") && m.includes("runner-verified"))).toBe(
      true,
    );
    expect(metas.some((m) => m.includes("verify: manual review"))).toBe(true);
  });
});

// @vitest-environment jsdom
//
// REVIEW TELEMETRY from the dashboard (Release A metrics package, A0): the Review view
// posts `review-opened` once per ticket and review round, so Health can split time in
// review into queue wait and decision time; opening an evidence row in full posts
// `review-raw-opened {what: "evidence"}`. Both are best-effort and never shown, and a
// read-only token sends neither (the server would refuse them).

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const ROUND = "2026-11-01T10:00:00.000Z";
const TICKET = {
  id: "tkt-1",
  number: 7,
  title: "Ship the thing",
  status: "in_review",
  risk_level: "low",
  branch_name: "feat/x",
  pr_url: null,
  updated_at: "2026-11-01T10:00:00.000Z",
};
const EVENTS = [
  {
    id: "e1",
    event_type: "ticket.transitioned",
    entity_id: TICKET.id,
    actor_type: "system",
    payload_json: JSON.stringify({ from: "in_progress", to: "in_review" }),
    created_at: ROUND,
  },
];
const EVIDENCE = [
  {
    id: "ev1",
    evidence_type: "test_output",
    summary: "DoD: PASS\nlint ok\ntests ok",
    created_by: "system",
    created_at: ROUND,
  },
];

let posts: Array<{ url: string; body: unknown }> = [];
let capability = "full";

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      if (method !== "GET") {
        posts.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return new Response(JSON.stringify({ recorded: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      let body: unknown = {};
      if (url.includes("/api/whoami")) body = { capability, actor: { type: "human" } };
      else if (url.includes("/tickets/") && url.endsWith("/diff"))
        body = {
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
      else if (url.includes(`/tickets/${TICKET.id}`))
        body = { ...TICKET, acceptance_criteria: [], evidence: EVIDENCE, events: EVENTS };
      else if (url.includes("/tickets")) body = { tickets: [TICKET] };
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
  location.hash = "#/review";
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await tick();
}

async function bootReview(): Promise<void> {
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}-${Math.random()}`);
  await settle();
}

const opened = () => posts.filter((p) => p.url.endsWith(`/tickets/${TICKET.id}/review-opened`));
const rawOpened = () =>
  posts.filter((p) => p.url.endsWith(`/tickets/${TICKET.id}/review-raw-opened`));

describe("web: the Review view records that a person opened the ticket", () => {
  beforeEach(() => {
    posts = [];
    capability = "full";
    mountShell();
    stubFetch();
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("posts review-opened once for the round on screen, not again on a re-render", async () => {
    await bootReview();
    expect(opened()).toHaveLength(1);
    expect(opened()[0]!.body).toEqual({ round_entered_at: ROUND });
    location.hash = `#/review/${TICKET.id}`;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await settle();
    expect(opened()).toHaveLength(1);
  });

  it("opening an evidence row in full posts review-raw-opened evidence, once", async () => {
    await bootReview();
    const more = document.querySelector(".rv-evid details.evi-more") as HTMLDetailsElement | null;
    expect(more).not.toBeNull();
    more!.open = true;
    more!.dispatchEvent(new Event("toggle"));
    await settle();
    more!.open = false;
    more!.dispatchEvent(new Event("toggle"));
    more!.open = true;
    more!.dispatchEvent(new Event("toggle"));
    await settle();
    expect(rawOpened()).toHaveLength(1);
    expect(rawOpened()[0]!.body).toEqual({ what: "evidence", round_entered_at: ROUND });
  });

  it("a read-only token sends nothing", async () => {
    capability = "read";
    await bootReview();
    expect(posts).toHaveLength(0);
  });
});

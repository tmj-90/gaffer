// @vitest-environment jsdom
//
// GATE INTEGRITY on the dashboard (src/api/web/app.js):
//   - Review (The gaffer's sign-off): when the server's diff carries a `test-modified`
//     risk annotation, a banner names what changed (one line per finding), says the
//     auto-approve is held, and offers "Allow test changes…"; the sheet POSTs
//     /tickets/:id/allow-test-changes with the reason. An allowed annotation shows the
//     quieter "allowed" banner with "Withdraw allowance…". A clean diff: no banner.
//   - The gates checklist renders the runner's integrity FLAG row as flagged (a
//     yellow "!", never a red ✗) with its note, and each gate's `source`.
//   - The Team Sheet row of a review whose DoD evidence FLAGged carries "Tests changed".
//   - A read token sees "Allow test changes…" switched off (the read-only strip's rule).

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { batchedReads } from "./helpers/batchedReads.js";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const TICKET = {
  id: "tkt-gi",
  number: 31,
  title: "Fix the reset endpoint",
  description: "deliver it",
  status: "in_review",
  risk_level: "low",
  policy_pack: "team_light",
  priority: 0,
  attempt_count: 0,
  branch_name: "gaffer/ticket-31-reset",
  pr_url: null,
  allow_test_changes: 0,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const DOD_FLAG = {
  id: "ev-dod",
  evidence_type: "test_output",
  summary: `DoD: PASS\n${JSON.stringify({
    dod: "PASS",
    gates: [
      {
        gate: "tests",
        repo: "svc",
        status: "PASS",
        rc: "0",
        note: "npm test",
        source: 'base: script "test" read from base 0123456789ab (unchanged in the delivery)',
      },
      {
        gate: "integrity",
        repo: "svc",
        status: "FLAG",
        rc: "0",
        note: "deleted 1 test file (src/x.test.ts); added skip/only markers (it.skip in src/y.test.ts:4)",
        source: "base 0123456789ab vs worktree",
      },
    ],
  })}\n`,
  payload_json: null,
  created_by: "factory-dod",
  created_at: "2026-01-02T00:00:00Z",
};

function testModified(allowed: boolean) {
  return {
    kind: "test-modified",
    severity: allowed ? "medium" : "high",
    detail:
      "deleted 1 test file (src/x.test.ts); added skip/only markers (it.skip in src/y.test.ts:4)",
    paths: ["src/x.test.ts", "src/y.test.ts"],
    items: ["deleted test file src/x.test.ts", "added it.skip in src/y.test.ts:4"],
    ...(allowed ? { allowed: true } : {}),
  };
}

let annotations: unknown[] = [];
// GET /api/whoami's capability: undefined (a full token, the default) or "read".
let capability: string | undefined;
const posts: Array<{ url: string; body: unknown }> = [];

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      batchedReads(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const json = (obj: unknown) =>
          new Response(JSON.stringify(obj), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        if (init?.method === "POST") {
          posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
          return json({ ticket_id: TICKET.id, allow_test_changes: true, event_id: "ev-1" });
        }
        if (url.includes("/api/whoami"))
          return json(capability ? { capability, actor: { type: "human", id: "viewer" } } : {});
        if (url.includes(`/tickets/${TICKET.id}/diff`))
          return json({
            ticketId: TICKET.id,
            repos: [
              {
                repo: "svc",
                branch: TICKET.branch_name,
                baseBranch: "main",
                diff: "diff --git a/src/y.test.ts b/src/y.test.ts\n+it.skip('adds', () => {})\n",
                files: 3,
                additions: 2,
                deletions: 12,
                truncated: false,
                riskAnnotations: annotations,
              },
            ],
          });
        if (url.includes(`/tickets/${TICKET.id}`))
          return json({
            ticket: TICKET,
            acceptance_criteria: [],
            repositories: [{ id: "r1", name: "svc", access: "write" }],
            scopes: [],
            blocking_decisions: [],
            dependencies: [],
            evidence: [DOD_FLAG],
            events: [],
          });
        if (url.includes("/api/human-queue"))
          return json({
            items: [
              {
                kind: "review",
                label: "Review sign-off",
                reason: "please review",
                ticket: {
                  id: TICKET.id,
                  number: TICKET.number,
                  title: TICKET.title,
                  status: "in_review",
                },
                decisionId: null,
                severity: null,
                since: new Date(Date.now() - 120_000).toISOString(),
                waitedMs: 120_000,
              },
            ],
            counts: { total: 1, reviews: 1 },
          });
        if (url.includes("/api/board"))
          return json({
            columns: [{ status: "in_review", cards: [TICKET] }],
            closed: [],
            wontDo: [],
          });
        if (url.includes("/api/runs")) return json({ active: [], recent: [] });
        if (url.includes("/api/dashboard")) return json({ summary: { ticketsByStatus: {} } });
        if (url.includes("/api/activity")) return json({ events: [], total: 0 });
        if (url.includes("/tickets")) return json({ tickets: [TICKET] });
        if (url.includes("/decisions")) return json({ decisions: [] });
        return json({});
      }),
    ),
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
async function boot(): Promise<void> {
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}-${Math.random()}`);
  for (let i = 0; i < 6; i += 1) await tick();
}

describe("web: gate integrity", () => {
  beforeEach(() => {
    vi.resetModules();
    posts.length = 0;
    stubFetch();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
    annotations = [];
    capability = undefined;
  });

  it("Review: the banner names what changed and says the auto-approve is held", async () => {
    annotations = [testModified(false)];
    mountShell("#/review");
    await boot();
    const banner = document.querySelector(".signoff .integrity-banner");
    expect(banner).not.toBeNull();
    expect(banner!.getAttribute("role")).toBe("alert");
    expect(banner!.getAttribute("aria-label")).toBe(
      "This delivery changed the tests that gate it.",
    );
    const items = [...banner!.querySelectorAll(".integrity-items li")].map((li) => li.textContent);
    expect(items).toEqual(["deleted test file src/x.test.ts", "added it.skip in src/y.test.ts:4"]);
    expect(banner!.textContent).toMatch(/Auto-approve is held until a person looks/);
    // The flag list carries it too, in words.
    const flagTitles = [...document.querySelectorAll(".flag-list .flag-title")].map(
      (h) => h.textContent,
    );
    expect(flagTitles).toContain("Test modified");
  });

  it("Review: Allow test changes… opens a sheet that POSTs the allowance with the reason", async () => {
    annotations = [testModified(false)];
    mountShell("#/review");
    await boot();
    const btn = [...document.querySelectorAll(".integrity-banner button")].find(
      (b) => b.textContent === "Allow test changes…",
    ) as HTMLButtonElement;
    expect(btn).toBeTruthy();
    btn.click();
    await tick();
    const reason = document.querySelector(
      'textarea[aria-label="Why this ticket may change its tests"]',
    ) as HTMLTextAreaElement;
    expect(reason).not.toBeNull();
    reason.value = "the v1 suite is obsolete";
    const confirm = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Allow test changes",
    ) as HTMLButtonElement;
    confirm.click();
    for (let i = 0; i < 4; i += 1) await tick();
    expect(posts).toEqual([
      {
        url: expect.stringContaining(`/tickets/${TICKET.id}/allow-test-changes`),
        body: { allow_test_changes: true, reason: "the v1 suite is obsolete" },
      },
    ]);
  });

  it("Review: an allowed annotation shows the quieter banner with Withdraw allowance…", async () => {
    annotations = [testModified(true)];
    mountShell("#/review");
    await boot();
    const banner = document.querySelector(".integrity-banner.is-allowed");
    expect(banner).not.toBeNull();
    expect(banner!.getAttribute("role")).toBe("status");
    expect(banner!.querySelector("button")?.textContent).toBe("Withdraw allowance…");
  });

  it("Review: a read token sees the banner with Allow test changes… switched off", async () => {
    annotations = [testModified(false)];
    capability = "read";
    mountShell("#/review");
    await boot();
    const btn = [...document.querySelectorAll(".integrity-banner button")].find(
      (b) => b.textContent === "Allow test changes…",
    ) as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    expect(btn.title).toBe("Read-only access: this token can look, not change anything.");
    btn.click();
    await tick();
    expect(
      document.querySelector('textarea[aria-label="Why this ticket may change its tests"]'),
    ).toBeNull();
    expect(posts).toEqual([]);
  });

  it("Review: a clean diff shows no banner", async () => {
    annotations = [];
    mountShell("#/review");
    await boot();
    expect(document.querySelector(".integrity-banner")).toBeNull();
  });

  it("the gates checklist shows the integrity FLAG (yellow, not red) and each gate's source", async () => {
    mountShell("#/review");
    await boot();
    const flag = document.querySelector(".dod-item.dod-i-flag");
    expect(flag).not.toBeNull();
    expect(flag!.querySelector(".dod-mark.dod-flag")?.textContent).toBe("!");
    expect(flag!.querySelector(".dod-word")?.textContent).toBe("flagged");
    expect(flag!.querySelector(".dod-note")?.textContent).toMatch(/deleted 1 test file/);
    expect(document.querySelector(".dod-mark.dod-fail")).toBeNull();
    expect(document.querySelector(".dod-i-pass .dod-src")?.textContent).toMatch(
      /^base: script "test"/,
    );
  });

  it("the Team Sheet row of a flagged review carries Tests changed", async () => {
    mountShell("#/overview");
    await boot();
    const row = document.querySelector("#what-i-own .own-row--review");
    expect(row).not.toBeNull();
    const chip = row!.querySelector(".own-flag");
    expect(chip?.textContent).toBe("Tests changed");
    expect(chip?.getAttribute("aria-label")).toMatch(/^Tests changed: deleted 1 test file/);
  });
});

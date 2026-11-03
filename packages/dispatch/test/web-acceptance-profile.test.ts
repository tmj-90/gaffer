// @vitest-environment jsdom
//
// ACCEPTANCE PROFILES (Release C, A6 artefact display): the "Independent testing" card
// shows the ticket's acceptance profile, lets a person set it while the contract is
// editable, and renders the runner's runtime acceptance records (the CLI transcript, the
// API probe responses) as expandable plain text with provenance and the tested commit.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const TICKET = {
  id: "tkt-1",
  number: 7,
  title: "Widget endpoint",
  description: "deliver it",
  status: "in_testing" as string,
  risk_level: "low",
  policy_pack: "team_light",
  priority: 0,
  attempt_count: 0,
  branch_name: "feat/x",
  pr_url: null,
  can_be_tested: 1,
  test_contract: JSON.stringify({
    changed_surfaces: ["POST /api/widgets"],
    runtime_deps: ["Postgres 16"],
    env_vars: ["DATABASE_URL"],
    run_command: "docker compose up",
    harness_ready: false,
    profile: "cli",
    profile_spec: { cases: [{ argv: ["node", "bin/cli.mjs", "--version"], expect: { exit: 0 } }] },
  }),
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const SHA = "a".repeat(40);
const TRANSCRIPT = {
  kind: "transcript",
  profile: "cli",
  tested_commit: SHA,
  contract_hash: "b".repeat(64),
  passed: true,
  digest: "c".repeat(64),
  sandbox: "none (no OS sandbox configured)",
  cases: [
    {
      name: "version",
      argv: ["node", "bin/cli.mjs", "--version"],
      exit: 0,
      duration_ms: 41,
      stdout: {
        sha256: "d".repeat(64),
        bytes: 9,
        excerpt: "fx 1.2.0 <img src=x onerror=alert(1)>",
      },
      stderr: { sha256: "e".repeat(64), bytes: 0, excerpt: "" },
      fs: { added: ["out/greeting.txt"], modified: [], deleted: [] },
      checks: [{ what: "exit code 0", held: true, detail: "exited 0" }],
      held: true,
    },
  ],
};
const EVIDENCE = [
  {
    id: "ev-accept",
    evidence_type: "log",
    summary: "runtime acceptance (cli): passed on aaaaaaaaaaaa, 1 command",
    uri: `gaffer-acceptance:cli:${SHA}`,
    payload_json: JSON.stringify(TRANSCRIPT),
    created_by: "system",
    recorded_by_actor_type: "system",
    created_at: "2026-01-02T00:00:00Z",
  },
  {
    // An agent-recorded look-alike is never shown as the runner's record.
    id: "ev-forged",
    evidence_type: "log",
    summary: "forged transcript row",
    uri: `gaffer-acceptance:cli:${SHA}`,
    payload_json: JSON.stringify({ ...TRANSCRIPT, cases: [] }),
    created_by: "agent-1",
    recorded_by_actor_type: "agent",
    created_at: "2026-01-02T00:00:01Z",
  },
];
const posts: Array<{ url: string; body: unknown }> = [];

function stubFetch(evidence: unknown[] = EVIDENCE): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      let body: unknown;
      if (init?.method === "POST") {
        posts.push({ url, body: JSON.parse(String(init.body ?? "{}")) });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
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
          evidence,
          events: [],
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

describe("acceptance profiles on the ticket page", () => {
  beforeEach(() => {
    mountShell();
    vi.resetModules();
    posts.length = 0;
    TICKET.status = "in_testing";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("renders the runner's transcript as expandable plain text with provenance and the tested commit", async () => {
    stubFetch();
    await bootDetail();
    const card = document.querySelector(".tk-testing")!;
    const text = card.textContent ?? "";
    expect(text).toContain("Acceptance profile");
    expect(text).toContain("1 command registered");
    const rows = card.querySelectorAll(".tk-accept-row");
    expect(rows).toHaveLength(1);
    const details = rows[0]!.querySelector("details.tk-accept-transcript")!;
    expect(details).not.toBeNull();
    expect(details.querySelector("summary")!.textContent).toContain("by runner");
    expect(details.querySelector("summary code")!.textContent).toBe(SHA.slice(0, 12));
    const pre = details.querySelector("pre")!.textContent ?? "";
    expect(pre).toContain("$ node bin/cli.mjs --version");
    expect(pre).toContain("exit 0, 41 ms");
    expect(pre).toContain("+ out/greeting.txt");
    expect(pre).toContain("ok   exit code 0");
    expect(details.textContent).toContain(`tested commit ${SHA}`);
    // Text, never HTML: the excerpt's markup is shown, not parsed.
    expect(pre).toContain("<img src=x onerror=alert(1)>");
    expect(card.querySelector("img")).toBeNull();
    // The agent's look-alike row is not shown as runtime acceptance.
    expect(text).not.toContain("forged transcript row");
    // In testing the profile is frozen: no editor.
    expect(card.querySelector("details.tk-accept-edit")).toBeNull();
    expect(text).toContain("Frozen while the ticket is in testing");
  });

  it("a person sets the profile and its spec while the contract is editable", async () => {
    TICKET.status = "in_review";
    stubFetch([]);
    await bootDetail();
    const card = document.querySelector(".tk-testing")!;
    expect(card.textContent).toContain("No runtime acceptance recorded.");
    const select = card.querySelector(
      'select[aria-label="Acceptance profile"]',
    ) as HTMLSelectElement;
    expect(select.value).toBe("cli");
    const area = card.querySelector(
      'textarea[aria-label="Profile spec (JSON)"]',
    ) as HTMLTextAreaElement;
    expect(JSON.parse(area.value).cases).toHaveLength(1);
    select.value = "api";
    select.dispatchEvent(new Event("change"));
    area.value = JSON.stringify({
      boot_argv: ["node", "server.mjs"],
      health_path: "/health",
      probes: [{ path: "/items", expect: { status: 200 } }],
    });
    const save = Array.from(card.querySelectorAll("button")).find(
      (b) => b.textContent === "Save profile",
    )!;
    save.click();
    await tick();
    await tick();
    const post = posts.find((p) => p.url.endsWith(`/tickets/${TICKET.id}/acceptance-profile`));
    expect(post).toBeDefined();
    expect(post!.body).toMatchObject({ profile: "api", spec: { health_path: "/health" } });
  });
});

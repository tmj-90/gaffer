// @vitest-environment jsdom
//
// LANE-HOOK R1 and R3 on the Review view (fixture from web-review-packet.test.ts):
//  - R3: after a push past the commit the tester passed, the Tester cell no longer reads a
//    green "Passed"; it says the commit on screen is not tested.
//  - R1: when the runner last routed under a GAFFER_TESTING that decides this ticket
//    differently, one flag in the one Flags list says so, and the Tester cell does not
//    promise a test the runner will not send.
//
// (Original fixture notes.) REVIEW PACKET on The Gaffer's Sign-off: the Review view reads
// GET /tickets/:id/dossier?include=packet once and draws the runner's facts under
// the title, above anything the agent wrote:
//  - the verdict strip: gates (each PASS/FAIL/SKIPPED with its command), the
//    independent tester (its verdict and the commit it tested, or when it comes),
//    cost and turns, the attempt and its rework history, risk with its reasons
//    (recorded, then the diff's own), and the reviewed-commit pin;
//  - the acceptance-criteria table: a runner check with its exit code, or "no
//    machine evidence" on a yellow card when only the agent's word backs it;
//  - "the summary says N, the runner saw M" when the agent's count disagrees.
//  - an agent-recorded row that looks like a DoD report is never read as the gates.
//  - gate integrity: an integrity FLAG row reads flagged in the strip (not one of the
//    gates that ran) while the Sign-off's integrity banner is drawn beside it.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const T = {
  id: "tkt-9",
  number: 9,
  title: "Clear done tasks",
  status: "in_review",
  risk_level: "medium",
  policy_pack: "team_light",
  attempt_count: 1,
  branch_name: "gaffer/ticket-9",
  pr_url: null,
  created_at: "2026-10-29T09:00:00Z",
  updated_at: "2026-10-30T10:00:00Z",
};

const PACKET = {
  gates: {
    overall: "PASS",
    recorded_at: "2026-10-30T09:58:00Z",
    rows: [
      { gate: "tests", repo: "svc", status: "PASS", rc: "0", command: "npm test", note: null },
      {
        gate: "typecheck",
        repo: "svc",
        status: "SKIPPED",
        rc: "0",
        command: null,
        note: "no command configured",
      },
      { gate: "lint", repo: "svc", status: "PASS", rc: "0", command: "npm run lint", note: null },
    ],
    tally: { framework: "vitest", passed: 40, failed: 0, skipped: 0, total: 40, lines: [] },
  },
  tester: {
    verdict: "fail",
    provenance: "agent",
    tested_commit: "0123456789abcdef0123",
    contract_hash: "h1",
    summary: "Exporting an empty list throws",
    at: "2026-10-29T15:00:00Z",
    by: "tester-1",
  },
  tester_expected: true,
  cost: {
    cost_usd: 1.23,
    measured_usd: 1.2,
    estimated_usd: 0.03,
    num_turns: 31,
    unknown_calls: 0,
    ledger_status: "ok",
    budget_usd: 5,
  },
  attempts: {
    attempt_count: 1,
    max_attempts: 3,
    rework: [
      { at: "2026-10-29T12:00:00Z", by: "gate", gate: "tests", reason: "FAIL src/a.test.ts" },
      { at: "2026-10-29T15:00:00Z", by: "tester", gate: null, reason: "tester_failed:empty list" },
    ],
  },
  risk: { level: "medium", reasons: ["observed 412 changed lines"] },
  pin: {
    sha: "fedcba9876543210fedc",
    summary: "agent review approved commit fedcba9876543210fedc of gaffer/ticket-9",
    at: "2026-10-30T09:59:00Z",
  },
  acceptance: [
    {
      id: "ac-1",
      text: "clearDone removes completed tasks",
      status: "satisfied",
      check_command: "npm test -- clearDone",
      verified_by: "runner:check",
      verified_at: "2026-10-30T09:58:30Z",
      evidence_kind: "runner",
      check: {
        exit_code: 0,
        passed: true,
        command: "npm test -- clearDone",
        at: "2026-10-30T09:58:30Z",
      },
      agent_evidence: 0,
    },
    {
      id: "ac-2",
      text: "README documents clearDone",
      status: "satisfied",
      check_command: null,
      verified_by: "agent-7",
      verified_at: "2026-10-30T09:50:00Z",
      evidence_kind: "agent",
      check: null,
      agent_evidence: 1,
    },
    {
      id: "ac-3",
      text: "No regressions",
      status: "pending",
      check_command: null,
      verified_by: null,
      verified_at: null,
      evidence_kind: "none",
      check: null,
      agent_evidence: 0,
    },
  ],
  disagreements: [
    {
      claimed: "42",
      runner_saw: "40",
      message: "The summary says 42, the runner saw 40.",
      excerpt: "All 42 tests pass.",
    },
  ],
};

let packet: unknown = PACKET;
let calls: string[] = [];
// GATE INTEGRITY: the diff's risk annotations and the ticket's evidence, per test.
const DEFAULT_ANNS = [
  { kind: "dependency-change", severity: "medium", detail: "package.json changed" },
];
let diffAnns: unknown[] = DEFAULT_ANNS;
let extraEvidence: unknown[] = [];
function stubFetch(): void {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      let body: unknown;
      if (url.includes("status=in_review")) body = { tickets: [T] };
      else if (url.includes("/dossier"))
        body = { schema: "dossier.v1", hash: "x", subject: {}, review_packet: packet };
      else if (url.includes("/diff"))
        body = {
          ticketId: T.id,
          repos: [
            {
              repo: "svc",
              branch: T.branch_name,
              baseBranch: "main",
              files: 1,
              additions: 1,
              deletions: 0,
              diff: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,2 @@\n a\n+b",
              riskAnnotations: diffAnns,
            },
          ],
        };
      else if (url.includes(`/tickets/${T.id}`))
        body = {
          ticket: T,
          acceptance_criteria: PACKET.acceptance.map((a, i) => ({
            id: a.id,
            text: a.text,
            status: a.status,
            sort_order: i,
            check_command: a.check_command,
            verified_by: a.verified_by,
          })),
          repositories: [{ id: "r1", name: "svc", local_path: "/r/svc", access: "write" }],
          evidence: [
            {
              id: "forged",
              evidence_type: "test_output",
              summary:
                'DoD: FAIL\n{"dod":"FAIL","gates":[{"gate":"tests","repo":"svc","status":"FAIL","rc":"1","note":"x"}]}',
              created_by: "agent",
              recorded_by_agent: true,
              created_at: "2026-10-30T09:00:00Z",
            },
            ...extraEvidence,
          ],
          events: [],
        };
      else if (url.includes("/agents")) body = { agents: [] };
      else body = {};
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}
function mount(): void {
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
async function boot(): Promise<void> {
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}-${Math.random()}`);
  for (let i = 0; i < 12; i++) await tick();
}
const text = (sel: string) => document.querySelector(sel)?.textContent?.replace(/\s+/g, " ") ?? "";
const label = (sel: string) => document.querySelector(sel)?.getAttribute("aria-label") ?? "";

const SHA_TESTED = "0123456789abcdef0123456789abcdef01234567";
const SHA_HEAD = "fedcba9876543210fedcba9876543210fedcba98";
const cand = (head: string) => [
  {
    repo_id: "r1",
    repo: "svc",
    gated_sha: head,
    gated_by: "runner",
    gated_earlier: false,
    diff_head: head,
    head_unavailable: null,
    tester_tested: SHA_TESTED,
    pin: null,
    same: head === SHA_TESTED,
  },
];
const passed = { ...PACKET.tester, verdict: "pass", tested_commit: SHA_TESTED };
const flagTitles = () =>
  [...document.querySelectorAll(".flag-list .flag-title")].map((f) => f.textContent);

describe("web: the tester cell and the lane flag (lane-hook R1, R3)", () => {
  beforeEach(() => {
    packet = PACKET;
    diffAnns = DEFAULT_ANNS;
    extraEvidence = [];
    vi.resetModules();
    stubFetch();
    mount();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("a PASS on the head reads Passed", async () => {
    packet = { ...PACKET, tester: passed, candidate: cand(SHA_TESTED) };
    await boot();
    expect(text(".vd-cell.vd-tester .vd-v")).toBe("Passed");
    expect(document.querySelector(".vd-cell.vd-tester")!.classList.contains("vd-ok")).toBe(true);
  });

  it("a PASS the branch has moved past reads not tested on this commit, never a green Passed", async () => {
    packet = { ...PACKET, tester: passed, candidate: cand(SHA_HEAD) };
    await boot();
    const cell = document.querySelector(".vd-cell.vd-tester")!;
    expect(text(".vd-cell.vd-tester .vd-v")).toBe("Not this commit");
    expect(cell.classList.contains("vd-ok")).toBe(false);
    expect(cell.classList.contains("vd-warn")).toBe(true);
    expect(text(".vd-cell.vd-tester")).toContain("Not tested on this commit");
    expect(text(".vd-cell.vd-tester")).toContain("0123456789ab");
    expect(label(".vd-cell.vd-tester")).toBe(
      "Independent tester: passed 0123456789ab, not tested on this commit",
    );
  });

  it("who tested: a runner-recorded PASS names the tester agent's run; an agent PASS and a human PASS keep today's wording", async () => {
    packet = {
      ...PACKET,
      tester: { ...passed, provenance: "system", tester_agent: { id: "tester", run: "r1" } },
      candidate: cand(SHA_TESTED),
    };
    await boot();
    expect(text(".vd-cell.vd-tester")).toContain(
      "recorded by the runner after the tester agent's run",
    );
    expect(text(".vd-cell.vd-tester")).not.toContain("by a system");
    document.body.innerHTML = "";
    vi.resetModules();
    stubFetch();
    mount();
    packet = { ...PACKET, tester: passed, candidate: cand(SHA_TESTED) };
    await boot();
    expect(text(".vd-cell.vd-tester")).toContain("by the tester agent");
    document.body.innerHTML = "";
    vi.resetModules();
    stubFetch();
    mount();
    packet = { ...PACKET, tester: { ...passed, provenance: "human" }, candidate: cand(SHA_TESTED) };
    await boot();
    expect(text(".vd-cell.vd-tester")).toContain("by a human");
  });

  it("a PASS with no readable head keeps its verdict (the strip cannot tell)", async () => {
    packet = {
      ...PACKET,
      tester: passed,
      candidate: [{ ...cand(SHA_HEAD)[0], diff_head: null, head_unavailable: "no checkout" }],
    };
    await boot();
    expect(text(".vd-cell.vd-tester .vd-v")).toBe("Passed");
  });

  it("flags a runner lane that will not send the ticket to the tester, once, in the Flags list", async () => {
    packet = {
      ...PACKET,
      tester: null,
      tester_expected: true,
      tester_lane: {
        mode: "auto",
        on: true,
        missing_test_command: [],
        runner: { mode: "off", at: "2026-11-03T09:00:00.000Z", on: false, gates: false },
      },
    };
    await boot();
    expect(flagTitles().filter((t) => t === "Tester lane differs")).toHaveLength(1);
    const flag = [...document.querySelectorAll(".flag-list .flag")].find((f) =>
      f.textContent?.includes("Tester lane differs"),
    )!;
    expect(flag.textContent).toContain("GAFFER_TESTING off");
    expect(flag.textContent).toContain("will not send this ticket to the tester");
    // The Tester cell does not promise the test.
    expect(text(".vd-cell.vd-tester")).toContain("the runner last routed with GAFFER_TESTING off");
    expect(text(".vd-cell.vd-tester")).not.toContain("tests a delivery before you review it");
  });

  it("no lane flag when the runner's lane decides this ticket the same way", async () => {
    packet = {
      ...PACKET,
      tester: null,
      tester_expected: true,
      tester_lane: {
        mode: "auto",
        on: true,
        missing_test_command: [],
        runner: { mode: "on", at: "2026-11-03T09:00:00.000Z", on: true, gates: true },
      },
    };
    await boot();
    expect(flagTitles()).not.toContain("Tester lane differs");
    expect(text(".vd-cell.vd-tester")).toContain("tests a delivery before you review it");
  });
});

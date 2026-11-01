// @vitest-environment jsdom
//
// REVIEW PACKET on The Gaffer's Sign-off: the Review view reads
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

describe("web: the review packet on The Gaffer's Sign-off", () => {
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

  it("reads the packet once, with the dossier's include=packet", async () => {
    await boot();
    const reads = calls.filter((u) => u.includes("/dossier"));
    expect(new Set(reads).size).toBe(1);
    expect(reads[0]).toContain(`/tickets/${T.id}/dossier?include=packet`);
  });

  it("draws the verdict strip under the title, before the sign-off", async () => {
    await boot();
    const strip = document.querySelector(".rv-verdict");
    expect(strip).not.toBeNull();
    expect(strip!.getAttribute("aria-label")).toBe("The runner's verdict");
    // Under the header, ahead of the sign-off and the agent's evidence.
    const head = document.querySelector(".rv-head")!;
    expect(head.nextElementSibling).toBe(strip);
    expect(
      strip!.compareDocumentPosition(document.querySelector(".rv-evid")!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // Gates: each with its verdict word and the command it ran; the runner's count.
    const gates = text(".vd-gate-list");
    expect(gates).toContain("tests");
    expect(gates).toContain("passed");
    expect(gates).toContain("npm test");
    expect(gates).toContain("skipped");
    expect(gates).toContain("no command configured");
    expect(label(".vd-cell.vd-gates")).toBe("Gates: passed, 2 of 3 ran");
    expect(text(".vd-cell.vd-gates")).toContain("The runner saw 40 tests pass (vitest).");

    // The tester: its verdict and what it tested.
    expect(text(".vd-cell.vd-tester .vd-v")).toBe("Failed");
    expect(text(".vd-cell.vd-tester")).toContain("0123456789ab");
    expect(text(".vd-cell.vd-tester")).toContain("Exporting an empty list throws");
    expect(label(".vd-cell.vd-tester")).toBe(
      "Independent tester: failed, tested commit 0123456789ab",
    );

    // Cost and turns, the estimate and the budget said as such.
    expect(text(".vd-cell.vd-cost .vd-v")).toBe("$1.23");
    expect(text(".vd-cell.vd-cost")).toContain("31 turns");
    expect(text(".vd-cell.vd-cost")).toContain("$0.03 of it estimated");
    expect(text(".vd-cell.vd-cost")).toContain("budget $5");

    // The attempt and who sent it back before.
    expect(text(".vd-cell.vd-attempts .vd-v")).toBe("2 of 3");
    expect(text(".vd-cell.vd-attempts")).toContain("Sent back by the tests gate");
    expect(text(".vd-cell.vd-attempts")).toContain("Sent back by the tester");
    expect(label(".vd-cell.vd-attempts")).toBe("Attempt 2 of 3, sent back 2 times");

    // Risk: the level, the recorded reason, then the diff's own flag once it loads.
    expect(text(".vd-cell.vd-risk .vd-v")).toContain("medium risk");
    expect(text(".vd-cell.vd-risk")).toContain("observed 412 changed lines");
    expect(text(".vd-cell.vd-risk")).toContain("package.json changed");
    expect(label(".vd-cell.vd-risk")).toBe("Risk: medium, 2 reasons");

    // The reviewed-commit pin.
    expect(text(".vd-cell.vd-pin .vd-v")).toBe("fedcba987654");
    expect(text(".vd-cell.vd-pin")).toContain("By the agent review");
  });

  it("draws the strip and the gate-integrity banner together for a delivery that changed its tests", async () => {
    const finding = "deleted 1 test file (src/x.test.ts)";
    packet = {
      ...PACKET,
      gates: {
        ...PACKET.gates,
        rows: [
          ...PACKET.gates.rows,
          { gate: "integrity", repo: "svc", status: "FLAG", rc: "0", command: null, note: finding },
        ],
      },
    };
    diffAnns = [
      ...DEFAULT_ANNS,
      {
        kind: "test-modified",
        severity: "high",
        detail: finding,
        paths: ["src/x.test.ts"],
        items: ["deleted test file src/x.test.ts"],
      },
    ];
    extraEvidence = [
      {
        id: "dod-runner",
        evidence_type: "test_output",
        summary: `DoD: PASS\n${JSON.stringify({
          dod: "PASS",
          gates: [
            { gate: "tests", repo: "svc", status: "PASS", rc: "0", note: "npm test" },
            { gate: "integrity", repo: "svc", status: "FLAG", rc: "0", note: finding },
          ],
        })}`,
        created_by: "system",
        recorded_by_actor_type: "system",
        created_at: "2026-10-30T09:58:00Z",
      },
    ];
    await boot();
    // The verdict strip: the integrity row is flagged (the yellow "!"), not skipped,
    // and it is not counted among the gates that ran.
    const gi = [...document.querySelectorAll(".vd-gate-list .vd-gate")].find((li) =>
      li.textContent?.includes("integrity"),
    );
    expect(gi).toBeTruthy();
    expect(gi!.classList.contains("vd-g-flag")).toBe(true);
    expect(gi!.querySelector(".dod-mark.dod-flag")?.textContent).toBe("!");
    expect(gi!.querySelector(".vd-word")?.textContent).toBe("flagged");
    expect(gi!.querySelector(".vd-note")?.textContent).toBe(finding);
    expect(label(".vd-cell.vd-gates")).toBe("Gates: passed, 2 of 3 ran");
    // The strip's risk cell takes the diff's test-modified reason (strip._setRisk) …
    expect(text(".vd-cell.vd-risk")).toContain(finding);
    // … and the Sign-off's integrity banner is drawn beside it, with its flag card.
    const banner = document.querySelector(".integrity-banner");
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain("deleted test file src/x.test.ts");
    expect(document.querySelector(".rv-verdict")).not.toBeNull();
    const flagTitles = [...document.querySelectorAll(".flag-list .flag-title")].map(
      (h) => h.textContent,
    );
    expect(flagTitles).toContain("Test modified");
    // The gates checklist carries the runner's FLAG row too.
    expect(document.querySelector(".dod-item.dod-i-flag .dod-note")?.textContent).toContain(
      finding,
    );
  });

  it("names each gate's repo on a multi-repo ticket (exploratory finding ui-workflows/F10)", async () => {
    // Two write repos: the same gates ran once per repo. The strip listed "tests PASSED"
    // twice with nothing to say which repo each was.
    packet = {
      ...PACKET,
      gates: {
        ...PACKET.gates,
        rows: [
          {
            gate: "tests",
            repo: "notes-mini",
            status: "PASS",
            rc: "0",
            command: "npm test",
            note: null,
          },
          {
            gate: "lint",
            repo: "notes-mini",
            status: "PASS",
            rc: "0",
            command: "npm run lint",
            note: null,
          },
          {
            gate: "tests",
            repo: "taskflow-mini",
            status: "PASS",
            rc: "0",
            command: "npm test",
            note: null,
          },
          {
            gate: "lint",
            repo: "taskflow-mini",
            status: "PASS",
            rc: "0",
            command: "npm run lint",
            note: null,
          },
        ],
      },
    };
    await boot();
    const rows = [...document.querySelectorAll(".vd-gate-list .vd-gate")].map((r) =>
      (r.textContent ?? "").replace(/\s+/g, " "),
    );
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.includes("notes-mini"))).toHaveLength(2);
    expect(rows.filter((r) => r.includes("taskflow-mini"))).toHaveLength(2);
    expect(new Set(rows).size).toBe(4);
  });

  it("a one-repo ticket's gates carry no repo label", async () => {
    await boot();
    expect(document.querySelector(".vd-gate-list .vd-gate-repo")).toBeNull();
  });

  it("shows when the tester comes, and leaves the pin out when none is recorded", async () => {
    packet = { ...PACKET, tester: null, pin: null };
    await boot();
    expect(text(".vd-cell.vd-tester .vd-v")).toBe("After you");
    expect(label(".vd-cell.vd-tester")).toBe("Independent tester: runs after your approval");
    expect(document.querySelector(".vd-cell.vd-pin")).toBeNull();
  });

  it("tells a runner check from the agent's word in the criteria table", async () => {
    await boot();
    const rows = Array.from(document.querySelectorAll(".rv-ac-table tbody tr"));
    expect(rows).toHaveLength(3);
    const [runner, agent, none] = rows;
    expect(runner!.className).toContain("ac-ev-runner");
    expect(runner!.className).toContain("ac-ev-ok");
    expect(runner!.textContent).toContain("npm test -- clearDone");
    expect(runner!.textContent).toContain("Runner · exit 0");
    expect(runner!.textContent).toContain("verified by runner:check");
    expect(runner!.querySelector(".ycard")).toBeNull();
    expect(runner!.getAttribute("aria-label")).toBe(
      "clearDone removes completed tasks: satisfied. The runner ran the check: exit 0.",
    );

    // Agent-only evidence: a yellow card and the words, never an exit code.
    for (const r of [agent!, none!]) {
      expect(r.className).toContain("ac-ev-none");
      expect(r.querySelector(".ycard")).not.toBeNull();
      expect(r.textContent).toContain("No machine evidence");
      expect(r.textContent).not.toContain("exit");
    }
    expect(agent!.textContent).toContain("The agent's word");
    expect(agent!.getAttribute("aria-label")).toBe(
      "README documents clearDone: satisfied. No machine evidence: only the agent's word.",
    );
    expect(none!.textContent).toContain("Nothing recorded");
  });

  it("flags a test count the runner did not see, as a yellow card and in the strip", async () => {
    await boot();
    expect(text(".vd-cell.vd-gates .vd-flag")).toBe("The summary says 42, the runner saw 40.");
    const flag = Array.from(document.querySelectorAll(".flag")).find((f) =>
      f.textContent?.includes("Test count disagrees"),
    );
    expect(flag).toBeTruthy();
    expect(flag!.textContent).toContain("The summary says 42, the runner saw 40.");
    expect(flag!.textContent).toContain("All 42 tests pass.");
  });

  it("never reads an agent-recorded DoD row as the gates", async () => {
    await boot();
    // The forged FAIL row would have raised a "Gate failed" flag and a failed checklist.
    expect(document.querySelector(".review-dod")).toBeNull();
    expect(
      Array.from(document.querySelectorAll(".flag-title")).map((f) => f.textContent),
    ).not.toContain("Gate failed");
  });

  it("without a packet the page still renders (the old checklist, no strip)", async () => {
    packet = null;
    await boot();
    expect(document.querySelector(".rv-verdict")).toBeNull();
    expect(document.querySelector(".signoff")).not.toBeNull();
  });
});

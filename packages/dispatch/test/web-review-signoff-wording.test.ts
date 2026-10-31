// @vitest-environment jsdom
//
// The sign-off says exactly what Approve does (external UI review, fix 1).
//  - The reviewer's case: a review read "Nothing flagged" while the evidence below held an
//    explicit runner request for human review. The flags, the summary and a warning band
//    beside the button now all read the same rows the Evidence list renders.
//  - The primary button names the server's outcome (GET /diff approve_outcome): "Approve
//    and send to tester", "Approve, waits for Merge now", "Approve and land now". The
//    armed button never says "Confirm merge" unless a landing is what the click starts,
//    and a line under the button says what follows.
//  - After approval the button and the done band say where the change actually went.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const T = {
  id: "tkt-10",
  number: 10,
  title: "Webhook delivery for task events",
  description: "Deliver task events to subscribers.",
  status: "in_review",
  risk_level: "medium",
  policy_pack: "team_light",
  priority: 5,
  attempt_count: 0,
  branch_name: "gaffer/ticket-10",
  pr_url: null,
  can_be_tested: 1,
  test_contract: null,
  delivery_budget_usd: null,
  created_at: "2026-10-27T10:30:00Z",
  updated_at: "2026-10-29T11:48:00Z",
};
const DIFF = [
  "diff --git a/src/webhooks.ts b/src/webhooks.ts",
  "--- a/src/webhooks.ts",
  "+++ b/src/webhooks.ts",
  "@@ -1,1 +1,2 @@",
  " a",
  "+b",
].join("\n");
const DOD_PASS =
  "DoD: PASS\n" +
  JSON.stringify({
    dod: "PASS",
    gates: [{ gate: "tests", repo: "taskflow-api", status: "PASS", rc: 0, note: "pnpm test" }],
  });
const HUMAN_REQUEST = {
  id: "ev-needs-human",
  evidence_type: "manual_note",
  summary:
    "needs_human_review: oversized_diff — 41 files / 1210 lines exceeds the minimalism budget",
  created_by: "system",
  created_at: "2026-10-29T11:44:00Z",
};

type Outcome = Record<string, unknown>;
const OUTCOMES: Record<string, Outcome> = {
  to_tester: {
    kind: "to_tester",
    approvable: true,
    to_status: "in_testing",
    label: "Approve and send to tester",
    confirm_label: "Confirm: send to tester",
    done_label: "Sent to tester",
    sentence:
      "It moves to In testing, not to merge. Independent testing is on and this ticket is testable. A PASS takes it to Ready for merge, where it waits for Merge now.",
    via: null,
    pr_url: null,
    lands_repo: null,
    not_landed_repos: [],
    review_mode: "human",
  },
  waits_for_merge: {
    kind: "waits_for_merge",
    approvable: true,
    to_status: "ready_for_merge",
    label: "Approve, waits for Merge now",
    confirm_label: "Confirm approval",
    done_label: "Waits for Merge now",
    sentence:
      "It waits in Ready for merge: Auto-merge on approval is off, so it lands only when someone presses Merge now.",
    via: null,
    pr_url: null,
    lands_repo: null,
    not_landed_repos: [],
    review_mode: "human",
  },
  land_now: {
    kind: "land_now",
    approvable: true,
    to_status: "ready_for_merge",
    label: "Approve and land now",
    confirm_label: "Confirm and land now",
    done_label: "Landing now",
    sentence:
      "Auto-merge on approval is on: the merge runner starts now, runs the landing check and the merge gate, then it merges taskflow-api onto main locally.",
    via: "local",
    pr_url: null,
    lands_repo: "taskflow-api",
    not_landed_repos: [],
    review_mode: "human",
  },
  held_ci: {
    kind: "held_ci",
    approvable: false,
    to_status: null,
    label: "Approve held: CI not passed",
    confirm_label: "Approve held: CI not passed",
    done_label: "Approve held",
    sentence:
      "Required CI has not passed for abc123456789 (pending). The server refuses approval until a passing result is recorded for this commit.",
    via: null,
    pr_url: null,
    lands_repo: null,
    not_landed_repos: [],
    review_mode: "human",
  },
};

interface Opts {
  evidence?: unknown[];
  events?: unknown[];
  outcome?: Outcome | null;
  approved?: Record<string, unknown>;
  anns?: unknown[];
  packet?: unknown;
}
let posts: string[] = [];
function stubFetch(o: Opts = {}): void {
  posts = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init && init.method === "POST") posts.push(url);
      let body: unknown;
      if (url.includes("/review/approve"))
        body = o.approved || { ticket: { ...T, status: "in_testing" } };
      else if (url.includes("/dossier"))
        body = { schema: "dossier.v1", review_packet: o.packet ?? null };
      else if (url.includes("/diff"))
        body = {
          ticketId: T.id,
          repos: [
            {
              repo: "taskflow-api",
              branch: T.branch_name,
              baseBranch: "main",
              files: 1,
              additions: 1,
              deletions: 0,
              diff: DIFF,
              riskAnnotations: o.anns || [],
            },
          ],
          ...(o.outcome === null ? {} : { approve_outcome: o.outcome || OUTCOMES.to_tester }),
        };
      else if (url.includes(`/tickets/${T.id}`))
        body = {
          ticket: T,
          acceptance_criteria: [],
          repositories: [
            { id: "r1", name: "taskflow-api", local_path: "/data/taskflow-api", access: "write" },
          ],
          scopes: [],
          blocking_decisions: [],
          dependencies: [],
          evidence: o.evidence || [],
          events: o.events || [],
          rework_trail: [],
        };
      else if (url.includes("/agents")) body = { agents: [] };
      else body = { tickets: [T] };
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
  location.hash = `#/review/${T.id}`;
}
const tick = () => new Promise((r) => setTimeout(r, 0));
async function boot(): Promise<void> {
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
  for (let i = 0; i < 8; i++) await tick();
}
const btn = () => document.querySelector("button.signoff-btn") as HTMLButtonElement;

describe("web review: the sign-off never says Nothing flagged over a request for a human", () => {
  beforeEach(() => {
    vi.resetModules();
    mount();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("the reviewer's case: a runner human-review request in the evidence is flagged beside the button", async () => {
    stubFetch({
      evidence: [
        {
          id: "ev-dod",
          evidence_type: "test_output",
          summary: DOD_PASS,
          created_by: "system",
          created_at: "2026-10-29T11:40:00Z",
        },
        HUMAN_REQUEST,
      ],
    });
    await boot();
    const summary = document.querySelector(".signoff-sum")?.textContent || "";
    expect(summary).not.toContain("Nothing flagged");
    expect(summary).toMatch(/runner asks for a human review/i);
    // The warning sits in the sign-off block, beside the button, as a live status.
    const asks = document.querySelector(".signoff .signoff-asks") as HTMLElement;
    expect(asks, "a human-request band in the sign-off").toBeTruthy();
    expect(asks.getAttribute("role")).toBe("status");
    expect(asks.textContent).toContain("oversized_diff");
    expect(asks.compareDocumentPosition(btn()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The flag list counts it, and the evidence row it came from is marked.
    expect(document.querySelector(".flag-none")).toBeNull();
    expect(document.querySelector(".rv-flags .flag-title")?.textContent).toBe(
      "Runner asks for a human review",
    );
    const row = document.querySelector(".review-evi.evi-asks") as HTMLElement;
    expect(row?.textContent).toContain("needs_human_review");
    expect(row?.textContent).toContain("asks for a human");
  });

  it("a reviewer agent's CHANGES and a tester FAIL are requests for a human too", async () => {
    stubFetch({
      evidence: [
        {
          id: "ev-rv",
          evidence_type: "manual_note",
          summary: "Reviewer agent (advisory): changes requested — retry on 5xx is missing",
          created_by: "system",
          created_at: "2026-10-29T11:41:00Z",
        },
        {
          id: "ev-t",
          evidence_type: "test_output",
          summary: "contract case 3 failed: no retry header",
          payload_json: JSON.stringify({ verdict: "fail", provenance: "agent" }),
          created_by: "tester",
          created_at: "2026-10-29T11:42:00Z",
        },
      ],
    });
    await boot();
    const asks = document.querySelector(".signoff-asks")?.textContent || "";
    expect(asks).toContain("Reviewer asked for changes");
    expect(asks).toContain("Tester asked for changes");
    expect(document.querySelector(".signoff-sum")?.textContent).not.toContain("Nothing flagged");
  });

  it("with nothing asking for a human it still says Nothing flagged, and shows no band", async () => {
    stubFetch({
      evidence: [
        {
          id: "ev-dod",
          evidence_type: "test_output",
          summary: DOD_PASS,
          created_by: "system",
          created_at: "2026-10-29T11:40:00Z",
        },
      ],
    });
    await boot();
    expect(document.querySelector(".signoff-sum")?.textContent).toContain("Nothing flagged");
    expect(document.querySelector(".signoff-asks")).toBeNull();
  });
});

describe("web review: the button names what Approve does", () => {
  beforeEach(() => {
    vi.resetModules();
    mount();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("the tester lane: 'Approve and send to tester', armed never as a merge, and a line under it", async () => {
    stubFetch({ outcome: OUTCOMES.to_tester });
    await boot();
    expect(btn().textContent).toBe("Approve and send to tester");
    const next = document.querySelector(".signoff-next") as HTMLElement;
    expect(next.hidden).toBe(false);
    expect(next.textContent).toContain("In testing");
    expect(btn().getAttribute("aria-describedby")).toBe(next.id);
    btn().click(); // arm
    expect(btn().textContent).toBe("Confirm: send to tester");
    expect(btn().textContent).not.toMatch(/merge/i);
    expect(document.querySelector(".rv-arm")?.textContent).not.toMatch(/merge/i);
    btn().click(); // approve
    for (let i = 0; i < 6; i++) await tick();
    expect(posts.filter((p) => p.includes("/review/approve"))).toHaveLength(1);
    expect(btn().textContent).toContain("Sent to tester");
    expect(document.querySelector(".rv-done")?.textContent).toContain("tester");
    expect(document.querySelector(".rv-done")?.textContent).not.toMatch(/merge runner/i);
  });

  it("AUTO_MERGE off: 'Approve, waits for Merge now', and the done band says it waits", async () => {
    stubFetch({
      outcome: OUTCOMES.waits_for_merge,
      approved: {
        ticket: { ...T, status: "ready_for_merge" },
        merge: { triggered: false, pid: null, skipped: "auto_merge_off" },
        approve_outcome: OUTCOMES.waits_for_merge,
      },
    });
    await boot();
    expect(btn().textContent).toBe("Approve, waits for Merge now");
    btn().click();
    expect(btn().textContent).toBe("Confirm approval");
    btn().click();
    for (let i = 0; i < 6; i++) await tick();
    expect(btn().textContent).toContain("Waits for Merge now");
    expect(document.querySelector(".rv-done")?.textContent).toContain("Merge now");
  });

  it("a landing now is the only outcome whose confirmation names the landing", async () => {
    stubFetch({ outcome: OUTCOMES.land_now });
    await boot();
    expect(btn().textContent).toBe("Approve and land now");
    btn().click();
    expect(btn().textContent).toBe("Confirm and land now");
  });

  it("required CI not passed: the button stays disabled and says why", async () => {
    stubFetch({ outcome: OUTCOMES.held_ci });
    await boot();
    expect(btn().disabled).toBe(true);
    expect(btn().textContent).toBe("Approve held: CI not passed");
    expect(document.querySelector(".diff-block-banner")?.textContent).toContain("Required CI");
  });

  it("an older server with no approve_outcome: plain Approve, and the arm says no merge", async () => {
    stubFetch({ outcome: null, approved: { ticket: { ...T, status: "in_testing" } } });
    await boot();
    expect(btn().textContent).toBe("Approve");
    btn().click();
    expect(btn().textContent).toBe("Confirm approval");
    btn().click();
    for (let i = 0; i < 6; i++) await tick();
    expect(document.querySelector(".rv-done")?.textContent).toContain("tester");
  });
});

// GATE INTEGRITY + THE REVIEW PACKET: the flags, the summary and the band beside the button
// read the verdict strip's own gate rows, and the tests changing is one finding said once.
const INTEGRITY_NOTE = "deleted 1 test file (src/webhooks.test.ts)";
function packet(rows: Array<Record<string, unknown>>, overall = "PASS") {
  return {
    gates: { overall, recorded_at: "2026-10-29T11:40:00Z", rows, tally: null },
    tester: null,
    tester_expected: false,
    cost: {
      cost_usd: 0.5,
      measured_usd: 0.5,
      estimated_usd: 0,
      num_turns: 4,
      unknown_calls: 0,
      ledger_status: "ok",
      budget_usd: null,
    },
    attempts: { attempt_count: 0, max_attempts: 3, rework: [] },
    risk: { level: "medium", reasons: [] },
    pin: null,
    acceptance: [],
    disagreements: [],
  };
}
const TESTS_PASS = {
  gate: "tests",
  repo: "taskflow-api",
  status: "PASS",
  rc: "0",
  command: "pnpm test",
  note: null,
};
const INTEGRITY_FLAG = {
  gate: "integrity",
  repo: "taskflow-api",
  status: "FLAG",
  rc: "0",
  command: null,
  note: INTEGRITY_NOTE,
};
const TEST_MODIFIED = {
  kind: "test-modified",
  severity: "high",
  detail: INTEGRITY_NOTE,
  paths: ["src/webhooks.test.ts"],
  items: ["deleted test file src/webhooks.test.ts"],
};
const ESCALATED = {
  id: "e-esc",
  event_type: "ticket.autoship_escalated",
  actor_type: "agent",
  payload_json: JSON.stringify({
    declared: "medium",
    observed: "high",
    reasons: ["tests modified: " + INTEGRITY_NOTE],
    holds: ["tests modified: " + INTEGRITY_NOTE],
  }),
  created_at: "2026-10-29T11:45:00Z",
};

describe("web review: one source of evidence, one finding said once", () => {
  beforeEach(() => {
    vi.resetModules();
    mount();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });
  const titles = () =>
    [...document.querySelectorAll(".rv-flags .flag-title")].map((h) => h.textContent);

  it("the flags and the summary read the strip's gate rows, never an evidence row it does not trust", async () => {
    // A DoD-looking FAIL row with no recorded actor (a legacy or hand-made row): the strip,
    // which reads only the runner's own record, says the gates passed; so must the sign-off.
    stubFetch({
      packet: packet([TESTS_PASS]),
      evidence: [
        {
          id: "ev-dod-legacy",
          evidence_type: "test_output",
          summary:
            "DoD: FAIL\n" +
            JSON.stringify({
              dod: "FAIL",
              gates: [{ gate: "tests", repo: "taskflow-api", status: "FAIL", note: "exit 1" }],
            }),
          created_by: "someone",
          created_at: "2026-10-29T11:41:00Z",
        },
      ],
    });
    await boot();
    expect(document.querySelector(".rv-verdict .vd-gates .vd-v")?.textContent).toBe("Passed");
    expect(titles()).not.toContain("Gate failed");
    const summary = document.querySelector(".signoff-sum")?.textContent || "";
    expect(summary).toContain("Gates passed");
    expect(summary).not.toContain("A gate failed");
  });

  it("tests changed: one Test modified flag, no repeat in the band, and the line says a human approval is not held", async () => {
    stubFetch({
      packet: packet([TESTS_PASS, INTEGRITY_FLAG]),
      anns: [TEST_MODIFIED],
      events: [ESCALATED],
      outcome: {
        ...OUTCOMES.waits_for_merge,
        sentence:
          "It waits in Ready for merge: Auto-merge on approval is off, so it lands only when someone presses Merge now. The tests that gate it changed: your approval is not held by that (only an agent's or auto approval is), and the test-changes banner above lists what changed.",
        agent_hold: {
          kind: "held_test_modified",
          label: "Approve held: tests changed, a person must allow it",
          sentence: "The delivery changed the tests that gate it.",
          holds: ["tests modified: " + INTEGRITY_NOTE],
        },
      },
    });
    await boot();
    // The strip shows the runner's integrity row as flagged; the banner names the change.
    expect(document.querySelector(".rv-verdict .vd-g-flag")).not.toBeNull();
    expect(document.querySelector(".signoff .integrity-banner")).not.toBeNull();
    // The flags band lists the finding once: no integrity-gate or observed-risk repeat.
    const t = titles();
    expect(t.filter((x) => x === "Test modified")).toHaveLength(1);
    expect(t).not.toContain("Gate flagged: integrity");
    expect(t).not.toContain("Observed risk above declared");
    expect(t).not.toContain("Auto-approve held: tests changed");
    // The band beside the button does not repeat the banner.
    expect(document.querySelector(".signoff-asks")).toBeNull();
    // The human's button is not held; its line says so and points at the banner.
    expect(btn().disabled).toBe(false);
    expect(btn().textContent).toBe("Approve, waits for Merge now");
    const next = document.querySelector(".signoff-next")?.textContent || "";
    expect(next).toContain("your approval is not held by that");
    expect(next).toContain("test-changes banner");
  });

  it("the runner's integrity FLAG with a clean diff (a git-ignored file) is still asked, once", async () => {
    stubFetch({ packet: packet([TESTS_PASS, INTEGRITY_FLAG]), events: [ESCALATED] });
    await boot();
    const t = titles();
    expect(t.filter((x) => x === "Gate flagged: integrity")).toHaveLength(1);
    expect(t).not.toContain("Observed risk above declared");
    expect(t).not.toContain("Auto-approve held: tests changed");
    expect(document.querySelector(".signoff-asks")?.textContent).toContain(INTEGRITY_NOTE);
  });

  it("an escalation for the tests changing, with no other record of it, says that, not a risk level", async () => {
    stubFetch({ packet: packet([TESTS_PASS]), events: [ESCALATED] });
    await boot();
    const t = titles();
    expect(t).toContain("Auto-approve held: tests changed");
    expect(t).not.toContain("Observed risk above declared");
    expect(document.querySelector(".signoff-asks")?.textContent).toContain(
      "a human approval is not",
    );
  });
});

// @vitest-environment jsdom
//
// REVIEW FACTS on The Gaffer's Sign-off (Release A, A4 + A5):
//  - "What was asked": the ticket's description, inside the header above the runner's
//    strip, as text (a description is untrusted text);
//  - the Candidate cell: the gated, shown, tested and pinned commits, and whether they are
//    one commit; a gated commit that is not the head joins the ONE flags list;
//  - the CI cell: the latest recorded result for the candidate commit;
//  - run-log links that open /api/runs/:id/log;
//  - "What backs this / What is not backed": the server's rows, no score, no second summary;
//  - the Behavioural surface panel above the diff, each fact with its method and a link to
//    its file in the diff; it feeds a "not backed" row.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");
const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);

const T = {
  id: "tkt-9",
  number: 9,
  title: "Clear done tasks",
  status: "in_review",
  risk_level: "low",
  policy_pack: "team_light",
  attempt_count: 0,
  branch_name: "gaffer/ticket-9",
  pr_url: null,
  created_at: "2026-10-29T09:00:00Z",
  updated_at: "2026-10-30T10:00:00Z",
};

function basePacket(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gates: {
      overall: "PASS",
      recorded_at: "2026-10-30T09:58:00Z",
      rows: [
        { gate: "tests", repo: "svc", status: "PASS", rc: "0", command: "npm test", note: null },
      ],
      tally: null,
    },
    tester: null,
    tester_expected: true,
    cost: {
      cost_usd: 0.5,
      measured_usd: 0.5,
      estimated_usd: 0,
      num_turns: 3,
      unknown_calls: 0,
      ledger_status: "ok",
      budget_usd: null,
    },
    attempts: { attempt_count: 0, max_attempts: 3, rework: [] },
    risk: { level: "low", reasons: [] },
    pin: null,
    acceptance: [],
    disagreements: [],
    judge: null,
    intent: "Users can clear every <b>done</b> task in one click.",
    candidate: [
      {
        repo_id: "r1",
        repo: "svc",
        gated_sha: HEAD,
        gated_by: "runner",
        gated_earlier: false,
        diff_head: HEAD,
        head_unavailable: null,
        tester_tested: null,
        pin: null,
        same: true,
      },
    ],
    ci: {
      required: true,
      state: "pass",
      commit: HEAD,
      at: "2026-10-30T09:59:00Z",
      detail: "unit ok",
      latest: null,
    },
    run_links: [
      {
        role: "delivery",
        run_id: "run-1",
        kind: "poll_work",
        status: "succeeded",
        started_at: "2026-10-30T09:50:00Z",
        ended_at: "2026-10-30T10:01:00Z",
        href: "/api/runs/run-1/log",
        method: "time window",
      },
    ],
    backing: [
      {
        fact: "The gates ran on the commit the diff shows (aaaaaaaaaaaa)",
        holds: true,
        source: "ticket_repo_delivery.commit_sha = the delivery branch head",
        cell: "candidate",
      },
      {
        fact: "The runner's gates passed",
        holds: true,
        source: "the runner's DoD row (system)",
        cell: "gates",
      },
      {
        fact: "The independent tester has not run (it runs after you approve)",
        holds: false,
        source: "the tester's verdict rows",
        cell: "tester",
      },
    ],
    ...over,
  };
}

const IMPACT = {
  facts: [
    {
      kind: "export_added",
      text: "export function clearDone added",
      path: "src/tasks.ts",
      line: 12,
      method: "from the diff's lines",
    },
    {
      kind: "untested_module",
      text: "src/tasks.ts changed and no test file in this change imports it",
      path: "src/tasks.ts",
      line: null,
      method: "by import text",
    },
  ],
  none: ["migration or DDL", "config", "environment variable", "dependency"],
  not_analysed: ["Callers of changed symbols and their test coverage: not analysed."],
};

let packet: Record<string, unknown> = basePacket();
let diffHead: string = HEAD;
let impact: unknown = IMPACT;
let calls: string[] = [];
let capability = "full";
function stubFetch(): void {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      let body: unknown;
      if (url.includes("/api/whoami"))
        body = { capability, actor: { type: "human", id: "viewer" } };
      else if (url.includes("status=in_review")) body = { tickets: [T] };
      else if (url.includes("/dossier"))
        body = { schema: "dossier.v1", hash: "x", subject: {}, review_packet: packet };
      else if (url.includes("/diff"))
        body = {
          ticketId: T.id,
          repos: [
            {
              repo: "svc",
              repoId: "r1",
              headSha: diffHead,
              branch: T.branch_name,
              baseBranch: "main",
              files: 1,
              additions: 2,
              deletions: 0,
              diff:
                "diff --git a/src/tasks.ts b/src/tasks.ts\n--- a/src/tasks.ts\n+++ b/src/tasks.ts\n" +
                "@@ -10,1 +10,3 @@\n a\n+\n+export function clearDone() {}",
              riskAnnotations: [],
              ...(impact ? { impact } : {}),
            },
          ],
        };
      else if (url.includes("/api/runs/run-1/log"))
        return new Response("tick log line\n", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      else if (url.includes(`/tickets/${T.id}`))
        body = {
          ticket: T,
          acceptance_criteria: [],
          repositories: [{ id: "r1", name: "svc", local_path: "/r/svc", access: "write" }],
          evidence: [],
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

describe("web: review facts on The Gaffer's Sign-off", () => {
  beforeEach(() => {
    packet = basePacket();
    diffHead = HEAD;
    impact = IMPACT;
    capability = "full";
    vi.resetModules();
    stubFetch();
    mount();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("shows what was asked inside the header, above the strip, as text", async () => {
    await boot();
    const intent = document.querySelector(".rv-head .rv-intent");
    expect(intent).not.toBeNull();
    expect(text(".rv-intent .rv-intent-h")).toBe("What was asked");
    expect(text(".rv-intent .rv-intent-t")).toBe(
      "Users can clear every <b>done</b> task in one click.",
    );
    expect(intent!.querySelector("b")).toBeNull();
    // The strip still follows the header directly.
    expect(document.querySelector(".rv-head")!.nextElementSibling).toBe(
      document.querySelector(".rv-verdict"),
    );
  });

  it("a ticket with no description says so instead of an empty block", async () => {
    packet = basePacket({ intent: null });
    await boot();
    expect(text(".rv-intent .rv-intent-t")).toContain("The ticket has no description");
  });

  it("the Candidate cell says one commit when gated, shown and tested agree", async () => {
    await boot();
    const cell = document.querySelector(".vd-cell.vd-candidate")!;
    expect(cell.querySelector(".vd-v")!.textContent).toBe("One commit");
    expect(cell.classList.contains("vd-ok")).toBe(true);
    expect(text(".vd-cell.vd-candidate")).toContain("Gates ran on aaaaaaaaaaaa");
    expect(text(".vd-cell.vd-candidate")).toContain("The diff shows aaaaaaaaaaaa");
    expect(text(".vd-cell.vd-candidate")).toContain("Tester tested nothing yet");
    expect(text(".signoff-sum")).toContain("Nothing flagged");
  });

  it("a gated commit that is not the head reads Differs and joins the one flags list", async () => {
    packet = basePacket({
      candidate: [
        {
          repo_id: "r1",
          repo: "svc",
          gated_sha: OTHER,
          gated_by: "runner",
          diff_head: HEAD,
          head_unavailable: null,
          tester_tested: null,
          pin: null,
          same: false,
        },
      ],
    });
    await boot();
    expect(text(".vd-cell.vd-candidate .vd-v")).toBe("Differs");
    expect(text(".flag-list")).toContain("Not the gated commit");
    expect(text(".flag-list")).toContain(`The gates ran on ${OTHER.slice(0, 12)}`);
    // One list: the summary reads it, never "Nothing flagged" beside an ask.
    expect(text(".signoff-sum")).toContain("not the gated commit");
    expect(text(".signoff-sum")).not.toContain("Nothing flagged");
  });

  const cand = (over: Record<string, unknown>) => [
    {
      repo_id: "r1",
      repo: "svc",
      gated_sha: OTHER,
      gated_by: "runner",
      gated_earlier: false,
      diff_head: HEAD,
      head_unavailable: null,
      tester_tested: null,
      pin: null,
      same: false,
      ...over,
    },
  ];
  const approveButton = () =>
    Array.from(document.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Approve"),
    ) as HTMLButtonElement | undefined;

  it("Differs is a flag, never a hold: Approve stays live (holds are the server's)", async () => {
    packet = basePacket({ candidate: cand({}) });
    await boot();
    expect(text(".vd-cell.vd-candidate .vd-v")).toBe("Differs");
    const approve = approveButton();
    expect(approve).toBeDefined();
    expect(approve!.hasAttribute("disabled")).toBe(false);
    // One flag for it, not two.
    expect(text(".flag-list").match(/Not the gated commit/g)).toHaveLength(1);
  });

  it("a rework before the runner's record lands reads Not recorded, not Differs", async () => {
    packet = basePacket({ candidate: cand({ gated_earlier: true }) });
    await boot();
    expect(text(".vd-cell.vd-candidate .vd-v")).toBe("Not recorded");
    expect(document.querySelector(".vd-cell.vd-candidate")!.classList.contains("vd-warn")).toBe(
      true,
    );
    expect(text(".vd-cell.vd-candidate")).toContain("an earlier attempt's record");
    expect(text(".flag-list")).toContain("Gated commit not recorded yet");
    expect(text(".flag-list")).not.toContain("Not the gated commit");
    expect(text(".signoff-sum")).toContain("gated commit not recorded yet");
  });

  it("the agent's record of the head is Unknown, never Differs", async () => {
    packet = basePacket({ candidate: cand({ gated_sha: HEAD, gated_by: "agent" }) });
    await boot();
    expect(text(".vd-cell.vd-candidate .vd-v")).toBe("Unknown");
    expect(text(".vd-cell.vd-candidate")).toContain("(the agent's record)");
    expect(text(".vd-cell.vd-candidate")).not.toContain("These are not one commit");
    expect(text(".flag-list")).not.toContain("Not the gated commit");
  });

  it("Moved after Differs is one tone (warn), not warn and bad at once", async () => {
    packet = basePacket({ candidate: cand({ gated_sha: "c".repeat(40) }) });
    diffHead = OTHER;
    await boot();
    const cell = document.querySelector(".vd-cell.vd-candidate")!;
    expect(cell.querySelector(".vd-v")!.textContent).toBe("Moved");
    expect(cell.classList.contains("vd-warn")).toBe(true);
    expect(cell.classList.contains("vd-bad")).toBe(false);
  });

  it("a read token sees the facts with no write affordance", async () => {
    capability = "read";
    packet = basePacket({ candidate: cand({}) });
    await boot();
    expect(document.querySelector(".rv-intent")).not.toBeNull();
    expect(document.querySelector(".vd-cell.vd-candidate")).not.toBeNull();
    expect(document.querySelector(".rv-backing")).not.toBeNull();
    expect(document.querySelector(".rv-impact")).not.toBeNull();
    const approve = approveButton();
    if (approve) expect(approve.hasAttribute("disabled")).toBe(true);
    // The new panels hold only links and folds: no form, no input.
    for (const sel of [".rv-intent", ".vd-cell.vd-candidate", ".rv-backing", ".rv-impact"])
      expect(
        document.querySelector(sel)!.querySelector("form, input, textarea, select"),
      ).toBeNull();
  });

  it("the diff on screen at a newer head than the packet read: the cell says Moved", async () => {
    diffHead = OTHER;
    await boot();
    expect(text(".vd-cell.vd-candidate .vd-v")).toBe("Moved");
    expect(text(".vd-cell.vd-candidate")).toContain("The branch moved");
  });

  it("the CI cell shows the candidate commit's recorded result", async () => {
    await boot();
    expect(text(".vd-cell.vd-ci .vd-v")).toBe("Green");
    expect(text(".vd-cell.vd-ci")).toContain("Recorded for aaaaaaaaaaaa");
    expect(text(".vd-cell.vd-ci")).toContain("unit ok");
  });

  it("no CI on record reads None", async () => {
    packet = basePacket({ ci: null });
    await boot();
    expect(text(".vd-cell.vd-ci .vd-v")).toBe("None");
  });

  it("a run-log link opens the delivery run's log", async () => {
    await boot();
    const btn = document.querySelector<HTMLButtonElement>(".vd-runlink")!;
    expect(btn.textContent).toBe("delivery run log");
    // How the link was found is said on screen, not only in a tooltip.
    expect(text(".vd-runlinks")).toContain("(found by time)");
    btn.click();
    for (let i = 0; i < 6; i++) await tick();
    expect(calls.some((u) => u.includes("/api/runs/run-1/log"))).toBe(true);
  });

  it("no run link recorded says so", async () => {
    packet = basePacket({ run_links: [] });
    await boot();
    expect(document.querySelector(".vd-runlink")).toBeNull();
    expect(text(".vd-runlinks")).toContain("No run log is recorded for this delivery");
  });

  it("what backs this / what is not backed: two lists of facts, no score, no second summary", async () => {
    await boot();
    const panel = document.querySelector(".rv-backing")!;
    expect(panel).not.toBeNull();
    expect(text(".rv-backing .rv-backs")).toContain("The runner's gates passed");
    expect(text(".rv-backing .rv-unbacked")).toContain("The independent tester has not run");
    expect(panel.textContent).not.toMatch(/%|score|confiden|Nothing flagged/i);
    // Each row names its source.
    expect(text(".rv-backing .rv-backs")).toContain("the runner's DoD row (system)");
  });

  it("the Behavioural surface panel sits above the diff, each fact with its method and file link", async () => {
    await boot();
    const panel = document.querySelector(".rv-diff .rv-impact")!;
    expect(panel).not.toBeNull();
    expect(text(".rv-impact .rv-h3, .rv-impact h3")).toContain("Behavioural surface");
    // Above the diff box.
    expect(
      panel.compareDocumentPosition(document.querySelector(".rv-diff .diff-box")!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const facts = [...panel.querySelectorAll(".rv-impact-fact")].map((li) =>
      li.textContent!.replace(/\s+/g, " "),
    );
    expect(facts[0]).toContain("export function clearDone added");
    expect(facts[0]).toContain("from the diff's lines");
    expect(facts[1]).toContain("by import text");
    expect(text(".rv-impact")).toContain(
      "No migration or DDL, config, environment variable or dependency change found.",
    );
    expect(text(".rv-impact")).toContain(
      "Callers of changed symbols and their test coverage: not analysed.",
    );
    expect(text(".rv-impact")).toContain("Advisory");
    // The file link opens that file's block in the diff.
    const go = panel.querySelector<HTMLButtonElement>(".rv-impact-go")!;
    expect(go.dataset.fileTarget).toBe("diff-file-0-0");
    // The untested module feeds a "not backed" row.
    expect(text(".rv-backing .rv-unbacked")).toContain(
      "1 changed module has no test in this change that imports it",
    );
  });

  it("a diff without impact facts (an older server) draws no panel", async () => {
    impact = null;
    await boot();
    expect(document.querySelector(".rv-impact")).toBeNull();
  });

  it("reads the impact facts with the one diff read (no second request)", async () => {
    await boot();
    expect(calls.filter((u) => u.includes(`/tickets/${T.id}/diff`))).toEqual([
      expect.stringMatching(/\/diff$/),
    ]);
  });
});

// @vitest-environment jsdom
//
// The ticket page's attempt history names WHICH model served each delivery attempt
// and WHICH Claude Code CLI ran it, from the runner's agent-run evidence
// (runner/factory.config.sh gaffer_record_agent_run → evidence_type "log",
// payload kind "agent_run"). A failed attempt carries the line under its head; a
// ticket that never failed still gets a plain list of its attempts.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const TICKET = {
  id: "tkt-9",
  number: 9,
  title: "Widget endpoint",
  description: "deliver it",
  status: "in_review",
  risk_level: "low",
  policy_pack: "team_light",
  priority: 0,
  attempt_count: 0,
  branch_name: "gaffer/ticket-9",
  pr_url: null,
  can_be_tested: 0,
  test_contract: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

function run(attempt: number, at: string, over: Record<string, unknown> = {}) {
  return {
    id: `ev-${attempt}-${at}`,
    ticket_id: TICKET.id,
    ac_id: null,
    repo_id: null,
    decision_id: null,
    evidence_type: "log",
    summary: `Agent run, attempt ${attempt}/3`,
    uri: null,
    payload_json: JSON.stringify({
      kind: "agent_run",
      role: "delivery",
      attempt,
      max_attempts: 3,
      model_requested: "stub-requested",
      models_served: [`stub-served-${attempt}`],
      claude_version: `4.${attempt}.0 (Claude Code)`,
      rc: 0,
      ...over,
    }),
    created_by: "system",
    recorded_by_actor_type: "system",
    created_at: at,
  };
}

// The runner's real numbering (tick.sh `wg runner-rework --attempt $_next`): the
// failure of run N is filed on the trail as attempt N+1, recorded after run N and
// before run N+1 starts.
function failure(trailAttempt: number, at: string, gate = "tests") {
  return {
    id: `rw${trailAttempt}`,
    ticket_id: TICKET.id,
    attempt: trailAttempt,
    max_attempts: 3,
    gate,
    distilled_failure: `FAIL on the go before ${trailAttempt}: expected 3 to be 4`,
    ac_id: null,
    created_at: at,
  };
}

function stubFetch(evidence: unknown[], trail: unknown[]): void {
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
          evidence,
          events: [],
          rework_trail: trail,
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
async function boot(): Promise<void> {
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}-${Math.random()}`);
  for (let i = 0; i < 4; i++) await tick();
}

describe("web: the attempt history names the model and the CLI", () => {
  beforeEach(() => {
    mountShell();
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("names the run that produced each failure, not the retry after it", async () => {
    // Run 1 (served-1) fails the tests gate; the trail files it as attempt 2. Run 2
    // (served-2, a different model) fails again, filed as attempt 3. Run 3 follows.
    stubFetch(
      [
        run(1, "2026-01-02T00:00:00Z"),
        run(2, "2026-01-02T00:10:00Z"),
        run(3, "2026-01-02T00:20:00Z"),
      ],
      [failure(2, "2026-01-02T00:05:00Z"), failure(3, "2026-01-02T00:15:00Z", "typecheck")],
    );
    await boot();
    const attempts = [...document.querySelectorAll(".failure-history .failure-attempt")];
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.querySelector(".attempt-run")?.textContent).toBe(
      "Model stub-served-1 · CLI 4.1.0 (Claude Code)",
    );
    expect(attempts[1]!.querySelector(".attempt-run")?.textContent).toBe(
      "Model stub-served-2 · CLI 4.2.0 (Claude Code)",
    );
    // Run 3 came after the last failure: it is listed on its own row, not dropped.
    const later = [...document.querySelectorAll(".failure-history .failure-run")];
    expect(later).toHaveLength(1);
    expect(later[0]!.textContent).toContain("Attempt 3/3");
    expect(later[0]!.querySelector(".attempt-run")?.textContent).toBe(
      "Model stub-served-3 · CLI 4.3.0 (Claude Code)",
    );
    expect(document.querySelectorAll(".failure-history .failure-kick-none")).toHaveLength(0);
  });

  it("shows the model of the attempt that passed after a failed one", async () => {
    // Attempt 1 (weak model) fails lint, filed on the trail as attempt 2; attempt 2
    // (the escalation model) is delivered. Both models must be on the page.
    stubFetch(
      [
        run(1, "2026-01-02T00:00:00Z", { models_served: ["weak-m-served"], max_attempts: 2 }),
        run(2, "2026-01-02T00:10:00Z", {
          models_served: ["strong-m-served"],
          model_requested: "strong-m",
          max_attempts: 2,
        }),
      ],
      [{ ...failure(2, "2026-01-02T00:05:00Z", "lint"), max_attempts: 2 }],
    );
    await boot();
    const card = document.querySelector(".failure-history")!;
    const lines = [...card.querySelectorAll(".attempt-run")].map((n) => n.textContent);
    expect(lines).toEqual([
      "Model weak-m-served · CLI 4.1.0 (Claude Code)",
      "Model strong-m-served · CLI 4.2.0 (Claude Code)",
    ]);
    expect(card.querySelector(".failure-attempt")?.textContent).toContain("lint failed");
    expect(card.querySelector(".failure-run")?.textContent).toContain("Attempt 2/2");
    expect(card.querySelector("h2")?.textContent).toContain("2 of 2 used");
    // Both goes were taken: no "not taken" kick is left on the sheet.
    expect(card.querySelectorAll(".failure-kick-none")).toHaveLength(0);
  });

  it("labels each failure with the attempt that failed, the number its run carries", async () => {
    // The live two-attempt case: run 1 (weak-m) fails DoD and is filed on the trail as
    // attempt 2; run 2 (strong-m) is delivered. The failure is attempt 1's, so it must
    // read "Attempt 1/2" next to weak-m, and the delivered run "Attempt 2/2": no two
    // rows claim the same attempt.
    stubFetch(
      [
        run(1, "2026-01-02T00:00:00Z", { models_served: ["weak-m-served"], max_attempts: 2 }),
        run(2, "2026-01-02T00:10:00Z", { models_served: ["strong-m-served"], max_attempts: 2 }),
      ],
      [{ ...failure(2, "2026-01-02T00:05:00Z", "definition-of-done"), max_attempts: 2 }],
    );
    await boot();
    const card = document.querySelector(".failure-history")!;
    const failed = card.querySelector(".failure-attempt")!;
    expect(failed.querySelector(".failure-attempt-num")?.textContent).toBe("Attempt 1/2");
    expect(failed.querySelector(".attempt-run")?.textContent).toContain("weak-m-served");
    expect(failed.querySelector("pre")?.getAttribute("aria-label")).toBe(
      "Attempt 1 failure output",
    );
    const passed = card.querySelector(".failure-run")!;
    expect(passed.querySelector(".failure-attempt-num")?.textContent).toBe("Attempt 2/2");
    expect(passed.querySelector(".attempt-run")?.textContent).toContain("strong-m-served");
    const labels = [...card.querySelectorAll(".failure-attempt-num")].map((n) => n.textContent);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("labels a failure whose agent never ran with its own attempt too", async () => {
    // Trail attempts 2 and 3 are the failures of attempts 1 and 2; the kick left is 3.
    stubFetch(
      [run(1, "2026-01-02T00:00:00Z")],
      [failure(2, "2026-01-02T00:05:00Z"), failure(3, "2026-01-02T00:07:00Z", "agent-env-install")],
    );
    await boot();
    const labels = [...document.querySelectorAll(".failure-history .failure-attempt-num")].map(
      (n) => n.textContent,
    );
    expect(labels).toEqual(["Attempt 1/3", "Attempt 2/3", "Attempt 3/3"]);
  });

  it("shows the last allowed attempt as failed, with its run, when the ticket parked", async () => {
    // Cap 3, every attempt red. The runner files the final failure (attempt 3) on the
    // trail too, as attempt 4 (one past the cap), just before it parks the ticket.
    stubFetch(
      [
        run(1, "2026-01-02T00:00:00Z"),
        run(2, "2026-01-02T00:10:00Z"),
        run(3, "2026-01-02T00:20:00Z", { models_served: ["strong-m-served"] }),
      ],
      [
        failure(2, "2026-01-02T00:05:00Z"),
        failure(3, "2026-01-02T00:15:00Z"),
        failure(4, "2026-01-02T00:25:00Z", "definition-of-done"),
      ],
    );
    await boot();
    const card = document.querySelector(".failure-history")!;
    const rows = [...card.querySelectorAll(".failure-attempt")];
    expect(rows).toHaveLength(3);
    const last = rows[2]!;
    expect(last.querySelector(".failure-attempt-num")?.textContent).toBe("Attempt 3/3");
    expect(last.querySelector(".failure-gate")?.textContent).toBe("definition-of-done failed");
    expect(last.querySelector(".attempt-run")?.textContent).toBe(
      "Model strong-m-served · CLI 4.3.0 (Claude Code)",
    );
    // Every go is accounted for by a failure: no "not taken" kick, no orphan run row.
    expect(card.querySelectorAll(".failure-kick-none")).toHaveLength(0);
    expect(card.querySelectorAll(".failure-run")).toHaveLength(0);
    expect(card.textContent).not.toContain("No failure recorded");
    expect(card.textContent).not.toContain("not taken");
    expect(card.querySelector("h2")?.textContent).toContain("3 of 3 used");
  });

  it("shows a last attempt that failed before its agent ran as failed, with no model", async () => {
    stubFetch(
      [run(1, "2026-01-02T00:00:00Z"), run(2, "2026-01-02T00:10:00Z")],
      [
        failure(2, "2026-01-02T00:05:00Z"),
        failure(3, "2026-01-02T00:15:00Z"),
        failure(4, "2026-01-02T00:17:00Z", "agent-env-install"),
      ],
    );
    await boot();
    const card = document.querySelector(".failure-history")!;
    const last = [...card.querySelectorAll(".failure-attempt")][2]!;
    expect(last.querySelector(".failure-attempt-num")?.textContent).toBe("Attempt 3/3");
    expect(last.querySelector(".failure-gate")?.textContent).toBe("agent-env-install failed");
    expect(last.querySelector(".attempt-run")).toBeNull();
    expect(card.textContent).not.toContain("not taken");
  });

  it("names no model for a failed attempt whose agent never ran", async () => {
    // Run 1 fails the tests gate (trail attempt 2). Attempt 2 fails before the agent is
    // launched (agent-env-install, trail attempt 3), so no agent-run row exists for it.
    // Run 1 is the latest run before that failure, but it is not attempt 2's run.
    stubFetch(
      [run(1, "2026-01-02T00:00:00Z")],
      [failure(2, "2026-01-02T00:05:00Z"), failure(3, "2026-01-02T00:07:00Z", "agent-env-install")],
    );
    await boot();
    const attempts = [...document.querySelectorAll(".failure-history .failure-attempt")];
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.querySelector(".attempt-run")?.textContent).toBe(
      "Model stub-served-1 · CLI 4.1.0 (Claude Code)",
    );
    expect(attempts[1]!.textContent).toContain("agent-env-install failed");
    expect(attempts[1]!.querySelector(".attempt-run")).toBeNull();
  });

  it("lists every recorded run of a parked ticket, one line each", async () => {
    // Two runs, one failure on the trail (the last go parked the ticket): 2 lines.
    stubFetch(
      [
        run(1, "2026-01-02T00:00:00Z", { max_attempts: 2 }),
        run(2, "2026-01-02T00:10:00Z", { max_attempts: 2, rc: 1 }),
      ],
      [{ ...failure(2, "2026-01-02T00:05:00Z"), max_attempts: 2 }],
    );
    await boot();
    const card = document.querySelector(".failure-history")!;
    expect(card.querySelectorAll(".attempt-run")).toHaveLength(2);
    expect(card.querySelector(".failure-run")?.textContent).toContain("exit 1");
  });

  it("after an Unblock the header counts the fresh set of attempts, as the run list does (exploratory finding ui-workflows/F9)", async () => {
    // Attempts 1 and 2 failed identically and the ticket parked; Unblock gave it a fresh
    // set, and the new attempt 1 passed. The header read "3 of 3 used" beside the new
    // run's "Attempt 1/3".
    stubFetch(
      [
        run(1, "2026-01-02T00:00:00Z"),
        run(2, "2026-01-02T00:10:00Z"),
        run(1, "2026-01-02T01:00:00Z"),
      ],
      [failure(2, "2026-01-02T00:05:00Z"), failure(3, "2026-01-02T00:15:00Z")],
    );
    await boot();
    const card = document.querySelector(".failure-history")!;
    const aux = card.querySelector(".panel-aux")?.textContent ?? "";
    expect(aux).toContain("1 of 3 used");
    const latest = [...card.querySelectorAll(".failure-run .failure-attempt-num")].map(
      (n) => n.textContent,
    );
    expect(latest).toEqual(["Attempt 1/3"]);
    const kicks = [...card.querySelectorAll(".failure-kick-none .failure-attempt-num")].map(
      (n) => n.textContent,
    );
    expect(kicks).toEqual(["Attempt 2/3", "Attempt 3/3"]);
    // The earlier set is still on the page, marked as before the Unblock.
    expect(card.querySelectorAll(".failure-attempt.is-earlier")).toHaveLength(2);
  });

  it("names no model for a failure with no run recorded before it", async () => {
    stubFetch([run(1, "2026-01-02T01:00:00Z")], [failure(2, "2026-01-02T00:05:00Z")]);
    await boot();
    const attempt = document.querySelector(".failure-history .failure-attempt");
    expect(attempt).toBeTruthy();
    expect(attempt!.querySelector(".attempt-run")).toBeNull();
  });

  it("ignores an agent_run row that the delivery agent recorded itself", async () => {
    const forged = {
      ...run(1, "2026-01-02T00:01:00Z", {
        models_served: ["FORGED-model"],
        claude_version: "FORGED",
      }),
      created_by: "agent-1",
      recorded_by_actor_type: "agent",
    };
    stubFetch([run(1, "2026-01-02T00:00:00Z"), forged], [failure(2, "2026-01-02T00:05:00Z")]);
    await boot();
    const page = document.querySelector("#app")!.textContent || "";
    expect(page).not.toContain("FORGED");
    expect(document.querySelector(".failure-attempt .attempt-run")?.textContent).toBe(
      "Model stub-served-1 · CLI 4.1.0 (Claude Code)",
    );
  });

  it("shows no run card when the only agent_run rows are agent-recorded", async () => {
    const forged = {
      ...run(1, "2026-01-02T00:00:00Z", { models_served: ["FORGED-model"] }),
      recorded_by_actor_type: "agent",
    };
    stubFetch([forged], []);
    await boot();
    expect(document.querySelector(".agent-runs")).toBeNull();
    expect(document.querySelector("#app")!.textContent || "").not.toContain("FORGED");
  });

  it("lists the attempts of a ticket that never failed", async () => {
    stubFetch([run(1, "2026-01-02T00:00:00Z")], []);
    await boot();
    const card = document.querySelector(".agent-runs");
    expect(card).toBeTruthy();
    expect(card!.querySelector("h2")?.textContent).toContain("1 run");
    const row = card!.querySelector(".agent-run")!;
    expect(row.textContent).toContain("Attempt 1/3");
    expect(row.querySelector(".attempt-run")?.textContent).toBe(
      "Model stub-served-1 · CLI 4.1.0 (Claude Code)",
    );
  });

  it("falls back to the requested model when nothing measured the call", async () => {
    stubFetch([run(1, "2026-01-02T00:00:00Z", { models_served: [], rc: 124 })], []);
    await boot();
    const row = document.querySelector(".agent-run")!;
    expect(row.querySelector(".attempt-run")?.textContent).toBe(
      "Model stub-requested · CLI 4.1.0 (Claude Code)",
    );
    expect(row.textContent).toContain("exit 124");
  });

  it("ignores ordinary log evidence and shows no card without runs or failures", async () => {
    const plain = { ...run(1, "2026-01-02T00:00:00Z"), payload_json: null };
    stubFetch([plain], []);
    await boot();
    expect(document.querySelector(".failure-history")).toBeNull();
  });
});

describe("web: Match footage shows each run's own turns and cost (exploratory finding ui-workflows/F9)", () => {
  beforeEach(() => {
    mountShell();
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("two runs of one ticket read their own figures, not the ticket's total twice", async () => {
    const claimEvents = [
      {
        id: "c1",
        event_type: "claim.created",
        payload_json: "{}",
        created_at: "2026-01-02T00:00:00Z",
      },
      {
        id: "c2",
        event_type: "claim.created",
        payload_json: "{}",
        created_at: "2026-01-02T01:00:00Z",
      },
    ];
    const runRow = (id: string, at: string) => ({
      id,
      kind: "poll_work",
      repo: null,
      pid: 1,
      status: "succeeded",
      started_at: at,
      ended_at: at,
      exit_code: 0,
      log_path: null,
      detail: null,
    });
    const details: Record<string, unknown> = {
      r1: {
        ticket_number: 9,
        phase: "implement",
        num_turns: 18,
        cost_usd: 0.06,
        run_num_turns: 12,
        run_cost_usd: 0.04,
        outcome: "in_review",
      },
      r2: {
        ticket_number: 9,
        phase: "implement",
        num_turns: 18,
        cost_usd: 0.06,
        run_num_turns: 6,
        run_cost_usd: 0.02,
        outcome: "in_review",
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input).replace(/^https?:\/\/[^/]+/, "");
        let body: unknown = {};
        const m = /^\/api\/runs\/(r\d)$/.exec(url);
        if (m)
          body = {
            detail: { run: runRow(m[1]!, "2026-01-02T00:00:00Z"), ...(details[m[1]!] as object) },
          };
        else if (url.startsWith("/api/runs"))
          body = {
            active: [],
            recent: [runRow("r1", "2026-01-02T00:00:30Z"), runRow("r2", "2026-01-02T01:00:30Z")],
          };
        else if (url.includes(`/tickets/${TICKET.id}/diff`))
          body = { ticketId: TICKET.id, repos: [] };
        else if (url === `/tickets/${TICKET.id}`)
          body = {
            ticket: TICKET,
            acceptance_criteria: [],
            repositories: [],
            scopes: [],
            blocking_decisions: [],
            dependencies: [],
            evidence: [],
            events: claimEvents,
            rework_trail: [],
          };
        else body = { tickets: [TICKET] };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    await boot();
    for (let i = 0; i < 8; i++) await tick();
    const rows = [...document.querySelectorAll(".tk-run-list .tk-run")].map((r) => r.textContent);
    expect(rows).toHaveLength(2);
    expect(rows.join(" | ")).toContain("12 turns");
    expect(rows.join(" | ")).toContain("6 turns");
    expect(rows.join(" | ")).not.toContain("18 turns");
  });
});

// REVIEW FACTS (Release A, A4): the review packet answers "what was asked?" and "is this
// the exact candidate that passed?" from recorded state, with no model call and no score:
//  - intent: the ticket's description;
//  - candidate: per write repo, the commit the runner gated (ticket_repo_delivery.commit_sha,
//    recorded after the gates), the head the diff and an approval bind to, the tester's
//    commit and the pin, and whether they are one commit;
//  - ci: the latest recorded CI result for the candidate commit;
//  - run_links: the dashboard-recorded run logs that cover the delivery;
//  - backing: deterministic {fact, holds, source} rows, never a percentage.

import { afterEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import type { ReviewPacket } from "../src/services/reviewPacketService.js";
import { TestClock } from "../src/util/clock.js";
import { FAKE_HEAD, nonEmptyDiffRunner } from "./helpers/realDiff.js";

const human: Actor = { type: "human", id: "tom" };
const runner: Actor = { type: "system", id: "runner" };
const OTHER = "b".repeat(40);

const DOD_PASS = [
  "DoD: PASS",
  JSON.stringify({
    dod: "PASS",
    gates: [
      { gate: "tests", repo: "svc", status: "PASS", rc: "0", note: "npm test" },
      { gate: "lint", repo: "svc", status: "SKIP", rc: "0", note: "no command configured" },
    ],
  }),
].join("\n");

const cost = () => ({
  cost_usd: 0,
  measured_usd: 0,
  estimated_usd: 0,
  num_turns: 0,
  unknown_calls: 0,
  ledger_status: "ok",
});

describe("REVIEW FACTS: intent, same candidate, CI, run links, backing", () => {
  let d: Dispatch;
  let clock: TestClock;
  afterEach(() => d.db.close());

  function deliver(opts: { commit?: string | null; by?: Actor; description?: string } = {}): {
    id: string;
    repoId: string;
  } {
    clock = new TestClock();
    d = Dispatch.open(":memory:", clock, nonEmptyDiffRunner);
    const repo = d.registerRepository(
      { name: "svc", default_branch: "main", local_path: process.cwd() },
      human,
    );
    const t = d.createTicket(
      {
        title: "Clear done tasks",
        description: opts.description ?? "Users can clear every done task in one click.",
        risk_level: "low",
      },
      human,
    );
    d.linkRepository(t.id, "svc", "primary", human);
    d.addAcceptanceCriterion({ ticket_id: t.id, text: "clears", check_command: "npm test" }, human);
    d.addAcceptanceCriterion({ ticket_id: t.id, text: "docs say so" }, human);
    d.markReady(t.id, human);
    const agent = d.registerAgent({ display_name: "Bot", max_risk: "critical" }, human);
    const agentActor: Actor = { type: "agent", id: agent.id };
    const claim = d.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, agentActor)!;
    d.recordRepoDelivery({ ticket_id: t.id, repo_id: repo.id, branch_name: "feat/x" }, agentActor);
    d.attachDeliveryEvidence(t.id, { evidenceType: "test_output", summary: DOD_PASS }, runner);
    // The runner records the delivery commit right after its gates (runner/tick.sh).
    const commit = opts.commit === undefined ? FAKE_HEAD : opts.commit;
    if (commit)
      d.recordRepoDelivery(
        { ticket_id: t.id, repo_id: repo.id, commit_sha: commit, status: "review_ready" },
        opts.by ?? runner,
      );
    d.submitForReview(
      { claimToken: claim.claimToken, ticket_id: t.id, reason: "done" },
      agentActor,
    );
    return { id: t.id, repoId: repo.id };
  }

  const packetOf = (id: string): ReviewPacket => d.reviewPacket(id, cost);

  it("intent is the ticket's description, as text", () => {
    const { id } = deliver({ description: "  Users can clear <b>done</b> tasks.  " });
    expect(packetOf(id).intent).toBe("Users can clear <b>done</b> tasks.");
  });

  it("a blank description has no intent", () => {
    const { id } = deliver({ description: "   " });
    expect(packetOf(id).intent).toBeNull();
  });

  it("the gated commit is the head: one candidate, and the backing row says so", () => {
    const { id, repoId } = deliver();
    const p = packetOf(id);
    expect(p.candidate).toEqual([
      {
        repo_id: repoId,
        repo: "svc",
        gated_sha: FAKE_HEAD,
        gated_by: "runner",
        diff_head: FAKE_HEAD,
        head_unavailable: null,
        tester_tested: null,
        pin: null,
        same: true,
      },
    ]);
    const row = p.backing.find((b) => b.cell === "candidate")!;
    expect(row.holds).toBe(true);
    expect(row.fact).toMatch(/The gates ran on the commit the diff shows/);
  });

  it("the runner gated another commit: not the same candidate, said as not backed", () => {
    const { id } = deliver({ commit: OTHER });
    const p = packetOf(id);
    expect(p.candidate[0]).toMatchObject({ gated_sha: OTHER, diff_head: FAKE_HEAD, same: false });
    const row = p.backing.find((b) => b.cell === "candidate")!;
    expect(row.holds).toBe(false);
    expect(row.fact).toContain(`The gates ran on ${OTHER.slice(0, 12)}`);
    expect(row.fact).toContain(`now at ${FAKE_HEAD.slice(0, 12)}`);
  });

  it("no gated commit recorded: not the same, and not backed", () => {
    const { id } = deliver({ commit: null });
    const p = packetOf(id);
    expect(p.candidate[0]).toMatchObject({ gated_sha: null, same: false });
    expect(p.backing.find((b) => b.cell === "candidate")!.holds).toBe(false);
  });

  it("a commit the agent recorded is its word, never the runner's gated commit", () => {
    const d0 = deliver({ commit: null });
    // The agent records the head itself (its MCP tool can pass a commit).
    const agent = d.registerAgent({ display_name: "Other", max_risk: "critical" }, human);
    d.recordRepoDelivery(
      { ticket_id: d0.id, repo_id: d0.repoId, commit_sha: FAKE_HEAD },
      { type: "agent", id: agent.id },
    );
    const p = packetOf(d0.id);
    expect(p.candidate[0]).toMatchObject({ gated_sha: FAKE_HEAD, gated_by: "agent", same: false });
    expect(p.backing.find((b) => b.cell === "candidate")!.fact).toMatch(/recorded by the agent/);
  });

  it("ci: no CI on record is null; a result for the candidate commit is read with its time", () => {
    const { id } = deliver();
    expect(packetOf(id).ci).toBeNull();
    d.recordCiResult(id, { commit: FAKE_HEAD, state: "pending" }, runner);
    clock.advanceSeconds(5);
    d.recordCiResult(id, { commit: FAKE_HEAD, state: "pass", detail: "unit ok" }, runner);
    const ci = packetOf(id).ci!;
    expect(ci).toMatchObject({
      required: true,
      state: "pass",
      commit: FAKE_HEAD,
      detail: "unit ok",
    });
    expect(packetOf(id).backing.find((b) => b.cell === "ci")).toMatchObject({
      holds: true,
      fact: "Required CI is green on this commit",
    });
  });

  it("run_links: the poll run with a log that was running when the ticket entered review", () => {
    // A dashboard poll run started before the delivery (the TestClock's epoch) and still running.
    const before = new TestClock().now();
    const { id } = deliver();
    d.db
      .prepare(
        "INSERT INTO runs (id, kind, status, started_at, log_path) VALUES ('run-1','poll_work','running',?,'/tmp/x.log')",
      )
      .run(before);
    d.db
      .prepare(
        "INSERT INTO runs (id, kind, status, started_at, ended_at, log_path) VALUES ('run-0','poll_work','succeeded','2000-01-01T00:00:00.000Z','2000-01-01T00:01:00.000Z','/tmp/y.log')",
      )
      .run();
    const links = packetOf(id).run_links;
    expect(links).toEqual([
      expect.objectContaining({
        role: "delivery",
        run_id: "run-1",
        href: "/api/runs/run-1/log",
        method: "time window",
      }),
    ]);
  });

  it("backing is rows of facts with sources: no score, no percentage", () => {
    const { id } = deliver();
    const p = packetOf(id);
    expect(p.backing.length).toBeGreaterThan(3);
    for (const b of p.backing) {
      expect(typeof b.fact).toBe("string");
      expect(typeof b.holds).toBe("boolean");
      expect(b.source).not.toBe("");
    }
    const facts = p.backing.map((b) => b.fact);
    expect(facts).toContain("The runner's gates passed");
    expect(facts).toContain("The lint gate did not run (no command configured)");
    expect(facts).toContain("2 criteria have no evidence recorded");
    expect(facts).toContain("0 of 1 checked criterion has a passing runner check");
    expect(facts).toContain("No CI result is recorded for this ticket");
    expect(JSON.stringify(p.backing)).not.toMatch(/%|score|confiden/i);
  });
});

/**
 * RUNNER-OWNED DELIVERY RECORD (sec-authz-2 F1). The per-repo delivery record (branch,
 * commit, status) decides what the Review view diffs, what the approval pins
 * (writeRepoHeads), which commits required CI accepts and what lands. Before the fix
 * the advisory reviewer / tester mount (GAFFER_REVIEW_TICKET) could re-point it on the
 * ticket under review with record_repo_delivery, and the service had no status, claim
 * or write-once check for an agent. Writers that stay legitimate: the runner's close
 * path (system actor), crew (system actor), a person over REST / the CLI, and the
 * delivery agent on its own claimed in_progress ticket (progress only in the factory).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { makeHandlers, type ToolResult } from "../src/mcp/tools.js";
import { DispatchError } from "../src/util/errors.js";

const human: Actor = { type: "human", id: "tom" };
const system: Actor = { type: "system" };
const agent: Actor = { type: "agent", id: "mcp-agent" };
const RUNNER_BRANCH = "gaffer/ticket-1";
const ATTACKER_BRANCH = "gaffer/attacker";

const ENV_KEYS = [
  "GAFFER_FACTORY",
  "GAFFER_CLAIM_TOKEN",
  "GAFFER_SCOPE_TICKET",
  "GAFFER_REVIEW_TICKET",
] as const;
let saved: Record<string, string | undefined> = {};
let work: string;
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  work = mkdtempSync(join(tmpdir(), "rd-owned-"));
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(work, { recursive: true, force: true });
});

const git = (dir: string, ...args: string[]): string =>
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    encoding: "utf8",
  }).trim();

/** A repo with main, the runner's delivery branch and an attacker branch. */
function makeRepo(): string {
  const dir = join(work, "app");
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  writeFileSync(join(dir, "README.md"), "app\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  for (const [b, file] of [
    [RUNNER_BRANCH, "change.txt"],
    [ATTACKER_BRANCH, "backdoor.txt"],
  ] as const) {
    git(dir, "checkout", "-q", "-b", b, "main");
    writeFileSync(join(dir, file), `${b}\n`);
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", b);
  }
  git(dir, "checkout", "-q", "main");
  return dir;
}

function code(r: ToolResult): string | undefined {
  return (r.structuredContent.error as { code?: string } | undefined)?.code;
}

function refusal(fn: () => unknown): DispatchError {
  try {
    fn();
  } catch (e) {
    if (e instanceof DispatchError) return e;
    throw e;
  }
  throw new Error("expected a DispatchError");
}

/** A claimed (in_progress) single-repo ticket. */
function claimed(d: Dispatch, dir: string) {
  const repo = d.registerRepository(
    { name: "app", default_branch: "main", local_path: dir },
    human,
  );
  const t = d.createTicket({ title: "T1", priority: 1, risk_level: "low" }, human);
  d.setTicketRepoAccess(
    { ticket_id: t.id, repo_id: repo.id, access: "write", relation: "confirmed" },
    human,
  );
  const { ac } = d.addAcceptanceCriterion({ ticket_id: t.id, text: "works" }, human);
  d.markReady(t.id, human);
  const bot = d.registerAgent({ display_name: "Bot" }, human);
  const claim = d.claimTicket({ ticket_id: t.id, agent_id: bot.id, ttl_seconds: 600 }, system);
  return { t, repo, ac, claim };
}

/** The runner's close path: gates ran, then submit and record branch + commit as system. */
function runnerCloses(d: Dispatch, dir: string) {
  const c = claimed(d, dir);
  d.recordEvidence(
    {
      claimToken: c.claim.claimToken,
      ticket_id: c.t.id,
      ac_id: c.ac.id,
      evidence_type: "test_output",
      summary: "ok",
    },
    agent,
  );
  d.submitForReview({ claimToken: c.claim.claimToken, ticket_id: c.t.id, reason: "done" }, system);
  const sha = git(dir, "rev-parse", RUNNER_BRANCH);
  d.recordRepoDelivery(
    {
      ticket_id: c.t.id,
      repo_id: c.repo.id,
      branch_name: RUNNER_BRANCH,
      commit_sha: sha,
      status: "review_ready",
    },
    system,
  );
  return { ...c, sha };
}

const row = (d: Dispatch, id: string) =>
  JSON.stringify(
    d.listRepoDeliveries(id).map((r) => [r.branch_name, r.commit_sha, r.pr_url, r.status]),
  );

describe("F1: a reviewer or tester mount cannot re-point the delivery under review", () => {
  it("the r3 scenario: refused, the row and writeRepoHeads unchanged", () => {
    const dir = makeRepo();
    const d = Dispatch.open(":memory:");
    const { t, sha } = runnerCloses(d, dir);
    expect(d.view(t.id).ticket.status).toBe("in_review");
    const headsBefore = JSON.stringify(d.writeRepoHeads(d.resolveTicket(t.id)).heads);
    expect(headsBefore).toContain(sha);
    const before = row(d, t.id);

    process.env.GAFFER_FACTORY = "1";
    process.env.GAFFER_REVIEW_TICKET = String(t.number);
    const mcp = makeHandlers(d, agent);
    const redirect = mcp.record_repo_delivery({
      ticket_id: String(t.number),
      repo_id: "app",
      branch_name: ATTACKER_BRANCH,
      status: "done",
    });
    expect(redirect.isError).toBe(true);
    expect(code(redirect)).toBe("FACTORY_RUNNER_OWNED");
    // Each part alone is refused too.
    for (const args of [
      { branch_name: ATTACKER_BRANCH },
      { commit_sha: git(dir, "rev-parse", ATTACKER_BRANCH) },
      { status: "done" },
      { status: "changes_made" },
      { evidence_ref: "x" },
    ])
      expect(code(mcp.record_repo_delivery({ ticket_id: t.id, repo_id: "app", ...args }))).toBe(
        "FACTORY_RUNNER_OWNED",
      );
    expect(row(d, t.id)).toBe(before);
    expect(JSON.stringify(d.writeRepoHeads(d.resolveTicket(t.id)).heads)).toBe(headsBefore);
  }, 20_000);

  it("the service refuses an agent on a ticket past delivery, whatever the mount", () => {
    const dir = makeRepo();
    const d = Dispatch.open(":memory:");
    const { t, repo } = runnerCloses(d, dir);
    const before = row(d, t.id);
    // No factory env at all (a standalone MCP server, or any other agent entry point).
    const mcp = makeHandlers(d, agent);
    const r = mcp.record_repo_delivery({
      ticket_id: t.id,
      repo_id: "app",
      branch_name: ATTACKER_BRANCH,
    });
    expect(code(r)).toBe("ACTOR_NOT_PERMITTED");
    for (const status of [
      "in_testing",
      "ready_for_merge",
      "done",
      "blocked",
      "ready",
      "refining",
    ]) {
      d.db.prepare("UPDATE tickets SET status = ? WHERE id = ?").run(status, t.id);
      const e = refusal(() =>
        d.recordRepoDelivery({ ticket_id: t.id, repo_id: repo.id, status: "done" }, agent),
      );
      expect(e.code).toBe("ACTOR_NOT_PERMITTED");
    }
    expect(row(d, t.id)).toBe(before);
  }, 20_000);

  it("a clarify / scope-only mount (no claim) is refused on an in_progress ticket", () => {
    const dir = makeRepo();
    const d = Dispatch.open(":memory:");
    const { t } = claimed(d, dir);
    process.env.GAFFER_FACTORY = "1";
    process.env.GAFFER_SCOPE_TICKET = String(t.number);
    const r = makeHandlers(d, agent).record_repo_delivery({
      ticket_id: t.id,
      repo_id: "app",
      status: "changes_made",
    });
    expect(code(r)).toBe("FACTORY_RUNNER_OWNED");
    expect(d.listRepoDeliveries(t.id)).toHaveLength(0);
  }, 20_000);
});

describe("F1: legitimate writers keep working", () => {
  it("the delivery agent records progress on its own claimed in_progress ticket", () => {
    const dir = makeRepo();
    const d = Dispatch.open(":memory:");
    const { t, claim } = claimed(d, dir);
    process.env.GAFFER_FACTORY = "1";
    process.env.GAFFER_CLAIM_TOKEN = claim.claimToken;
    process.env.GAFFER_SCOPE_TICKET = String(t.number);
    const mcp = makeHandlers(d, agent);
    const ok = mcp.record_repo_delivery({
      ticket_id: `#${t.number}`,
      repo_id: "app",
      status: "changes_made",
      evidence_ref: "notes",
    });
    expect(ok.isError).toBeUndefined();
    expect(d.listRepoDeliveries(t.id)[0]?.status).toBe("changes_made");
    // The gated record is the runner's: branch, commit, PR and review_ready / done.
    for (const args of [
      { branch_name: ATTACKER_BRANCH },
      { commit_sha: git(dir, "rev-parse", ATTACKER_BRANCH) },
      { pr_url: "https://example.com/pr/1" },
      { status: "review_ready" },
      { status: "done" },
    ])
      expect(code(mcp.record_repo_delivery({ ticket_id: t.id, repo_id: "app", ...args }))).toBe(
        "FACTORY_RUNNER_OWNED",
      );
    expect(row(d, t.id)).toBe(JSON.stringify([[null, null, null, "changes_made"]]));
  }, 20_000);

  it("a standalone agent records on its claimed ticket, but never changes a recorded branch or commit", () => {
    const dir = makeRepo();
    const d = Dispatch.open(":memory:");
    const { t, repo } = claimed(d, dir);
    const mcp = makeHandlers(d, agent);
    expect(
      mcp.record_repo_delivery({ ticket_id: t.id, repo_id: "app", branch_name: RUNNER_BRANCH })
        .isError,
    ).toBeUndefined();
    // Re-recording the same values is fine; changing them is not.
    expect(
      mcp.record_repo_delivery({
        ticket_id: t.id,
        repo_id: "app",
        branch_name: RUNNER_BRANCH,
        status: "tests_passed",
      }).isError,
    ).toBeUndefined();
    const e = refusal(() =>
      d.recordRepoDelivery(
        { ticket_id: t.id, repo_id: repo.id, branch_name: ATTACKER_BRANCH },
        agent,
      ),
    );
    expect(e.code).toBe("ACTOR_NOT_PERMITTED");
    // A rework round: the runner recorded round 1's branch and commit; the agent is back
    // on the ticket in_progress and still cannot move them.
    const sha = git(dir, "rev-parse", RUNNER_BRANCH);
    d.recordRepoDelivery({ ticket_id: t.id, repo_id: repo.id, commit_sha: sha }, system);
    expect(
      refusal(() =>
        d.recordRepoDelivery(
          {
            ticket_id: t.id,
            repo_id: repo.id,
            commit_sha: git(dir, "rev-parse", ATTACKER_BRANCH),
          },
          agent,
        ),
      ).code,
    ).toBe("ACTOR_NOT_PERMITTED");
    // The same commit re-recorded byte for byte is fine; any other spelling is refused.
    expect(
      d.recordRepoDelivery({ ticket_id: t.id, repo_id: repo.id, commit_sha: sha }, agent).delivery
        .commit_sha,
    ).toBe(sha);
    expect(
      refusal(() =>
        d.recordRepoDelivery(
          { ticket_id: t.id, repo_id: repo.id, commit_sha: sha.toUpperCase() },
          agent,
        ),
      ).code,
    ).toBe("ACTOR_NOT_PERMITTED");
    expect(d.listRepoDeliveries(t.id)[0]?.branch_name).toBe(RUNNER_BRANCH);
  }, 20_000);

  it("the runner (system) and a person still record and re-record, in review included", () => {
    const dir = makeRepo();
    const d = Dispatch.open(":memory:");
    const { t, repo } = runnerCloses(d, dir);
    // A new round recorded host side moves the branch and commit.
    const next = git(dir, "rev-parse", ATTACKER_BRANCH);
    d.recordRepoDelivery(
      {
        ticket_id: t.id,
        repo_id: repo.id,
        branch_name: ATTACKER_BRANCH,
        commit_sha: next,
        status: "review_ready",
      },
      system,
    );
    expect(row(d, t.id)).toBe(JSON.stringify([[ATTACKER_BRANCH, next, null, "review_ready"]]));
    d.recordRepoDelivery(
      { ticket_id: t.id, repo_id: repo.id, branch_name: RUNNER_BRANCH, status: "done" },
      human,
    );
    expect(d.listRepoDeliveries(t.id)[0]?.branch_name).toBe(RUNNER_BRANCH);
  }, 20_000);
});

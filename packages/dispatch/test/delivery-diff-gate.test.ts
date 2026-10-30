import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import {
  computeTicketDiff,
  defaultGitRunner,
  MAX_DIFF_BYTES,
  type GitRunner,
} from "../src/services/diffService.js";
import { TestClock } from "../src/util/clock.js";
import { DispatchError } from "../src/util/errors.js";
import { emptyDiffRunner, giveTicketRealDelivery, nonEmptyDiffRunner } from "./helpers/realDiff.js";

const human: Actor = { type: "human", id: "tom" };
const reviewer: Actor = { type: "human", id: "rev" };
const agentActor: Actor = { type: "agent", id: "agent-runner" };
const testerAgent: Actor = { type: "agent", id: "tester-1" };

/**
 * A real git repo whose `feat/big` branch adds a ~1.2 MB file — larger than the
 * default runner's 800 KB output cap — plus a `feat/small` control branch.
 */
let repoDir: string;
const BIG_LINES = 40_000;

function git(args: string[]): void {
  execFileSync("git", ["-C", repoDir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    stdio: "ignore",
  });
}

beforeAll(() => {
  repoDir = mkdtempSync(join(tmpdir(), "dispatch-bigdiff-"));
  execFileSync("git", ["init", "-q", "-b", "main", repoDir]);
  writeFileSync(join(repoDir, "README.md"), "hello\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);
  git(["checkout", "-q", "-b", "feat/big"]);
  const line = "x".repeat(29); // 30 bytes per line with the newline
  writeFileSync(join(repoDir, "lock.json"), `${line}\n`.repeat(BIG_LINES));
  git(["add", "."]);
  git(["commit", "-q", "-m", "regenerate lockfile"]);
  git(["checkout", "-q", "main"]);
});

afterAll(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

/** A ticket with one write repo at `localPath` whose recorded delivery branch is `branch`. */
function deliveredTicket(wg: Dispatch, localPath: string, branch: string): string {
  const repo = wg.registerRepository(
    { name: "svc", default_branch: "main", local_path: localPath },
    human,
  );
  const t = wg.createTicket(
    { title: "deliver", description: "d", policy_pack: "solo_loose" },
    human,
  );
  wg.addAcceptanceCriterion({ ticket_id: t.id, text: "it works" }, human);
  wg.setTicketRepoAccess(
    { ticket_id: t.id, repo_id: repo.id, access: "write", relation: "confirmed" },
    human,
  );
  wg.recordRepoDelivery({ ticket_id: t.id, repo_id: repo.id, branch_name: branch }, human);
  return t.id;
}

describe("big-diff-blocks-approval: a diff over the runner's output cap", () => {
  it("is reported truncated (not git_error) with honest numstat, and passes the done gate", () => {
    const wg = Dispatch.open(":memory:");
    const ticketId = deliveredTicket(wg, repoDir, "feat/big");

    const diff = wg.ticketDiff(ticketId);
    expect(diff.repos).toHaveLength(1);
    const rd = diff.repos[0]!;
    expect(rd.unavailable).toBeUndefined();
    expect(rd.truncated).toBe(true);
    expect(Buffer.byteLength(rd.diff, "utf8")).toBeLessThanOrEqual(MAX_DIFF_BYTES);
    expect(rd.diff).toContain("lock.json");
    expect(rd.files).toBe(1);
    expect(rd.additions).toBe(BIG_LINES);

    const gate = wg.transitions.preview(ticketId, "ready_for_merge");
    expect(gate?.failures.map((f) => f.code)).not.toContain("PR_OR_DIFF_REQUIRED");
    wg.db.close();
  });

  it("defaultGitRunner reports an overflow as truncated output, not a failed spawn", () => {
    const res = defaultGitRunner(repoDir, ["diff", "main...feat/big"], { maxBuffer: 4096 });
    expect(res.status).toBe(0);
    expect(res.truncated).toBe(true);
    expect(res.stdout.length).toBeGreaterThan(0);
  });

  it("defaultGitRunner still reports a bad range as a failure", () => {
    const res = defaultGitRunner(repoDir, ["diff", "--numstat", "main...no-such-branch"]);
    expect(res.status).not.toBe(0);
    expect(res.truncated).toBeUndefined();
  });

  it("an injected runner that flags truncated output yields a truncated diff", () => {
    const wg = Dispatch.open(":memory:");
    const ticketId = deliveredTicket(wg, process.cwd(), "feat/x");
    const runGit: GitRunner = (_cwd, args) =>
      args.includes("--numstat")
        ? { status: 0, stdout: "3\t0\tsrc/a.ts\n", stderr: "" }
        : {
            status: 0,
            stdout: "diff --git a/src/a.ts b/src/a.ts\n+partial",
            stderr: "",
            truncated: true,
          };
    const out = computeTicketDiff(
      { repos: wg.repos, tickets: wg.tickets, repoDeliveries: wg.repoDeliveries, runGit },
      ticketId,
    );
    expect(out.repos[0]!.unavailable).toBeUndefined();
    expect(out.repos[0]!.truncated).toBe(true);
    wg.db.close();
  });
});

/**
 * A git runner that counts its calls and records whether each one ran while the
 * database held an open transaction (the SQLite write lock).
 */
function spyRunner(base: GitRunner): {
  runGit: GitRunner;
  calls: Array<{ args: string; inTransaction: boolean }>;
  bind: (wg: Dispatch) => void;
} {
  let bound: Dispatch | undefined;
  const calls: Array<{ args: string; inTransaction: boolean }> = [];
  const runGit: GitRunner = (cwd, args, opts) => {
    calls.push({ args: args.join(" "), inTransaction: bound?.db.inTransaction ?? false });
    return base(cwd, args, opts);
  };
  return { runGit, calls, bind: (wg) => (bound = wg) };
}

/** Drive a team_light ticket to in_review with a satisfied AC and a recorded delivery. */
function inReview(wg: Dispatch): string {
  wg.registerRepository({ name: "svc", default_branch: "main" }, human);
  const t = wg.createTicket(
    { title: "Ship it", description: "deliver the thing", policy_pack: "team_light" },
    human,
  );
  wg.linkRepository(t.id, "svc", "primary", human);
  const { ac } = wg.addAcceptanceCriterion({ ticket_id: t.id, text: "Returns 200" }, human);
  wg.markReady(t.id, human);
  const agent = wg.registerAgent({ display_name: "a" }, human);
  const claim = wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, agentActor);
  wg.recordEvidence(
    {
      claimToken: claim!.claimToken,
      ticket_id: t.id,
      ac_id: ac.id,
      evidence_type: "test_output",
      summary: "passed",
    },
    agentActor,
  );
  wg.submitForReview(
    { claimToken: claim!.claimToken, ticket_id: t.id, reason: "done" },
    agentActor,
  );
  giveTicketRealDelivery(wg, t.id, human);
  return t.id;
}

describe("git-inside-write-lock: the done gate's git never runs under the write lock", () => {
  it("the ready and claim gates spawn no git, even with a delivery branch recorded", () => {
    const spy = spyRunner(nonEmptyDiffRunner);
    const wg = Dispatch.open(":memory:", new TestClock(), spy.runGit);
    spy.bind(wg);
    const t = wg.createTicket(
      { title: "rework", description: "d", policy_pack: "team_light" },
      human,
    );
    wg.addAcceptanceCriterion({ ticket_id: t.id, text: "Returns 200" }, human);
    // A reworked ticket keeps its recorded delivery branch from the previous attempt.
    giveTicketRealDelivery(wg, t.id, human);

    wg.markReady(t.id, human);
    const agent = wg.registerAgent({ display_name: "a" }, human);
    const claim = wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, agentActor);
    expect(claim?.ticketId).toBe(t.id);
    expect(spy.calls).toEqual([]);
    wg.db.close();
  });

  it("approveReview runs the gate's git outside any transaction", () => {
    const spy = spyRunner(nonEmptyDiffRunner);
    const wg = Dispatch.open(":memory:", new TestClock(), spy.runGit);
    spy.bind(wg);
    const ticketId = inReview(wg);
    spy.calls.length = 0;

    expect(wg.approveReview(ticketId, reviewer).ticket.status).toBe("ready_for_merge");
    expect(spy.calls.length).toBeGreaterThan(0);
    expect(spy.calls.filter((c) => c.inTransaction)).toEqual([]);
    wg.db.close();
  });

  it("testerPass runs the gate's git outside its outer transaction", () => {
    const spy = spyRunner(nonEmptyDiffRunner);
    const wg = Dispatch.open(":memory:", new TestClock(), spy.runGit, { testingEnabled: true });
    spy.bind(wg);
    const ticketId = inReview(wg);
    wg.setTestable(ticketId, true, human);
    expect(wg.approveReview(ticketId, reviewer).ticket.status).toBe("in_testing");
    spy.calls.length = 0;

    const res = wg.testerPass(ticketId, { summary: "black-box tests pass" }, testerAgent);
    expect(res.ticket.status).toBe("ready_for_merge");
    expect(spy.calls.length).toBeGreaterThan(0);
    expect(spy.calls.filter((c) => c.inTransaction)).toEqual([]);
    wg.db.close();
  });

  it("a stale or forged proof cannot skip the gate: a fingerprint mismatch recomputes", () => {
    const wg = Dispatch.open(":memory:", new TestClock(), emptyDiffRunner);
    const ticketId = inReview(wg);
    let err: unknown;
    try {
      wg.transitions.transition({
        ticketId,
        actor: reviewer,
        toStatus: "ready_for_merge",
        expectedFromStatus: "in_review",
        reviewApprove: true,
        deliveryDiff: { hasDiff: true, fingerprint: "not-this-ticket" },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DispatchError);
    expect((err as DispatchError).code).toBe("POLICY_DENIED");
    wg.db.close();
  });

  it("a git failure (e.g. a timeout) fails the done gate closed", () => {
    const failing: GitRunner = () => ({ status: null, stdout: "", stderr: "git timed out" });
    const wg = Dispatch.open(":memory:", new TestClock(), failing);
    const ticketId = inReview(wg);
    const gate = wg.transitions.preview(ticketId, "ready_for_merge");
    expect(gate?.failures.map((f) => f.code)).toContain("PR_OR_DIFF_REQUIRED");
    wg.db.close();
  });
});

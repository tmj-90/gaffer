/**
 * RUNNER-OWNED DELIVERY RECORD, end of the chain (sec-authz-2 F1, the step the auditor
 * left open). The fix refuses the redirect at record_repo_delivery; this test documents
 * what the rest of the chain does when a redirect reaches the row anyway (what the
 * pre-fix reviewer-mount call wrote: branch re-pointed, the runner's commit kept by the
 * upsert's COALESCE, status done). It plants that row host side, as the old agent call
 * did, then approves the shown head and starts the landing:
 *  - with no further gate configured, the approval pins the redirected head and the
 *    landing starts on it: nothing downstream holds, so the refusal at the record is the
 *    gate that matters;
 *  - with required CI, green only on the runner's gated commit, the approval of the
 *    redirected head is refused (POLICY_DENIED ci_required): required CI by exact
 *    commit holds, because a CI result is recorded host side for a commit, never by an
 *    agent, and the shown head has none.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { DispatchError } from "../src/util/errors.js";

const human: Actor = { type: "human", id: "tom" };
const system: Actor = { type: "system" };
const agent: Actor = { type: "agent", id: "mcp-agent" };
const RUNNER_BRANCH = "gaffer/ticket-1";
const ATTACKER_BRANCH = "gaffer/attacker";

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "rd-chain-"));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

const git = (dir: string, ...args: string[]): string =>
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    encoding: "utf8",
  }).trim();

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

/** Runner close, then the redirect the pre-fix reviewer mount could write. */
function redirected(d: Dispatch, dir: string, ciRequired: boolean) {
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
  d.recordEvidence(
    {
      claimToken: claim.claimToken,
      ticket_id: t.id,
      ac_id: ac.id,
      evidence_type: "test_output",
      summary: "ok",
    },
    agent,
  );
  if (ciRequired) d.recordCiRequired(t.id, {}, system);
  d.submitForReview({ claimToken: claim.claimToken, ticket_id: t.id, reason: "done" }, system);
  const gated = git(dir, "rev-parse", RUNNER_BRANCH);
  d.recordRepoDelivery(
    {
      ticket_id: t.id,
      repo_id: repo.id,
      branch_name: RUNNER_BRANCH,
      commit_sha: gated,
      status: "review_ready",
    },
    system,
  );
  if (ciRequired) d.recordCiResult(t.id, { commit: gated, state: "pass" }, system);
  // An agent can no longer write this (refused, see repo-delivery-runner-owned.test.ts):
  expect(() =>
    d.recordRepoDelivery(
      { ticket_id: t.id, repo_id: repo.id, branch_name: ATTACKER_BRANCH, status: "done" },
      agent,
    ),
  ).toThrow(DispatchError);
  // ...so plant the row the pre-fix call left behind.
  d.db
    .prepare(
      "UPDATE ticket_repo_delivery SET branch_name = ?, status = 'done' WHERE ticket_id = ? AND repo_id = ?",
    )
    .run(ATTACKER_BRANCH, t.id, repo.id);
  return { t, repo, gated, attacker: git(dir, "rev-parse", ATTACKER_BRANCH) };
}

describe("F1 end of chain: what holds a redirected delivery head", () => {
  it("no further gate configured: the approval pins the redirected head and it starts landing", () => {
    const dir = makeRepo();
    const d = Dispatch.open(":memory:");
    const { t, repo, gated, attacker } = redirected(d, dir, false);
    const shown = d.ticketDiff(t.id).repos.map((r) => ({ repo: r.repoId!, sha: r.headSha! }));
    expect(shown.map((s) => s.sha)).toEqual([attacker]);
    d.approveReview(t.id, human, { commits: shown, requireCommits: true });
    expect(d.view(t.id).ticket.status).toBe("ready_for_merge");
    const started = d.beginLanding(t.id, { repo: repo.id, commit: attacker }, system);
    expect(started.commit).toBe(attacker);
    expect(started.commit).not.toBe(gated);
  }, 30_000);

  it("required CI, green only on the runner's gated commit, refuses the redirected head", () => {
    const dir = makeRepo();
    const d = Dispatch.open(":memory:");
    const { t, repo, attacker } = redirected(d, dir, true);
    const shown = d.ticketDiff(t.id).repos.map((r) => ({ repo: r.repoId!, sha: r.headSha! }));
    let err: unknown;
    try {
      d.approveReview(t.id, human, { commits: shown, requireCommits: true });
    } catch (e) {
      err = e;
    }
    // Required CI holds at the approval already: no green result for the shown head.
    expect(err).toBeInstanceOf(DispatchError);
    expect((err as DispatchError).code).toBe("POLICY_DENIED");
    expect((err as DispatchError).details).toMatchObject({
      reason: "ci_required",
      commit: attacker,
    });
    expect(d.view(t.id).ticket.status).toBe("in_review");
    // And the landing cannot start on it either.
    expect(() => d.beginLanding(t.id, { repo: repo.id, commit: attacker }, system)).toThrow(
      DispatchError,
    );
    expect(d.landingsStarted(t.id)).toHaveLength(0);
  }, 30_000);
});

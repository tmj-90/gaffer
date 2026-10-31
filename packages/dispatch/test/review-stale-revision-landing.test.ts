/**
 * External review #2 and #3, against REAL git repositories.
 *
 * #2 STALE REVISION — an approval names the commit(s) the reviewer saw. When a branch
 *    moved between the render and the click, approveReview refuses (STATE_CONFLICT,
 *    details.reason "stale_revision"), approves nothing and records no pin; an approval
 *    that names no commit is refused ("revision_required") when the entry point asks for
 *    one. A good approval records ONE pin per write repo, in the same transaction.
 *
 * #3 PER-REPOSITORY LANDING — a two-repo ticket is done only when BOTH approved commits
 *    landed: markMerged refuses after one landing (partial_landing, a "Partly merged"
 *    item in the human queue) and accepts once the second repo's commit is on its
 *    default branch (verified from git, recorded as a landing).
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
const agentActor: Actor = { type: "agent", id: "agt-1" };
const system: Actor = { type: "system" };
const BRANCH = "gaffer/t1";

let work: string;
const git = (dir: string, ...args: string[]): string =>
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    encoding: "utf8",
  }).trim();

function makeRepo(name: string): string {
  const dir = join(work, name);
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  writeFileSync(join(dir, "README.md"), `${name}\n`);
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  git(dir, "checkout", "-q", "-b", BRANCH);
  writeFileSync(join(dir, "change.txt"), `${name} change\n`);
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", `change ${name}`);
  git(dir, "checkout", "-q", "main");
  return dir;
}

function advance(dir: string): string {
  git(dir, "checkout", "-q", BRANCH);
  writeFileSync(join(dir, "late.txt"), "pushed after the review rendered\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "late commit");
  git(dir, "checkout", "-q", "main");
  return git(dir, "rev-parse", BRANCH);
}

/** A two-repo ticket delivered and submitted for review. */
function twoRepoInReview(d: Dispatch, a: string, b: string): { id: string; number: number } {
  const ra = d.registerRepository({ name: "repoA", default_branch: "main", local_path: a }, human);
  const rb = d.registerRepository({ name: "repoB", default_branch: "main", local_path: b }, human);
  const t = d.createTicket({ title: "spans two repos", priority: 1, risk_level: "low" }, human);
  for (const r of [ra, rb])
    d.setTicketRepoAccess(
      { ticket_id: t.id, repo_id: r.id, access: "write", relation: "confirmed" },
      human,
    );
  const { ac } = d.addAcceptanceCriterion({ ticket_id: t.id, text: "both changed" }, human);
  d.markReady(t.id, human);
  const agent = d.registerAgent({ display_name: "Bot" }, human);
  const claim = d.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, agentActor);
  if (!claim) throw new Error("expected a claim");
  d.recordEvidence(
    {
      claimToken: claim.claimToken,
      ticket_id: t.id,
      ac_id: ac.id,
      evidence_type: "test_output",
      summary: "ok",
    },
    agentActor,
  );
  for (const r of [ra, rb])
    d.recordRepoDelivery({ ticket_id: t.id, repo_id: r.id, branch_name: BRANCH }, agentActor);
  d.submitForReview({ claimToken: claim.claimToken, ticket_id: t.id, reason: "done" }, agentActor);
  return { id: t.id, number: t.number! };
}

const reviewPins = (d: Dispatch, id: string) =>
  d.view(id).evidence.filter((e) => String(e.uri ?? "").startsWith("gaffer-reviewed-commit:"));

function refusal(fn: () => unknown): DispatchError {
  try {
    fn();
  } catch (e) {
    if (e instanceof DispatchError) return e;
    throw e;
  }
  throw new Error("expected a DispatchError");
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "stale-rev-"));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("approve names the commits it saw (stale revision)", () => {
  it("the diff endpoint returns repoId + headSha for each write repo", () => {
    const a = makeRepo("a");
    const b = makeRepo("b");
    const d = Dispatch.open(":memory:");
    const t = twoRepoInReview(d, a, b);
    const diff = d.ticketDiff(t.id);
    expect(diff.repos.map((r) => [r.repo, r.headSha])).toEqual([
      ["repoA", git(a, "rev-parse", BRANCH)],
      ["repoB", git(b, "rev-parse", BRANCH)],
    ]);
    expect(diff.repos.every((r) => typeof r.repoId === "string")).toBe(true);
  });

  it("refuses an approval of a commit the branch has moved past, approving nothing", () => {
    const a = makeRepo("a");
    const b = makeRepo("b");
    const d = Dispatch.open(":memory:");
    const t = twoRepoInReview(d, a, b);
    const shown = d.ticketDiff(t.id).repos.map((r) => ({ repo: r.repoId!, sha: r.headSha! }));
    const moved = advance(a); // the branch advances between the render and the click
    const e = refusal(() => d.approveReview(t.id, human, { commits: shown, requireCommits: true }));
    expect(e.code).toBe("STATE_CONFLICT");
    expect(e.details.reason).toBe("stale_revision");
    expect(JSON.stringify(e.details.repos)).toContain(moved);
    expect(d.view(t.id).ticket.status).toBe("in_review");
    expect(reviewPins(d, t.id)).toHaveLength(0);
  });

  it("refuses an approval that leaves a write repo out", () => {
    const a = makeRepo("a");
    const b = makeRepo("b");
    const d = Dispatch.open(":memory:");
    const t = twoRepoInReview(d, a, b);
    const onlyA = [{ repo: "repoA", sha: git(a, "rev-parse", BRANCH) }];
    const e = refusal(() => d.approveReview(t.id, human, { commits: onlyA, requireCommits: true }));
    expect(e.details.reason).toBe("stale_revision");
    const bare = [{ repo: null, sha: git(a, "rev-parse", BRANCH) }];
    expect(
      refusal(() => d.approveReview(t.id, human, { commits: bare, requireCommits: true })).details
        .reason,
    ).toBe("stale_revision");
    expect(d.view(t.id).ticket.status).toBe("in_review");
  });

  it("refuses an approval that names no commit when the entry point requires one", () => {
    const a = makeRepo("a");
    const b = makeRepo("b");
    const d = Dispatch.open(":memory:");
    const t = twoRepoInReview(d, a, b);
    const e = refusal(() => d.approveReview(t.id, human, { requireCommits: true }));
    expect(e.code).toBe("STATE_CONFLICT");
    expect(e.details.reason).toBe("revision_required");
    expect(d.view(t.id).ticket.status).toBe("in_review");
  });

  it("an agent approval follows the same rule", () => {
    const a = makeRepo("a");
    const b = makeRepo("b");
    const prev = process.env.DISPATCH_ALLOW_AGENT_APPROVE;
    process.env.DISPATCH_ALLOW_AGENT_APPROVE = "1";
    try {
      const d = Dispatch.open(":memory:");
      const t = twoRepoInReview(d, a, b);
      const reviewer: Actor = { type: "agent", id: "reviewer-x" };
      const stale = [{ repo: "repoA", sha: git(a, "rev-parse", BRANCH) }];
      advance(a);
      const e = refusal(() =>
        d.approveReview(t.id, reviewer, { commits: stale, requireCommits: true }),
      );
      expect(e.details.reason).toBe("stale_revision");
    } finally {
      if (prev === undefined) delete process.env.DISPATCH_ALLOW_AGENT_APPROVE;
      else process.env.DISPATCH_ALLOW_AGENT_APPROVE = prev;
    }
  });

  it("an approval of the shown heads records one pin per repo", () => {
    const a = makeRepo("a");
    const b = makeRepo("b");
    const d = Dispatch.open(":memory:");
    const t = twoRepoInReview(d, a, b);
    const shown = d.ticketDiff(t.id).repos.map((r) => ({ repo: r.repoId!, sha: r.headSha! }));
    const res = d.approveReview(t.id, human, { commits: shown, requireCommits: true });
    expect(res.ticket.status).toBe("ready_for_merge");
    const pins = reviewPins(d, t.id);
    expect(pins).toHaveLength(2);
    expect(new Set(pins.map((p) => p.repo_id)).size).toBe(2);
    expect(pins.every((p) => p.recorded_by_actor_type === "system")).toBe(true);
    expect(d.view(t.id).landing.repos.map((r) => [r.repo, r.landed])).toEqual([
      ["repoA", false],
      ["repoB", false],
    ]);
  });
});

describe("a two-repo ticket is done only when both repos landed", () => {
  function approved(): { d: Dispatch; t: { id: string; number: number }; a: string; b: string } {
    const a = makeRepo("a");
    const b = makeRepo("b");
    const d = Dispatch.open(":memory:");
    const t = twoRepoInReview(d, a, b);
    const shown = d.ticketDiff(t.id).repos.map((r) => ({ repo: r.repoId!, sha: r.headSha! }));
    d.approveReview(t.id, human, { commits: shown, requireCommits: true });
    return { d, t, a, b };
  }

  it("markMerged refuses with nothing landed", () => {
    const { d, t } = approved();
    const e = refusal(() => d.markMerged(t.id, system));
    expect(e.code).toBe("STATE_CONFLICT");
    expect(e.details.reason).toBe("not_landed");
    expect(d.view(t.id).ticket.status).toBe("ready_for_merge");
  });

  it("after ONE repo lands the ticket is held, partly merged, in the human queue", () => {
    const { d, t, a } = approved();
    git(a, "merge", "-q", "--no-ff", "-m", "land", BRANCH);
    const shaA = git(a, "rev-parse", BRANCH);
    const rec = d.recordLanding(t.id, { repo: "repoA", commit: shaA, via: "local" }, system);
    expect(rec.recorded).toBe(true);
    // Idempotent: recording it again changes nothing.
    expect(d.recordLanding(t.id, { repo: "repoA", commit: shaA }, system).recorded).toBe(false);
    const e = refusal(() => d.markMerged(t.id, system));
    expect(e.details.reason).toBe("partial_landing");
    expect(JSON.stringify(e.details.pending)).toContain("repoB");
    expect(d.view(t.id).ticket.status).toBe("ready_for_merge");
    expect(d.view(t.id).landing.partial).toBe(true);
    const item = d.humanQueue().items.find((i) => i.ticket?.id === t.id);
    expect(item?.kind).toBe("awaiting_merge");
    expect(item?.label).toBe("Partly merged");
    expect(item?.reason).toContain("Landed in repoA");
    expect(item?.reason).toContain("repoB still on the delivery branch");
  });

  it("once the second repo's approved commit is on its default branch, the ticket is done", () => {
    const { d, t, a, b } = approved();
    git(a, "merge", "-q", "--no-ff", "-m", "land", BRANCH);
    d.recordLanding(t.id, { repo: "repoA", commit: git(a, "rev-parse", BRANCH) }, system);
    git(b, "merge", "-q", "--no-ff", "-m", "land", BRANCH); // landed without a record
    const res = d.markMerged(t.id, system); // git-verified: recorded, then done
    expect(res.ticket.status).toBe("done");
    expect(d.view(t.id).landing.repos.every((r) => r.landed)).toBe(true);
  });

  it("only an approved commit can be recorded as landed; agents cannot record one", () => {
    const { d, t, a } = approved();
    advance(a);
    const other = git(a, "rev-parse", BRANCH);
    const e = refusal(() => d.recordLanding(t.id, { repo: "repoA", commit: other }, system));
    expect(e.details.reason).toBe("not_approved_revision");
    expect(
      refusal(() => d.recordLanding(t.id, { repo: "repoA", commit: other }, agentActor)).code,
    ).toBe("ACTOR_NOT_PERMITTED");
  });

  it("a local landing the default branch does not contain is refused, so markMerged stays shut", () => {
    const { d, t, a, b } = approved();
    git(a, "merge", "-q", "--no-ff", "-m", "land", BRANCH);
    d.recordLanding(t.id, { repo: "repoA", commit: git(a, "rev-parse", BRANCH) }, system);
    // repoB never merged: a forged "local" (or unlabelled) landing row is not written.
    const pinB = git(b, "rev-parse", BRANCH);
    for (const via of ["local", undefined, "git-verified"]) {
      const e = refusal(() => d.recordLanding(t.id, { repo: "repoB", commit: pinB, via }, system));
      expect(e.code).toBe("STATE_CONFLICT");
      expect(e.details.reason).toBe("not_on_default_branch");
    }
    expect(refusal(() => d.markMerged(t.id, system)).details.reason).toBe("partial_landing");
    expect(d.view(t.id).ticket.status).toBe("ready_for_merge");
    // A PR landing happens upstream (possibly squashed), so git here cannot confirm it.
    expect(d.recordLanding(t.id, { repo: "repoB", commit: pinB, via: "pr" }, system).recorded).toBe(
      true,
    );
  });
});

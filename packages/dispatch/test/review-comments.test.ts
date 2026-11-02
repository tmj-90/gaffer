/**
 * REVIEW COMMENTS (Release A: A1 comments, A2 Fix these, A3 since your review), against a
 * REAL git repository.
 *
 * A1: a human writes a line, a file and a ticket-level comment; each line comment is
 *     anchored from git (the +-3 lines at the commit the reviewer saw, hashed); every
 *     write records a review.comment_* event; resolving is a human act (an agent and the
 *     runner are refused every write); the dossier hash does not move when a comment does.
 * A2: Fix these sends the ticket back to Refining with the deterministic reason
 *     "Fix these: N requirements (ids)", stamps sent_round, resets the ACs, and records a
 *     reject pin per write repo under its own prefix (never the reviewed-commit prefix
 *     the landing and tester binding read as an approval).
 * A3: the next attempt's interdiff starts from the reject pin; a rewritten branch is the
 *     fact history_rewritten; each comment says whether git changed its anchored lines.
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
const other: Actor = { type: "human", id: "ann" };
const agentActor: Actor = { type: "agent", id: "agt-1" };
const BRANCH = "gaffer/t1";

let work: string;
const git = (dir: string, ...args: string[]): string =>
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    encoding: "utf8",
  }).trim();

const LINES = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);

function makeRepo(): string {
  const dir = join(work, "app");
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  writeFileSync(join(dir, "src.txt"), LINES.join("\n") + "\n");
  writeFileSync(join(dir, "other.txt"), "other\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  git(dir, "checkout", "-q", "-b", BRANCH);
  const next = [...LINES];
  next[9] = "line 10 changed by the agent";
  writeFileSync(join(dir, "src.txt"), next.join("\n") + "\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "attempt 1");
  git(dir, "checkout", "-q", "main");
  return dir;
}

/** Commit on the delivery branch; returns the new head. */
function commitOnBranch(dir: string, file: string, content: string): string {
  git(dir, "checkout", "-q", BRANCH);
  writeFileSync(join(dir, file), content);
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", `edit ${file}`);
  git(dir, "checkout", "-q", "main");
  return git(dir, "rev-parse", BRANCH);
}

function deliver(d: Dispatch, ticketId: string, repoId: string): void {
  const agent = d.registerAgent({ display_name: `Bot ${Math.random()}` }, human);
  const claim = d.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, agentActor);
  if (!claim) throw new Error("expected a claim");
  const ac = d.view(ticketId).acceptanceCriteria[0]!;
  d.recordEvidence(
    {
      claimToken: claim.claimToken,
      ticket_id: ticketId,
      ac_id: ac.id,
      evidence_type: "test_output",
      summary: "ok",
    },
    agentActor,
  );
  d.recordRepoDelivery({ ticket_id: ticketId, repo_id: repoId, branch_name: BRANCH }, agentActor);
  d.submitForReview(
    { claimToken: claim.claimToken, ticket_id: ticketId, reason: "done" },
    agentActor,
  );
}

function inReview(d: Dispatch, dir: string): { id: string; number: number; repoId: string } {
  const r = d.registerRepository({ name: "app", default_branch: "main", local_path: dir }, human);
  const t = d.createTicket({ title: "comment me", priority: 1, risk_level: "low" }, human);
  d.setTicketRepoAccess(
    { ticket_id: t.id, repo_id: r.id, access: "write", relation: "confirmed" },
    human,
  );
  d.addAcceptanceCriterion({ ticket_id: t.id, text: "it works" }, human);
  d.markReady(t.id, human);
  deliver(d, t.id, r.id);
  return { id: t.id, number: t.number!, repoId: r.id };
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

const events = (d: Dispatch, id: string, type: string) =>
  d.view(id).events.filter((e) => e.event_type === type);

let d: Dispatch;
let dir: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "review-comments-"));
  dir = makeRepo();
  d = Dispatch.open(":memory:", undefined, undefined, { maxAttempts: 5 });
});
afterEach(() => {
  d.db.close();
  rmSync(work, { recursive: true, force: true });
});

describe("A1: review comments", () => {
  it("a line comment is anchored from git at the commit the reviewer saw", () => {
    const t = inReview(d, dir);
    const head = git(dir, "rev-parse", BRANCH);
    const c = d.createReviewComment(
      t.id,
      { body: "Name this better", path: "src.txt", line: 10, severity: "must_fix", commit: head },
      human,
    );
    expect(c.repo).toBe("app");
    expect(c.side).toBe("new");
    expect(c.anchor_sha).toBe(head);
    expect(c.anchor_excerpt).toBe(
      [
        "line 7",
        "line 8",
        "line 9",
        "line 10 changed by the agent",
        "line 11",
        "line 12",
        "line 13",
      ].join("\n"),
    );
    expect(c.anchor_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(c.status).toBe("open");
    expect(c.short_id).toBe(c.id.slice(0, 8));
    // The old side reads the base the branch was cut from.
    const old = d.createReviewComment(
      t.id,
      { body: "was this ok?", path: "src.txt", line: 10, side: "old" },
      human,
    );
    expect(old.anchor_excerpt).toContain("line 10\nline 11");
    // A file and a ticket-level comment.
    const f = d.createReviewComment(t.id, { body: "whole file", path: "other.txt" }, human);
    expect(f.line).toBeNull();
    expect(f.repo_id).toBe(t.repoId);
    const g = d.createReviewComment(t.id, { body: "overall" }, human);
    expect(g.path).toBeNull();
    expect(g.repo_id).toBeNull();
    expect(g.severity).toBe("consider");
    const created = events(d, t.id, "review.comment_created");
    expect(created).toHaveLength(4);
    const p = JSON.parse(created[0]!.payload_json ?? "{}");
    expect(p.comment_id).toBe(c.id);
    expect(p.body_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(p)).not.toContain("Name this better");
    expect(d.view(t.id).reviewComments.map((x) => x.id)).toEqual([c.id, old.id, f.id, g.id]);
  });

  it("refuses a line the file does not have, and a comment from an agent or the runner", () => {
    const t = inReview(d, dir);
    expect(
      refusal(() => d.createReviewComment(t.id, { body: "x", path: "src.txt", line: 99 }, human))
        .code,
    ).toBe("VALIDATION_ERROR");
    for (const actor of [agentActor, { type: "system" } as Actor]) {
      const e = refusal(() => d.createReviewComment(t.id, { body: "x" }, actor));
      expect(e.code).toBe("ACTOR_NOT_PERMITTED");
    }
    expect(d.view(t.id).reviewComments).toHaveLength(0);
  });

  it("resolve, reopen and withdraw are human acts, each audited", () => {
    const t = inReview(d, dir);
    const c = d.createReviewComment(t.id, { body: "fix", severity: "must_fix" }, human);
    expect(refusal(() => d.setReviewCommentState(c.id, "resolve", agentActor)).code).toBe(
      "ACTOR_NOT_PERMITTED",
    );
    const r = d.setReviewCommentState(c.short_id, "resolve", other);
    expect(r.status).toBe("resolved");
    expect(r.resolved_by).toBe("ann");
    expect(r.resolved_at_sha).toBe(git(dir, "rev-parse", BRANCH));
    expect(refusal(() => d.setReviewCommentState(c.id, "resolve", other)).code).toBe("NO_OP");
    expect(d.setReviewCommentState(c.id, "reopen", other).status).toBe("open");
    // Only the author (or an admin) withdraws.
    expect(refusal(() => d.setReviewCommentState(c.id, "withdraw", other)).code).toBe(
      "ACTOR_NOT_PERMITTED",
    );
    expect(d.setReviewCommentState(c.id, "withdraw", human).status).toBe("withdrawn");
    for (const type of ["resolved", "reopened", "withdrawn"])
      expect(events(d, t.id, `review.comment_${type}`)).toHaveLength(1);
    expect(d.reviewCommentSvc.counts(t.id)).toEqual({
      open: 0,
      open_must_fix: 0,
      resolved: 0,
      withdrawn: 1,
    });
  });

  it("comments stay outside the hashed dossier subject", () => {
    const t = inReview(d, dir);
    const before = d.dossier(t.id).hash;
    const c = d.createReviewComment(t.id, { body: "fix", severity: "must_fix" }, human);
    d.setReviewCommentState(c.id, "resolve", human);
    expect(d.dossier(t.id).hash).toBe(before);
  });
});

describe("A2: Fix these", () => {
  it("sends back with numbered requirements, a deterministic reason and a reject pin", () => {
    const t = inReview(d, dir);
    const head = git(dir, "rev-parse", BRANCH);
    const a = d.createReviewComment(
      t.id,
      { body: "rename", path: "src.txt", line: 10, severity: "must_fix" },
      human,
    );
    const b = d.createReviewComment(t.id, { body: "add a test", severity: "must_fix" }, human);
    const soft = d.createReviewComment(t.id, { body: "maybe", severity: "consider" }, human);
    const predicted = d.rejectOutcome(t.id);
    expect(predicted).toMatchObject({
      kind: "to_refining",
      label: "Fix these (2)",
      ac_reset: true,
      requirements: 2,
    });
    expect(predicted.sentence).toMatch(/acceptance criteria reset to not met/);
    const res = d.fixThese(t.id, {}, human);
    expect(res.ticket.status).toBe("refining");
    expect(res.rejectOutcome.kind).toBe("to_refining");
    expect(res.requirements.map((c) => c.id)).toEqual([a.id, b.id]);
    const moved = d
      .view(t.id)
      .events.filter((e) => e.event_type === "ticket.transitioned")
      .map((e) => JSON.parse(e.payload_json ?? "{}"))
      .pop();
    expect(moved.reason).toBe(
      `Fix these: 2 requirements (${a.id.slice(0, 8)}, ${b.id.slice(0, 8)})`,
    );
    const v = d.view(t.id);
    expect(v.acceptanceCriteria.every((x) => x.status !== "satisfied")).toBe(true);
    const sent = v.reviewComments.filter((c) => c.sent_round !== null).map((c) => c.id);
    expect(sent).toEqual([a.id, b.id]);
    expect(v.reviewComments.find((c) => c.id === soft.id)!.sent_round).toBeNull();
    // The reject pin: system commit evidence under its own prefix, never a review pin.
    const pins = v.evidence.filter((e) =>
      String(e.uri ?? "").startsWith("gaffer-rejected-commit:"),
    );
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({
      uri: `gaffer-rejected-commit:${head}`,
      repo_id: t.repoId,
      recorded_by_actor_type: "system",
      evidence_type: "commit",
    });
    expect(v.evidence.some((e) => String(e.uri ?? "").startsWith("gaffer-reviewed-commit:"))).toBe(
      false,
    );
    expect(d.landingStatus(t.id).repos).toEqual([]);
  });

  it("is refused to an agent and when no open must-fix comment exists", () => {
    const t = inReview(d, dir);
    expect(refusal(() => d.fixThese(t.id, {}, human)).details.reason).toBe("no_requirements");
    d.createReviewComment(t.id, { body: "fix", severity: "must_fix" }, human);
    expect(refusal(() => d.fixThese(t.id, {}, agentActor)).code).toBe("ACTOR_NOT_PERMITTED");
    const soft = d.createReviewComment(t.id, { body: "maybe" }, human);
    expect(refusal(() => d.fixThese(t.id, { commentIds: [soft.id] }, human)).code).toBe(
      "VALIDATION_ERROR",
    );
    expect(d.resolveTicket(t.id).status).toBe("in_review");
  });

  it("names the retry-cap park in its outcome", () => {
    d.db.close();
    d = Dispatch.open(":memory:", undefined, undefined, { maxAttempts: 1 });
    const t = inReview(d, dir);
    d.createReviewComment(t.id, { body: "fix", severity: "must_fix" }, human);
    expect(d.rejectOutcome(t.id).kind).toBe("parked_retry_cap");
    const res = d.fixThese(t.id, {}, human);
    expect(res.ticket.status).toBe("blocked");
    expect(res.rejectOutcome.kind).toBe("parked_retry_cap");
  });
});

describe("A3: since your review", () => {
  it("diffs from the reject pin, and tags each comment from git", () => {
    const t = inReview(d, dir);
    const near = d.createReviewComment(
      t.id,
      { body: "rename", path: "src.txt", line: 10, severity: "must_fix" },
      human,
    );
    const far = d.createReviewComment(
      t.id,
      { body: "tail", path: "src.txt", line: 19, severity: "must_fix" },
      human,
    );
    const file = d.createReviewComment(t.id, { body: "whole", path: "other.txt" }, human);
    expect(d.ticketDiffSince(t.id).since[0]).toMatchObject({
      available: false,
      reason: "no_reject_pin",
    });
    const pinned = git(dir, "rev-parse", BRANCH);
    d.fixThese(t.id, {}, human);
    // Attempt 2 edits line 10 only.
    const next = [...LINES];
    next[9] = "line 10 renamed";
    const head2 = commitOnBranch(dir, "src.txt", next.join("\n") + "\n");
    const since = d.ticketDiffSince(t.id);
    expect(since.since[0]).toMatchObject({
      from_sha: pinned,
      to_sha: head2,
      available: true,
      history_rewritten: false,
    });
    expect(since.repos[0]!.files).toBe(1);
    expect(since.repos[0]!.diff).toContain("+line 10 renamed");
    expect(since.repos[0]!.diff).toContain("-line 10 changed by the agent");
    const states = Object.fromEntries(
      d.listReviewComments(t.id, { anchors: true }).map((c) => [c.id, c.anchor_state]),
    );
    expect(states[near.id]).toBe("changed");
    expect(states[far.id]).toBe("untouched");
    expect(states[file.id]).toBe("untouched");
    // The heads endpoint reads only the branch head.
    expect(d.ticketHeads(t.id).heads).toEqual([{ repo: "app", repo_id: t.repoId, sha: head2 }]);
  });

  it("starts from the commit a PERSON sent back, not an agent reviewer's later send-back", () => {
    const t = inReview(d, dir);
    d.createReviewComment(t.id, { body: "fix", severity: "must_fix" }, human);
    const humanPin = git(dir, "rev-parse", BRANCH);
    d.fixThese(t.id, {}, human);
    // Attempt 2 is delivered, and the AGENT reviewer sends it back (review.sh's path).
    commitOnBranch(dir, "src.txt", [...LINES, "attempt 2"].join("\n") + "\n");
    d.markReady(t.id, human);
    deliver(d, t.id, t.repoId);
    d.rejectReview(t.id, "ready", agentActor, "the agent reviewer wants more");
    // Attempt 3 reaches the person.
    const head3 = commitOnBranch(
      dir,
      "src.txt",
      [...LINES, "attempt 2", "attempt 3"].join("\n") + "\n",
    );
    deliver(d, t.id, t.repoId);
    const since = d.ticketDiffSince(t.id).since[0]!;
    expect(since).toMatchObject({ from_sha: humanPin, to_sha: head3, available: true });
    expect(d.ticketDiffSince(t.id).repos[0]!.diff).toContain("+attempt 2");
  });

  it("reports a rewritten branch as a fact instead of a guessed interdiff", () => {
    const t = inReview(d, dir);
    d.createReviewComment(t.id, { body: "fix", severity: "must_fix" }, human);
    d.fixThese(t.id, {}, human);
    // A fresh branch from main (GAFFER_RETRY_FRESH_BRANCH=1 or a reset).
    git(dir, "branch", "-f", BRANCH, "main");
    commitOnBranch(dir, "src.txt", "rebuilt\n");
    const since = d.ticketDiffSince(t.id);
    expect(since.since[0]).toMatchObject({ available: true, history_rewritten: true });
    expect(since.repos).toEqual([]);
  });
});

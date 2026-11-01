import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { listEvents } from "../src/events/eventWriter.js";

import { runCli } from "./helpers/cli.js";

/**
 * Exploratory finding cli-wg/F-04: `wg review approve` / `review reject` recorded the
 * actor as `human:reviewer` (a literal default), `last_review_feedback.reviewer` read
 * "reviewer" and `ticket.reviewer` stayed null, so the audit trail could not say who
 * approved from the CLI. README: "On the CLI the actor is whatever `$USER` says." The
 * human default is now $USER, and an unassigned ticket records its human reviewer.
 */
const human: Actor = { type: "human", id: "tom" };
const agentActor: Actor = { type: "agent", id: "agt-1" };
const BRANCH = "gaffer/t1";

let work: string;
let db: string;
const git = (dir: string, ...args: string[]): string =>
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    encoding: "utf8",
  }).trim();

function makeRepo(): string {
  const dir = join(work, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  writeFileSync(join(dir, "README.md"), "r\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  git(dir, "checkout", "-q", "-b", BRANCH);
  writeFileSync(join(dir, "change.txt"), "change\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "change");
  git(dir, "checkout", "-q", "main");
  return dir;
}

/** One ticket delivered on a real branch and in review; returns its number. */
function inReview(repoDir: string, reviewer?: string): number {
  const d = Dispatch.open(db);
  try {
    const r = d.registerRepository(
      {
        name: `repo-${Math.random().toString(36).slice(2, 8)}`,
        default_branch: "main",
        local_path: repoDir,
      },
      human,
    );
    const t = d.createTicket({ title: "ship it", risk_level: "low" }, human);
    d.setTicketRepoAccess(
      { ticket_id: t.id, repo_id: r.id, access: "write", relation: "confirmed" },
      human,
    );
    const { ac } = d.addAcceptanceCriterion({ ticket_id: t.id, text: "changed" }, human);
    if (reviewer) d.assignReviewer(t.id, reviewer, human);
    d.markReady(t.id, human);
    const agent = d.registerAgent({ display_name: "Bot" }, human);
    const claim = d.claimTicket(
      { ticket_id: t.id, agent_id: agent.id, ttl_seconds: 600 },
      agentActor,
    );
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
    d.recordRepoDelivery({ ticket_id: t.id, repo_id: r.id, branch_name: BRANCH }, agentActor);
    d.submitForReview(
      { claimToken: claim.claimToken, ticket_id: t.id, reason: "done" },
      agentActor,
    );
    return t.number!;
  } finally {
    d.db.close();
  }
}

function latest(n: number) {
  const d = Dispatch.open(db);
  try {
    const t = d.resolveTicket(String(n));
    const ev = listEvents(d.db, "ticket", t.id).filter(
      (e) => e.event_type === "ticket.transitioned",
    );
    return { ticket: t, last: ev[ev.length - 1]! };
  } finally {
    d.db.close();
  }
}

describe("cli-wg F-04: review approve / reject act as $USER", () => {
  let repo: string;
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "wg-review-user-"));
    db = join(work, "d.sqlite");
    Dispatch.open(db).db.close();
    repo = makeRepo();
  });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  it("approve records human:$USER and sets ticket.reviewer", () => {
    const n = inReview(repo);
    const sha = git(repo, "rev-parse", BRANCH);
    const r = runCli(db, ["review", "approve", String(n), "--commit", sha], { USER: "alice" });
    expect(r.error).toBeUndefined();
    const { ticket, last } = latest(n);
    expect(`${last.actor_type}:${last.actor_id}`).toBe("human:alice");
    expect(ticket.reviewer).toBe("alice");
  });

  it("reject records $USER in last_review_feedback and on the event", () => {
    const n = inReview(repo);
    const r = runCli(db, ["review", "reject", String(n), "--reason", "needs work"], {
      USER: "alice",
    });
    expect(r.error).toBeUndefined();
    const { ticket, last } = latest(n);
    expect(`${last.actor_type}:${last.actor_id}`).toBe("human:alice");
    expect(JSON.parse(ticket.last_review_feedback ?? "{}").reviewer).toBe("alice");
    expect(ticket.reviewer).toBe("alice");
  });

  it("--reviewer still names someone else, and an assigned reviewer is not overwritten", () => {
    const n = inReview(repo, "carol");
    const sha = git(repo, "rev-parse", BRANCH);
    runCli(db, ["review", "approve", String(n), "--commit", sha, "--reviewer", "bob"], {
      USER: "alice",
    });
    const { ticket, last } = latest(n);
    expect(`${last.actor_type}:${last.actor_id}`).toBe("human:bob");
    expect(ticket.reviewer).toBe("carol");
  });

  it("an agent or runner rejection never becomes the ticket's reviewer", () => {
    const n = inReview(repo);
    runCli(db, [
      "review",
      "reject",
      String(n),
      "--reason",
      "ci red",
      "--as",
      "system",
      "--reviewer",
      "factory-ci",
    ]);
    const { ticket } = latest(n);
    expect(ticket.reviewer).toBeNull();
    expect(JSON.parse(ticket.last_review_feedback ?? "{}").reviewer).toBe("factory-ci");
  });
});

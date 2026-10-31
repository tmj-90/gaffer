/**
 * TESTER REPLAY ON THE LANDED REVISION (external review #4), against a REAL git repo.
 *
 * The runner's landing path records which of the independent tester's assertions passed
 * on which landed revision: a SYSTEM `commit` evidence row, uri
 * `gaffer-tester-replayed:<landed sha>`. The epic is counted as accepted only on that
 * record, so its ACTOR RULE is the point: only `system` (the runner) may write it — not an
 * agent, not a human, not an admin — and only for the tested commit that actually landed.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { readTesterReplay, TESTER_REPLAY_PREFIX } from "../src/services/testerReplay.js";
import { DispatchError } from "../src/util/errors.js";

const human: Actor = { type: "human", id: "tom" };
const admin: Actor = { type: "admin", id: "root" };
const agentActor: Actor = { type: "agent", id: "agt-1" };
const tester: Actor = { type: "agent", id: "tester-1" };
const system: Actor = { type: "system" };
const BRANCH = "gaffer/t1";

let work: string;
const git = (dir: string, ...args: string[]): string =>
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    encoding: "utf8",
  }).trim();

function makeRepo(): string {
  const dir = join(work, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  writeFileSync(join(dir, "README.md"), "repo\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  git(dir, "checkout", "-q", "-b", BRANCH);
  writeFileSync(join(dir, "change.txt"), "change\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "change");
  git(dir, "checkout", "-q", "main");
  return dir;
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

/**
 * A testable ticket delivered, approved (pinning the branch head) and passed by the tester
 * bound to that head: ready_for_merge, with the head merged onto main (the landed merge).
 */
function testedAndLanded(opts: { waiver?: boolean } = {}) {
  const repoDir = makeRepo();
  const d = Dispatch.open(":memory:", undefined, undefined, { testingEnabled: true });
  const r = d.registerRepository(
    { name: "repo", default_branch: "main", local_path: repoDir },
    human,
  );
  const t = d.createTicket({ title: "label", priority: 1, risk_level: "low" }, human);
  d.setTicketRepoAccess(
    { ticket_id: t.id, repo_id: r.id, access: "write", relation: "confirmed" },
    human,
  );
  const { ac } = d.addAcceptanceCriterion({ ticket_id: t.id, text: "label reads Ada" }, human);
  d.setTestable(t.id, true, human);
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
  d.recordRepoDelivery({ ticket_id: t.id, repo_id: r.id, branch_name: BRANCH }, agentActor);
  d.submitForReview({ claimToken: claim.claimToken, ticket_id: t.id, reason: "done" }, agentActor);
  const pin = git(repoDir, "rev-parse", BRANCH);
  const approved = d.approveReview(t.id, human, {
    commits: [{ repo: r.id, sha: pin }],
    requireCommits: true,
  });
  expect(approved.ticket.status).toBe("in_testing");
  if (opts.waiver) d.testerPass(t.id, { summary: "checked by hand" }, human);
  else d.testerPass(t.id, { summary: "black-box PASS", tested_commit: pin }, tester);
  expect(d.view(t.id).ticket.status).toBe("ready_for_merge");
  git(repoDir, "merge", "-q", "--no-ff", "-m", "land", BRANCH);
  const landed = git(repoDir, "rev-parse", "main");
  return { d, t, r, repoDir, pin, landed };
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "tester-replay-"));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("the tester-replay record's actor rule", () => {
  it("only the system actor (the runner's landing path) may record it — agent, human and admin are refused", () => {
    const { d, t, pin, landed } = testedAndLanded();
    const input = { commit: landed, pin, files: ["test/bb-label.test.js"] };
    for (const actor of [agentActor, tester, human, admin]) {
      const e = refusal(() => d.recordTesterReplay(t.id, input, actor));
      expect(e.code).toBe("ACTOR_NOT_PERMITTED");
    }
    expect(readTesterReplay(d.db, t.id, pin)).toBeNull();
    const res = d.recordTesterReplay(t.id, input, system);
    expect(res.recorded).toBe(true);
    const ev = d
      .view(t.id)
      .evidence.filter((e) => String(e.uri ?? "").startsWith(TESTER_REPLAY_PREFIX));
    expect(ev).toHaveLength(1);
    expect(ev[0]!.uri).toBe(`${TESTER_REPLAY_PREFIX}${landed}`);
    expect(ev[0]!.recorded_by_actor_type).toBe("system");
    const rec = readTesterReplay(d.db, t.id, pin);
    expect(rec?.commit).toBe(landed);
    expect(rec?.files).toEqual(["test/bb-label.test.js"]);
    // Idempotent per landed revision.
    expect(d.recordTesterReplay(t.id, input, system).recorded).toBe(false);
    expect(
      d.view(t.id).events.filter((e) => e.event_type === "ticket.tester_replayed"),
    ).toHaveLength(1);
  });

  it("a row shaped like the record but written by an agent (the MCP's evidence tool) is not a record", () => {
    const { d, t, pin, landed } = testedAndLanded();
    d.db
      .prepare(
        "INSERT INTO evidence (id, ticket_id, evidence_type, summary, uri, payload_json, created_by, recorded_by_actor_type, created_at) VALUES ('forged', ?, 'commit', 'forged', ?, ?, 'agt-1', 'agent', '2099-01-01T00:00:00.000Z')",
      )
      .run(
        t.id,
        `${TESTER_REPLAY_PREFIX}${landed}`,
        JSON.stringify({ kind: "tester_replay", tested: pin, pin, files: [] }),
      );
    expect(readTesterReplay(d.db, t.id, pin)).toBeNull();
  });

  it("is refused unless it names the tested commit that landed, on an approved ticket", () => {
    const { d, t, pin, landed } = testedAndLanded();
    const other = "0".repeat(40);
    // The pin must be the commit the tester's PASS is bound to.
    expect(
      refusal(() => d.recordTesterReplay(t.id, { commit: landed, pin: other, files: [] }, system))
        .details,
    ).toMatchObject({ reason: "not_tested_commit" });
    // A local landing must be on the default branch.
    expect(
      refusal(() => d.recordTesterReplay(t.id, { commit: other, pin, files: [] }, system)).details,
    ).toMatchObject({ reason: "not_on_default_branch" });
    // A PR landing names the fast-forwarded local default's head (the runner checked its
    // tree is the candidate the replay passed on): it must be on the default branch too —
    // a scratch candidate GitHub never landed is refused.
    expect(
      refusal(() =>
        d.recordTesterReplay(t.id, { commit: other, pin, files: [], via: "pr" }, system),
      ).details,
    ).toMatchObject({ reason: "not_on_default_branch" });
    // A PR merge whose local default was not fast-forwarded cannot show what landed.
    expect(
      refusal(() =>
        d.recordTesterReplay(t.id, { commit: landed, pin, files: [], via: "pr-stale" }, system),
      ).details,
    ).toMatchObject({ reason: "unverifiable_landing" });
    // Malformed input.
    expect(
      refusal(() => d.recordTesterReplay(t.id, { commit: "abc", pin, files: [] }, system)).code,
    ).toBe("VALIDATION_ERROR");
    expect(
      refusal(() => d.recordTesterReplay(t.id, { commit: landed, pin, files: ["a\nb"] }, system))
        .code,
    ).toBe("VALIDATION_ERROR");
    // Only while the ticket is approved (before mark-merged), like a landing record.
    d.recordLanding(t.id, { repo: "repo", commit: pin, via: "local" }, system);
    d.markMerged(t.id, system);
    expect(
      refusal(() => d.recordTesterReplay(t.id, { commit: landed, pin, files: [] }, system)).code,
    ).toBe("ILLEGAL_TRANSITION");
  });

  it("MULTI-REPO: the record names the repo replayed and the ticket's other write repos it did not cover", () => {
    const { d, t, repoDir, pin, landed } = testedAndLanded();
    const b = d.registerRepository(
      { name: "repo-b", default_branch: "main", local_path: repoDir },
      human,
    );
    d.db
      .prepare(
        "INSERT INTO ticket_repos (ticket_id, repo_id, role, access, relation) VALUES (?, ?, 'secondary', 'write', 'confirmed')",
      )
      .run(t.id, b.id);
    d.recordTesterReplay(
      t.id,
      { commit: landed, pin, files: ["test/bb-label.test.js"], repo: "repo" },
      system,
    );
    const rec = readTesterReplay(d.db, t.id, pin);
    expect(rec?.notReplayedRepos).toEqual(["repo-b"]);
    const ev = d
      .view(t.id)
      .evidence.find((e) => String(e.uri ?? "").startsWith(TESTER_REPLAY_PREFIX));
    expect(ev?.summary).toContain("not replayed in repo-b");
  });

  it("a HUMAN tester waiver has no tester assertions to replay: nothing can be recorded", () => {
    const { d, t, pin, landed } = testedAndLanded({ waiver: true });
    expect(
      refusal(() => d.recordTesterReplay(t.id, { commit: landed, pin, files: [] }, system)).details,
    ).toMatchObject({ reason: "not_tested_commit" });
  });
});

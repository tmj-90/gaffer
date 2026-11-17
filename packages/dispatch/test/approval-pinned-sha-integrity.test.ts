/**
 * External review 21, item 1: an agent's approval must judge the commit it pins.
 *
 * The reviewer's reproduction, with a real Git repository: the delivery branch holds a
 * commit that adds `test.skip` (a GATE INTEGRITY hard hold) on top of a safe commit.
 *  (a) Left in place, the autonomous approval is refused (OBSERVED_RISK_ESCALATED).
 *  (b) Moved to the safe predecessor while the integrity scan reads it, then moved
 *      back: the approval used to succeed and pin the commit carrying `test.skip`,
 *      because the scan read the branch NAME while the diff read the resolved commit,
 *      and the head comparison saw the same commit before and after.
 *  (c) The approved commit, inspected again, carries the hold.
 *
 * The rule pinned here: the approval resolves each write repo's head ONCE and every Git
 * read that feeds the decision takes that commit (and the base commit), never a branch
 * name or HEAD. A hook in the Git seam moves the branch to the safe commit at every Git
 * call index of the approval (for one call, for a few calls, and for the rest of the
 * approval) and back; in every case the approval is refused, or approves and pins the
 * SAFE commit. It never pins the risky one.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { fileGateKeyring } from "../src/events/gateSeal.js";
import { defaultGitRunner, type GitRunner } from "../src/services/diffService.js";
import { REVIEW_PIN_PREFIX } from "../src/services/landingStatus.js";
import { systemClock } from "../src/util/clock.js";

const human: Actor = { type: "human", id: "tom" };
const agent: Actor = { type: "agent", id: "gaffer-factory" };
const agentRunner: Actor = { type: "agent", id: "agent-runner" };
const BRANCH = "gaffer/ticket-1-x";

const FLAGS = ["AUTO_MERGE", "MERGE_ON_AGENT_REVIEW", "DISPATCH_ALLOW_AGENT_APPROVE"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const f of FLAGS) {
    saved[f] = process.env[f];
    delete process.env[f];
  }
});

let repoDir = "";
let base = "";
let safe = "";
let risky = "";
const roots: string[] = [];
const open: Dispatch[] = [];

function git(...args: string[]): string {
  return execFileSync("git", ["-C", repoDir, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: repoDir,
    },
  }).trim();
}

/** main with one passing test; the delivery: a safe commit, then one adding test.skip. */
beforeAll(() => {
  repoDir = mkdtempSync(join(tmpdir(), "r21-pinned-sha-"));
  git("init", "-q", "-b", "main");
  mkdirSync(join(repoDir, "test"));
  writeFileSync(join(repoDir, "test/a.test.js"), 'test("a", () => { expect(1).toBe(1); });\n');
  writeFileSync(join(repoDir, "a.js"), "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  base = git("rev-parse", "HEAD");
  git("checkout", "-q", "-b", BRANCH);
  writeFileSync(join(repoDir, "a.js"), "export const a = 2;\n");
  git("commit", "-qam", "safe change");
  safe = git("rev-parse", "HEAD");
  writeFileSync(join(repoDir, "test/a.test.js"), 'test.skip("a", () => { expect(1).toBe(1); });\n');
  git("commit", "-qam", "skip the test");
  risky = git("rev-parse", "HEAD");
  git("checkout", "-q", "--detach", "main");
});

afterEach(() => {
  for (const wg of open.splice(0)) wg.db.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  for (const f of FLAGS) {
    if (saved[f] === undefined) delete process.env[f];
    else process.env[f] = saved[f];
  }
});
afterAll(() => {
  if (repoDir) rmSync(repoDir, { recursive: true, force: true });
});

/**
 * The window during which the delivery branch points at the safe commit, in Git call
 * indexes of the approval (1-based, inclusive). Calls outside an armed approval are
 * not counted.
 */
interface Window {
  from: number;
  to: number;
}

function world(window: Window | null) {
  git("update-ref", `refs/heads/${BRANCH}`, risky);
  const root = mkdtempSync(join(tmpdir(), "r21-pinned-world-"));
  roots.push(root);
  const data = join(root, "data");
  mkdirSync(data, { recursive: true });
  const dbPath = join(data, "dispatch.sqlite");
  const seam = { armed: false, calls: 0, window };
  const runner: GitRunner = (cwd, args, opts) => {
    if (!seam.armed || !seam.window) return defaultGitRunner(cwd, args, opts);
    seam.calls += 1;
    const n = seam.calls;
    if (n === seam.window.from) git("update-ref", `refs/heads/${BRANCH}`, safe);
    try {
      return defaultGitRunner(cwd, args, opts);
    } finally {
      if (n === seam.window.to) git("update-ref", `refs/heads/${BRANCH}`, risky);
    }
  };
  const counting: GitRunner = (cwd, args, opts) => {
    if (seam.armed && !seam.window) seam.calls += 1;
    return runner(cwd, args, opts);
  };
  const wg = Dispatch.open(dbPath, systemClock, counting, {
    gateKeyring: fileGateKeyring({ dbPath, keysDir: join(root, "keys") }),
  });
  open.push(wg);
  return { wg, seam };
}

function delivered(wg: Dispatch): string {
  const t = wg.createTicket(
    { title: "Ship", description: "x", policy_pack: "team_light", risk_level: "low" },
    human,
  );
  const { ac } = wg.addAcceptanceCriterion({ ticket_id: t.id, text: "ok" }, human);
  const repo = wg.registerRepository(
    { name: "svc", default_branch: "main", local_path: repoDir },
    human,
  );
  wg.setTicketRepoAccess(
    { ticket_id: t.id, repo_id: repo.id, access: "write", relation: "confirmed" },
    human,
  );
  wg.recordRepoDelivery(
    { ticket_id: t.id, repo_id: repo.id, branch_name: BRANCH, base_sha: base },
    human,
  );
  wg.markReady(t.id, human);
  const reg = wg.registerAgent({ display_name: "a", max_risk: "critical" }, human);
  const claim = wg.claimNextTicket({ agentId: reg.id, ttlSeconds: 600 }, agentRunner);
  wg.recordEvidence(
    {
      claimToken: claim!.claimToken,
      ticket_id: t.id,
      ac_id: ac.id,
      evidence_type: "test_output",
      summary: "passed",
    },
    agentRunner,
  );
  wg.submitForReview({ claimToken: claim!.claimToken, ticket_id: t.id, reason: "d" }, agentRunner);
  wg.setAutonomyPolicy(
    { repoId: repo.id, riskLevel: "low", gate: "approve", mode: "auto", confirm: true },
    human,
  );
  return t.id;
}

function pinsOf(wg: Dispatch, id: string): string[] {
  const rows = wg.db
    .prepare("SELECT uri FROM evidence WHERE ticket_id = ? AND uri LIKE ?")
    .all(id, `${REVIEW_PIN_PREFIX}%`) as Array<{ uri: string }>;
  return rows.map((r) => r.uri.slice(REVIEW_PIN_PREFIX.length));
}

type Naming = "risky" | "safe";
const commitsFor = (naming: Naming) => ({
  commits: [{ repo: "svc", sha: naming === "risky" ? risky : safe }],
});

function attempt(window: Window | null, naming: Naming) {
  const { wg, seam } = world(window);
  const id = delivered(wg);
  seam.armed = true;
  let refused: string | undefined;
  try {
    wg.approveReview(id, agent, commitsFor(naming));
  } catch (err) {
    refused = (err as { code?: string }).code ?? String(err);
  }
  seam.armed = false;
  git("update-ref", `refs/heads/${BRANCH}`, risky);
  return { wg, id, refused, calls: seam.calls, pins: pinsOf(wg, id) };
}

describe("an agent's approval judges the commit it pins (real Git)", () => {
  it("(a) the commit carrying test.skip, left in place, is held", () => {
    const r = attempt(null, "risky");
    expect(r.refused).toBe("OBSERVED_RISK_ESCALATED");
    expect(r.pins).toEqual([]);
    expect(r.wg.resolveTicket(r.id).status).toBe("in_review");
  }, 30_000);

  it("(c) the risky commit, inspected again, carries the hold", () => {
    const { wg } = world(null);
    const id = delivered(wg);
    const ann = wg.ticketDiff(id).repos[0]!.riskAnnotations.find((a) => a.kind === "test-modified");
    expect(ann?.severity).toBe("high");
  }, 30_000);

  // The runner's reviewer names the commit it reviewed (lib/review.sh, --commit): the
  // risky head, or (a reviewer that saw the moved branch) the safe one. An agent's
  // approval without named commits pins nothing and cannot land (landingStatus).
  for (const naming of ["risky", "safe"] as const) {
    it(`(b) the branch moved to the safe commit and back at any Git call never gets the risky commit approved (named: ${naming})`, () => {
      // How many Git calls an approval makes: the most of a held run and of a run that
      // sees the safe commit throughout (that one gets past the gate and pins).
      const held = attempt(null, naming).calls;
      const through = attempt({ from: 1, to: Number.MAX_SAFE_INTEGER }, naming).calls;
      const calls = Math.max(held, through) + 1;
      expect(calls).toBeGreaterThan(3);

      const windows: Window[] = [];
      for (let from = 1; from <= calls; from++) {
        for (const span of [0, 1, 3]) windows.push({ from, to: from + span });
        windows.push({ from, to: Number.MAX_SAFE_INTEGER });
      }
      const bad: unknown[] = [];
      for (const w of windows) {
        const r = attempt(w, naming);
        const ok =
          r.refused !== undefined
            ? r.pins.length === 0
            : r.pins.length > 0 && r.pins.every((p) => p === safe);
        if (!ok) bad.push({ window: w, refused: r.refused ?? null, pins: r.pins });
      }
      expect(bad).toEqual([]);
      // Named safe and moved for the rest of the approval, the safe commit is approved.
      if (naming === "safe") {
        const r = attempt({ from: 1, to: Number.MAX_SAFE_INTEGER }, naming);
        expect(r.refused).toBeUndefined();
        expect(r.pins).toEqual([safe]);
      }
    }, 600_000);
  }
});

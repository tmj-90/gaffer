/**
 * Review of external review 21, item 1: the BASE branch is as mutable as the delivery
 * branch. A delivery of three commits (safe, one adding a CI workflow, a harmless third)
 * is approved by an agent at its head. With the base branch parked on the workflow
 * commit for the length of the approval, `base...head` showed only the third commit:
 * the observed risk read "low", the approval pinned the head, and the workflow change
 * would land once the base moved back. The approval now observes from the cut point the
 * runner recorded (base_sha), as the integrity scan already did.
 *
 * The honest direction: a base that moved on with unrelated work (the delivery not
 * merged into it) still approves the same harmless delivery.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

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
const roots: string[] = [];
const open: Dispatch[] = [];

beforeEach(() => {
  for (const f of FLAGS) {
    saved[f] = process.env[f];
    delete process.env[f];
  }
});
afterEach(() => {
  for (const wg of open.splice(0)) wg.db.close();
  for (const f of FLAGS) {
    if (saved[f] === undefined) delete process.env[f];
    else process.env[f] = saved[f];
  }
});
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "base-parked-"));
  roots.push(dir);
  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
        GIT_CONFIG_NOSYSTEM: "1",
        HOME: dir,
      },
    }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.js"), "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  const base = git("rev-parse", "HEAD");
  git("checkout", "-q", "-b", BRANCH);
  writeFileSync(join(dir, "a.js"), "export const a = 2;\n");
  git("commit", "-qam", "safe");
  mkdirSync(join(dir, ".github/workflows"), { recursive: true });
  writeFileSync(join(dir, ".github/workflows/ci.yml"), "on: push\n");
  git("add", "-A");
  git("commit", "-qm", "workflow");
  const workflow = git("rev-parse", "HEAD");
  writeFileSync(join(dir, "b.js"), "export const b = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "third");
  const head = git("rev-parse", "HEAD");
  // A harmless delivery from the same base, for the honest direction.
  git("checkout", "-q", "-b", "gaffer/ticket-2-y", base);
  writeFileSync(join(dir, "c.js"), "export const c = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "harmless");
  const harmless = git("rev-parse", "HEAD");
  // Unrelated work on main after the cut.
  git("checkout", "-q", "main");
  writeFileSync(join(dir, "d.js"), "export const d = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "main moved on");
  const mainLater = git("rev-parse", "HEAD");
  git("checkout", "-q", "--detach", base);
  return { dir, git, base, workflow, head, harmless, mainLater };
}

function deliveredAndApproved(
  r: ReturnType<typeof repo>,
  branch: string,
  sha: string,
  baseTip: string,
) {
  r.git("update-ref", "refs/heads/main", r.mainLater);
  const root = mkdtempSync(join(tmpdir(), "base-parked-world-"));
  roots.push(root);
  mkdirSync(join(root, "data"));
  const dbPath = join(root, "data", "dispatch.sqlite");
  const seam = { armed: false };
  // While armed, the base branch is parked on `baseTip` (put back after the approval).
  const runner: GitRunner = (cwd, args, opts) => {
    if (seam.armed) r.git("update-ref", "refs/heads/main", baseTip);
    return defaultGitRunner(cwd, args, opts);
  };
  const wg = Dispatch.open(dbPath, systemClock, runner, {
    gateKeyring: fileGateKeyring({ dbPath, keysDir: join(root, "keys") }),
  });
  open.push(wg);
  const t = wg.createTicket(
    { title: "Ship", description: "x", policy_pack: "team_light", risk_level: "low" },
    human,
  );
  const { ac } = wg.addAcceptanceCriterion({ ticket_id: t.id, text: "ok" }, human);
  const reg = wg.registerRepository(
    { name: "svc", default_branch: "main", local_path: r.dir },
    human,
  );
  wg.setTicketRepoAccess(
    { ticket_id: t.id, repo_id: reg.id, access: "write", relation: "confirmed" },
    human,
  );
  wg.recordRepoDelivery(
    { ticket_id: t.id, repo_id: reg.id, branch_name: branch, base_sha: r.base },
    human,
  );
  wg.markReady(t.id, human);
  const a = wg.registerAgent({ display_name: "a", max_risk: "critical" }, human);
  const claim = wg.claimNextTicket({ agentId: a.id, ttlSeconds: 600 }, agentRunner);
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
    { repoId: reg.id, riskLevel: "low", gate: "approve", mode: "auto", confirm: true },
    human,
  );
  seam.armed = true;
  let refused: string | undefined;
  try {
    wg.approveReview(t.id, agent, { commits: [{ repo: "svc", sha }] });
  } catch (err) {
    refused = (err as { code?: string }).code ?? String(err);
  }
  seam.armed = false;
  r.git("update-ref", "refs/heads/main", r.mainLater);
  const pins = (
    wg.db
      .prepare("SELECT uri FROM evidence WHERE ticket_id = ? AND uri LIKE ?")
      .all(t.id, `${REVIEW_PIN_PREFIX}%`) as Array<{ uri: string }>
  ).map((x) => x.uri.slice(REVIEW_PIN_PREFIX.length));
  return { refused, pins };
}

describe("an agent approval observes the delivery from its recorded cut, not the base tip", () => {
  it("a base parked on the delivery's workflow commit does not hide it", () => {
    const r = repo();
    r.git("update-ref", `refs/heads/${BRANCH}`, r.head);
    const res = deliveredAndApproved(r, BRANCH, r.head, r.workflow);
    expect(res.refused).toBe("OBSERVED_RISK_ESCALATED");
    expect(res.pins).toEqual([]);
  }, 30_000);

  it("the same delivery with the base left alone is held as before", () => {
    const r = repo();
    r.git("update-ref", `refs/heads/${BRANCH}`, r.head);
    const res = deliveredAndApproved(r, BRANCH, r.head, r.mainLater);
    expect(res.refused).toBe("OBSERVED_RISK_ESCALATED");
  }, 30_000);

  it("honest: a harmless delivery approves while the base has moved on with other work", () => {
    const r = repo();
    const res = deliveredAndApproved(r, "gaffer/ticket-2-y", r.harmless, r.mainLater);
    expect(res.refused).toBeUndefined();
    expect(res.pins).toEqual([r.harmless]);
  }, 30_000);
});

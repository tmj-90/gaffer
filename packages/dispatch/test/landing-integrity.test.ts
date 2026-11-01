// LANDING INTEGRITY (exploratory test pass, Package A). Each block pins one finding:
//   cli-runner/F-02  a partly landed ticket cannot be cancelled (PARTLY_LANDED);
//   cli-wg/F-10      `ticket landing` drops the approval's pins once it is withdrawn;
//   ...and the further findings added below, one describe per finding.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import type { GitRunner } from "../src/services/diffService.js";
import { systemClock } from "../src/util/clock.js";
import { DispatchError } from "../src/util/errors.js";
import { giveTicketRealDelivery, nonEmptyDiffRunner } from "./helpers/realDiff.js";

const human: Actor = { type: "human", id: "tom" };
const system: Actor = { type: "system" };
const agentActor: Actor = { type: "agent", id: "agent-runner" };

const ENV_KEYS = ["AUTO_MERGE", "GAFFER_TESTING", "GAFFER_DATA"] as const;
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** Branch heads the test can move, one per branch (a review pin is one of these). */
let head = "a".repeat(40);
const branchHead = new Map<string, string>();
let gitOverride: GitRunner | null = null;
const movableHead: GitRunner = (cwd, args, opts) => {
  if (gitOverride) {
    const r = gitOverride(cwd, args, opts);
    if (r) return r;
  }
  if (args[0] === "rev-parse") {
    const b = /^refs\/heads\/(.+)\^\{commit\}$/.exec(String(args[3] ?? ""))?.[1] ?? "";
    return { status: 0, stdout: `${branchHead.get(b) ?? head}\n`, stderr: "" };
  }
  return nonEmptyDiffRunner(cwd, args, opts);
};

function freshWg(): Dispatch {
  head = "a".repeat(40);
  branchHead.clear();
  gitOverride = null;
  return Dispatch.open(":memory:", systemClock, movableHead);
}

/** A delivered ticket in review, optionally with a second write repo. */
function inReview(wg: Dispatch, opts: { extraWrite?: string } = {}) {
  const t = wg.createTicket({ title: "Ship", description: "x", policy_pack: "team_light" }, human);
  const { ac } = wg.addAcceptanceCriterion({ ticket_id: t.id, text: "ok" }, human);
  const { repoId } = giveTicketRealDelivery(wg, t.id, human, { repoName: "billing-api" });
  let extraId: string | null = null;
  if (opts.extraWrite) {
    const r = wg.registerRepository(
      { name: opts.extraWrite, default_branch: "main", local_path: process.cwd() },
      human,
    );
    extraId = r.id;
    wg.setTicketRepoAccess(
      { ticket_id: t.id, repo_id: r.id, access: "write", relation: "confirmed" },
      human,
    );
    wg.recordRepoDelivery({ ticket_id: t.id, repo_id: r.id, branch_name: "feat/web" }, human);
  }
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
  wg.submitForReview({ claimToken: claim!.claimToken, ticket_id: t.id, reason: "d" }, agentActor);
  return { id: t.id, number: t.number ?? 0, repoId, extraId, agentId: agent.id };
}

/** A human-approved ticket (ready_for_merge), every write repo pinned. */
function approved(wg: Dispatch, opts: { extraWrite?: string } = {}) {
  const r = inReview(wg, opts);
  expect(wg.approveReview(r.id, human).ticket.status).toBe("ready_for_merge");
  return r;
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof DispatchError ? e.code : `non-dispatch: ${String(e)}`;
  }
  return "no error";
}

describe("cli-runner/F-02: a partly landed ticket cannot be cancelled", () => {
  it("wont-do is refused (PARTLY_LANDED) while one repo's approved commit has landed", () => {
    const wg = freshWg();
    const { id } = approved(wg, { extraWrite: "web-storefront" });
    wg.recordLanding(id, { repo: "billing-api", commit: head, via: "local" }, system);
    let err: DispatchError | null = null;
    try {
      wg.wontDo(id, human, "changed my mind");
    } catch (e) {
      err = e as DispatchError;
    }
    expect(err?.code).toBe("PARTLY_LANDED");
    expect(err?.message).toContain("billing-api");
    expect(err?.message).toContain("gaffer merge");
    expect(err?.details).toMatchObject({ landed: ["billing-api"], pending: ["web-storefront"] });
    expect(wg.view(id).ticket.status).toBe("ready_for_merge");
    wg.db.close();
  });

  it("a reject that would cancel is refused the same way", () => {
    const wg = freshWg();
    const { id } = approved(wg, { extraWrite: "web-storefront" });
    wg.recordLanding(id, { repo: "billing-api", commit: head, via: "local" }, system);
    expect(codeOf(() => wg.rejectReview(id, "cancelled", human, "no"))).toBe("PARTLY_LANDED");
    expect(wg.view(id).ticket.status).toBe("ready_for_merge");
    wg.db.close();
  });

  it("with nothing landed a wont-do still cancels", () => {
    const wg = freshWg();
    const { id } = approved(wg, { extraWrite: "web-storefront" });
    expect(wg.wontDo(id, human, "no").ticket.status).toBe("cancelled");
    wg.db.close();
  });
});

describe("cli-wg/F-10: ticket landing shows no approved pin once the approval is withdrawn", () => {
  it("after a reject the pins are gone", () => {
    const wg = freshWg();
    const { id } = approved(wg);
    expect(wg.landingStatus(id).repos).toHaveLength(1);
    wg.rejectReview(id, "refining", human, "changed my mind");
    expect(wg.view(id).ticket.status).toBe("refining");
    const s = wg.landingStatus(id);
    expect(s.repos).toEqual([]);
    expect(s.pending).toBe(0);
    wg.db.close();
  });

  it("after a wont-do, and after reopening it, the pins are gone", () => {
    const wg = freshWg();
    const { id } = approved(wg);
    wg.wontDo(id, human, "no");
    expect(wg.landingStatus(id).repos).toEqual([]);
    wg.reopenFromWontDo(id, "refining", human);
    expect(wg.landingStatus(id).repos).toEqual([]);
    wg.db.close();
  });

  it("the approval's own path keeps them: ready_for_merge, a hold, done", () => {
    const wg = freshWg();
    const { id } = approved(wg);
    wg.holdForHuman(id, { reasonCode: "merge_gate_red", reason: "red" }, system);
    expect(wg.landingStatus(id).repos).toHaveLength(1);
    wg.db.close();
    const wg2 = freshWg();
    const b = approved(wg2);
    wg2.recordLanding(b.id, { repo: "billing-api", commit: head, via: "local" }, system);
    wg2.markMerged(b.id, system);
    expect(wg2.view(b.id).ticket.status).toBe("done");
    expect(wg2.landingStatus(b.id)).toMatchObject({ landed: 1, pending: 0 });
    wg2.db.close();
  });
});

describe("api/F12: duplicate repo entries in the approval's commits are refused, in any order", () => {
  it("[head, other] and [other, head] are both 422 VALIDATION_ERROR and approve nothing", () => {
    for (const order of [
      [head, "0".repeat(40)],
      ["0".repeat(40), head],
    ]) {
      const wg = freshWg();
      const { id } = inReview(wg);
      const commits = order.map((sha) => ({ repo: "billing-api", sha }));
      expect(codeOf(() => wg.approveReview(id, human, { commits }))).toBe("VALIDATION_ERROR");
      expect(wg.view(id).ticket.status).toBe("in_review");
      wg.db.close();
    }
  });

  it("the same repo named by name and by id is a duplicate too", () => {
    const wg = freshWg();
    const { id, repoId } = inReview(wg);
    const commits = [
      { repo: "billing-api", sha: head },
      { repo: repoId, sha: head },
    ];
    expect(codeOf(() => wg.approveReview(id, human, { commits }))).toBe("VALIDATION_ERROR");
    wg.db.close();
  });

  it("one entry per repo still approves", () => {
    const wg = freshWg();
    const { id } = inReview(wg);
    const commits = [{ repo: "billing-api", sha: head }];
    expect(wg.approveReview(id, human, { commits }).ticket.status).toBe("ready_for_merge");
    wg.db.close();
  });
});

describe("api/F8: a principal cannot take a registered agent's id; nobody approves under the author's id", () => {
  it("a human principal with a registered agent's actor_id is refused (DUPLICATE → 409)", () => {
    const wg = freshWg();
    const agent = wg.registerAgent({ display_name: "builder" }, human);
    let err: DispatchError | null = null;
    try {
      wg.createPrincipal({ name: "sneaky", actorType: "human", actorId: agent.id }, system);
    } catch (e) {
      err = e as DispatchError;
    }
    expect(err?.code).toBe("DUPLICATE");
    expect(err?.details).toMatchObject({ reason: "actor_id_is_agent" });
    expect(codeOf(() => wg.createPrincipal({ name: agent.id }, system))).toBe("DUPLICATE");
    // Any other id is fine.
    const ok = wg.createPrincipal({ name: "alice", actorType: "human" }, system);
    expect(ok.principal.actor_id).toBe("alice");
    wg.db.close();
  });

  it("a human actor whose id is the delivering agent's id cannot approve its delivery", () => {
    const wg = freshWg();
    const { id, agentId } = inReview(wg);
    const disguised: Actor = { type: "human", id: agentId };
    expect(codeOf(() => wg.approveReview(id, disguised))).toBe("ACTOR_NOT_PERMITTED");
    expect(wg.view(id).ticket.status).toBe("in_review");
    expect(wg.approveReview(id, human).ticket.status).toBe("ready_for_merge");
    wg.db.close();
  });
});

describe("api/F1: two parallel Merge requests start one merge", () => {
  it("the second POST /tickets/:id/merge is 409 MERGE_IN_FLIGHT and starts nothing", async () => {
    const { createApiServer } = await import("../src/api/server.js");
    const { createMergeRunner } = await import("../src/api/mergeRunner.js");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const runs = mkdtempSync(join(tmpdir(), "merge-in-flight-"));
    process.env.GAFFER_DATA = runs;
    const wg = freshWg();
    const { id } = approved(wg);
    // A merge command that stays alive long enough for the second request to arrive.
    const { writeFileSync } = await import("node:fs");
    const slow = join(runs, "slow-merge.cjs");
    writeFileSync(slow, "setTimeout(() => {}, 4000);\n");
    const env = { ...process.env, DISPATCH_MERGE_CMD: JSON.stringify([process.execPath, slow]) };
    const runner = createMergeRunner(env, () => {}, wg);
    const noopPo = { run: () => ({ started: false, pid: null }) };
    const noopPlan = { run: async () => ({ phase: "error", error: "n/a" }) };
    const server = createApiServer(wg, noopPo as never, noopPlan as never, runner);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      const fire = () => fetch(`http://127.0.0.1:${port}/tickets/${id}/merge`, { method: "POST" });
      const [a, b] = await Promise.all([fire(), fire()]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([202, 409]);
      const refused = (await (a.status === 409 ? a : b).json()) as { error: { code: string } };
      expect(refused.error.code).toBe("MERGE_IN_FLIGHT");
      const started = wg.db
        .prepare(
          "SELECT COUNT(*) AS n FROM work_events WHERE entity_id = ? AND event_type = 'ticket.merge_started'",
        )
        .get(id) as { n: number };
      expect(started.n).toBe(1);
      // A third request while it still runs is refused the same way (the run registry).
      expect((await fire()).status).toBe(409);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      wg.db.close();
      rmSync(runs, { recursive: true, force: true });
    }
  });

  it("the merge runner itself spawns one merge per ticket while the first is alive", async () => {
    const { createMergeRunner } = await import("../src/api/mergeRunner.js");
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "merge-runner-"));
    const slow = join(dir, "slow-merge.cjs");
    writeFileSync(slow, "setTimeout(() => {}, 3000);\n");
    const env = { ...process.env, DISPATCH_MERGE_CMD: JSON.stringify([process.execPath, slow]) };
    const runner = createMergeRunner(env, () => {});
    const first = runner.trigger({ ticketNumber: 41 });
    const second = runner.trigger({ ticketNumber: 41 });
    const other = runner.trigger({ ticketNumber: 42 });
    expect(first.triggered).toBe(true);
    expect(second).toMatchObject({ triggered: false, skipped: "in_flight" });
    expect(other.triggered).toBe(true);
    for (const p of [first.pid, other.pid]) if (p) process.kill(p);
    rmSync(dir, { recursive: true, force: true });
  });
});

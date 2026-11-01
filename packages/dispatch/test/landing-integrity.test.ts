// LANDING INTEGRITY (exploratory test pass, Package A). Each block pins one finding:
//   cli-runner/F-02  a partly landed ticket cannot be cancelled (PARTLY_LANDED), and a
//                    send-back of one is held for a person, not re-queued;
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

function freshWg(opts: { maxAttempts?: number; testingEnabled?: boolean } = {}): Dispatch {
  head = "a".repeat(40);
  branchHead.clear();
  gitOverride = null;
  return Dispatch.open(":memory:", systemClock, movableHead, opts);
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

  // Review of the package: the guard read only the CURRENT approval's pins, which a
  // send-back or a reopen withdraws, so each of these ended cancelled with one repo's
  // merge on main.
  const partlyLanded = (wg: Dispatch) => {
    const r = approved(wg, { extraWrite: "web-storefront" });
    wg.recordLanding(r.id, { repo: "billing-api", commit: head, via: "local" }, system);
    return r;
  };

  it("a send-back to rework parks it for a person (blocked, partly_landed); still no cancel", () => {
    const wg = freshWg();
    const { id } = partlyLanded(wg);
    expect(wg.rejectReview(id, "refining", human, "rework the storefront").ticket.status).toBe(
      "blocked",
    );
    // Still visibly partly landed, and listed for a person with the reason.
    expect(wg.landingStatus(id)).toMatchObject({ landed: 1, partial: true });
    const parked = wg.humanQueue().items.find((i) => i.ticket?.id === id);
    expect(parked).toMatchObject({ kind: "parked", reasonCode: "partly_landed" });
    expect(parked?.reason).toContain("billing-api");
    expect(codeOf(() => wg.wontDo(id, human, "drop"))).toBe("PARTLY_LANDED");
    // A person may still rework it from the hold (a red merge gate's recovery), and
    // even then it cannot be cancelled.
    wg.moveTicket(id, "ready", human);
    expect(wg.view(id).ticket.status).toBe("ready");
    expect(codeOf(() => wg.wontDo(id, human, "drop"))).toBe("PARTLY_LANDED");
    wg.db.close();
  });

  it("after a reopen for review: a cancelling send-back is refused, a rework one parks it", () => {
    const wg = freshWg();
    const { id } = partlyLanded(wg);
    wg.reopenForReview(id, { reason: "repo moved", resolution: "re-review" }, { type: "admin" });
    expect(wg.view(id).ticket.status).toBe("in_review");
    expect(codeOf(() => wg.rejectReview(id, "cancelled", human, "drop"))).toBe("PARTLY_LANDED");
    expect(codeOf(() => wg.wontDo(id, human, "drop"))).toBe("PARTLY_LANDED");
    expect(wg.rejectReview(id, "ready", human, "redo").ticket.status).toBe("blocked");
    wg.db.close();
  });

  it("a retry-cap park, then a person's unblock: still cannot be cancelled", () => {
    const wg = freshWg({ maxAttempts: 1 });
    const { id } = partlyLanded(wg);
    expect(wg.rejectReview(id, "refining", human, "again").ticket.status).toBe("blocked");
    wg.moveTicket(id, "refining", human);
    expect(codeOf(() => wg.wontDo(id, human, "drop"))).toBe("PARTLY_LANDED");
    wg.db.close();
  });

  it("a tester FAIL of a partly landed ticket holds it for a person instead of re-queueing", () => {
    const wg = freshWg({ testingEnabled: true });
    const { id } = partlyLanded(wg);
    wg.reopenForReview(id, { reason: "repo moved", resolution: "re-review" }, { type: "admin" });
    wg.setTestable(id, true, human);
    expect(wg.approveReview(id, human).ticket.status).toBe("in_testing");
    const res = wg.testerFail(id, { summary: "checkout breaks", to: "ready" }, agentActor);
    expect(res.ticket.status).toBe("blocked");
    expect(wg.humanQueue().items.find((i) => i.ticket?.id === id)).toMatchObject({
      reasonCode: "partly_landed",
    });
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
    // ...in any case: the same id in capitals reads as that agent too.
    expect(
      codeOf(() =>
        wg.createPrincipal(
          { name: "loud", actorType: "admin", actorId: agent.id.toUpperCase() },
          system,
        ),
      ),
    ).toBe("DUPLICATE");
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
    expect(codeOf(() => wg.approveReview(id, { type: "admin", id: agentId.toUpperCase() }))).toBe(
      "ACTOR_NOT_PERMITTED",
    );
    expect(wg.view(id).ticket.status).toBe("in_review");
    expect(wg.approveReview(id, human).ticket.status).toBe("ready_for_merge");
    wg.db.close();
  });
});

describe("cli-wg/F-13: human-release hands back only your own by-hand ticket", () => {
  function byHand(wg: Dispatch, owner: string) {
    const t = wg.createTicket({ title: "By hand", description: "x" }, human);
    wg.addAcceptanceCriterion({ ticket_id: t.id, text: "ok" }, human);
    giveTicketRealDelivery(wg, t.id, human);
    wg.markReady(t.id, human);
    wg.humanClaimTicket(t.id, { type: "human", id: owner });
    expect(wg.view(t.id).ticket.human_owner).toBe(owner);
    return t.id;
  }

  it("another person is refused; the owner hands it back", () => {
    const wg = freshWg();
    const id = byHand(wg, "alice");
    expect(codeOf(() => wg.humanReleaseTicket(id, { type: "human", id: "bob" }))).toBe(
      "ACTOR_NOT_PERMITTED",
    );
    expect(wg.view(id).ticket.status).toBe("in_progress");
    expect(wg.humanReleaseTicket(id, { type: "human", id: "alice" }).status).toBe("ready");
    wg.db.close();
  });

  it("an admin (--admin) may hand back anyone's", () => {
    const wg = freshWg();
    const id = byHand(wg, "alice");
    expect(wg.humanReleaseTicket(id, { type: "admin", id: "bob" }).status).toBe("ready");
    wg.db.close();
  });
});

describe("cli-wg/F-13 and cli-runner/F-02 over REST", () => {
  const FULL = "shared-full-token-for-landing-integrity-0123456789";
  let closeServer: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await closeServer?.();
    closeServer = undefined;
    const { setPrincipalResolver } = await import("../src/api/auth.js");
    setPrincipalResolver(null);
    delete process.env.DISPATCH_API_TOKEN;
  });
  async function serve(wg: Dispatch) {
    const { createApiServer } = await import("../src/api/server.js");
    process.env.DISPATCH_AUDIT_OFF = "1";
    process.env.DISPATCH_API_TOKEN = FULL;
    const server = createApiServer(wg);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closeServer = () => new Promise<void>((resolve) => server.close(() => resolve()));
    const { port } = server.address() as { port: number };
    return (path: string, token: string, body: unknown = {}) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
  }
  function byHand(wg: Dispatch, owner: string, repoName: string): string {
    const t = wg.createTicket({ title: "By hand", description: "x" }, human);
    wg.addAcceptanceCriterion({ ticket_id: t.id, text: "ok" }, human);
    giveTicketRealDelivery(wg, t.id, human, { repoName });
    wg.markReady(t.id, human);
    wg.humanClaimTicket(t.id, { type: "human", id: owner });
    return t.id;
  }

  it("human-release: a named principal only its own; the shared token any", async () => {
    const wg = freshWg();
    const post = await serve(wg);
    const carol = wg.createPrincipal({ name: "carol" }, system).token;
    // A principal that merely carries the shared operator's actor id is still a principal.
    const lookalike = wg.createPrincipal({ name: "dispatch-api" }, system).token;
    const alice = wg.createPrincipal({ name: "alice" }, system).token;
    const a = byHand(wg, "alice", "repo-a");
    expect((await post(`/tickets/${a}/human-release`, carol)).status).toBe(403);
    expect((await post(`/tickets/${a}/human-release`, lookalike)).status).toBe(403);
    expect((await post(`/tickets/${a}/human-release`, alice)).status).toBe(200);
    const b = byHand(wg, "alice", "repo-b");
    expect((await post(`/tickets/${b}/human-release`, FULL)).status).toBe(200);
    wg.db.close();
  });

  it("a partly landed ticket: wont-do is 409 PARTLY_LANDED, a rework send-back parks it", async () => {
    const wg = freshWg();
    const post = await serve(wg);
    const { id } = approved(wg, { extraWrite: "web-storefront" });
    wg.recordLanding(id, { repo: "billing-api", commit: head, via: "local" }, system);
    const w = await post(`/tickets/${id}/wont-do`, FULL, { reason: "drop" });
    expect(w.status).toBe(409);
    expect(((await w.json()) as { error: { code: string } }).error.code).toBe("PARTLY_LANDED");
    const r = await post(`/tickets/${id}/review/reject`, FULL, { to: "refining", reason: "redo" });
    expect(r.status).toBe(200);
    expect(wg.view(id).ticket.status).toBe("blocked");
    wg.db.close();
  });
});

describe("cli-wg/F-11: ci-result accepts only a commit of the ticket", () => {
  it("a foreign sha is refused (not_ticket_commit); ci-status reports the ticket's own result", () => {
    const wg = freshWg();
    const { id } = inReview(wg);
    wg.recordCiResult(id, { commit: head, state: "fail" }, system);
    let err: DispatchError | null = null;
    try {
      wg.recordCiResult(id, { commit: "2".repeat(40), state: "pass" }, system);
    } catch (e) {
      err = e as DispatchError;
    }
    expect(err?.code).toBe("STATE_CONFLICT");
    expect(err?.details).toMatchObject({ reason: "not_ticket_commit" });
    expect(wg.ciStatus(id, null)).toMatchObject({ state: "fail", commit: head });
    wg.db.close();
  });

  it("the head (full or abbreviated) and an approved revision are accepted", () => {
    const wg = freshWg();
    const { id } = approved(wg);
    const pinned = head;
    expect(wg.recordCiResult(id, { commit: head.slice(0, 12), state: "pass" }, system).state).toBe(
      "pass",
    );
    // The branch moves on; the approved revision is still the ticket's own commit.
    head = "b".repeat(40);
    expect(wg.recordCiResult(id, { commit: pinned, state: "pass" }, system).state).toBe("pass");
    wg.db.close();
  });
});

describe("cli-wg/F-01: record-landing --via pr|pr-stale must be justified", () => {
  const setPr = (wg: Dispatch, id: string, url: string | null) =>
    wg.db.prepare("UPDATE tickets SET pr_url = ? WHERE id = ?").run(url, id);

  it("no PR on record: --via pr and --via pr-stale are refused (no_pr_recorded); mark-merged stays refused", () => {
    const wg = freshWg();
    const { id } = approved(wg);
    for (const via of ["pr", "pr-stale"]) {
      let err: DispatchError | null = null;
      try {
        wg.recordLanding(id, { repo: "billing-api", commit: head, via }, system);
      } catch (e) {
        err = e as DispatchError;
      }
      expect(err?.code).toBe("STATE_CONFLICT");
      expect(err?.details).toMatchObject({ reason: "no_pr_recorded" });
    }
    expect(wg.landingStatus(id).landed).toBe(0);
    // ...and with the commit not on the default branch, mark-merged stays refused.
    gitOverride = (_cwd, args) =>
      args[0] === "merge-base" && args[1] === "--is-ancestor"
        ? { status: 1, stdout: "", stderr: "" }
        : (null as never);
    expect(codeOf(() => wg.markMerged(id, system))).toBe("STATE_CONFLICT");
    expect(wg.view(id).ticket.status).toBe("ready_for_merge");
    wg.db.close();
  });

  it("--via pr with a PR: the local default branch must carry the change", () => {
    const wg = freshWg();
    const { id } = approved(wg);
    setPr(wg, id, "https://github.com/o/r/pull/7");
    // The local default does not have it: not an ancestor, and merging it changes the tree.
    gitOverride = (_cwd, args) => {
      if (args[0] === "merge-base" && args[1] === "--is-ancestor")
        return { status: 1, stdout: "", stderr: "" };
      if (args[0] === "rev-parse" && String(args[3]).endsWith("^{tree}"))
        return { status: 0, stdout: "t1\n", stderr: "" };
      if (args[0] === "merge-tree") return { status: 0, stdout: "t2\n", stderr: "" };
      return null as never;
    };
    expect(
      codeOf(() => wg.recordLanding(id, { repo: "billing-api", commit: head, via: "pr" }, system)),
    ).toBe("STATE_CONFLICT");
    // A squash merge of the change is on main: merging the commit into main is a no-op.
    gitOverride = (_cwd, args) => {
      if (args[0] === "merge-base" && args[1] === "--is-ancestor")
        return { status: 1, stdout: "", stderr: "" };
      if (args[0] === "rev-parse" && String(args[3]).endsWith("^{tree}"))
        return { status: 0, stdout: "t1\n", stderr: "" };
      if (args[0] === "merge-tree") return { status: 0, stdout: "t1\n", stderr: "" };
      return null as never;
    };
    expect(
      wg.recordLanding(id, { repo: "billing-api", commit: head, via: "pr" }, system).recorded,
    ).toBe(true);
    wg.db.close();
  });

  it("--via pr-stale: checked against a remote-tracking ref when one exists, else the PR record", () => {
    const wg = freshWg();
    const { id } = approved(wg);
    setPr(wg, id, "https://github.com/o/r/pull/8");
    let remotes = "refs/remotes/origin/main\n";
    gitOverride = (_cwd, args) => {
      if (args[0] === "for-each-ref") return { status: 0, stdout: remotes, stderr: "" };
      if (args[0] === "merge-base" && args[1] === "--is-ancestor")
        return { status: 1, stdout: "", stderr: "" };
      if (args[0] === "rev-parse" && String(args[3]).endsWith("^{tree}"))
        return { status: 0, stdout: "t1\n", stderr: "" };
      if (args[0] === "merge-tree") return { status: 0, stdout: "t2\n", stderr: "" };
      return null as never;
    };
    expect(
      codeOf(() =>
        wg.recordLanding(id, { repo: "billing-api", commit: head, via: "pr-stale" }, system),
      ),
    ).toBe("STATE_CONFLICT");
    // No remote-tracking ref and the local default known stale: the PR record is the evidence.
    remotes = "";
    gitOverride = ((prev) => (cwd: string, args: readonly string[], opts?: unknown) => {
      if (args[0] === "rev-parse" && String(args[3]) === "refs/heads/main^{commit}")
        return { status: 1, stdout: "", stderr: "" };
      return prev!(cwd, args as string[], opts as never);
    })(gitOverride) as GitRunner;
    expect(
      wg.recordLanding(id, { repo: "billing-api", commit: head, via: "pr-stale" }, system).recorded,
    ).toBe(true);
    wg.db.close();
  });

  it("--via local is unchanged (ancestry)", () => {
    const wg = freshWg();
    const { id } = approved(wg);
    expect(
      wg.recordLanding(id, { repo: "billing-api", commit: head, via: "local" }, system).recorded,
    ).toBe(true);
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

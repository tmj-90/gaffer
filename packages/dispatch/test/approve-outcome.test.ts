// WHAT HAPPENS ON APPROVE — the outcome the Review view's sign-off button names.
//
// The button used to arm to "Confirm merge" whatever the settings said, so a click that
// sent the ticket to the independent tester, or left it waiting for Merge now, promised
// a merge. These pin the outcome to the facts the approve path acts on:
//   - the pure decision, one case per outcome (and the multi-repo / PR / both modifiers);
//   - the facts, read from the same predicates approveReview, the approve route and the
//     merge lane use (tester route, CI hold, AUTO_MERGE, an earned merge gate, the repo
//     every landing path merges);
//   - the routes: GET /diff carries the prediction for an in_review ticket, and
//     review/approve answers what the click actually did.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { createApiServer } from "../src/api/server.js";
import type { MergeRunner } from "../src/api/mergeRunner.js";
import type { ProductOwnerRunner } from "../src/api/productOwner.js";
import type { PlanBuildRunner } from "../src/api/planBuild.js";
import {
  type ApproveOutcomeFacts,
  decideApproveOutcome,
  settleApproveOutcome,
} from "../src/services/approveOutcome.js";
import { TestClock } from "../src/util/clock.js";
import {
  FAKE_HEAD,
  giveTicketRealDelivery,
  nonEmptyDiffRunner,
  testWeakeningDiffRunner,
} from "./helpers/realDiff.js";

const human: Actor = { type: "human", id: "tom" };
const agentActor: Actor = { type: "agent", id: "agent-runner" };

const FACTS: ApproveOutcomeFacts = {
  ciHold: null,
  toTester: false,
  acceptance: false,
  autoMerge: false,
  mergeCommand: false,
  mergeLane: true,
  mergeGateEarned: false,
  reviewMode: "human",
  prMode: false,
  prUrl: null,
  prMergeMethod: "merge",
  landsRepo: "billing-api",
  baseBranch: "main",
  alsoLandsRepos: [],
  noCheckoutRepos: [],
};
const facts = (o: Partial<ApproveOutcomeFacts> = {}): ApproveOutcomeFacts => ({ ...FACTS, ...o });

describe("decideApproveOutcome: one outcome per approve path", () => {
  it("a write repo is unavailable: approve is held and disabled, never 'land now' (external review #7)", () => {
    const missing = [
      { repo: "web-storefront", why: "its delivery branch feat/web cannot be resolved" },
    ];
    for (const extra of [
      { autoMerge: true, mergeCommand: true },
      { autoMerge: true, mergeCommand: false },
      { toTester: true },
      {},
    ]) {
      const o = decideApproveOutcome(
        facts({ ...extra, alsoLandsRepos: ["web-storefront"], unavailableRepos: missing }),
      );
      expect(o.kind).toBe("held_repo_unavailable");
      expect(o.approvable).toBe(false);
      expect(o.to_status).toBeNull();
      expect(o.label).toBe("Approve held: web-storefront unavailable");
      expect(o.confirm_label).toBe(o.label);
      expect(o.label).not.toMatch(/land/i);
      expect(o.sentence).not.toContain("lands after it");
      expect(o.sentence).toContain(
        "web-storefront: its delivery branch feat/web cannot be resolved",
      );
      expect(o.sentence).toContain("covers every repository this ticket writes to");
      expect(o.also_lands_repos).toEqual([]);
    }
    // An agent or auto approval is held the same way.
    expect(decideApproveOutcome(facts({ approver: "agent", unavailableRepos: missing })).kind).toBe(
      "held_repo_unavailable",
    );
    // Two repos: both named.
    expect(
      decideApproveOutcome(
        facts({
          unavailableRepos: [
            ...missing,
            { repo: "ios", why: "it has no checkout on this machine" },
          ],
        }),
      ).label,
    ).toBe("Approve held: web-storefront and ios unavailable");
    // Once approved (settle), the hold no longer applies.
    expect(
      settleApproveOutcome(facts({ unavailableRepos: missing }), { toStatus: "ready_for_merge" })
        .kind,
    ).toBe("waits_for_merge");
  });

  it("testing lane: approve sends it to the tester, never to merge", () => {
    const o = decideApproveOutcome(facts({ toTester: true, autoMerge: true, mergeCommand: true }));
    expect(o.kind).toBe("to_tester");
    expect(o.to_status).toBe("in_testing");
    expect(o.label).toBe("Approve and send to tester");
    expect(o.confirm_label).not.toMatch(/merge/i);
    expect(o.sentence).toContain("In testing");
    expect(o.sentence).toContain("merge lane lands it");
    expect(o.lands_repo).toBeNull();
  });

  it("an epic's acceptance ticket says why it goes to the tester", () => {
    const o = decideApproveOutcome(facts({ toTester: true, acceptance: true }));
    expect(o.kind).toBe("to_tester");
    expect(o.sentence).toContain("acceptance ticket always goes to the independent tester");
    expect(o.sentence).toContain("it waits for Merge now");
  });

  it("AUTO_MERGE on + a merge command: approve lands now through the merge gate", () => {
    const o = decideApproveOutcome(facts({ autoMerge: true, mergeCommand: true }));
    expect(o.kind).toBe("land_now");
    expect(o.label).toBe("Approve and land now");
    expect(o.confirm_label).toBe("Confirm and land now");
    expect(o.sentence).toContain("merge runner starts now");
    expect(o.sentence).toContain("merge gate");
    expect(o.sentence).toContain("billing-api onto main locally");
    expect(o.via).toBe("local");
  });

  it("AUTO_MERGE off: approve waits at ready_for_merge for Merge now", () => {
    const o = decideApproveOutcome(facts());
    expect(o.kind).toBe("waits_for_merge");
    expect(o.to_status).toBe("ready_for_merge");
    expect(o.label).toBe("Approve, merge is a separate click");
    expect(o.confirm_label).toBe("Confirm approval");
    expect(o.sentence).toContain("Auto-merge on approval is off");
    expect(o.via).toBeNull();
  });

  it("AUTO_MERGE on, no merge command: the runner's merge lane lands it next tick", () => {
    const o = decideApproveOutcome(facts({ autoMerge: true, mergeCommand: false }));
    expect(o.kind).toBe("land_next_tick");
    expect(o.label).toBe("Approve, lands on next tick");
    expect(o.sentence).toContain("no merge command");
  });

  it("an earned merge grant (AUTO_MERGE off) also lands on the next tick", () => {
    const o = decideApproveOutcome(facts({ mergeGateEarned: true }));
    expect(o.kind).toBe("land_next_tick");
    expect(o.sentence).toContain("earned merge grant");
  });

  it("no merge command and the merge lane off: it waits even with AUTO_MERGE on", () => {
    const o = decideApproveOutcome(facts({ autoMerge: true, mergeLane: false }));
    expect(o.kind).toBe("waits_for_merge");
    expect(o.sentence).toContain("merge lane is off");
  });

  it("required CI not passed: approve is held (the server would refuse it)", () => {
    const o = decideApproveOutcome(
      facts({ ciHold: { state: "pending", commit: "abcdef1234567890" }, toTester: true }),
    );
    expect(o.kind).toBe("held_ci");
    expect(o.approvable).toBe(false);
    expect(o.to_status).toBeNull();
    expect(o.sentence).toContain("abcdef123456");
    expect(o.sentence).toContain("pending");
  });

  it("PR mode: a landing goes through the recorded pull request", () => {
    const o = decideApproveOutcome(
      facts({
        autoMerge: true,
        mergeCommand: true,
        prMode: true,
        prUrl: "https://github.com/acme/billing-api/pull/9",
        prMergeMethod: "squash",
      }),
    );
    expect(o.via).toBe("pr");
    expect(o.pr_url).toContain("/pull/9");
    expect(o.sentence).toContain("through its pull request (gh pr merge, squash)");
  });

  it("PR mode with no PR recorded says the merge is local", () => {
    const o = decideApproveOutcome(facts({ autoMerge: true, mergeCommand: true, prMode: true }));
    expect(o.via).toBe("local");
    expect(o.sentence).toContain("no pull request was recorded");
  });

  it("a multi-repo ticket lands every repo: the others after the primary, held if one fails", () => {
    const o = decideApproveOutcome(
      facts({ autoMerge: true, mergeCommand: true, alsoLandsRepos: ["web-storefront"] }),
    );
    expect(o.lands_repo).toBe("billing-api");
    expect(o.also_lands_repos).toEqual(["web-storefront"]);
    expect(o.not_landed_repos).toEqual([]);
    expect(o.sentence).toContain(
      "web-storefront lands after it the same way, each through the merge gate on its own default branch.",
    );
    expect(o.sentence).toContain("Approved · partly landed");
    expect(o.sentence).not.toMatch(/by hand|Only billing-api lands/);
    // The merge lane lands them all the same way.
    const tick = decideApproveOutcome(
      facts({ autoMerge: true, alsoLandsRepos: ["web-storefront"] }),
    );
    expect(tick.kind).toBe("land_next_tick");
    expect(tick.also_lands_repos).toEqual(["web-storefront"]);
  });

  it("a write repo with no checkout here is named as one no landing path can merge", () => {
    const o = decideApproveOutcome(
      facts({ autoMerge: true, mergeCommand: true, noCheckoutRepos: ["docs-site"] }),
    );
    expect(o.not_landed_repos).toEqual(["docs-site"]);
    expect(o.sentence).toContain("docs-site has no checkout on this machine");
  });

  it("tests changed: an agent or auto approval is held_test_modified, a human's is not", () => {
    const holds = ["tests modified: src/x.test.ts deleted"];
    const agent = decideApproveOutcome(
      facts({ approver: "agent", testModifiedHolds: holds, autoMerge: true }),
    );
    expect(agent.kind).toBe("held_test_modified");
    expect(agent.approvable).toBe(false);
    expect(agent.to_status).toBeNull();
    expect(agent.label).toBe("Approve held: tests changed, a person must allow it");
    expect(agent.sentence).toContain("src/x.test.ts deleted");
    // The human's button keeps its outcome; its line says it is not held, and why to look.
    const human = decideApproveOutcome(facts({ testModifiedHolds: holds, autoMerge: true }));
    expect(human.kind).toBe("land_next_tick");
    expect(human.approvable).toBe(true);
    expect(human.label).toBe("Approve, lands on next tick");
    expect(human.sentence).toContain("your approval is not held by that");
    expect(human.sentence).toContain("the Flags below the button name what changed");
    expect(human.agent_hold?.kind).toBe("held_test_modified");
    expect(human.agent_hold?.holds).toEqual(holds);
    // No holds: nothing said, nothing held.
    const clean = decideApproveOutcome(facts({ approver: "agent", autoMerge: true }));
    expect(clean.kind).toBe("land_next_tick");
    expect(decideApproveOutcome(facts()).agent_hold).toBeNull();
    // Required CI holds everyone first.
    expect(
      decideApproveOutcome(
        facts({
          approver: "agent",
          testModifiedHolds: holds,
          ciHold: { state: "fail", commit: null },
        }),
      ).kind,
    ).toBe("held_ci");
  });

  it("REVIEW_MODE both: the click is the human confirmation of the agent screen", () => {
    const o = decideApproveOutcome(facts({ reviewMode: "both" }));
    expect(o.kind).toBe("waits_for_merge");
    expect(o.review_mode).toBe("both");
    expect(o.sentence).toContain("this click is the human confirmation");
  });

  it("no outcome but a landing now ever arms to a merge confirmation", () => {
    for (const f of [
      facts({ toTester: true }),
      facts(),
      facts({ autoMerge: true }),
      facts({ ciHold: { state: null, commit: null } }),
    ])
      expect(decideApproveOutcome(f).confirm_label).not.toMatch(/merge/i);
  });
});

describe("settleApproveOutcome: what the click actually did", () => {
  it("the route sent it to the tester", () => {
    expect(settleApproveOutcome(facts(), { toStatus: "in_testing" }).kind).toBe("to_tester");
  });
  it("the merge runner started", () => {
    const o = settleApproveOutcome(facts({ autoMerge: true, mergeCommand: true }), {
      toStatus: "ready_for_merge",
      merge: { triggered: true },
    });
    expect(o.kind).toBe("land_now");
  });
  it("AUTO_MERGE off: waits", () => {
    const o = settleApproveOutcome(facts(), {
      toStatus: "ready_for_merge",
      merge: { triggered: false, skipped: "auto_merge_off" },
    });
    expect(o.kind).toBe("waits_for_merge");
  });
  it("the merge runner could not start: says so, and who lands it instead", () => {
    const o = settleApproveOutcome(facts({ autoMerge: true, mergeCommand: true }), {
      toStatus: "ready_for_merge",
      merge: { triggered: false, skipped: "spawn_error" },
    });
    expect(o.kind).toBe("land_next_tick");
    expect(o.sentence).toMatch(/^The merge runner could not start\./);
  });
});

// ---------------------------------------------------------------------------
// The facts, from the same predicates the approve path uses.
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  "AUTO_MERGE",
  "MERGE_ON_AGENT_REVIEW",
  "GAFFER_TESTING",
  "GAFFER_CREATE_PR",
  "REVIEW_MODE",
  "GAFFER_MERGE_LANE",
  "GAFFER_PR_MERGE_METHOD",
  "DISPATCH_ALLOW_AGENT_APPROVE",
  "GAFFER_USAGE_PAUSE_FILE",
  "GAFFER_DATA",
] as const;
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

function freshWg(): Dispatch {
  return Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner);
}

/** A ticket in review with ONE write repo on disk and a real delivery diff. */
function inReview(
  wg: Dispatch,
  opts: { extraWrite?: string; extraOnDisk?: boolean } = {},
): { id: string; number: number } {
  const t = wg.createTicket({ title: "Ship", description: "x", policy_pack: "team_light" }, human);
  const { ac } = wg.addAcceptanceCriterion({ ticket_id: t.id, text: "ok" }, human);
  giveTicketRealDelivery(wg, t.id, human, { repoName: "billing-api" });
  if (opts.extraWrite) {
    const r = wg.registerRepository(
      {
        name: opts.extraWrite,
        default_branch: "main",
        ...(opts.extraOnDisk ? { local_path: process.cwd() } : {}),
      },
      human,
    );
    wg.setTicketRepoAccess(
      { ticket_id: t.id, repo_id: r.id, access: "write", relation: "confirmed" },
      human,
    );
    if (opts.extraOnDisk)
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
  wg.submitForReview(
    { claimToken: claim!.claimToken, ticket_id: t.id, reason: "done" },
    agentActor,
  );
  expect(wg.view(t.id).ticket.status).toBe("in_review");
  return { id: t.id, number: t.number ?? 0 };
}

describe("Dispatch.approveOutcome: read from the approve path's own predicates", () => {
  it("GAFFER_TESTING on + testable: to_tester, and approveReview really goes there", () => {
    process.env.GAFFER_TESTING = "1";
    const wg = freshWg();
    const { id } = inReview(wg);
    wg.setTestable(id, true, human);
    expect(wg.approveOutcome(id, { mergeCommand: true }).kind).toBe("to_tester");
    expect(wg.approveReview(id, human).ticket.status).toBe("in_testing");
    wg.db.close();
  });

  it("AUTO_MERGE off by default: waits_for_merge, and approveReview stops at ready_for_merge", () => {
    const wg = freshWg();
    const { id } = inReview(wg);
    const o = wg.approveOutcome(id, { mergeCommand: true });
    expect(o.kind).toBe("waits_for_merge");
    expect(o.to_status).toBe("ready_for_merge");
    expect(wg.approveReview(id, human).ticket.status).toBe("ready_for_merge");
    wg.db.close();
  });

  it("AUTO_MERGE on: land_now with a merge command, land_next_tick without", () => {
    process.env.AUTO_MERGE = "true";
    const wg = freshWg();
    const { id } = inReview(wg);
    expect(wg.approveOutcome(id, { mergeCommand: true }).kind).toBe("land_now");
    expect(wg.approveOutcome(id, { mergeCommand: false }).kind).toBe("land_next_tick");
    process.env.GAFFER_MERGE_LANE = "0";
    expect(wg.approveOutcome(id, { mergeCommand: false }).kind).toBe("waits_for_merge");
    wg.db.close();
  });

  it("the agent merge floor (AUTO_MERGE off) is not a human landing; the full floor is", () => {
    process.env.MERGE_ON_AGENT_REVIEW = "1";
    const wg = freshWg();
    const { id } = inReview(wg);
    expect(wg.approveOutcome(id, { mergeCommand: false }).kind).toBe("waits_for_merge");
    wg.db.close();
  });

  it("required CI recorded without a PASS: held_ci, and approveReview refuses", () => {
    const wg = freshWg();
    const { id } = inReview(wg);
    // (An abbreviated id of the ticket's head: a CI result must name one of its commits.)
    wg.recordCiResult(id, { commit: FAKE_HEAD.slice(0, 7), state: "pending" }, { type: "system" });
    const o = wg.approveOutcome(id, { mergeCommand: true });
    expect(o.kind).toBe("held_ci");
    expect(o.approvable).toBe(false);
    expect(() => wg.approveReview(id, human)).toThrow(/Required CI/);
    wg.db.close();
  });

  it("required CI pending is held like the server holds it; the PASS for the head releases both", () => {
    // The CI gate records `pending` when it starts polling the candidate, then pass/fail.
    // approveReview refuses every result but a PASS, so the sign-off must not offer an
    // approval while CI is pending (the button would only earn a POLICY_DENIED toast).
    const wg = freshWg();
    const { id } = inReview(wg);
    wg.recordCiResult(id, { commit: FAKE_HEAD, state: "pending" }, { type: "system" });
    const held = wg.approveOutcome(id, { mergeCommand: true });
    expect(held.kind).toBe("held_ci");
    expect(held.approvable).toBe(false);
    expect(held.sentence).toContain("(pending)");
    expect(() => wg.approveReview(id, human)).toThrow(/Required CI has not passed.*pending/);
    expect(wg.view(id).ticket.status).toBe("in_review");
    wg.recordCiResult(id, { commit: FAKE_HEAD, state: "pass" }, { type: "system" });
    const open = wg.approveOutcome(id, { mergeCommand: true });
    expect(open.kind).toBe("waits_for_merge");
    expect(open.approvable).toBe(true);
    expect(wg.approveReview(id, human).ticket.status).toBe("ready_for_merge");
    wg.db.close();
  });

  it("a multi-repo ticket with both checkouts: every repo lands, the primary first", () => {
    process.env.AUTO_MERGE = "1";
    const wg = freshWg();
    const { id } = inReview(wg, { extraWrite: "web-storefront", extraOnDisk: true });
    const o = wg.approveOutcome(id, { mergeCommand: true });
    expect(o.lands_repo).toBe("billing-api");
    expect(o.also_lands_repos).toEqual(["web-storefront"]);
    expect(o.not_landed_repos).toEqual([]);
    expect(o.sentence).toContain("web-storefront lands after it the same way");
    wg.db.close();
  });

  it("a write repo with no checkout on this machine holds the approval: no landing path could land it (external review #7)", () => {
    process.env.AUTO_MERGE = "1";
    const wg = freshWg();
    const { id } = inReview(wg, { extraWrite: "web-storefront" });
    const o = wg.approveOutcome(id, { mergeCommand: true });
    expect(o.kind).toBe("held_repo_unavailable");
    expect(o.approvable).toBe(false);
    expect(o.label).toBe("Approve held: web-storefront unavailable");
    expect(o.sentence).toContain("web-storefront: it has no checkout on this machine");
    expect(o.lands_repo).toBeNull();
    // …and the server refuses exactly that approval.
    let reason = "";
    try {
      wg.approveReview(id, human);
    } catch (e) {
      reason = String((e as { details?: { reason?: string } }).details?.reason ?? "");
    }
    expect(reason).toBe("repo_unavailable");
    expect(wg.view(id).ticket.status).toBe("in_review");
    wg.db.close();
  });

  it("a delivery that weakened its tests: held_test_modified for an agent, as the gate refuses it", () => {
    process.env.DISPATCH_ALLOW_AGENT_APPROVE = "1";
    const wg = Dispatch.open(":memory:", new TestClock(), testWeakeningDiffRunner);
    const { id } = inReview(wg);
    const agent = wg.approveOutcome(id, { mergeCommand: true, approver: "agent" });
    expect(agent.kind).toBe("held_test_modified");
    expect(agent.approvable).toBe(false);
    expect(agent.sentence).toMatch(/tests modified/);
    // The outcome is the gate's own read: an agent approve really is refused.
    const reviewer = wg.registerAgent({ display_name: "rev" }, human);
    let code = "";
    try {
      wg.approveReview(id, { type: "agent", id: reviewer.id });
    } catch (e) {
      code = (e as { code?: string }).code ?? "";
    }
    expect(code).toBe("OBSERVED_RISK_ESCALATED");
    // The human's outcome is not held, says so, and names the agent hold.
    const mine = wg.approveOutcome(id, { mergeCommand: true });
    expect(mine.kind).toBe("waits_for_merge");
    expect(mine.approvable).toBe(true);
    expect(mine.agent_hold?.kind).toBe("held_test_modified");
    expect(mine.sentence).toContain("your approval is not held by that");
    // A person allows test changes: the hold lifts for the agent too.
    wg.setAllowTestChanges(id, true, human, "the old suite is obsolete");
    expect(wg.approveOutcome(id, { mergeCommand: true, approver: "agent" }).kind).toBe(
      "waits_for_merge",
    );
    expect(wg.approveOutcome(id, { mergeCommand: true }).agent_hold).toBeNull();
    // And the human approval goes through (it was never held).
    expect(wg.approveReview(id, human).ticket.status).toBe("ready_for_merge");
    wg.db.close();
  });

  it("a usage-window pause: the next tick waits for it, and the line says until when", () => {
    process.env.AUTO_MERGE = "1";
    const dir = mkdtempSync(join(tmpdir(), "approve-pause-"));
    const until = new Date(Date.now() + 3_600_000).toISOString();
    writeFileSync(
      join(dir, "usage-pause.json"),
      JSON.stringify({ paused_until: until, kind: "usage_limit" }),
    );
    process.env.GAFFER_DATA = dir;
    const wg = freshWg();
    const { id } = inReview(wg);
    const o = wg.approveOutcome(id, { mergeCommand: false });
    expect(o.kind).toBe("land_next_tick");
    expect(o.sentence).toContain(`paused for the usage limit until ${until}`);
    // The same pause read as the ticket's landing_state once approved.
    wg.approveReview(id, human);
    expect(wg.landingState(id)?.paused_until).toBe(until);
    // No pause: the sentence says none.
    rmSync(join(dir, "usage-pause.json"));
    expect(wg.approveOutcomeFacts(id, { mergeCommand: false }).pause).toBeNull();
    rmSync(dir, { recursive: true, force: true });
    wg.db.close();
  });

  it("REVIEW_MODE and GAFFER_CREATE_PR are read from the settings env", () => {
    process.env.REVIEW_MODE = "both";
    process.env.GAFFER_CREATE_PR = "1";
    process.env.AUTO_MERGE = "1";
    const wg = freshWg();
    const { id } = inReview(wg);
    const o = wg.approveOutcome(id, { mergeCommand: true });
    expect(o.review_mode).toBe("both");
    expect(o.sentence).toContain("no pull request was recorded");
    wg.db.close();
  });
});

describe("routes: GET /diff predicts, review/approve says what happened", () => {
  const noopPo: ProductOwnerRunner = { run: () => ({ started: false, pid: null }) };
  const noopPlan: PlanBuildRunner = { run: async () => ({ phase: "error", error: "n/a" }) };
  let wg: Dispatch;
  let baseUrl = "";
  let close: () => Promise<void> = async () => {};
  let configured = true;
  let triggers: number[] = [];
  beforeEach(async () => {
    wg = freshWg();
    configured = true;
    triggers = [];
    const mergeRunner: MergeRunner = {
      configured: () => configured,
      trigger: ({ ticketNumber }) => {
        triggers.push(ticketNumber);
        return configured
          ? { triggered: true, pid: 1 }
          : { triggered: false, pid: null, skipped: "not_configured" };
      },
    };
    const server = createApiServer(wg, noopPo, noopPlan, mergeRunner);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () =>
      new Promise<void>((resolve) =>
        server.close(() => {
          wg.db.close();
          resolve();
        }),
      );
  });
  afterEach(async () => {
    await close();
  });
  /** POST review/approve naming the commits the diff showed (as the Review view does). */
  const approve = async (id: string) => {
    const diff = (await (await fetch(`${baseUrl}/tickets/${id}/diff`)).json()) as {
      repos: Array<{ repoId: string; headSha: string }>;
    };
    return fetch(`${baseUrl}/tickets/${id}/review/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commits: diff.repos.map((r) => ({ repo: r.repoId, sha: r.headSha })),
      }),
    });
  };

  it("an in_review ticket's diff carries approve_outcome; the approve answers it", async () => {
    process.env.AUTO_MERGE = "1";
    const { id } = inReview(wg);
    const diff = (await (await fetch(`${baseUrl}/tickets/${id}/diff`)).json()) as {
      approve_outcome?: { kind: string; label: string };
    };
    expect(diff.approve_outcome?.kind).toBe("land_now");
    expect(diff.approve_outcome?.label).toBe("Approve and land now");
    const res = await approve(id);
    const body = (await res.json()) as { approve_outcome?: { kind: string; done_label: string } };
    expect(res.status).toBe(200);
    expect(body.approve_outcome?.kind).toBe("land_now");
    expect(body.approve_outcome?.done_label).toBe("Landing now");
    // Out of review: the diff no longer predicts an approval.
    const after = (await (await fetch(`${baseUrl}/tickets/${id}/diff`)).json()) as object;
    expect(after).not.toHaveProperty("approve_outcome");
  });

  it("AUTO_MERGE on with no merge command: the approve says the merge lane lands it", async () => {
    process.env.AUTO_MERGE = "1";
    configured = false;
    const { id } = inReview(wg);
    const res = await approve(id);
    const body = (await res.json()) as { approve_outcome?: { kind: string } };
    expect(body.approve_outcome?.kind).toBe("land_next_tick");
  });

  it("'Approve and send to tester' starts no merge, even with AUTO_MERGE and a merge command", async () => {
    // The button says "It moves to In testing, not to merge": the click must not spawn the
    // merge runner for a ticket that is in_testing (merge-ticket refuses it, leaving a failed
    // merge run behind and a merge_started note on a ticket nothing is landing).
    process.env.AUTO_MERGE = "1";
    process.env.GAFFER_TESTING = "1";
    const { id, number } = inReview(wg);
    wg.setTestable(id, true, human);
    const diff = (await (await fetch(`${baseUrl}/tickets/${id}/diff`)).json()) as {
      approve_outcome?: { kind: string };
    };
    expect(diff.approve_outcome?.kind).toBe("to_tester");
    const res = await approve(id);
    const body = (await res.json()) as {
      ticket: { status: string };
      merge?: { triggered: boolean };
      approve_outcome?: { kind: string; done_label: string };
    };
    expect(res.status).toBe(200);
    expect(body.ticket.status).toBe("in_testing");
    expect(body.approve_outcome?.kind).toBe("to_tester");
    expect(triggers, `no merge triggered for #${number}`).toEqual([]);
    expect(body.merge?.triggered ?? false).toBe(false);
    const events = wg.listTicketEvents(id).map((e) => e.event_type);
    expect(events).toContain("ticket.routed_to_testing");
    expect(events).not.toContain("ticket.merge_started");
  });

  it("an epic's acceptance ticket goes to the tester and starts no merge either", async () => {
    process.env.AUTO_MERGE = "1";
    const { id } = inReview(wg);
    wg.db.prepare("UPDATE tickets SET acceptance = 1 WHERE id = ?").run(id);
    const res = await approve(id);
    const body = (await res.json()) as { ticket: { status: string } };
    expect(body.ticket.status).toBe("in_testing");
    expect(triggers).toEqual([]);
  });
});

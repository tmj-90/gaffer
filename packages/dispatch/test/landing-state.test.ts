// WHERE AN APPROVED CHANGE IS — the truthful status label for ready_for_merge.
//
// Every approved ticket read "Approved · merging", also with AUTO_MERGE off where nothing
// lands it until someone presses Merge now. landing_state says what is true, from the
// facts the landing paths act on:
//   - the pure decision, one case per state;
//   - the facts on a real Dispatch: the merge lane's rule (AUTO_MERGE + a human approval,
//     or an earned grant), a merge run the API started, per-repo landings, the review pin
//     against the head, the merge gate's evidence, a parked hold;
//   - the routes: GET /tickets/:id, GET /tickets and GET /api/board carry it, and Merge
//     now records the run so the ticket reads "landing" while it runs.

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
import type { GitRunner } from "../src/services/diffService.js";
import { decideLandingState, type LandingFacts } from "../src/services/landingState.js";
import { systemClock } from "../src/util/clock.js";
import { giveTicketRealDelivery, nonEmptyDiffRunner } from "./helpers/realDiff.js";

const human: Actor = { type: "human", id: "tom" };
const system: Actor = { type: "system" };
const agentActor: Actor = { type: "agent", id: "agent-runner" };

const F: LandingFacts = {
  status: "ready_for_merge",
  hold: null,
  mergeRunning: false,
  landedRepos: [],
  writeRepos: ["billing-api"],
  autoMerge: false,
  mergeLane: true,
  mergeGateEarned: false,
  approver: "human",
};
const f = (o: Partial<LandingFacts> = {}) => decideLandingState({ ...F, ...o });

describe("decideLandingState", () => {
  it("AUTO_MERGE off: waiting for Merge now, never merging", () => {
    expect(f()?.label).toBe("Approved · waiting for Merge now");
    expect(f()?.kind).toBe("waiting_for_merge");
  });
  it("AUTO_MERGE on and a human approval: the merge lane lands it next tick", () => {
    expect(f({ autoMerge: true })?.label).toBe("Approved · lands next tick");
  });
  it("AUTO_MERGE on but an agent's approval and no earned grant: waits", () => {
    expect(f({ autoMerge: true, approver: "agent" })?.kind).toBe("waiting_for_merge");
  });
  it("an earned merge grant lands an agent approval next tick", () => {
    expect(f({ approver: "agent", mergeGateEarned: true })?.kind).toBe("lands_next_tick");
  });
  it("the merge lane off: waits even with AUTO_MERGE on", () => {
    expect(f({ autoMerge: true, mergeLane: false })?.kind).toBe("waiting_for_merge");
  });
  it("a merge run in progress: landing", () => {
    expect(f({ mergeRunning: true })?.label).toBe("Approved · landing");
  });
  it("some write repos landed, not all: partly landed", () => {
    const s = f({ writeRepos: ["api", "web"], landedRepos: ["api"] });
    expect(s?.label).toBe("Approved · partly landed");
    expect(s?.detail).toContain("web not yet");
  });
  it("a hold's wording wins, on ready_for_merge and on the parked ticket", () => {
    expect(f({ hold: "moved_since_review", mergeRunning: true })?.label).toBe(
      "Held · moved since review",
    );
    expect(f({ hold: "merge_gate_red" })?.label).toBe("Held · merge gate failed");
    expect(f({ status: "blocked", hold: "ci_red" })?.label).toBe("Held · CI red");
  });
  it("lands next tick while the usage window is paused: says paused, and until when", () => {
    const until = "2026-11-01T09:00:00.000Z";
    const s = f({ autoMerge: true, pause: { until, kind: "usage_limit" } });
    expect(s?.kind).toBe("lands_next_tick");
    expect(s?.label).toBe("Approved · lands next tick (paused: usage limit)");
    expect(s?.detail).toContain(`paused for the usage limit until ${until}`);
    expect(s?.paused_until).toBe(until);
    // The pause changes nothing that waits for Merge now, and a hold still wins.
    expect(f({ pause: { until, kind: "usage_limit" } })?.kind).toBe("waiting_for_merge");
    expect(
      f({ autoMerge: true, hold: "ci_red", pause: { until, kind: "usage_limit" } })?.kind,
    ).toBe("held");
  });
  it("a write repo the approval did not pin: held, naming it, never 'lands next tick'", () => {
    const s = f({
      hold: "unpinned_repo",
      autoMerge: true,
      writeRepos: ["api", "web"],
      landedRepos: ["api"],
      unpinnedRepos: ["web"],
    });
    expect(s?.kind).toBe("held");
    expect(s?.label).toBe("Held · approval does not cover every repository");
    expect(s?.detail).toContain("Not approved: web.");
    expect(s?.detail).toContain("Partly landed: api landed; web held.");
  });
  it("a hold says the merge gate and CI hold every landing path", () => {
    expect(f({ hold: "merge_gate_red" })?.detail).toContain("every landing path");
    expect(f({ hold: "ci_red" })?.detail).toContain("no landing path merges it");
  });
  it("any other status has no landing state", () => {
    expect(f({ status: "in_review" })).toBeNull();
    expect(f({ status: "blocked" })).toBeNull();
  });
});

const ENV_KEYS = [
  "AUTO_MERGE",
  "MERGE_ON_AGENT_REVIEW",
  "GAFFER_MERGE_LANE",
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

/** A git runner whose branch heads can be moved (for the review pins), one per branch. */
let head = "a".repeat(40);
const branchHead = new Map<string, string>();
const movableHead: GitRunner = (cwd, args, opts) => {
  if (args[0] === "rev-parse") {
    const b = /^refs\/heads\/(.+)\^\{commit\}$/.exec(String(args[3] ?? ""))?.[1] ?? "";
    return { status: 0, stdout: `${branchHead.get(b) ?? head}\n`, stderr: "" };
  }
  return nonEmptyDiffRunner(cwd, args, opts);
};

function freshWg(): Dispatch {
  head = "a".repeat(40);
  branchHead.clear();
  // The wall clock, as in production: per-repo review pins are read against the event
  // log's in_review entry, which is stamped by the wall clock too.
  return Dispatch.open(":memory:", systemClock, movableHead);
}

/** A ticket a HUMAN approved: ready_for_merge with one write repo on disk. */
function approved(wg: Dispatch, opts: { extraWrite?: string } = {}) {
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
  expect(wg.approveReview(t.id, human).ticket.status).toBe("ready_for_merge");
  return { id: t.id, number: t.number ?? 0, repoId, extraId };
}

describe("Dispatch.landingState: from the facts the landing paths act on", () => {
  it("AUTO_MERGE off (the default): waiting for Merge now", () => {
    const wg = freshWg();
    const { id } = approved(wg);
    expect(wg.landingState(id)?.label).toBe("Approved · waiting for Merge now");
    wg.db.close();
  });

  it("AUTO_MERGE on with a human approval: lands next tick; the lane off: waits", () => {
    process.env.AUTO_MERGE = "1";
    const wg = freshWg();
    const { id } = approved(wg);
    expect(wg.landingState(id)?.kind).toBe("lands_next_tick");
    process.env.GAFFER_MERGE_LANE = "off";
    expect(wg.landingState(id)?.kind).toBe("waiting_for_merge");
    wg.db.close();
  });

  it("the runner's usage-limit pause file is active: lands next tick says paused", () => {
    process.env.AUTO_MERGE = "1";
    const dir = mkdtempSync(join(tmpdir(), "landing-pause-"));
    const file = join(dir, "usage-pause.json");
    process.env.GAFFER_USAGE_PAUSE_FILE = file;
    const wg = freshWg();
    const { id } = approved(wg);
    expect(wg.landingState(id)?.label).toBe("Approved · lands next tick");
    const until = Date.now() + 30 * 60_000;
    writeFileSync(file, JSON.stringify({ until_ms: until, kind: "usage_limit", basis: "reset" }));
    const s = wg.landingState(id);
    expect(s?.label).toBe("Approved · lands next tick (paused: usage limit)");
    expect(s?.paused_until).toBe(new Date(until).toISOString());
    // A pause that has ended is no pause.
    writeFileSync(file, JSON.stringify({ until_ms: Date.now() - 1000, kind: "usage_limit" }));
    expect(wg.landingState(id)?.label).toBe("Approved · lands next tick");
    rmSync(dir, { recursive: true, force: true });
    wg.db.close();
  });

  it("a merge run the API started reads landing while it runs, not after", () => {
    const wg = freshWg();
    const { id } = approved(wg);
    const run = wg.recordRunStart({ kind: "merge" });
    wg.noteMergeStarted(id, run.id, human);
    expect(wg.landingState(id)?.label).toBe("Approved · landing");
    wg.markRunEnd(run.id, { exit_code: 1 });
    expect(wg.landingState(id)?.kind).toBe("waiting_for_merge");
    wg.db.close();
  });

  it("one of two approved revisions has a landing record: partly landed, naming each", () => {
    const wg = freshWg();
    const { id } = approved(wg, { extraWrite: "web-storefront" });
    // The human approval pinned each write repo's head (one review pin per repo).
    expect(wg.landingStatus(id).repos.map((r) => r.repo)).toEqual([
      "billing-api",
      "web-storefront",
    ]);
    expect(wg.landingState(id)?.kind).toBe("waiting_for_merge");
    wg.recordLanding(id, { repo: "billing-api", commit: "a".repeat(40), via: "local" }, system);
    const s = wg.landingState(id);
    expect(s?.label).toBe("Approved · partly landed");
    expect(s?.detail).toContain("billing-api landed; web-storefront not yet");
    expect(s?.detail).toContain("Merge now lands the rest");
    // Both landed: nothing partial left (the done gate takes it from here).
    wg.recordLanding(id, { repo: "web-storefront", commit: "a".repeat(40) }, system);
    expect(wg.landingState(id)?.kind).not.toBe("partly_landed");
    wg.db.close();
  });

  it("a repo delivery row marked done is not a landing: only a landing record is", () => {
    const wg = freshWg();
    const { id, repoId } = approved(wg, { extraWrite: "web-storefront" });
    wg.recordRepoDelivery({ ticket_id: id, repo_id: repoId, status: "done" }, system);
    expect(wg.landingStatus(id).landed).toBe(0);
    expect(wg.landingState(id)?.kind).toBe("waiting_for_merge");
    wg.db.close();
  });

  it("a secondary repo's branch moved since review: held, naming that repo", () => {
    const wg = freshWg();
    const { id } = approved(wg, { extraWrite: "web-storefront" });
    expect(wg.landingState(id)?.kind).toBe("waiting_for_merge");
    branchHead.set("feat/web", "c".repeat(40)); // only the secondary moved
    const s = wg.landingState(id);
    expect(s?.label).toBe("Held · moved since review");
    expect(s?.detail).toContain("Moved: web-storefront.");
    expect(s?.detail).not.toContain("billing-api");
    wg.db.close();
  });

  it("a landed repo whose branch then moved or went is not held: it already landed", () => {
    const wg = freshWg();
    const { id } = approved(wg, { extraWrite: "web-storefront" });
    wg.recordLanding(id, { repo: "web-storefront", commit: "a".repeat(40) }, system);
    branchHead.set("feat/web", "d".repeat(40));
    expect(wg.landingState(id)?.label).toBe("Approved · partly landed");
    wg.db.close();
  });

  it("a merge gate hold on a partly landed ticket keeps the landed repos in its words", () => {
    const wg = freshWg();
    const { id } = approved(wg, { extraWrite: "web-storefront" });
    wg.recordLanding(id, { repo: "billing-api", commit: "a".repeat(40) }, system);
    wg.holdForHuman(id, { reasonCode: "merge_gate_red", reason: "red on web" }, system);
    const s = wg.landingState(id);
    expect(s?.label).toBe("Held · merge gate failed");
    expect(s?.detail).toContain("Partly landed: billing-api landed; web-storefront held.");
    wg.db.close();
  });

  it("the branch moved since the review approved it: held, whatever else is true", () => {
    process.env.AUTO_MERGE = "1";
    const wg = freshWg();
    const { id } = approved(wg); // the human approval pinned head aaaa…
    expect(wg.landingState(id)?.kind).toBe("lands_next_tick");
    head = "b".repeat(40);
    expect(wg.landingState(id)?.label).toBe("Held · moved since review");
    wg.db.close();
  });

  it("the merge gate's failure evidence holds it; a parked hold keeps its wording", () => {
    const wg = freshWg();
    const { id } = approved(wg);
    wg.attachDeliveryEvidence(
      id,
      { evidenceType: "test_output", summary: "MERGE GATE FAILED: tests red" },
      system,
    );
    expect(wg.landingState(id)?.label).toBe("Held · merge gate failed");
    wg.holdForHuman(id, { reasonCode: "merge_gate_red", reason: "red" }, system);
    expect(wg.view(id).ticket.status).toBe("blocked");
    expect(wg.landingState(id)?.label).toBe("Held · merge gate failed");
    wg.db.close();
  });
});

describe("routes carry landing_state; Merge now records the run", () => {
  const noopPo: ProductOwnerRunner = { run: () => ({ started: false, pid: null }) };
  const noopPlan: PlanBuildRunner = { run: async () => ({ phase: "error", error: "n/a" }) };
  let wg: Dispatch;
  let baseUrl = "";
  let close: () => Promise<void> = async () => {};
  beforeEach(async () => {
    wg = freshWg();
    const mergeRunner: MergeRunner = {
      configured: () => true,
      trigger: () => {
        const run = wg.recordRunStart({ kind: "merge" });
        return { triggered: true, pid: 1, runId: run.id };
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
  const get = async (p: string) => (await (await fetch(`${baseUrl}${p}`)).json()) as any;

  it("ticket, list and board say waiting for Merge now; after Merge now, landing", async () => {
    const { id } = approved(wg);
    const label = "Approved · waiting for Merge now";
    expect((await get(`/tickets/${id}`)).ticket.landing_state.label).toBe(label);
    const list = await get("/tickets?status=ready_for_merge");
    expect(list.tickets.find((t: { id: string }) => t.id === id).landing_state.label).toBe(label);
    const board = await get("/api/board");
    expect(board.readyForMerge.find((c: { id: string }) => c.id === id).landing_state.label).toBe(
      label,
    );
    const res = await fetch(`${baseUrl}/tickets/${id}/merge`, { method: "POST" });
    expect(res.status).toBe(202);
    expect((await get(`/tickets/${id}`)).ticket.landing_state.label).toBe("Approved · landing");
  });

  it("a ticket that is not approved or held carries none", async () => {
    const t = wg.createTicket({ title: "Draft", description: "x" }, human);
    expect((await get(`/tickets/${t.id}`)).ticket).not.toHaveProperty("landing_state");
  });
});

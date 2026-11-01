// @vitest-environment jsdom
//
// THE SIGN-OFF SAYS WHAT APPROVE DOES, driven end to end through the real path: the
// Review view in JSDOM, the REAL API on a file DB, a real git delivery, the settings in
// the server's env. For each outcome the button's label, the line under it and what the
// click actually did (the ticket's status and events, the merge runner's calls, the
// status the Review view shows afterwards against the ticket page's) must agree.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { createApiServer } from "../src/api/server.js";
import type { MergeRunner } from "../src/api/mergeRunner.js";
import type { ProductOwnerRunner } from "../src/api/productOwner.js";
import type { PlanBuildRunner } from "../src/api/planBuild.js";
import {
  type FetchLogEntry,
  realServerFetch,
  reviewViewState,
  waitUntil,
} from "./helpers/jsdomRealServer.js";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");
const human: Actor = { type: "human", id: "tom" };
const agentActor: Actor = { type: "agent", id: "agt-1" };
const BRANCH = "gaffer/t1";
const ENV_KEYS = [
  "AUTO_MERGE",
  "GAFFER_TESTING",
  "GAFFER_MERGE_LANE",
  "GAFFER_USAGE_PAUSE_FILE",
  "MERGE_ON_AGENT_REVIEW",
  "REVIEW_MODE",
  "GAFFER_CREATE_PR",
];

let work = "";
let saved: Record<string, string | undefined> = {};
const git = (dir: string, ...args: string[]): string =>
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    encoding: "utf8",
  }).trim();

/** A ticket delivered on a real branch and submitted for review. */
function inReview(d: Dispatch, opts: { testable?: boolean } = {}): string {
  const dir = join(work, "taskflow-api");
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  writeFileSync(join(dir, "README.md"), "taskflow\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  git(dir, "checkout", "-q", "-b", BRANCH);
  writeFileSync(join(dir, "webhooks.ts"), "export const deliver = 1;\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "webhooks");
  git(dir, "checkout", "-q", "main");
  const repo = d.registerRepository(
    { name: "taskflow-api", default_branch: "main", local_path: dir },
    human,
  );
  const t = d.createTicket(
    { title: "Webhook delivery for task events", priority: 1, risk_level: "low" },
    human,
  );
  d.setTicketRepoAccess(
    { ticket_id: t.id, repo_id: repo.id, access: "write", relation: "confirmed" },
    human,
  );
  const { ac } = d.addAcceptanceCriterion({ ticket_id: t.id, text: "events delivered" }, human);
  if (opts.testable) d.setTestable(t.id, true, human);
  d.markReady(t.id, human);
  const agent = d.registerAgent({ display_name: "Kev" }, human);
  const claim = d.claimNextTicket({ agentId: agent.id, ttlSeconds: 3600 }, agentActor);
  if (!claim) throw new Error("expected a claim");
  d.recordEvidence(
    {
      claimToken: claim.claimToken,
      ticket_id: t.id,
      ac_id: ac.id,
      evidence_type: "test_output",
      summary: "events delivered: ok",
    },
    agentActor,
  );
  d.recordRepoDelivery({ ticket_id: t.id, repo_id: repo.id, branch_name: BRANCH }, agentActor);
  d.submitForReview({ claimToken: claim.claimToken, ticket_id: t.id, reason: "done" }, agentActor);
  return t.id;
}

const realFetch = globalThis.fetch;
let closeServer: () => Promise<void> = async () => {};
let triggers: number[] = [];
let base = "";
let fetchLog: FetchLogEntry[] = [];
async function serve(d: Dispatch, mergeCommand: boolean): Promise<void> {
  const po: ProductOwnerRunner = { run: () => ({ started: false, pid: null }) };
  const plan: PlanBuildRunner = { run: async () => ({ phase: "error", error: "n/a" }) };
  // The merge runner as the server holds it: configured() is DISPATCH_MERGE_CMD's presence.
  const merge: MergeRunner = {
    configured: () => mergeCommand,
    trigger: ({ ticketNumber }) => {
      triggers.push(ticketNumber);
      return mergeCommand
        ? { triggered: true, pid: 1 }
        : { triggered: false, pid: null, skipped: "not_configured" };
    },
  };
  const server = createApiServer(d, po, plan, merge);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closeServer = () =>
    new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => {
        d.db.close();
        r();
      });
    });
  // The dashboard's relative API paths go to the real server (helpers/jsdomRealServer.ts:
  // JSDOM's AbortSignal kept away from Node's fetch, every request logged).
  fetchLog = [];
  vi.stubGlobal("fetch", realServerFetch(base, realFetch, fetchLog).fetch);
}

const viewState = () => reviewViewState(fetchLog);
async function openReview(id: string): Promise<void> {
  document.body.innerHTML = `
    <div id="toast" class="toast" role="alert" hidden></div>
    <div class="shell">
      <header id="appbar" class="appbar" hidden></header>
      <main id="app" class="app"><p class="loading">Loading…</p></main>
      <nav id="bottomnav" class="bottomnav" hidden></nav>
    </div>`;
  location.hash = `#/review/${id}`;
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
  // Settled once the diff (and with it the outcome's line under the button) is on screen.
  await waitUntil(
    () => document.querySelector(".signoff-next:not([hidden])") !== null,
    "the review settled",
    viewState,
  );
  expect(document.querySelector(".signoff-next:not([hidden])"), "the review settled").toBeTruthy();
}
const btn = () => document.querySelector("button.signoff-btn") as HTMLButtonElement;
const nextLine = () => document.querySelector(".signoff-next")?.textContent ?? "";
/** The confirmed click's answer is on the button. */
const approved = () =>
  waitUntil(() => btn().classList.contains("is-approved"), "the approval settled", viewState);
async function approve(): Promise<void> {
  btn().click(); // arm
  btn().click(); // confirm
  await approved();
  expect(btn().classList.contains("is-approved"), "approved").toBe(true);
}
async function ticketPage(id: string): Promise<{
  ticket: { status: string; landing_state?: { label: string } };
  events: Array<{ event_type: string }>;
}> {
  return (await (await realFetch(`${base}/tickets/${id}`)).json()) as never;
}

// A settle may take up to waitUntil's 30 s on a loaded runner: the test's budget covers it.
describe(
  "the sign-off and what Approve does agree (real API, real git, JSDOM)",
  { timeout: 90_000 },
  () => {
    beforeEach(() => {
      work = mkdtempSync(join(tmpdir(), "rv-approve-real-"));
      saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
      for (const k of ENV_KEYS) delete process.env[k];
      triggers = [];
      vi.resetModules();
    });
    afterEach(async () => {
      vi.unstubAllGlobals();
      document.body.innerHTML = "";
      await closeServer();
      closeServer = async () => {};
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      rmSync(work, { recursive: true, force: true });
    });

    it("the testing lane with AUTO_MERGE and a merge command: sent to the tester, no merge started", async () => {
      process.env.GAFFER_TESTING = "1";
      process.env.AUTO_MERGE = "1";
      const d = Dispatch.open(join(work, "dispatch.db"));
      const id = inReview(d, { testable: true });
      await serve(d, true);
      await openReview(id);
      expect(btn().textContent).toBe("Approve and send to tester");
      expect(nextLine()).toContain("not to merge");
      btn().click();
      expect(btn().textContent).toBe("Confirm: send to tester");
      btn().click();
      await approved();
      const page = await ticketPage(id);
      expect(page.ticket.status).toBe("in_testing");
      expect(triggers).toEqual([]);
      expect(page.events.map((e) => e.event_type)).not.toContain("ticket.merge_started");
      expect(btn().textContent).toContain("Sent to tester");
    });

    it("AUTO_MERGE on, no merge command, a usage pause: the line, the Review status and the ticket page all say the pause", async () => {
      process.env.AUTO_MERGE = "1";
      const pauseFile = join(work, "usage-pause.json");
      const until = new Date(Date.now() + 3_600_000).toISOString();
      writeFileSync(pauseFile, JSON.stringify({ paused_until: until, kind: "usage_limit" }));
      process.env.GAFFER_USAGE_PAUSE_FILE = pauseFile;
      const d = Dispatch.open(join(work, "dispatch.db"));
      const id = inReview(d);
      await serve(d, false);
      await openReview(id);
      expect(btn().textContent).toBe("Approve, lands on next tick");
      expect(nextLine()).toContain("paused for the usage limit until");
      await approve();
      const page = await ticketPage(id);
      expect(page.ticket.status).toBe("ready_for_merge");
      // No merge command: the merge runner starts nothing.
      expect(page.events.map((e) => e.event_type)).not.toContain("ticket.merge_started");
      expect(page.ticket.landing_state?.label).toBe(
        "Approved · lands next tick (paused: usage limit)",
      );
      // The Review view's status after the click is the ticket page's.
      expect(document.querySelector(".rv-meta .badge.st")?.textContent).toBe(
        page.ticket.landing_state?.label,
      );
    });

    it("AUTO_MERGE off with a merge command: waits for Merge now, and nothing merges", async () => {
      const d = Dispatch.open(join(work, "dispatch.db"));
      const id = inReview(d);
      await serve(d, true);
      await openReview(id);
      expect(btn().textContent).toBe("Approve, merge is a separate click");
      btn().click();
      expect(btn().textContent).toBe("Confirm approval");
      btn().click();
      await approved();
      const page = await ticketPage(id);
      expect(page.ticket.status).toBe("ready_for_merge");
      expect(triggers).toEqual([]);
      expect(page.ticket.landing_state?.label).toBe("Approved · waiting for Merge now");
      expect(document.querySelector(".rv-meta .badge.st")?.textContent).toBe(
        "Approved · waiting for Merge now",
      );
      expect(document.querySelector(".rv-done")?.textContent).toContain("Merge now");
    });

    it("AUTO_MERGE on with a merge command: lands now, and the merge runner is started once", async () => {
      process.env.AUTO_MERGE = "1";
      const d = Dispatch.open(join(work, "dispatch.db"));
      const id = inReview(d);
      await serve(d, true);
      await openReview(id);
      expect(btn().textContent).toBe("Approve and land now");
      btn().click();
      expect(btn().textContent).toBe("Confirm and land now");
      btn().click();
      await approved();
      const page = await ticketPage(id);
      expect(page.ticket.status).toBe("ready_for_merge");
      expect(triggers).toHaveLength(1);
      expect(page.events.map((e) => e.event_type)).toContain("ticket.merge_started");
      expect(btn().textContent).toContain("Landing now");
    });

    it("required CI recorded without a PASS for the head: held, the button disabled, the server refuses", async () => {
      const d = Dispatch.open(join(work, "dispatch.db"));
      const id = inReview(d);
      const head = git(join(work, "taskflow-api"), "rev-parse", BRANCH);
      d.recordCiResult(id, { commit: head, state: "pending" }, { type: "system" });
      await serve(d, true);
      await openReview(id);
      expect(btn().textContent).toBe("Approve held: CI not passed");
      expect(btn().disabled).toBe(true);
      // The server holds it too: an approve with the shown head is refused.
      const res = await realFetch(`${base}/tickets/${id}/review/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commits: [{ sha: head }] }),
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect((await ticketPage(id)).ticket.status).toBe("in_review");
    });

    it("the Team Sheet's approved row says what the ticket page says, not 'the runner held the merge gate'", async () => {
      process.env.AUTO_MERGE = "1"; // no merge command: the merge lane lands it next tick
      const d = Dispatch.open(join(work, "dispatch.db"));
      const id = inReview(d);
      await serve(d, false);
      await openReview(id);
      await approve();
      const page = await ticketPage(id);
      expect(page.ticket.landing_state?.label).toBe("Approved · lands next tick");
      // The human queue the Team Sheet reads, from the real API.
      const q = (await (await realFetch(`${base}/api/human-queue`)).json()) as {
        items: Array<{ kind: string; ticket: { id: string } | null }>;
      };
      const item = q.items.find((i) => i.ticket?.id === id) as
        { kind: string; ticket: { landing_state?: { label: string } } } | undefined;
      expect(item?.kind).toBe("awaiting_merge");
      expect(item?.ticket.landing_state?.label).toBe("Approved · lands next tick");
      // The Overview's Team Sheet row.
      location.hash = "#/";
      await waitUntil(
        () => document.querySelector("#what-i-own .own-row--awaiting_merge") !== null,
        "the approved row on the Team Sheet",
        () =>
          `${viewState()}\n  #what-i-own: ${JSON.stringify(document.querySelector("#what-i-own")?.textContent?.trim().slice(0, 300) ?? null)}`,
      );
      const row = document.querySelector("#what-i-own .own-row--awaiting_merge");
      expect(row, "the approved row on the Team Sheet").toBeTruthy();
      expect(row?.querySelector(".own-kind")?.textContent).toBe("Approved · lands next tick");
      expect(row?.querySelector(".own-reason")?.textContent).toContain("merge lane lands");
      expect(row?.textContent).not.toMatch(/runner held the merge gate/);
    });
  },
);

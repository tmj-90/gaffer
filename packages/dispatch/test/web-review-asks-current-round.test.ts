// @vitest-environment jsdom
//
// THE REQUESTS FOR A HUMAN BESIDE THE SIGN-OFF ARE THIS ROUND'S, through the real path:
// the Review view in JSDOM, reading the REAL API on a file DB over a real git delivery.
//
// The band beside the button, the summary and the flags read one list of evidence rows
// that ask for a human. That list read every row the ticket ever had, so a reviewer
// agent's advisory CHANGES, a runner's needs_human_review or a tester FAIL from an EARLIER
// attempt (sent back, reworked and redelivered since) stood beside the button as if the
// new delivery asked it: the review packet and the Work card already date those verdicts
// to the round they were about. A request from the current attempt must still show,
// including one the runner records before the delivery enters review.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor, EvidenceType } from "../src/domain/types.js";
import { createApiServer } from "../src/api/server.js";
import type { MergeRunner } from "../src/api/mergeRunner.js";
import type { ProductOwnerRunner } from "../src/api/productOwner.js";
import type { PlanBuildRunner } from "../src/api/planBuild.js";
import { TestClock } from "../src/util/clock.js";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");
const human: Actor = { type: "human", id: "tom" };
const agentActor: Actor = { type: "agent", id: "agt-1" };
const system: Actor = { type: "system" };
const BRANCH = "gaffer/t1";

let work = "";
const git = (dir: string, ...args: string[]): string =>
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    encoding: "utf8",
  }).trim();
function makeRepo(): string {
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
  return dir;
}

interface Fixture {
  d: Dispatch;
  clock: TestClock;
  id: string;
  dir: string;
  /** One delivery attempt: claim, evidence, (`during` = the runner's gates), submit. */
  deliver: (during?: () => void) => void;
  /** A system row, as the runner records it (`wg attach-evidence`). */
  runnerNote: (summary: string, type?: EvidenceType) => void;
}

function fixture(): Fixture {
  const clock = new TestClock("2026-10-29T10:00:00.000Z");
  const d = Dispatch.open(join(work, "dispatch.db"), clock);
  const dir = makeRepo();
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
  d.markReady(t.id, human);
  const agent = d.registerAgent({ display_name: "Kev" }, human);
  const runnerNote = (summary: string, type: EvidenceType = "manual_note") => {
    d.attachDeliveryEvidence(t.id, { evidenceType: type, summary }, system);
    clock.advanceSeconds(1);
  };
  const deliver = (during?: () => void) => {
    clock.advanceSeconds(60);
    const claim = d.claimNextTicket({ agentId: agent.id, ttlSeconds: 3600 }, agentActor);
    if (!claim) throw new Error("expected a claim");
    clock.advanceSeconds(1);
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
    clock.advanceSeconds(1);
    during?.();
    d.submitForReview(
      { claimToken: claim.claimToken, ticket_id: t.id, reason: "done" },
      agentActor,
    );
    clock.advanceSeconds(1);
  };
  return { d, clock, id: t.id, dir, deliver, runnerNote };
}

const realFetch = globalThis.fetch;
let closeServer: () => Promise<void> = async () => {};
async function serve(d: Dispatch): Promise<void> {
  const po: ProductOwnerRunner = { run: () => ({ started: false, pid: null }) };
  const plan: PlanBuildRunner = { run: async () => ({ phase: "error", error: "n/a" }) };
  const merge: MergeRunner = {
    configured: () => false,
    trigger: () => ({ triggered: false, pid: null, skipped: "not_configured" }),
  };
  const server = createApiServer(d, po, plan, merge);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closeServer = () =>
    new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => {
        d.db.close();
        r();
      });
    });
  // The dashboard's relative API paths go to the real server.
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    realFetch(/^https?:/.test(String(input)) ? String(input) : base + String(input), init),
  );
}

async function openReview(f: Fixture): Promise<void> {
  await serve(f.d);
  document.body.innerHTML = `
    <div id="toast" class="toast" role="alert" hidden></div>
    <div class="shell">
      <header id="appbar" class="appbar" hidden></header>
      <main id="app" class="app"><p class="loading">Loading…</p></main>
      <nav id="bottomnav" class="bottomnav" hidden></nav>
    </div>`;
  location.hash = `#/review/${f.id}`;
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
  // Settled once the diff (and with it the outcome's line under the button) is on screen.
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 25));
    if (document.querySelector(".signoff-next:not([hidden])")) break;
  }
  expect(document.querySelector(".signoff-next:not([hidden])"), "the review settled").toBeTruthy();
}

const band = () => document.querySelector(".signoff .signoff-asks")?.textContent ?? "";
const summary = () => document.querySelector(".signoff-sum")?.textContent ?? "";
const markedRows = () =>
  [...document.querySelectorAll(".review-evi.evi-asks")].map((r) => r.textContent ?? "");

const ADVISORY = "Reviewer agent (advisory): changes requested — retry on 5xx is missing";
const OVERSIZED = "needs_human_review: oversized_diff — 41 files / 1210 lines";

describe("the sign-off's requests for a human are the current round's (real API, real git)", () => {
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "rv-asks-round-"));
    vi.resetModules();
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
    await closeServer();
    closeServer = async () => {};
    delete process.env.GAFFER_TESTING;
    rmSync(work, { recursive: true, force: true });
  });

  it("a reviewer's advisory CHANGES from an earlier round is history, not a current ask", async () => {
    const f = fixture();
    f.deliver();
    f.runnerNote(ADVISORY);
    f.d.rejectReview(f.id, "ready", human, "add the retry");
    f.deliver(); // the reworked delivery: nobody has reviewed it yet
    await openReview(f);
    expect(band()).toBe("");
    expect(summary()).not.toMatch(/reviewer asked for changes/i);
    expect(summary()).toContain("Nothing flagged");
    expect(markedRows()).toEqual([]);
  });

  it("a reviewer's advisory CHANGES in the current round stands beside the button", async () => {
    const f = fixture();
    f.deliver();
    f.runnerNote(ADVISORY);
    await openReview(f);
    expect(band()).toContain("Reviewer asked for changes");
    expect(band()).toContain("retry on 5xx is missing");
    expect(summary()).not.toContain("Nothing flagged");
    expect(markedRows().some((r) => r.includes("Reviewer agent (advisory)"))).toBe(true);
  });

  it("a runner needs_human_review (recorded as system) from an earlier attempt is not asked again", async () => {
    const f = fixture();
    f.deliver(() => f.runnerNote(OVERSIZED));
    f.d.rejectReview(f.id, "ready", human, "split it up");
    f.deliver();
    await openReview(f);
    expect(band()).toBe("");
    expect(summary()).toContain("Nothing flagged");
  });

  it("a runner needs_human_review recorded during THIS attempt (before it entered review) shows", async () => {
    const f = fixture();
    f.deliver(() => f.runnerNote(OVERSIZED));
    await openReview(f);
    expect(band()).toContain("Runner asks for a human review");
    expect(band()).toContain("oversized_diff");
    expect(summary()).not.toContain("Nothing flagged");
  });

  it("a second attempt's own needs_human_review shows; the first attempt's does not repeat", async () => {
    const f = fixture();
    f.deliver(() => f.runnerNote("needs_human_review: missing smallest-change note (first)"));
    f.d.rejectReview(f.id, "ready", human, "again");
    f.deliver(() => f.runnerNote(OVERSIZED));
    await openReview(f);
    expect(band()).toContain("oversized_diff");
    expect(band()).not.toContain("(first)");
    expect(document.querySelectorAll(".signoff-asks-list li")).toHaveLength(1);
  });

  it("a tester FAIL that sent an earlier candidate back is not a current request", async () => {
    process.env.GAFFER_TESTING = "1";
    const f = fixture();
    f.d.setTestable(f.id, true, human);
    f.deliver();
    f.d.approveReview(f.id, human, {
      commits: [{ repo: null, sha: git(f.dir, "rev-parse", BRANCH) }],
    });
    f.clock.advanceSeconds(5);
    f.d.testerFail(
      f.id,
      { summary: "contract case 3 failed: no retry header", to: "ready" },
      system,
    );
    f.deliver();
    await openReview(f);
    expect(band()).toBe("");
    expect(summary()).not.toMatch(/tester asked for changes/i);
  });

  it("the runner's integrity FLAG on this attempt's DoD record shows", async () => {
    const f = fixture();
    f.deliver(() =>
      f.runnerNote(
        "DoD: PASS\n" +
          JSON.stringify({
            dod: "PASS",
            gates: [
              { gate: "tests", repo: "taskflow-api", status: "PASS", rc: 0, note: "pnpm test" },
              {
                gate: "integrity",
                repo: "taskflow-api",
                status: "FLAG",
                rc: "-",
                note: "a git-ignored .npmrc changed",
              },
            ],
          }),
        "test_output",
      ),
    );
    await openReview(f);
    expect(band()).toContain("Gate flagged: integrity");
    expect(summary()).not.toContain("Nothing flagged");
  });
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import { createApiServer } from "../src/api/server.js";
import { createPollWorkRunner, TICK_CMD_ENV, type PollWorkRunner } from "../src/api/pollWork.js";

// A live poll needs a dollar cap (runner/lib/budget.sh gaffer_spend_cap_ok), and the
// route now checks for one before it spawns. These tests are about the work counts and
// the spawn, so they run uncapped; the cap check has its own describe below.
let prevUncapped: string | undefined;
beforeAll(() => {
  prevUncapped = process.env["GAFFER_ALLOW_UNCAPPED"];
  process.env["GAFFER_ALLOW_UNCAPPED"] = "1";
});
afterAll(() => {
  if (prevUncapped === undefined) delete process.env["GAFFER_ALLOW_UNCAPPED"];
  else process.env["GAFFER_ALLOW_UNCAPPED"] = prevUncapped;
});

/**
 * The "Poll for work" button fires a single factory tick on demand. The runner
 * spawns the operator-configured DISPATCH_TICK_CMD using the SAME safe pattern
 * as the merge runner: no shell, argv array, bearer token stripped from the
 * child env, fire-and-gaffert. When unset it surfaces NOT_CONFIGURED (like the
 * product-owner runner) rather than silently doing nothing.
 */

// ===========================================================================
//  Runner unit tests — drive the REAL spawn path against a tiny node script.
// ===========================================================================

describe("createPollWorkRunner (spawns the tick command)", () => {
  it("throws NOT_CONFIGURED when DISPATCH_TICK_CMD is unset", () => {
    const runner = createPollWorkRunner({});
    expect(() => runner.run()).toThrowError(/NOT_CONFIGURED|not configured|tick command/i);
  });

  it("treats a blank/whitespace command as unconfigured", () => {
    const runner = createPollWorkRunner({ [TICK_CMD_ENV]: "   " } as NodeJS.ProcessEnv);
    expect(() => runner.run()).toThrow();
  });

  it("spawns the configured command and strips DISPATCH_API_TOKEN from the child env", async () => {
    const { mkdtempSync, readFileSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "wg-tick-"));
    const outFile = join(dir, "out.json");
    const scriptFile = join(dir, "fake-tick.cjs");
    writeFileSync(
      scriptFile,
      "const fs=require('fs');" +
        "fs.writeFileSync(process.env.WG_TICK_OUT," +
        "JSON.stringify({argv:process.argv.slice(2),token:process.env.DISPATCH_API_TOKEN??null}));",
    );

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DISPATCH_API_TOKEN: "super-secret-bearer",
      WG_TICK_OUT: outFile,
      [TICK_CMD_ENV]: `${process.execPath} ${scriptFile}`,
    };
    const runner = createPollWorkRunner(env);
    const res = runner.run();
    expect(res.started).toBe(true);

    // Wait for the detached child to write the file.
    const deadline = Date.now() + 4000;
    let raw: string | null = null;
    while (Date.now() < deadline) {
      try {
        raw = readFileSync(outFile, "utf8");
        if (raw) break;
      } catch {
        // not written yet
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as { argv: string[]; token: string | null };
    // No request-derived args are appended (the tick takes none).
    expect(parsed.argv).toEqual([]);
    // The bearer token is STRIPPED from the child env (defence-in-depth).
    expect(parsed.token).toBeNull();
  });
});

// ===========================================================================
//  REST tests — POST /poll-work with an injected fake runner.
// ===========================================================================

interface Harness {
  baseUrl: string;
  runCount: () => number;
  close: () => Promise<void>;
}

async function startHarness(
  runner: PollWorkRunner,
  seedReady = true,
  seed?: (wg: Dispatch) => void,
): Promise<Harness> {
  const wg = Dispatch.open(":memory:");
  seed?.(wg);
  if (seedReady) {
    // The route only fires a tick when something is actually READY; seed one so the
    // spawn / NOT_CONFIGURED paths below are exercised (empty queue is tested separately).
    const human = { type: "human" as const, id: "tom" };
    const t = wg.createTicket({ title: "seed ready" }, human);
    wg.addAcceptanceCriterion({ ticket_id: t.id, text: "AC" }, human); // Guard A: ≥1 AC required to ready
    wg.markReady(t.id, human);
  }
  let runs = 0;
  const wrapped: PollWorkRunner = {
    run() {
      runs += 1;
      return runner.run();
    },
  };
  const noopPo = { run: () => ({ started: false, pid: null }) };
  const noopPlan = { run: () => Promise.resolve({ phase: "error" as const, error: "x" }) };
  const noopMerge = { trigger: () => ({ triggered: false, pid: null, skipped: "not_configured" }) };
  const server = createApiServer(wg, noopPo, noopPlan, noopMerge, wrapped);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    runCount: () => runs,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          wg.db.close();
          resolve();
        });
      }),
  };
}

async function call(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

describe("POST /poll-work", () => {
  let h: Harness;
  afterEach(async () => {
    if (h) await h.close();
  });

  it("fires one tick and returns 202 with the run result", async () => {
    h = await startHarness({ run: () => ({ started: true, pid: 1234 }) });
    const res = await call(h.baseUrl, "POST", "/poll-work");
    expect(res.status).toBe(202);
    expect(res.body.run).toMatchObject({ started: true, pid: 1234 });
    expect(h.runCount()).toBe(1);
  });

  it("returns 503 NOT_CONFIGURED when no tick command is set", async () => {
    // The real default runner with an empty env throws NOT_CONFIGURED, which the
    // server maps to a 503 — the click had no effect and the user is told why.
    h = await startHarness(createPollWorkRunner({}));
    const res = await call(h.baseUrl, "POST", "/poll-work");
    expect(res.status).toBe(503);
    expect((res.body.error as { code: string }).code).toBe("NOT_CONFIGURED");
  });

  it("returns 405 for a non-POST method", async () => {
    h = await startHarness({ run: () => ({ started: true, pid: 1 }) });
    const res = await call(h.baseUrl, "GET", "/poll-work");
    expect(res.status).toBe(405);
    expect(h.runCount()).toBe(0);
  });

  it("returns 200 'no ready work' (and never spawns) when the queue has nothing ready", async () => {
    h = await startHarness({ run: () => ({ started: true, pid: 1 }) }, /* seedReady */ false);
    const res = await call(h.baseUrl, "POST", "/poll-work");
    expect(res.status).toBe(200);
    expect(res.body.polled).toBe(false);
    expect(res.body.reason).toBe("no_ready_work");
    expect(h.runCount()).toBe(0);
  });

  it("fires the tick on an EMPTY queue when the idle maintenance lane is on in crew.yaml", async () => {
    // The tick then runs the scheduler-chosen scan lane (which may draft + promote its
    // own ticket), so refusing to spawn here would make the lane unreachable from the
    // dashboard's Poll button.
    const dir = mkdtempSync(join(tmpdir(), "wg-poll-maint-"));
    const crewPath = join(dir, "crew.yaml");
    writeFileSync(
      crewPath,
      "factory:\n  name: demo\nloops:\n  maintenance:\n    enabled: true\n  idle_tech_debt:\n    enabled: true\n",
      "utf8",
    );
    const prev = process.env["CREW_CONFIG"];
    process.env["CREW_CONFIG"] = crewPath;
    try {
      h = await startHarness({ run: () => ({ started: true, pid: 7 }) }, /* seedReady */ false);
      const res = await call(h.baseUrl, "POST", "/poll-work");
      expect(res.status).toBe(202);
      expect(res.body.polled).toBe(true);
      expect(res.body.readyCount).toBe(0);
      expect(res.body.idle).toBe("maintenance");
      expect(h.runCount()).toBe(1);
    } finally {
      if (prev === undefined) delete process.env["CREW_CONFIG"];
      else process.env["CREW_CONFIG"] = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
//  Non-ready work a tick handles first: a Continue'd paused delivery, an agent
//  review, a black-box test. Counting only `ready` made Continue + Poll a no-op.
// ===========================================================================

const human = { type: "human" as const, id: "tom" };

/** A ticket driven to `paused` with a human's Continue on it (resume-requested). */
function seedResumeRequested(wg: Dispatch): void {
  wg.registerRepository({ name: "svc", default_branch: "main" }, human);
  const t = wg.createTicket({ title: "big", description: "x", policy_pack: "solo_loose" }, human);
  wg.linkRepository(t.id, "svc", "primary", human);
  wg.addAcceptanceCriterion({ ticket_id: t.id, text: "AC" }, human);
  wg.markReady(t.id, human);
  const agent = wg.registerAgent({ display_name: "a" }, human);
  wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, { type: "agent", id: "runner" });
  wg.pauseDelivery(
    t.id,
    {
      reason: "cap_hit",
      branch_name: "gaffer/ticket-1-big",
      worktree_path: "/tmp/wt",
      worktrees_json: "[]",
      repo: "svc",
      attempt: 1,
      turns: 200,
      spend: "$1",
    },
    { type: "system" },
  );
  wg.continuePaused(t.id, human);
}

/** A ticket sitting in `status` (set directly — the lanes only read the status). */
function seedInStatus(status: string): (wg: Dispatch) => void {
  return (wg) => {
    const t = wg.createTicket({ title: `in ${status}` }, human);
    wg.db.prepare("UPDATE tickets SET status = ? WHERE id = ?").run(status, t.id);
  };
}

function withEnv(vars: Record<string, string | undefined>): () => void {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

describe("POST /poll-work — work beyond the ready queue", () => {
  let h: Harness | undefined;
  let restore: (() => void) | undefined;
  afterEach(async () => {
    if (h) await h.close();
    h = undefined;
    restore?.();
    restore = undefined;
  });

  it("fires for a paused ticket a human pressed Continue on (nothing ready)", async () => {
    restore = withEnv({ GAFFER_PAUSE_ON_CAP: undefined, CREW_CONFIG: "/nonexistent/crew.yaml" });
    h = await startHarness({ run: () => ({ started: true, pid: 3 }) }, false, seedResumeRequested);
    const res = await call(h.baseUrl, "POST", "/poll-work");
    expect(res.status).toBe(202);
    expect(res.body.polled).toBe(true);
    expect(res.body.readyCount).toBe(0);
    expect(res.body.pending).toMatchObject({ ready: 0, resume: 1 });
    expect(res.body.idle).toBeUndefined();
    expect(h.runCount()).toBe(1);
  });

  it("does not count a Continue'd ticket when pause-on-cap is off (the tick would not resume it)", async () => {
    restore = withEnv({ GAFFER_PAUSE_ON_CAP: "0", CREW_CONFIG: "/nonexistent/crew.yaml" });
    h = await startHarness({ run: () => ({ started: true, pid: 3 }) }, false, seedResumeRequested);
    const res = await call(h.baseUrl, "POST", "/poll-work");
    expect(res.status).toBe(200);
    expect(res.body.reason).toBe("no_ready_work");
    expect(h.runCount()).toBe(0);
  });

  it("fires for an in_review ticket when the reviewer agent is on, and not under human review", async () => {
    restore = withEnv({ REVIEW_MODE: "agent", CREW_CONFIG: "/nonexistent/crew.yaml" });
    h = await startHarness(
      { run: () => ({ started: true, pid: 4 }) },
      false,
      seedInStatus("in_review"),
    );
    let res = await call(h.baseUrl, "POST", "/poll-work");
    expect(res.status).toBe(202);
    expect(res.body.pending).toMatchObject({ review: 1 });
    await h.close();
    restore();
    restore = withEnv({ REVIEW_MODE: "human", CREW_CONFIG: "/nonexistent/crew.yaml" });
    h = await startHarness(
      { run: () => ({ started: true, pid: 4 }) },
      false,
      seedInStatus("in_review"),
    );
    res = await call(h.baseUrl, "POST", "/poll-work");
    expect(res.status).toBe(200);
    expect(res.body.polled).toBe(false);
    expect(h.runCount()).toBe(0);
  });

  it("fires for an in_testing ticket only when the tester lane is on", async () => {
    restore = withEnv({ GAFFER_TESTING: "1", CREW_CONFIG: "/nonexistent/crew.yaml" });
    h = await startHarness(
      { run: () => ({ started: true, pid: 5 }) },
      false,
      seedInStatus("in_testing"),
    );
    const res = await call(h.baseUrl, "POST", "/poll-work");
    expect(res.status).toBe(202);
    expect(res.body.pending).toMatchObject({ testing: 1 });
  });

  it("fires for an epic's ACCEPTANCE ticket in testing even with the tester lane off (exploratory finding ui-workflows/F1)", async () => {
    // quickstart: the Acceptance ticket "always goes through the independent tester on
    // approval, whatever GAFFER_TESTING says", and runner/lib/tester.sh picks acceptance
    // tickets with the lane off. Counting in_testing only with the lane on stranded the
    // build: Poll for work answered no_ready_work forever.
    const acceptanceInTesting = (wg: Dispatch) => {
      const t = wg.createTicket({ title: "Acceptance" }, human);
      wg.db
        .prepare("UPDATE tickets SET status = 'in_testing', acceptance = 1 WHERE id = ?")
        .run(t.id);
    };
    restore = withEnv({ GAFFER_TESTING: undefined, CREW_CONFIG: "/nonexistent/crew.yaml" });
    h = await startHarness({ run: () => ({ started: true, pid: 5 }) }, false, acceptanceInTesting);
    let res = await call(h.baseUrl, "POST", "/poll-work");
    expect(res.status).toBe(202);
    expect(res.body.polled).toBe(true);
    expect(res.body.pending).toMatchObject({ ready: 0, testing: 1 });
    expect(h.runCount()).toBe(1);
    // A plain (non-acceptance) ticket in testing is the lane's: with the lane off the
    // runner leaves it alone, so nothing would run.
    await h.close();
    h = await startHarness(
      { run: () => ({ started: true, pid: 5 }) },
      false,
      seedInStatus("in_testing"),
    );
    res = await call(h.baseUrl, "POST", "/poll-work");
    expect(res.status).toBe(200);
    expect(res.body.reason).toBe("no_ready_work");
    expect(h.runCount()).toBe(0);
  });

  it("fires for an approved ticket the merge lane would land (AUTO_MERGE on), not otherwise", async () => {
    restore = withEnv({
      AUTO_MERGE: "1",
      GAFFER_MERGE_LANE: undefined,
      CREW_CONFIG: "/nonexistent/crew.yaml",
    });
    h = await startHarness(
      { run: () => ({ started: true, pid: 7 }) },
      false,
      seedInStatus("ready_for_merge"),
    );
    let res = await call(h.baseUrl, "POST", "/poll-work");
    expect(res.status).toBe(202);
    expect(res.body.pending).toMatchObject({ ready: 0, merge: 1 });
    expect(h.runCount()).toBe(1);
    for (const env of [{ AUTO_MERGE: "0" }, { AUTO_MERGE: "1", GAFFER_MERGE_LANE: "0" }]) {
      await h.close();
      restore();
      restore = withEnv({
        GAFFER_MERGE_LANE: undefined,
        ...env,
        CREW_CONFIG: "/nonexistent/crew.yaml",
      });
      h = await startHarness(
        { run: () => ({ started: true, pid: 7 }) },
        false,
        seedInStatus("ready_for_merge"),
      );
      res = await call(h.baseUrl, "POST", "/poll-work");
      expect(res.status).toBe(200);
      expect(res.body.polled).toBe(false);
      expect(h.runCount()).toBe(0);
    }
  });

  it("a PARTLY LANDED ticket is merge work under the lane's own policy: not with AUTO_MERGE off, yes with it on (external review #7)", async () => {
    // Two write repos, both approved (one review pin each); repoA's landing is recorded,
    // repoB's is not. The merge lane lands the rest only when the policy that let it land
    // the first still holds (AUTO_MERGE for this approval); with AUTO_MERGE off the ticket
    // stays partly landed for a human's Merge now, so Poll for work has nothing to run.
    const partlyLanded = (wg: Dispatch) => {
      const t = wg.createTicket({ title: "spans two repos" }, human);
      const sha = (c: string) => c.repeat(40);
      const ins = wg.db.prepare(
        "INSERT INTO evidence (id, ticket_id, ac_id, repo_id, decision_id, evidence_type, summary, uri, payload_json, created_by, recorded_by_actor_type, created_at) VALUES (?, ?, NULL, ?, NULL, 'commit', 's', ?, '{}', 'dispatch', 'system', ?)",
      );
      for (const [name, c] of [
        ["repoA", "a"],
        ["repoB", "b"],
      ] as const) {
        const r = wg.registerRepository({ name, default_branch: "main" }, human);
        wg.setTicketRepoAccess(
          { ticket_id: t.id, repo_id: r.id, access: "write", relation: "confirmed" },
          human,
        );
        ins.run(
          `pin-${name}`,
          t.id,
          r.id,
          `gaffer-reviewed-commit:${sha(c)}`,
          "2026-01-01T00:00:00Z",
        );
        if (name === "repoA")
          ins.run(
            `land-${name}`,
            t.id,
            r.id,
            `gaffer-landed-commit:${sha(c)}`,
            "2026-01-01T00:01:00Z",
          );
      }
      wg.db.prepare("UPDATE tickets SET status = 'ready_for_merge' WHERE id = ?").run(t.id);
    };
    restore = withEnv({
      AUTO_MERGE: "0",
      GAFFER_MERGE_LANE: undefined,
      CREW_CONFIG: "/nonexistent/crew.yaml",
    });
    h = await startHarness({ run: () => ({ started: true, pid: 8 }) }, false, partlyLanded);
    let res = await call(h.baseUrl, "POST", "/poll-work");
    expect(res.status).toBe(200);
    expect(res.body.polled).toBe(false);
    expect(h.runCount()).toBe(0);
    await h.close();
    restore();
    // AUTO_MERGE back on: the lane would land the remaining repo.
    restore = withEnv({
      AUTO_MERGE: "1",
      GAFFER_MERGE_LANE: undefined,
      CREW_CONFIG: "/nonexistent/crew.yaml",
    });
    h = await startHarness({ run: () => ({ started: true, pid: 8 }) }, false, partlyLanded);
    res = await call(h.baseUrl, "POST", "/poll-work");
    expect(res.status).toBe(202);
    expect(res.body.polled).toBe(true);
    expect(res.body.pending).toMatchObject({ ready: 0, merge: 1 });
    expect(h.runCount()).toBe(1);
    // The lane off: nothing would land it.
    await h.close();
    restore();
    restore = withEnv({
      AUTO_MERGE: "1",
      GAFFER_MERGE_LANE: "0",
      CREW_CONFIG: "/nonexistent/crew.yaml",
    });
    h = await startHarness({ run: () => ({ started: true, pid: 8 }) }, false, partlyLanded);
    res = await call(h.baseUrl, "POST", "/poll-work");
    expect(res.status).toBe(200);
    expect(res.body.polled).toBe(false);
  });

  it("fires for a draft with a local repo when clarify-when-idle is on, not for a repo-less one", async () => {
    const draftWithRepo = (local: boolean) => (wg: Dispatch) => {
      const t = wg.createTicket({ title: local ? "vague draft" : "repo-less draft" }, human);
      if (local) {
        wg.registerRepository(
          { name: "svc", default_branch: "main", local_path: "/tmp/svc" },
          human,
        );
        wg.linkRepository(t.id, "svc", "primary", human);
      }
    };
    restore = withEnv({ CLARIFY_DRAFTS_WHEN_IDLE: "1", CREW_CONFIG: "/nonexistent/crew.yaml" });
    h = await startHarness({ run: () => ({ started: true, pid: 6 }) }, false, draftWithRepo(true));
    let res = await call(h.baseUrl, "POST", "/poll-work");
    expect(res.status).toBe(202);
    expect(res.body.pending).toMatchObject({ clarify: 1 });
    await h.close();
    h = await startHarness({ run: () => ({ started: true, pid: 6 }) }, false, draftWithRepo(false));
    res = await call(h.baseUrl, "POST", "/poll-work");
    expect(res.status).toBe(200);
    expect(res.body.polled).toBe(false);
    await h.close();
    restore();
    restore = withEnv({
      CLARIFY_DRAFTS_WHEN_IDLE: undefined,
      CREW_CONFIG: "/nonexistent/crew.yaml",
    });
    h = await startHarness({ run: () => ({ started: true, pid: 6 }) }, false, draftWithRepo(true));
    res = await call(h.baseUrl, "POST", "/poll-work");
    expect(res.status).toBe(200);
    expect(res.body.polled).toBe(false);
  });
});

// ===========================================================================
//  A poll the runner would refuse is reported as refused (exploratory findings
//  api-robustness/F11, fresh-user/F-16): with no dollar cap the answer was
//  202 polled:true and the run "succeeded", the refusal only in the run log.
// ===========================================================================

describe("POST /poll-work — the runner's refusal is reported truthfully", () => {
  let h: Harness | undefined;
  let restore: (() => void) | undefined;
  let dir: string | undefined;
  afterEach(async () => {
    if (h) await h.close();
    h = undefined;
    restore?.();
    restore = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const noCap = (extra: Record<string, string | undefined> = {}) => {
    dir = mkdtempSync(join(tmpdir(), "wg-poll-cap-"));
    return withEnv({
      GAFFER_DATA: dir,
      GAFFER_ALLOW_UNCAPPED: undefined,
      GAFFER_DAILY_BUDGET_USD: undefined,
      GAFFER_BUDGET_USD: undefined,
      DRY_RUN: undefined,
      CREW_CONFIG: "/nonexistent/crew.yaml",
      ...extra,
    });
  };

  it("no dollar cap: polled:false reason no_budget_cap with the runner's fix, and no tick is spawned", async () => {
    restore = noCap();
    h = await startHarness({ run: () => ({ started: true, pid: 9 }) });
    const res = await call(h.baseUrl, "POST", "/poll-work");
    expect(res.status).toBe(200);
    expect(res.body.polled).toBe(false);
    expect(res.body.reason).toBe("no_budget_cap");
    expect(String(res.body.message)).toMatch(/no dollar cap is set: set GAFFER_DAILY_BUDGET_USD/);
    expect(res.body.readyCount).toBe(1);
    expect(h.runCount()).toBe(0);
  });

  it("a daily budget in settings.json, GAFFER_ALLOW_UNCAPPED=1 or a dry run lets the poll fire", async () => {
    restore = noCap();
    writeFileSync(join(dir!, "settings.json"), JSON.stringify({ GAFFER_DAILY_BUDGET_USD: "5" }));
    h = await startHarness({ run: () => ({ started: true, pid: 9 }) });
    expect((await call(h.baseUrl, "POST", "/poll-work")).status).toBe(202);
    await h.close();
    h = undefined;
    restore();
    for (const extra of [
      { GAFFER_ALLOW_UNCAPPED: "1" },
      { DRY_RUN: "1" },
      { GAFFER_BUDGET_USD: "20" },
    ]) {
      restore = noCap(extra);
      h = await startHarness({ run: () => ({ started: true, pid: 9 }) });
      const res = await call(h.baseUrl, "POST", "/poll-work");
      expect(res.status, JSON.stringify(extra)).toBe(202);
      await h.close();
      h = undefined;
      restore();
      restore = undefined;
    }
  });

  it("a cap of 0 is no cap", async () => {
    restore = noCap({ GAFFER_DAILY_BUDGET_USD: "0" });
    h = await startHarness({ run: () => ({ started: true, pid: 9 }) });
    const res = await call(h.baseUrl, "POST", "/poll-work");
    expect(res.body.reason).toBe("no_budget_cap");
  });

  it("a poll run the runner refused after it started ends 'failed' with the refusal as its detail, not 'succeeded'", async () => {
    dir = mkdtempSync(join(tmpdir(), "wg-poll-refused-"));
    const script = join(dir, "refusing-tick.cjs");
    writeFileSync(
      script,
      "process.stderr.write('gaffer poll: per-day cap (MAX_TICKS_PER_DAY=1, used 1) reached — not polling.\\n');" +
        "process.stdout.write('TICK_RESULT=no_work\\n');",
    );
    const wg = Dispatch.open(":memory:");
    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        GAFFER_DATA: dir,
        [TICK_CMD_ENV]: `${process.execPath} ${script}`,
      };
      const res = createPollWorkRunner(env, wg).run();
      expect(res.runId).toBeTruthy();
      const deadline = Date.now() + 5000;
      let run = wg.listRuns({}).find((r) => r.id === res.runId);
      while (run?.status === "running" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
        run = wg.listRuns({}).find((r) => r.id === res.runId);
      }
      expect(run?.exit_code).toBe(0);
      expect(run?.status).toBe("failed");
      expect(run?.detail).toMatch(/^refused: per-day cap \(MAX_TICKS_PER_DAY=1, used 1\) reached/);
    } finally {
      wg.db.close();
    }
  });
});

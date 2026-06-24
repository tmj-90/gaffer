import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import { resolveRunsDir, spawnTrackedRun } from "../src/api/runTracking.js";
import { TestClock } from "../src/util/clock.js";

/**
 * RUN-ACTIVITY — the shared spawn wrapper. Drives a trivial child to assert it
 * records a run, captures output to a per-run log, and marks the run ended with
 * the status derived from the exit code (succeeded on 0, failed on non-zero).
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function freshWg(dataDir: string): Dispatch {
  const wg = Dispatch.open(join(dataDir, "dispatch.sqlite"), new TestClock());
  cleanups.push(() => wg.db.close());
  return wg;
}

/** Wait until the run leaves `running` (the child exited + the listener fired). */
async function waitForEnd(wg: Dispatch, runId: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = wg.runs.findById(runId);
    if (run && run.status !== "running") return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`run ${runId} did not end within ${timeoutMs}ms`);
}

describe("RUN-ACTIVITY: spawnTrackedRun records + captures + marks ended", () => {
  it("records a run, writes a log, and marks it succeeded when the child exits 0", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "wg-rt-"));
    const env = { ...process.env, GAFFER_DATA: dataDir };
    const wg = freshWg(dataDir);

    const res = spawnTrackedRun(
      {
        bin: process.execPath,
        args: ["-e", "process.stdout.write('hello-from-child'); process.exit(0)"],
        env,
        kind: "product_owner",
        repo: "gaffer",
      },
      wg,
      env,
    );
    expect(res.started).toBe(true);
    expect(res.runId).toBeTruthy();
    const runId = res.runId!;

    // Recorded as running with the captured log path + pid on the row.
    const live = wg.runs.findById(runId)!;
    expect(live.kind).toBe("product_owner");
    expect(live.repo).toBe("gaffer");
    expect(live.log_path).toBe(join(resolveRunsDir(env), `${runId}.log`));
    expect(live.pid).toBeGreaterThan(0);

    await waitForEnd(wg, runId);

    const done = wg.runs.findById(runId)!;
    expect(done.status).toBe("succeeded");
    expect(done.exit_code).toBe(0);
    expect(done.ended_at).not.toBeNull();

    // The child's stdout was captured to the per-run log (not discarded).
    const log = readFileSync(done.log_path!, "utf8");
    expect(log).toContain("hello-from-child");
  });

  it("marks a run failed when the child exits non-zero (and still captures stderr)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "wg-rt-"));
    const env = { ...process.env, GAFFER_DATA: dataDir };
    const wg = freshWg(dataDir);

    const res = spawnTrackedRun(
      {
        bin: process.execPath,
        args: ["-e", "process.stderr.write('boom'); process.exit(1)"],
        env,
        kind: "onboard",
        repo: "crew",
      },
      wg,
      env,
    );
    const runId = res.runId!;
    await waitForEnd(wg, runId);

    const done = wg.runs.findById(runId)!;
    expect(done.status).toBe("failed");
    expect(done.exit_code).toBe(1);
    expect(readFileSync(done.log_path!, "utf8")).toContain("boom");
  });

  it("falls back to legacy ignore-output spawn when no tracker is wired", () => {
    const res = spawnTrackedRun(
      {
        bin: process.execPath,
        args: ["-e", "process.exit(0)"],
        env: process.env,
        kind: "poll_work",
        repo: null,
      },
      undefined,
    );
    expect(res.started).toBe(true);
    expect(res.runId).toBeNull();
  });

  it("records a failed run and rethrows on a synchronous spawn failure", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "wg-rt-"));
    const env = { ...process.env, GAFFER_DATA: dataDir };
    const wg = freshWg(dataDir);

    // A non-string bin forces a synchronous spawn throw (TypeError) — exercises the
    // catch path: the attempt is recorded as a failed run, then rethrown.
    expect(() =>
      spawnTrackedRun(
        // @ts-expect-error deliberately invalid bin to force a sync throw
        { bin: 123, args: [], env, kind: "merge", repo: null },
        wg,
        env,
      ),
    ).toThrow();

    const recent = wg.listRuns();
    expect(recent).toHaveLength(1);
    expect(recent[0]!.status).toBe("failed");
    expect(recent[0]!.detail).toMatch(/spawn failed/i);
  });
});

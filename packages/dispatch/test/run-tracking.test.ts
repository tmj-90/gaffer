import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { Dispatch } from "../src/core.js";
import { resolveRunsDir, spawnTrackedRun, type RunTracker } from "../src/api/runTracking.js";
import { TestClock } from "../src/util/clock.js";

/**
 * Wrap node:fs so the test can observe per-run log fds: every openSync return is
 * recorded in `openFds` and every closeSync removes it, letting the fail-closed
 * test assert the SUT closed the fd it opened (rather than leaking it). The
 * SUT's `import { openSync, closeSync } from "node:fs"` bindings resolve to these
 * wrappers. Module mocks are hoisted, so this must use a self-contained factory.
 */
const { openFds } = vi.hoisted(() => ({ openFds: new Set<number>() }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>): number => {
      const fd = actual.openSync(...args);
      openFds.add(fd);
      return fd;
    },
    closeSync: (fd: number): void => {
      openFds.delete(fd);
      actual.closeSync(fd);
    },
  };
});

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

  it("fails CLOSED when recordRunStart throws after a successful spawn (no orphan)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "wg-rt-"));
    const env = { ...process.env, GAFFER_DATA: dataDir };

    // A tracker that mints ids but THROWS on recordRunStart — simulating a
    // registry write that fails (SQLite locked / migration / disk full) AFTER the
    // child has already been spawned. The child must not be left orphaned.
    let capturedPid: number | null = null;
    let capturedLogPath: string | null | undefined;
    const failingTracker: RunTracker = {
      newRunId: () => "fixed-run-id",
      recordRunStart: (input) => {
        capturedPid = input.pid ?? null;
        capturedLogPath = input.log_path;
        throw new Error("registry write failed (simulated SQLITE_BUSY)");
      },
      markRunEnd: () => {
        throw new Error("markRunEnd must not be called on the fail-closed path");
      },
    };

    openFds.clear();

    // A long-lived child so we can prove it was killed rather than having simply
    // exited on its own before we checked.
    expect(() =>
      spawnTrackedRun(
        {
          bin: process.execPath,
          args: ["-e", "setTimeout(() => {}, 60000)"],
          env,
          kind: "product_owner",
          repo: "gaffer",
        },
        failingTracker,
        env,
      ),
    ).toThrow(/registry write failed/);

    // recordRunStart did receive a real, live pid (the spawn succeeded first).
    expect(capturedPid).toBeGreaterThan(0);
    const pid = capturedPid!;

    // The child was SIGTERM'd: it must no longer be alive. SIGTERM is async, so
    // poll briefly for the process to disappear.
    const deadline = Date.now() + 5000;
    let alive = true;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 25));
      } catch {
        alive = false;
        break;
      }
    }
    expect(alive).toBe(false);

    // The per-run log was opened (fd-bearing branch ran, not the ignore fallback)
    // AND every fd opened by the SUT was closed on the fail-closed path — no leak.
    expect(capturedLogPath).toBe(join(resolveRunsDir(env), "fixed-run-id.log"));
    expect(openFds.size).toBe(0);
  });

  it("escalates to SIGKILL after grace when SIGTERM does not reap the child", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "wg-rt-kill-"));
    const env = { ...process.env, GAFFER_DATA: dataDir };

    // A tracker that throws on recordRunStart — this is the fail-closed path that
    // fires SIGTERM (+ SIGKILL after grace). Use a child that ignores SIGTERM so
    // only the SIGKILL reaps it.
    let capturedPid: number | null = null;
    const failingTracker: RunTracker = {
      newRunId: () => "kill-grace-run-id",
      recordRunStart: (input) => {
        capturedPid = input.pid ?? null;
        throw new Error("registry write failed (kill-grace test)");
      },
      markRunEnd: () => {},
    };

    // A child that traps and ignores SIGTERM (only SIGKILL can stop it).
    expect(() =>
      spawnTrackedRun(
        {
          bin: process.execPath,
          // Node child: catch SIGTERM and do nothing; only SIGKILL terminates.
          args: ["-e", "process.on('SIGTERM', () => {}); setTimeout(() => {}, 30000)"],
          env,
          kind: "product_owner",
          repo: "gaffer",
        },
        failingTracker,
        env,
      ),
    ).toThrow(/registry write failed/);

    expect(capturedPid).toBeGreaterThan(0);
    const pid = capturedPid!;

    // SIGKILL fires after the grace period. Wait up to 6s for the process to die.
    const deadline = Date.now() + 6_000;
    let alive = true;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 100));
      } catch {
        alive = false;
        break;
      }
    }
    expect(alive).toBe(false);
  }, 10_000);

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

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import { migrate } from "../src/db/connection.js";
import { RunRepository } from "../src/repositories/runRepository.js";
import { TestClock } from "../src/util/clock.js";

/**
 * RUN-ACTIVITY — the runs control-plane registry (repo + Dispatch facade).
 * Covers: start → list(active) → markEnd → list(recent); status derivation from
 * the exit code; sweepStaleRuns flipping a dead-pid running row to `unknown`;
 * and the migration applying on an older (pre-v10) DB.
 */

function freshWg(): Dispatch {
  return Dispatch.open(":memory:", new TestClock());
}

describe("RUN-ACTIVITY: runs facade lifecycle", () => {
  let wg: Dispatch;
  beforeEach(() => {
    wg = freshWg();
  });

  it("records a run start as `running` and lists it as active", () => {
    const { id } = wg.recordRunStart({
      kind: "product_owner",
      repo: "gaffer",
      pid: 4242,
      log_path: "/tmp/runs/x.log",
    });
    expect(id).toBeTruthy();

    const active = wg.listRuns({ active: true });
    expect(active).toHaveLength(1);
    const run = active[0]!;
    expect(run.id).toBe(id);
    expect(run.kind).toBe("product_owner");
    expect(run.repo).toBe("gaffer");
    expect(run.pid).toBe(4242);
    expect(run.status).toBe("running");
    expect(run.log_path).toBe("/tmp/runs/x.log");
    expect(run.ended_at).toBeNull();
    expect(run.exit_code).toBeNull();
  });

  it("marks a run ended succeeded on exit 0 and moves it out of the active list", () => {
    const { id } = wg.recordRunStart({ kind: "onboard", repo: "crew", pid: 1 });
    wg.markRunEnd(id, { exit_code: 0 });

    expect(wg.listRuns({ active: true })).toHaveLength(0);
    const recent = wg.listRuns();
    expect(recent).toHaveLength(1);
    const run = recent[0]!;
    expect(run.status).toBe("succeeded");
    expect(run.exit_code).toBe(0);
    expect(run.ended_at).not.toBeNull();
  });

  it("derives `failed` from a non-zero exit code (and a null code)", () => {
    const a = wg.recordRunStart({ kind: "poll_work", pid: 2 });
    const b = wg.recordRunStart({ kind: "merge", pid: 3 });
    wg.markRunEnd(a.id, { exit_code: 1 });
    wg.markRunEnd(b.id, { exit_code: null, detail: "spawn error" });

    const byId = new Map(wg.listRuns().map((r) => [r.id, r]));
    expect(byId.get(a.id)!.status).toBe("failed");
    expect(byId.get(b.id)!.status).toBe("failed");
    expect(byId.get(b.id)!.detail).toBe("spawn error");
  });

  it("caps and orders the recent list, most-recently-started first", () => {
    const clock = new TestClock();
    const w = Dispatch.open(":memory:", clock);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      clock.advanceSeconds(1);
      ids.push(w.recordRunStart({ kind: "other", repo: `r${i}` }).id);
    }
    const recent = w.listRuns({ limit: 3 });
    expect(recent).toHaveLength(3);
    // Newest three, newest first.
    expect(recent.map((r) => r.id)).toEqual([ids[4], ids[3], ids[2]]);
    w.db.close();
  });

  it("does not resurrect an already-ended run via a late markRunEnd", () => {
    const { id } = wg.recordRunStart({ kind: "product_owner", pid: 9 });
    wg.markRunEnd(id, { exit_code: 0 });
    // A late/duplicate end (e.g. the exit listener firing after a sweep) is a no-op.
    wg.markRunEnd(id, { exit_code: 1 });
    expect(wg.runs.findById(id)!.status).toBe("succeeded");
  });
});

describe("RUN-ACTIVITY: sweepStaleRuns reconciles orphans", () => {
  it("flips a running row with a dead pid to `unknown`, leaving a live one running", () => {
    const wg = freshWg();
    const dead = wg.recordRunStart({ kind: "product_owner", repo: "gaffer", pid: 999_999 });
    const live = wg.recordRunStart({ kind: "onboard", repo: "crew", pid: process.pid });

    // Inject a deterministic liveness probe: only the current process is alive.
    const swept = wg.runs.sweepStale(new TestClock().now(), (pid) => pid === process.pid);
    expect(swept).toEqual([dead.id]);

    expect(wg.runs.findById(dead.id)!.status).toBe("unknown");
    expect(wg.runs.findById(dead.id)!.ended_at).not.toBeNull();
    expect(wg.runs.findById(live.id)!.status).toBe("running");
  });

  it("treats a null pid as dead (a run we can't probe can't be trusted live)", () => {
    const wg = freshWg();
    const { id } = wg.recordRunStart({ kind: "merge", pid: null });
    const swept = wg.runs.sweepStale(new TestClock().now(), () => true);
    expect(swept).toEqual([id]);
    expect(wg.runs.findById(id)!.status).toBe("unknown");
  });

  it("the facade sweepStaleRuns uses the real liveness probe end-to-end", () => {
    const wg = freshWg();
    // A pid that is overwhelmingly unlikely to be alive.
    const { id } = wg.recordRunStart({ kind: "poll_work", pid: 2_147_483_646 });
    const swept = wg.sweepStaleRuns();
    expect(swept).toContain(id);
    expect(wg.runs.findById(id)!.status).toBe("unknown");
  });
});

describe("RUN-ACTIVITY: migration applies on an older (pre-v10) DB", () => {
  it("adds the runs table to a DB stamped at schema_version 9", () => {
    // Stand up an in-memory DB stamped at the previous version with NO runs table.
    const db = new Database(":memory:");
    db.exec("CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare("INSERT INTO schema_meta(key,value) VALUES ('schema_version','9')").run();
    // Sanity: the runs table does not exist yet.
    const before = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='runs'")
      .get();
    expect(before).toBeUndefined();

    // Apply the current migration.
    migrate(db);

    // The runs table now exists and the version was bumped to 10.
    const after = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='runs'")
      .get();
    expect(after).toBeDefined();
    const version = db
      .prepare("SELECT value FROM schema_meta WHERE key='schema_version'")
      .get() as { value: string };
    expect(version.value).toBe("10");

    // The migrated table is usable by the repository.
    const repo = new RunRepository(db);
    repo.insertStart({
      id: "r1",
      kind: "other",
      repo: null,
      pid: 1,
      log_path: null,
      started_at: "2026-01-01T00:00:00.000Z",
    });
    expect(repo.list({ active: true })).toHaveLength(1);
    db.close();
  });
});

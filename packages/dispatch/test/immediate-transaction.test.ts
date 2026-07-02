import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { inTransaction } from "../src/db/connection.js";

// ---------------------------------------------------------------------------
// inTransaction() must run its body inside a `BEGIN IMMEDIATE` transaction.
//
// better-sqlite3's `db.transaction(fn)` defaults to DEFERRED: it takes no write
// lock until the first write statement runs. Under GAFFER_CONCURRENCY>1 two
// worker PROCESSES sharing one SQLite file then race to UPGRADE a read snapshot
// to a write lock — and SQLite does NOT honour `busy_timeout` on that upgrade,
// so the loser fails immediately with `SQLITE_BUSY` (SQLITE_BUSY_SNAPSHOT)
// instead of waiting. `.immediate()` acquires the write lock up front, so
// `busy_timeout` applies and the loser WAITS for the lock rather than throwing.
//
// These tests are deterministic (no thread/process timing): they drive a second
// connection from INSIDE the transaction body to observe, without races, that
// the write lock was taken at BEGIN — the exact behaviour a deferred txn lacks.
// ---------------------------------------------------------------------------

describe("inTransaction uses BEGIN IMMEDIATE", () => {
  const dirs: string[] = [];
  const conns: Database.Database[] = [];

  afterEach(() => {
    for (const c of conns.splice(0)) {
      try {
        c.close();
      } catch {
        // already closed
      }
    }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function fileDb(): { file: string; open: () => Database.Database } {
    const dir = mkdtempSync(join(tmpdir(), "gaffer-immtx-"));
    dirs.push(dir);
    const file = join(dir, "t.sqlite");
    const open = (): Database.Database => {
      const db = new Database(file);
      db.pragma("journal_mode = WAL");
      // 0 so a blocked write fails FAST instead of waiting — makes the "is the
      // lock already held?" probe deterministic rather than timing out.
      db.pragma("busy_timeout = 0");
      conns.push(db);
      return db;
    };
    return { file, open };
  }

  it("holds the write lock from the start of the body (a concurrent writer is refused before the body writes)", () => {
    const { open } = fileDb();
    const a = open();
    const b = open();
    a.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER NOT NULL)");
    a.prepare("INSERT INTO t (id, n) VALUES (1, 0)").run();

    let secondWriterRefusedUpFront = false;
    inTransaction(a, () => {
      // We are inside a's transaction but a has issued NO write statement yet.
      // With BEGIN IMMEDIATE the write lock is already held, so b's write is
      // refused (SQLITE_BUSY, busy_timeout=0). With a DEFERRED txn the lock is
      // not yet held and b's write would SUCCEED here — which is exactly what
      // then makes a's own later write fail to upgrade.
      try {
        b.prepare("UPDATE t SET n = 999 WHERE id = 1").run();
      } catch (err) {
        secondWriterRefusedUpFront = /SQLITE_BUSY|database is locked/i.test(String(err));
      }
      a.prepare("UPDATE t SET n = 1 WHERE id = 1").run();
    });

    expect(secondWriterRefusedUpFront).toBe(true);
    // a's write is the one that landed — the concurrent writer never clobbered it.
    expect((a.prepare("SELECT n FROM t WHERE id = 1").get() as { n: number }).n).toBe(1);
  });

  it("rolls back atomically on error — no partial write survives (fail-safe guarantee)", () => {
    const { open } = fileDb();
    const a = open();
    a.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER NOT NULL)");
    a.prepare("INSERT INTO t (id, n) VALUES (1, 0)").run();

    expect(() =>
      inTransaction(a, () => {
        a.prepare("UPDATE t SET n = 42 WHERE id = 1").run();
        throw new Error("boom");
      }),
    ).toThrow("boom");

    // The mid-transaction write was rolled back with the failed transaction.
    expect((a.prepare("SELECT n FROM t WHERE id = 1").get() as { n: number }).n).toBe(0);
  });

  it("commits the body's writes on success", () => {
    const { open } = fileDb();
    const a = open();
    a.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER NOT NULL)");
    a.prepare("INSERT INTO t (id, n) VALUES (1, 0)").run();

    const returned = inTransaction(a, () => {
      a.prepare("UPDATE t SET n = 7 WHERE id = 1").run();
      return "result";
    });

    expect(returned).toBe("result");
    expect((a.prepare("SELECT n FROM t WHERE id = 1").get() as { n: number }).n).toBe(7);
  });
});

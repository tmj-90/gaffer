/**
 * Ledger writers validate and write ATOMICALLY (external review 17, finding 4).
 *
 * `advanceFeature` / `releaseFeature` read and validated the feature's status BEFORE
 * their write transaction and then updated unconditionally. Two real connections and
 * a scheduled interleaving gave two successful claims of one feature, a stale claim
 * moving `shipped` back to `building`, and a stale release moving `shipped` back to
 * `backlog`. The same read-then-write shape sat in the sibling writers: the feature
 * re-add (addFeature), the first digest write, a lore reject (deleting a record that
 * was approved meanwhile), a lore update (overwriting a concurrent update with stale
 * values), and the boundary reject / agent re-declare (dropping or rewriting an edge a
 * human approved meanwhile).
 *
 * Every case here is deterministic, with no sleeps: connection A is wrapped so that a
 * competing call on connection B runs exactly once, at the first of two points:
 *   - right after A's validating read returns (what the reviewer scheduled), or
 *   - right as A starts its write transaction.
 * Before the fix A's read came first (outside any transaction), so B landed between
 * A's check and A's write. After it, A takes the write lock first, so B either runs
 * entirely before A's read (and A refuses with its typed error) or, when A already
 * holds the lock, cannot write until A commits.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { approveBoundary, rejectBoundary, suggestBoundary } from "../src/core/boundaries.js";
import {
  addLore,
  approveLore,
  getLore,
  rejectLore,
  suggestLore,
  updateLore,
} from "../src/core/lore.js";
import {
  addFeature,
  advanceFeature,
  AdvanceFeatureError,
  getDigest,
  getFeature,
  mergeDigest,
  releaseFeature,
  touchDigest,
  upsertDigest,
} from "../src/core/repoUnderstanding.js";
import type { FeatureStatus } from "../src/db/types.js";
import { openDb } from "../src/db/index.js";

let dir: string;
let dbA: Database;
let dbB: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memory-ledger-races-"));
  const path = join(dir, "lore.db");
  dbA = openDb(path);
  dbB = openDb(path);
});

afterEach(() => {
  dbA.close();
  dbB.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Interleave {
  /** A read statement of A's (by SQL text); B runs right after it first returns. */
  readonly afterRead?: RegExp;
  /** Run B as A starts its write transaction (whichever point comes first wins). */
  readonly atTxStart?: boolean;
  readonly competitor: () => void;
}

/**
 * Connection A, wrapped: the competitor runs ONCE, at the first scheduled point A
 * reaches. Everything else passes straight through to the real connection.
 */
function scheduled(db: Database, plan: Interleave): { db: Database; fired: () => boolean } {
  let fired = false;
  const fire = (): void => {
    if (fired) return;
    fired = true;
    plan.competitor();
  };
  const passthrough = (target: object, prop: string | symbol): unknown => {
    const v = Reflect.get(target, prop, target) as unknown;
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
  };
  const wrapped = new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          const stmt = target.prepare(sql);
          if (!plan.afterRead || !plan.afterRead.test(sql)) return stmt;
          return new Proxy(stmt, {
            get(s, p) {
              if (p === "get") {
                return (...args: unknown[]) => {
                  const row = (s.get as (...a: unknown[]) => unknown)(...args);
                  fire();
                  return row;
                };
              }
              return passthrough(s, p);
            },
          });
        };
      }
      if (prop === "transaction" && plan.atTxStart) {
        return (fn: (...a: unknown[]) => unknown) => {
          const tx = target.transaction(fn);
          const at =
            (run: (...a: unknown[]) => unknown) =>
            (...args: unknown[]) => {
              fire();
              return run(...args);
            };
          return Object.assign(at(tx), {
            deferred: at(tx.deferred),
            immediate: at(tx.immediate),
            exclusive: at(tx.exclusive),
          });
        };
      }
      return passthrough(target, prop);
    },
  });
  return { db: wrapped, fired: () => fired };
}

type Outcome = { ok: true; status: FeatureStatus } | { ok: false; error: unknown };

function attempt(fn: () => { status: FeatureStatus }): Outcome {
  try {
    return { ok: true, status: fn().status };
  } catch (error) {
    return { ok: false, error };
  }
}

/** The feature's transition events, in order. */
function transitions(
  db: Database,
  id: string,
): Array<{ kind: string; from?: string; to?: string; status?: string }> {
  const rows = db
    .prepare(
      "SELECT kind, payload FROM events WHERE lore_id = ? AND kind LIKE 'feature_%' ORDER BY rowid",
    )
    .all(id) as Array<{ kind: string; payload: string }>;
  return rows.map((r) => ({ kind: r.kind, ...(JSON.parse(r.payload) as object) }));
}

/**
 * The ledger tells one consistent story: every transition starts where the previous
 * one ended (a stale write records a `from` that was no longer true), and the row's
 * status is where the last one ended.
 */
function expectConsistentLedger(db: Database, id: string): void {
  const evs = transitions(db, id);
  let current = evs[0]!.status as string;
  for (const e of evs.slice(1)) {
    expect(e.from, `${e.kind} recorded from '${e.from}' while the feature was '${current}'`).toBe(
      current,
    );
    current = e.to as string;
  }
  expect(getFeature(db, id)!.status).toBe(current);
}

const FEATURE_READ = /SELECT status FROM feature WHERE id/;

function seedFeature(status: FeatureStatus): string {
  return addFeature(dbA, { repo: "r", name: "Refunds", summary: "s", status }).id;
}

function expectIllegal(o: Outcome): void {
  expect(o.ok).toBe(false);
  if (!o.ok) {
    expect(o.error).toBeInstanceOf(AdvanceFeatureError);
    expect((o.error as AdvanceFeatureError).reason).toBe("illegal_transition");
  }
}

describe("feature transitions are atomic across connections", () => {
  it("two claims of one backlog feature: exactly one succeeds, the loser gets illegal_transition", () => {
    const id = seedFeature("backlog");
    let b: Outcome | undefined;
    const a = scheduled(dbA, {
      afterRead: FEATURE_READ,
      atTxStart: true,
      competitor: () => {
        b = attempt(() => advanceFeature(dbB, id, "building"));
      },
    });
    const outA = attempt(() => advanceFeature(a.db, id, "building"));
    expect(a.fired()).toBe(true);
    const wins = [outA, b!].filter((o) => o.ok).length;
    expect(wins, "both connections claimed the same feature").toBe(1);
    expectIllegal(outA.ok ? b! : outA);
    expect(transitions(dbA, id).filter((e) => e.kind === "feature_advanced")).toHaveLength(1);
    expectConsistentLedger(dbA, id);
  });

  it("a stale claim never moves a feature shipped meanwhile back to building", () => {
    const id = seedFeature("backlog");
    let b: Outcome | undefined;
    const a = scheduled(dbA, {
      afterRead: FEATURE_READ,
      atTxStart: true,
      competitor: () => {
        b = attempt(() => advanceFeature(dbB, id, "shipped"));
      },
    });
    const outA = attempt(() => advanceFeature(a.db, id, "building"));
    expect(b!.ok).toBe(true);
    expectIllegal(outA);
    expect(getFeature(dbA, id)!.status).toBe("shipped");
    expectConsistentLedger(dbA, id);
  });

  it("a stale release never moves a feature shipped meanwhile back to backlog", () => {
    const id = seedFeature("building");
    let b: Outcome | undefined;
    const a = scheduled(dbA, {
      afterRead: FEATURE_READ,
      atTxStart: true,
      competitor: () => {
        b = attempt(() => advanceFeature(dbB, id, "shipped"));
      },
    });
    const outA = attempt(() => releaseFeature(a.db, id));
    expect(b!.ok).toBe(true);
    expectIllegal(outA);
    expect(getFeature(dbA, id)!.status).toBe("shipped");
    expectConsistentLedger(dbA, id);
  });

  it("while A holds its transaction, B cannot write between A's check and A's write", () => {
    // Only the after-read point: A has read and validated. B must not get its write in
    // (it waits for A's lock; with no busy wait it is refused outright).
    const id = seedFeature("backlog");
    dbB.pragma("busy_timeout = 0");
    let b: Outcome | undefined;
    const a = scheduled(dbA, {
      afterRead: FEATURE_READ,
      competitor: () => {
        b = attempt(() => advanceFeature(dbB, id, "shipped"));
      },
    });
    const outA = attempt(() => advanceFeature(a.db, id, "building"));
    expect(a.fired()).toBe(true);
    expect(outA.ok).toBe(true);
    expect(b!.ok, "B wrote between A's validation and A's write").toBe(false);
    expect((b as { error: { code?: string } }).error.code).toBe("SQLITE_BUSY");
    expect(getFeature(dbA, id)!.status).toBe("building");
    expectConsistentLedger(dbA, id);
    // Once A committed, B's move validates against what A wrote.
    expect(advanceFeature(dbB, id, "shipped").status).toBe("shipped");
    expectConsistentLedger(dbA, id);
  });
});

describe("sibling ledger writers with the same read-then-write shape", () => {
  it("addFeature: a re-add that read 'backlog' never writes 'building' over a ship", () => {
    const id = seedFeature("backlog");
    const a = scheduled(dbA, {
      afterRead: /FROM feature WHERE repo = \? AND lower\(name\)/,
      atTxStart: true,
      competitor: () => {
        advanceFeature(dbB, id, "shipped");
      },
    });
    const out = addFeature(a.db, { repo: "r", name: "Refunds", summary: "s2", status: "building" });
    expect(a.fired()).toBe(true);
    expect(out.status).toBe("shipped");
    expect(getFeature(dbA, id)!.status).toBe("shipped");
  });

  it("upsertDigest: two first writes for one repo both land (no key conflict)", () => {
    const input = {
      repo: "r",
      overview: "o",
      structure: "s",
      conventions: "c",
      stack: "k",
    };
    const a = scheduled(dbA, {
      afterRead: /SELECT repo FROM repo_digest/,
      atTxStart: true,
      competitor: () => {
        upsertDigest(dbB, { ...input, source: "merge:#2" });
      },
    });
    expect(() =>
      upsertDigest(a.db, { ...input, overview: "o1", source: "merge:#1" }),
    ).not.toThrow();
    expect(getDigest(dbA, "r")!.overview).toBe("o1");
    const events = dbA
      .prepare(
        "SELECT payload FROM events WHERE kind = 'digest_updated' AND lore_id = 'r' ORDER BY rowid",
      )
      .all() as Array<{ payload: string }>;
    expect(
      events.map((e) => (JSON.parse(e.payload) as { superseded: boolean }).superseded),
    ).toEqual([false, true]);
  });

  it("a partial digest set and a touch never put back a section another write just set", () => {
    // The CLI's `digest set` (partial) and `digest touch` read the digest and upserted
    // it in a separate step; they now go through mergeDigest / touchDigest, one write
    // transaction each. (Before the fix these core functions did not exist: the CLI
    // carried the read-then-write itself, in a process this test cannot schedule.)
    upsertDigest(dbA, {
      repo: "r",
      overview: "o0",
      structure: "s0",
      conventions: "c0",
      stack: "k0",
      source: "onboard",
    });
    const a = scheduled(dbA, {
      afterRead: /SELECT \* FROM repo_digest WHERE repo/,
      atTxStart: true,
      competitor: () => {
        mergeDigest(dbB, { repo: "r", stack: "k-from-B", source: "merge:#2" });
      },
    });
    mergeDigest(a.db, { repo: "r", overview: "o-from-A", source: "merge:#1" });
    expect(a.fired()).toBe(true);
    expect(getDigest(dbA, "r")).toMatchObject({ overview: "o-from-A", stack: "k-from-B" });
    const t = scheduled(dbA, {
      afterRead: /SELECT \* FROM repo_digest WHERE repo/,
      atTxStart: true,
      competitor: () => {
        mergeDigest(dbB, { repo: "r", conventions: "c-from-B", source: "merge:#3" });
      },
    });
    touchDigest(t.db, "r", "merge:#4");
    expect(getDigest(dbA, "r")).toMatchObject({ conventions: "c-from-B", source: "merge:#4" });
  });

  it("rejectLore never deletes a record that was approved meanwhile", () => {
    const draft = suggestLore(dbA, { title: "t", summary: "s", body: "b" });
    let approved: unknown;
    const a = scheduled(dbA, {
      afterRead: /SELECT rowid, status FROM lore WHERE id/,
      atTxStart: true,
      competitor: () => {
        approved = approveLore(dbB, draft.id);
      },
    });
    const rejected = rejectLore(a.db, draft.id, "no");
    expect(a.fired()).toBe(true);
    expect(approved).not.toBeNull();
    expect(rejected).toBe(false);
    expect(getLore(dbA, draft.id, { recordRead: false })?.status).toBe("active");
  });

  it("updateLore never overwrites a concurrent update with stale values", () => {
    const lore = addLore(dbA, { title: "t0", summary: "s0", body: "b0" });
    const a = scheduled(dbA, {
      afterRead: /SELECT \* FROM lore WHERE id/,
      atTxStart: true,
      competitor: () => {
        updateLore(dbB, lore.id, { summary: "s-from-B" });
      },
    });
    updateLore(a.db, lore.id, { title: "t-from-A" });
    expect(a.fired()).toBe(true);
    const now = getLore(dbA, lore.id, { recordRead: false })!;
    expect(now.title).toBe("t-from-A");
    expect(now.summary, "A's update put B's summary back to its old value").toBe("s-from-B");
  });

  it("rejectBoundary never drops an edge that was approved meanwhile", () => {
    const edge = suggestBoundary(dbA, { repo: "r", contract: "c", role: "provides" });
    let approved: unknown = "not-run";
    const a = scheduled(dbA, {
      afterRead: /SELECT status FROM boundaries WHERE id/,
      atTxStart: true,
      competitor: () => {
        approved = approveBoundary(dbB, edge.id);
      },
    });
    const rejected = rejectBoundary(a.db, edge.id);
    if (approved === "not-run") approved = approveBoundary(dbB, edge.id);
    const row = dbA.prepare("SELECT status FROM boundaries WHERE id = ?").get(edge.id) as
      { status: string } | undefined;
    // One serial story: approved then not rejected, or rejected then nothing to approve.
    if (approved) {
      expect(rejected).toBe(false);
      expect(row?.status).toBe("active");
    } else {
      expect(rejected).toBe(true);
      expect(row).toBeUndefined();
    }
  });

  it("an agent re-declare never rewrites an edge a human approved meanwhile", () => {
    const edge = suggestBoundary(dbA, {
      repo: "r",
      contract: "c",
      role: "provides",
      detail: "human-reviewed detail",
    });
    const a = scheduled(dbA, {
      afterRead: /SELECT \* FROM boundaries WHERE repo/,
      atTxStart: true,
      competitor: () => {
        approveBoundary(dbB, edge.id);
      },
    });
    suggestBoundary(a.db, { repo: "r", contract: "c", role: "provides", detail: "agent rewrite" });
    expect(a.fired()).toBe(true);
    const row = dbA.prepare("SELECT status, detail FROM boundaries WHERE id = ?").get(edge.id) as {
      status: string;
      detail: string;
    };
    expect(row.status).toBe("active");
    expect(row.detail).toBe("human-reviewed detail");
  });
});

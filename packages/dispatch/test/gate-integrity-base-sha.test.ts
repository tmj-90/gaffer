/**
 * GATE INTEGRITY: the server-side scan diffs from the commit the runner RECORDED when
 * it cut the delivery branch (ticket_repo_delivery.base_sha), not from the base branch
 * NAME. An agent can move that branch from inside its worktree (`git branch -f main
 * HEAD`); a merge-base taken from the moved branch hid every commit before the move.
 *
 *  1. A committed test.skip, then `main` moved onto it, then another commit: with the
 *     recorded base the `test-modified` annotation still names the marker.
 *  2. The base branch rewritten so it no longer contains the recorded commit: the scan
 *     still runs from the recorded commit and adds an `incomplete` finding.
 *  3. Only the runner records it: an agent actor is refused; the value is validated;
 *     a later record without it keeps the stored one.
 *  4. The v29→v30 migration adds the column to an existing table.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import { migrate } from "../src/db/connection.js";
import { SCHEMA_VERSION } from "../src/db/schema.js";
import type { Actor } from "../src/domain/types.js";
import { DispatchError } from "../src/util/errors.js";

const human: Actor = { type: "human", id: "tom" };
const agent: Actor = { type: "agent", id: "agt-1" };

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function git(...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: dir,
    },
  }).trim();
}

/** A repo on main with one passing test, and the delivery branch cut from it. */
function repoWithDelivery(): { base: string } {
  dir = mkdtempSync(join(tmpdir(), "gi-basesha-"));
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "README"), "r\n");
  git("add", "-A");
  git("commit", "-qm", "root");
  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "test/a.test.js"), 'test("a", () => {});\n');
  writeFileSync(join(dir, "a.js"), "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  const base = git("rev-parse", "HEAD");
  git("checkout", "-q", "-b", "gaffer/ticket-1-x");
  return { base };
}

function ticketOn(d: Dispatch, baseSha?: string): string {
  const repo = d.registerRepository(
    { name: "svc", default_branch: "main", local_path: dir },
    human,
  );
  const t = d.createTicket({ title: "x" }, human);
  d.setTicketRepoAccess(
    { ticket_id: t.id, repo_id: repo.id, access: "write", relation: "confirmed" },
    human,
  );
  d.recordRepoDelivery(
    {
      ticket_id: t.id,
      repo_id: repo.id,
      branch_name: "gaffer/ticket-1-x",
      ...(baseSha ? { base_sha: baseSha } : {}),
    },
    human,
  );
  return t.id;
}

const testModified = (d: Dispatch, id: string) =>
  d.ticketDiff(id).repos[0]!.riskAnnotations.find((a) => a.kind === "test-modified");

describe("the integrity scan diffs from the recorded base commit", () => {
  it("a base branch moved onto the delivery's commits cannot hide a committed test.skip", () => {
    const { base } = repoWithDelivery();
    writeFileSync(join(dir, "test/a.test.js"), 'test.skip("a", () => {});\n');
    git("commit", "-qam", "skip");
    git("branch", "-f", "main", "HEAD"); // the move the agent made from its worktree
    writeFileSync(join(dir, "a.js"), "export const a = 2;\n");
    git("commit", "-qam", "more");

    // Without a recorded base (a pre-v30 row), the merge-base is the moved main: hidden.
    const legacy = Dispatch.open(":memory:");
    expect(testModified(legacy, ticketOn(legacy))).toBeUndefined();
    legacy.db.close();

    const d = Dispatch.open(":memory:");
    const ann = testModified(d, ticketOn(d, base));
    expect(ann).toMatchObject({ kind: "test-modified", severity: "high" });
    expect((ann!.items ?? []).join(";")).toContain("test.skip in test/a.test.js");
    d.db.close();
  });

  it("a base branch that no longer contains the recorded commit is flagged incomplete", () => {
    const { base } = repoWithDelivery();
    writeFileSync(join(dir, "a.js"), "export const a = 2;\n");
    git("commit", "-qam", "clean change");
    // Rewrite main: drop the commit the delivery was cut from, replace it with another.
    git("checkout", "-q", "-B", "rewritten", "main~1");
    git("commit", "-qm", "rewritten", "--allow-empty");
    git("branch", "-f", "main", "HEAD");
    git("checkout", "-q", "gaffer/ticket-1-x");

    const d = Dispatch.open(":memory:");
    const ann = testModified(d, ticketOn(d, base));
    expect(ann?.severity).toBe("high");
    expect((ann!.items ?? []).join(";")).toMatch(
      /main no longer contains .*the base branch was rewritten/,
    );
    d.db.close();
  });

  it("a clean delivery from the recorded base carries no test-modified annotation", () => {
    const { base } = repoWithDelivery();
    writeFileSync(join(dir, "a.js"), "export const a = 2;\n");
    git("commit", "-qam", "clean change");
    const d = Dispatch.open(":memory:");
    expect(testModified(d, ticketOn(d, base))).toBeUndefined();
    d.db.close();
  });
});

describe("recording the base commit", () => {
  it("is refused for an agent, validated, and kept when a later record omits it", () => {
    const { base } = repoWithDelivery();
    const d = Dispatch.open(":memory:");
    const id = ticketOn(d, base);
    const repoId = d.listRepoDeliveries(id)[0]!.repo_id;
    let code = "";
    try {
      d.recordRepoDelivery({ ticket_id: id, repo_id: repoId, base_sha: "b".repeat(40) }, agent);
    } catch (e) {
      code = e instanceof DispatchError ? e.code : String(e);
    }
    expect(code).toBe("ACTOR_NOT_PERMITTED");
    expect(() =>
      d.recordRepoDelivery({ ticket_id: id, repo_id: repoId, base_sha: "main" }, human),
    ).toThrow();
    // The end-of-delivery record (branch + commit, no base) keeps the stored base.
    d.recordRepoDelivery(
      { ticket_id: id, repo_id: repoId, commit_sha: "c".repeat(40), status: "review_ready" },
      agent,
    );
    expect(d.listRepoDeliveries(id)[0]!.base_sha).toBe(base);
    d.db.close();
  });

  it("is write-once: a different base is refused unless the runner re-cut the branch", () => {
    const { base } = repoWithDelivery();
    const d = Dispatch.open(":memory:");
    const id = ticketOn(d, base);
    const repoId = d.listRepoDeliveries(id)[0]!.repo_id;
    const tip = "d".repeat(40); // e.g. an in-tick retry re-reading the branch tip
    let code = "";
    try {
      d.recordRepoDelivery({ ticket_id: id, repo_id: repoId, base_sha: tip }, human);
    } catch (e) {
      code = e instanceof DispatchError ? e.code : String(e);
    }
    expect(code).toBe("STATE_CONFLICT");
    expect(d.listRepoDeliveries(id)[0]!.base_sha).toBe(base);
    // The same base again is a no-op, not a conflict.
    d.recordRepoDelivery({ ticket_id: id, repo_id: repoId, base_sha: base }, human);
    expect(d.listRepoDeliveries(id)[0]!.base_sha).toBe(base);
    // An agent can never claim a re-cut.
    expect(() =>
      d.recordRepoDelivery(
        { ticket_id: id, repo_id: repoId, base_sha: tip, base_recut: true },
        agent,
      ),
    ).toThrow(/runner records it/);
    // The runner cut the branch again from the base: the new cut commit replaces it.
    d.recordRepoDelivery(
      { ticket_id: id, repo_id: repoId, base_sha: tip, base_recut: true },
      human,
    );
    expect(d.listRepoDeliveries(id)[0]!.base_sha).toBe(tip);
    d.db.close();
  });
});

describe("gate integrity: migration v29→v30", () => {
  it("adds ticket_repo_delivery.base_sha (NULL) to an existing table and preserves rows", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE ticket_repo_delivery (
        ticket_id TEXT NOT NULL, repo_id TEXT NOT NULL, branch_name TEXT, commit_sha TEXT,
        pr_url TEXT, status TEXT NOT NULL DEFAULT 'not_started', evidence_ref TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (ticket_id, repo_id)
      );
      INSERT INTO ticket_repo_delivery(ticket_id, repo_id, branch_name, created_at, updated_at)
        VALUES ('t1', 'r1', 'gaffer/x', 'now', 'now');
      INSERT INTO schema_meta(key,value) VALUES ('schema_version','29');
    `);
    // The rest of the schema is created by migrate(); the FK-less legacy table is enough
    // to exercise the ALTER.
    db.pragma("foreign_keys = OFF");
    migrate(db);
    const row = db
      .prepare("SELECT branch_name, base_sha FROM ticket_repo_delivery WHERE ticket_id = 't1'")
      .get() as { branch_name: string; base_sha: string | null };
    expect(row).toEqual({ branch_name: "gaffer/x", base_sha: null });
    const v = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as {
      value: string;
    };
    expect(Number(v.value)).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(30);
  });
});

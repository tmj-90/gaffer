import type { AddressInfo } from "node:net";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApiServer } from "../src/api/server.js";
import { Dispatch } from "../src/core.js";
import { migrate } from "../src/db/connection.js";
import { SCHEMA_VERSION } from "../src/db/schema.js";
import { listEvents } from "../src/events/eventWriter.js";
import type { Actor, Repository } from "../src/domain/types.js";
import { TestClock } from "../src/util/clock.js";
import { DispatchError } from "../src/util/errors.js";

const human: Actor = { type: "human", id: "tom" };

function fresh(): Dispatch {
  return Dispatch.open(":memory:", new TestClock());
}

function register(wg: Dispatch, name: string): Repository {
  return wg.registerRepository({ name }, human);
}

// --- Core: hide/unhide round-trip + default exclusion -----------------------

describe("WG-006: hide repo — core", () => {
  it("a newly registered repo is visible (hidden = 0)", () => {
    const wg = fresh();
    const repo = register(wg, "alpha");
    expect(repo.hidden).toBe(0);
    expect(wg.listRepositories().map((r) => r.name)).toContain("alpha");
  });

  it("hides and un-hides a repo by name, round-tripping the flag", () => {
    const wg = fresh();
    register(wg, "secret");

    const hidden = wg.setRepoHidden("secret", true, human);
    expect(hidden.hidden).toBe(1);

    const back = wg.setRepoHidden("secret", false, human);
    expect(back.hidden).toBe(0);
  });

  it("hides a repo by id too", () => {
    const wg = fresh();
    const repo = register(wg, "byid");
    const hidden = wg.setRepoHidden(repo.id, true, human);
    expect(hidden.id).toBe(repo.id);
    expect(hidden.hidden).toBe(1);
  });

  it("throws NOT_FOUND when the repo does not exist", () => {
    const wg = fresh();
    expect(() => wg.setRepoHidden("ghost", true, human)).toThrow(DispatchError);
    try {
      wg.setRepoHidden("ghost", true, human);
    } catch (err) {
      expect((err as DispatchError).code).toBe("NOT_FOUND");
    }
  });

  it("is idempotent: hiding an already-hidden repo is a no-op (no extra event)", () => {
    const wg = fresh();
    const repo = register(wg, "idem");
    wg.setRepoHidden(repo.id, true, human);
    const before = listEvents(wg.db, "repository", repo.id).length;
    wg.setRepoHidden(repo.id, true, human); // second hide — no change.
    const after = listEvents(wg.db, "repository", repo.id).length;
    expect(after).toBe(before);
  });

  it("excludes hidden repos from the repo list by default, includes with includeHidden", () => {
    const wg = fresh();
    register(wg, "visible");
    register(wg, "ghosted");
    wg.setRepoHidden("ghosted", true, human);

    const def = wg.listRepositories().map((r) => r.name);
    expect(def).toContain("visible");
    expect(def).not.toContain("ghosted");

    const all = wg.listRepositories(true).map((r) => r.name);
    expect(all).toEqual(expect.arrayContaining(["visible", "ghosted"]));
  });

  it("excludes hidden repos from the Factory Map unmapped list by default", () => {
    const wg = fresh();
    register(wg, "lonely"); // unmapped
    register(wg, "tucked"); // unmapped + hidden
    wg.setRepoHidden("tucked", true, human);

    const unmapped = wg.listUnmappedRepos().map((r) => r.name);
    expect(unmapped).toContain("lonely");
    expect(unmapped).not.toContain("tucked");

    const withHidden = wg.listUnmappedRepos(true).map((r) => r.name);
    expect(withHidden).toEqual(expect.arrayContaining(["lonely", "tucked"]));
  });

  it("lists only hidden repos via listHiddenRepos", () => {
    const wg = fresh();
    register(wg, "shown");
    register(wg, "stowed");
    wg.setRepoHidden("stowed", true, human);

    const hidden = wg.listHiddenRepos().map((r) => r.name);
    expect(hidden).toEqual(["stowed"]);
  });

  it("un-hiding returns the repo to the unmapped list", () => {
    const wg = fresh();
    register(wg, "comeback");
    wg.setRepoHidden("comeback", true, human);
    expect(wg.listUnmappedRepos().map((r) => r.name)).not.toContain("comeback");
    wg.setRepoHidden("comeback", false, human);
    expect(wg.listUnmappedRepos().map((r) => r.name)).toContain("comeback");
  });

  it("keeps a hidden repo registered and resolvable by name (non-destructive)", () => {
    const wg = fresh();
    const repo = register(wg, "stillhere");
    wg.setRepoHidden("stillhere", true, human);
    // Detail-style lookup (includeHidden) still finds it.
    expect(wg.listRepositories(true).find((r) => r.id === repo.id)).toBeTruthy();
    // Scope lookups by the hidden repo still work.
    expect(() => wg.scopesForRepo("stillhere")).not.toThrow();
  });
});

// --- Migration: additive v5 → v6 -------------------------------------------

describe("WG-006: additive migration (v5 → v6)", () => {
  it("adds the hidden column to a simulated v5 repositories table without data loss", () => {
    // A minimal v5-shaped repositories table: NO hidden column, schema_version 5,
    // and one pre-existing row.
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE repositories (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
        local_path TEXT, remote_url TEXT,
        default_branch TEXT NOT NULL DEFAULT 'main', stack TEXT,
        risk_level TEXT NOT NULL DEFAULT 'medium',
        test_command TEXT, lint_command TEXT, coverage_command TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
    db.prepare("INSERT INTO schema_meta(key,value) VALUES ('schema_version','5')").run();
    db.prepare(
      "INSERT INTO repositories (id, name, stack) VALUES ('legacy-repo', 'old-repo', 'ts')",
    ).run();

    migrate(db);

    // Pre-existing data preserved + column backfilled to 0 (visible).
    const row = db
      .prepare("SELECT name, stack, hidden FROM repositories WHERE id = 'legacy-repo'")
      .get() as {
      name: string;
      stack: string;
      hidden: number;
    };
    expect(row.name).toBe("old-repo");
    expect(row.stack).toBe("ts");
    expect(row.hidden).toBe(0);

    // Version stamped to the current schema version (migrate() applies all
    // additive migrations up to SCHEMA_VERSION, not just v5 -> v6).
    const ver = db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as {
      value: string;
    };
    expect(Number(ver.value)).toBe(SCHEMA_VERSION);

    // The new column is usable.
    db.prepare("UPDATE repositories SET hidden = 1 WHERE id = 'legacy-repo'").run();
    const updated = db.prepare("SELECT hidden FROM repositories WHERE id='legacy-repo'").get() as {
      hidden: number;
    };
    expect(updated.hidden).toBe(1);

    db.close();
  });

  it("re-running migrate() on an already-v6 DB is a no-op (idempotent)", () => {
    const db = new Database(":memory:");
    migrate(db);
    migrate(db); // must not throw or duplicate the column.
    const cols = (db.prepare("PRAGMA table_info(repositories)").all() as Array<{ name: string }>)
      .map((c) => c.name)
      .filter((n) => n === "hidden");
    expect(cols).toEqual(["hidden"]); // exactly one `hidden` column.
    db.close();
  });
});

// --- REST + CLI-equivalent surface -----------------------------------------

interface Harness {
  wg: Dispatch;
  baseUrl: string;
  close: () => Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const wg = Dispatch.open(":memory:", new TestClock());
  const server = createApiServer(wg);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    wg,
    baseUrl: `http://127.0.0.1:${port}`,
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

describe("WG-006: hide repo — REST surface", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("POST /repos/:id/hidden hides a repo; it drops out of the default lists", async () => {
    const repo = h.wg.registerRepository({ name: "demo-secret" }, human); // unmapped
    h.wg.registerRepository({ name: "demo-public" }, human);

    const before = await call(h.baseUrl, "GET", "/scope/unmapped-repos");
    expect((before.body.repositories as Repository[]).map((r) => r.name)).toContain("demo-secret");

    const hide = await call(h.baseUrl, "POST", `/repos/${repo.id}/hidden`, { hidden: true });
    expect(hide.status).toBe(200);
    expect((hide.body.repository as Repository).hidden).toBe(1);

    // Excluded from unmapped + the repo list by default.
    const unmapped = await call(h.baseUrl, "GET", "/scope/unmapped-repos");
    expect((unmapped.body.repositories as Repository[]).map((r) => r.name)).not.toContain(
      "demo-secret",
    );
    const repos = await call(h.baseUrl, "GET", "/repositories");
    expect((repos.body.repositories as Repository[]).map((r) => r.name)).not.toContain(
      "demo-secret",
    );
  });

  it("GET /repositories?hidden=only lists just the hidden repos (the Hidden page)", async () => {
    h.wg.registerRepository({ name: "v1" }, human);
    const hide = h.wg.registerRepository({ name: "h1" }, human);
    h.wg.setRepoHidden(hide.id, true, human);

    const only = await call(h.baseUrl, "GET", "/repositories?hidden=only");
    expect((only.body.repositories as Repository[]).map((r) => r.name)).toEqual(["h1"]);

    const all = await call(h.baseUrl, "GET", "/repositories?hidden=1");
    expect((all.body.repositories as Repository[]).map((r) => r.name)).toEqual(
      expect.arrayContaining(["v1", "h1"]),
    );
  });

  it("POST /repos/:id/hidden {hidden:false} un-hides — round-trips via REST", async () => {
    const repo = h.wg.registerRepository({ name: "round-trip" }, human);
    await call(h.baseUrl, "POST", `/repos/${repo.id}/hidden`, { hidden: true });
    const unhide = await call(h.baseUrl, "POST", `/repos/${repo.id}/hidden`, { hidden: false });
    expect(unhide.status).toBe(200);
    expect((unhide.body.repository as Repository).hidden).toBe(0);

    const repos = await call(h.baseUrl, "GET", "/repositories");
    expect((repos.body.repositories as Repository[]).map((r) => r.name)).toContain("round-trip");
  });

  it("rejects a missing repo with 404 and a bad body with 422", async () => {
    const missing = await call(h.baseUrl, "POST", "/repos/nope/hidden", { hidden: true });
    expect(missing.status).toBe(404);

    const repo = h.wg.registerRepository({ name: "validate" }, human);
    const bad = await call(h.baseUrl, "POST", `/repos/${repo.id}/hidden`, { hidden: "yes" });
    expect(bad.status).toBe(422);
  });
});

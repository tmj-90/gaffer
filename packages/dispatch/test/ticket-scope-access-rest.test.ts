import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApiServer } from "../src/api/server.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { migrate } from "../src/db/connection.js";
import { SCHEMA_VERSION } from "../src/db/schema.js";
import Database from "better-sqlite3";
import { TestClock } from "../src/util/clock.js";

const human: Actor = { type: "human", id: "tom" };

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

describe("WG-001/WG-002 REST surface", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("links + lists + makes primary + removes a ticket scope", async () => {
    const t = h.wg.createTicket({ title: "T", description: "d" }, human);
    const node = h.wg.createScopeNode({ name: "Prod", type: "product" }, human);

    const linked = await call(h.baseUrl, "POST", `/tickets/${t.id}/scopes`, {
      scope_node_id: node.id,
      relation: "secondary",
    });
    expect(linked.status).toBe(201);

    const list = await call(h.baseUrl, "GET", `/tickets/${t.id}/scopes`);
    expect((list.body.scopes as unknown[]).length).toBe(1);

    const primary = await call(h.baseUrl, "PUT", `/tickets/${t.id}/primary-scope`, {
      scope_node_id: node.id,
    });
    expect(primary.status).toBe(200);
    expect((primary.body.scope as { relation: string }).relation).toBe("primary");

    const del = await call(h.baseUrl, "DELETE", `/tickets/${t.id}/scopes/${node.id}`);
    expect(del.status).toBe(200);
    const after = await call(h.baseUrl, "GET", `/tickets/${t.id}/scopes`);
    expect((after.body.scopes as unknown[]).length).toBe(0);
  });

  it("sets repo access, reads the work-repo partition, and applies mono fallback", async () => {
    const t = h.wg.createTicket({ title: "T", description: "d" }, human);
    const repo = h.wg.registerRepository({ name: "solo" }, human);

    const set = await call(h.baseUrl, "PUT", `/tickets/${t.id}/repo-access`, {
      repo_id: repo.id,
      access: "read",
      relation: "context_only",
    });
    expect(set.status).toBe(200);

    const packet1 = await call(h.baseUrl, "GET", `/tickets/${t.id}/work-repos`);
    const wr1 = packet1.body.work_repos as { writeRepos: unknown[]; readOnlyRepos: unknown[] };
    expect(wr1.writeRepos).toHaveLength(0);
    expect(wr1.readOnlyRepos).toHaveLength(1);

    const fallback = await call(h.baseUrl, "POST", `/tickets/${t.id}/mono-fallback`);
    expect(fallback.status).toBe(200);
    expect((fallback.body as { applied: boolean }).applied).toBe(true);

    const packet2 = await call(h.baseUrl, "GET", `/tickets/${t.id}/work-repos`);
    const wr2 = packet2.body.work_repos as { writeRepos: Array<{ name: string }> };
    expect(wr2.writeRepos.map((r) => r.name)).toEqual(["solo"]);
  });

  it("rejects manually setting implicit_single_repo via repo-access (422)", async () => {
    const t = h.wg.createTicket({ title: "T", description: "d" }, human);
    const repo = h.wg.registerRepository({ name: "solo" }, human);
    const bad = await call(h.baseUrl, "PUT", `/tickets/${t.id}/repo-access`, {
      repo_id: repo.id,
      access: "write",
      relation: "implicit_single_repo",
    });
    expect(bad.status).toBe(422);
  });
});

describe("WG-002 schema migration: v2 -> v3 ticket_repos", () => {
  it("adds the access columns to an existing ticket_repos and backfills defaults", () => {
    // Build a v2-shaped DB by hand: ticket_repos WITHOUT the WG-002 columns, a
    // ticket + repo + a legacy link row, stamped at schema_version 2.
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE tickets (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'draft',
        priority INTEGER NOT NULL DEFAULT 0,
        risk_level TEXT NOT NULL DEFAULT 'medium',
        policy_pack TEXT NOT NULL DEFAULT 'solo_loose',
        created_at TEXT NOT NULL DEFAULT '2020-01-01T00:00:00Z'
      );
      CREATE TABLE repositories (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE);
      CREATE TABLE ticket_repos (
        ticket_id TEXT NOT NULL,
        repo_id   TEXT NOT NULL,
        role      TEXT NOT NULL DEFAULT 'primary',
        branch_name TEXT,
        pr_url    TEXT,
        status    TEXT NOT NULL DEFAULT 'not_started',
        created_at TEXT NOT NULL DEFAULT '2020-01-01T00:00:00Z',
        updated_at TEXT NOT NULL DEFAULT '2020-01-01T00:00:00Z',
        PRIMARY KEY (ticket_id, repo_id)
      );
      INSERT INTO tickets (id) VALUES ('t1');
      INSERT INTO repositories (id, name) VALUES ('r1', 'legacy');
      INSERT INTO ticket_repos (ticket_id, repo_id, role) VALUES ('t1', 'r1', 'primary');
      INSERT INTO schema_meta (key, value) VALUES ('schema_version', '2');
    `);

    // Run the migration (idempotent ALTER + full schema apply).
    migrate(db);

    const stamped = db
      .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
      .get() as { value: string };
    expect(Number(stamped.value)).toBe(SCHEMA_VERSION);

    const row = db
      .prepare("SELECT access, relation, source FROM ticket_repos WHERE ticket_id = 't1'")
      .get() as { access: string; relation: string; source: string };
    expect(row.access).toBe("write");
    expect(row.relation).toBe("confirmed");
    expect(row.source).toBe("manual");

    // Idempotent: a second migrate() does not error or duplicate columns.
    expect(() => migrate(db)).not.toThrow();
    db.close();
  });
});

/**
 * MCP server — repo understanding tools (digest + feature ledger).
 * Drives the REAL server via an in-memory transport + MCP Client so each
 * tool runs its actual zod schema, audit call, and response shaping.
 *
 * Pins:
 *   - update_repo_digest → get_repo_digest round-trip (incl. freshness +
 *     honesty caveat)
 *   - add_feature with and WITHOUT scope_node (repo-level vs node-level)
 *   - list_features filtered by scope_node and by status
 *   - advance_feature legal vs illegal transitions
 *   - structuredContent deep-equals the parsed text body
 */
import BetterSqlite3 from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildMcpServer } from "../src/mcp/server.js";
import { runMigrations } from "../src/db/migrations.js";
import type { Database } from "better-sqlite3";

const savedAuditOff = { v: undefined as string | undefined };

let db: Database;
let client: Client;

function newDb(): Database {
  const d = new BetterSqlite3(":memory:");
  d.pragma("foreign_keys = ON");
  runMigrations(d);
  return d;
}

async function connectClient(database: Database): Promise<Client> {
  const server = buildMcpServer(database);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverT), c.connect(clientT)]);
  return c;
}

async function callJson(
  c: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{
  isError: boolean;
  json: any;
  text: string;
  structuredContent: unknown;
}> {
  const res = (await c.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
    structuredContent?: unknown;
  };
  const text = res.content.map((b) => b.text).join("");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return {
    isError: res.isError === true,
    json,
    text,
    structuredContent: res.structuredContent,
  };
}

beforeEach(() => {
  savedAuditOff.v = process.env["MEMORY_AUDIT_OFF"];
  process.env["MEMORY_AUDIT_OFF"] = "1";
  db = newDb();
});

afterEach(async () => {
  if (savedAuditOff.v === undefined) delete process.env["MEMORY_AUDIT_OFF"];
  else process.env["MEMORY_AUDIT_OFF"] = savedAuditOff.v;
  try {
    await client?.close();
  } catch {
    /* already closed */
  }
});

describe("MCP — update_repo_digest / get_repo_digest", () => {
  it("writes then reads a digest back with freshness + caveat", async () => {
    client = await connectClient(db);
    const write = await callJson(client, "update_repo_digest", {
      repo: "payments-svc",
      overview: "Captures payments.",
      structure: "src/api, src/core.",
      conventions: "TS strict; zod at boundaries.",
      stack: "TypeScript, Fastify",
      source: "merge:#42",
    });
    expect(write.isError).toBe(false);
    expect(write.json.source).toBe("merge:#42");
    expect(write.json.message).toMatch(/applied directly/);

    const read = await callJson(client, "get_repo_digest", {
      repo: "payments-svc",
    });
    expect(read.json.overview).toBe("Captures payments.");
    expect(read.json.conventions).toContain("zod at boundaries");
    expect(read.json.source).toBe("merge:#42");
    expect(read.json.updated_at).toBeTruthy();
    expect(read.json.caveat).toMatch(/verify it against the actual code/);
  });

  it("get_repo_digest returns null for an unknown repo", async () => {
    client = await connectClient(db);
    const read = await callJson(client, "get_repo_digest", { repo: "ghost" });
    expect(read.isError).toBe(false);
    expect(read.json.digest).toBeNull();
    expect(read.json.message).toMatch(/No digest/);
  });

  it("emits structuredContent that deep-equals the parsed text body", async () => {
    client = await connectClient(db);
    await callJson(client, "update_repo_digest", {
      repo: "r",
      overview: "o",
      structure: "s",
      conventions: "c",
      stack: "st",
      source: "onboard",
    });
    const { json, structuredContent } = await callJson(client, "get_repo_digest", { repo: "r" });
    expect(structuredContent).toBeDefined();
    expect(structuredContent).toEqual(json);
  });
});

describe("MCP — add_feature (repo-level and node-level)", () => {
  it("adds a repo-level feature (no scope_node), defaults to backlog", async () => {
    client = await connectClient(db);
    const { json, isError } = await callJson(client, "add_feature", {
      repo: "app",
      name: "Refund flow",
      summary: "Issue refunds.",
    });
    expect(isError).toBe(false);
    expect(json.id).toMatch(/^[a-z2-9]{8}$/);
    expect(json.status).toBe("backlog");
    expect(json.scope_node).toBeUndefined();
  });

  it("adds a node-level feature carrying scope_node", async () => {
    client = await connectClient(db);
    const { json } = await callJson(client, "add_feature", {
      repo: "app",
      scope_node: "auth",
      name: "MFA challenge",
      summary: "Step-up auth.",
    });
    expect(json.scope_node).toBe("auth");
  });

  it("structuredContent deep-equals the parsed text body", async () => {
    client = await connectClient(db);
    const { json, structuredContent } = await callJson(client, "add_feature", {
      repo: "app",
      name: "X",
      summary: "y",
    });
    expect(structuredContent).toEqual(json);
  });

  it("accepts a name exactly 200 chars long (boundary)", async () => {
    client = await connectClient(db);
    const name = "a".repeat(200);
    const { isError, json } = await callJson(client, "add_feature", {
      repo: "app",
      name,
      summary: "s",
    });
    expect(isError).toBe(false);
    expect(json.id).toMatch(/^[a-z2-9]{8}$/);
  });

  it("rejects a name over 200 chars with a validation error", async () => {
    client = await connectClient(db);
    const { isError } = await callJson(client, "add_feature", {
      repo: "app",
      name: "a".repeat(201),
      summary: "s",
    });
    expect(isError).toBe(true);
  });
});

describe("MCP — list_features (scope_node + status filters)", () => {
  beforeEach(async () => {
    client = await connectClient(db);
    await callJson(client, "add_feature", {
      repo: "app",
      name: "Repo backlog",
      summary: "s",
    });
    await callJson(client, "add_feature", {
      repo: "app",
      scope_node: "auth",
      name: "Auth backlog",
      summary: "s",
    });
    await callJson(client, "add_feature", {
      repo: "app",
      scope_node: "auth",
      name: "Auth shipped",
      summary: "s",
      status: "shipped",
    });
  });

  it("lists every feature in the repo when unfiltered", async () => {
    const { json } = await callJson(client, "list_features", { repo: "app" });
    expect(json.count).toBe(3);
  });

  it("filters by scope_node", async () => {
    const { json } = await callJson(client, "list_features", {
      repo: "app",
      scope_node: "auth",
    });
    expect(json.count).toBe(2);
    expect(json.features.every((f: { scope_node?: string }) => f.scope_node === "auth")).toBe(true);
  });

  it("filters by status", async () => {
    const { json } = await callJson(client, "list_features", {
      repo: "app",
      status: "shipped",
    });
    expect(json.count).toBe(1);
    expect(json.features[0].name).toBe("Auth shipped");
  });
});

describe("MCP — advance_feature (legal vs illegal)", () => {
  it("advances backlog → building → shipped", async () => {
    client = await connectClient(db);
    const add = await callJson(client, "add_feature", {
      repo: "app",
      name: "X",
      summary: "y",
    });
    const id = add.json.id;
    const building = await callJson(client, "advance_feature", {
      id,
      to_status: "building",
    });
    expect(building.json.status).toBe("building");
    const shipped = await callJson(client, "advance_feature", {
      id,
      to_status: "shipped",
    });
    expect(shipped.json.status).toBe("shipped");
  });

  it("rejects an illegal shipped → backlog move", async () => {
    client = await connectClient(db);
    const add = await callJson(client, "add_feature", {
      repo: "app",
      name: "X",
      summary: "y",
      status: "shipped",
    });
    const res = await callJson(client, "advance_feature", {
      id: add.json.id,
      to_status: "backlog",
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/not a legal transition/);
  });

  it("errors on an unknown feature id", async () => {
    client = await connectClient(db);
    const res = await callJson(client, "advance_feature", {
      id: "missing00",
      to_status: "shipped",
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/no feature with id/);
  });
});

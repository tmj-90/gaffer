/**
 * MCP server — end-to-end integration. Drives the REAL server (built by
 * `buildMcpServer` against a temp in-memory DB) through an in-memory
 * transport and a real MCP `Client`, so every tool handler runs with its
 * actual zod schema, env gates, redaction, audit calls, and response
 * shaping — not just the pure helpers exercised in mcp-redaction.test.ts.
 *
 * This is the layer the agent actually talks to; it had no direct
 * coverage before. Each test gets a fresh server+DB; the audit log is
 * silenced (MEMORY_AUDIT_OFF) and env gates are reset per-test.
 */
import BetterSqlite3 from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { addBoundary } from "../src/core/boundaries.js";
import { addLore } from "../src/core/lore.js";
import { recordAbsence } from "../src/core/absence.js";
import { buildMcpServer } from "../src/mcp/server.js";
import { runMigrations } from "../src/db/migrations.js";
import type { Database } from "better-sqlite3";

const ENV_KEYS = ["MEMORY_ALLOW_RESTRICTED_MCP", "MEMORY_ALLOW_MCP_ABSENCE", "MEMORY_AUDIT_OFF"];
const savedEnv: Record<string, string | undefined> = {};

let db: Database;
let client: Client;

function newDb(): Database {
  const d = new BetterSqlite3(":memory:");
  d.pragma("foreign_keys = ON");
  runMigrations(d);
  return d;
}

/** Spin up the real server over a linked in-memory transport pair. */
async function connectClient(database: Database): Promise<Client> {
  const server = buildMcpServer(database);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverT), c.connect(clientT)]);
  return c;
}

/** Call a tool and parse its single text-content block as JSON. */
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
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  // Silence the audit log so tests don't write ~/.memory/audit.jsonl.
  process.env["MEMORY_AUDIT_OFF"] = "1";
  delete process.env["MEMORY_ALLOW_RESTRICTED_MCP"];
  delete process.env["MEMORY_ALLOW_MCP_ABSENCE"];
  db = newDb();
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  try {
    await client?.close();
  } catch {
    /* already closed */
  }
});

describe("MCP — tool registration", () => {
  it("exposes exactly the memory tools", async () => {
    client = await connectClient(db);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "add_feature",
        "advance_feature",
        "declare_boundary",
        "find_dependents",
        "get_lore",
        "get_repo_digest",
        "list_features",
        "record_absence",
        "report_conflict",
        "search_lore",
        "suggest_lore",
        "update_repo_digest",
      ].sort(),
    );
  });

  it("every tool has a title and a non-trivial description", async () => {
    client = await connectClient(db);
    const { tools } = await client.listTools();
    for (const t of tools) {
      expect(t.description && t.description.length).toBeGreaterThan(40);
    }
  });
});

describe("MCP — search_lore", () => {
  beforeEach(() => {
    addLore(db, {
      title: "Argon2id is the password hash default",
      summary: "Platform ruling.",
      body: "m=64MB t=3 p=4",
      repos: ["payments-svc"],
      tags: ["security"],
      source: "https://example.com/adr/1",
      confidence: "high",
    });
  });

  it("returns active hits as brief summaries (no body)", async () => {
    client = await connectClient(db);
    const { json } = await callJson(client, "search_lore", { query: "argon2id" });
    expect(json.results).toHaveLength(1);
    expect(json.results[0].title).toContain("Argon2id");
    expect(json.results[0].body).toBeUndefined();
  });

  it("emits structuredContent that deep-equals the parsed text body", async () => {
    client = await connectClient(db);
    const { json, structuredContent } = await callJson(client, "search_lore", {
      query: "argon2id",
    });
    expect(structuredContent).toBeDefined();
    expect(structuredContent).toEqual(json);
  });

  it("strips the CLI-only possibleConflicts heuristic from MCP results", async () => {
    addLore(db, {
      title: "Argon2id rotation policy",
      summary: "s",
      body: "b",
      repos: ["payments-svc"],
      tags: ["security"],
    });
    client = await connectClient(db);
    const { json } = await callJson(client, "search_lore", { query: "argon2id" });
    for (const r of json.results) {
      expect(r.possibleConflicts).toBeUndefined();
    }
  });

  it("zero hits + query → a `next` coach, no results", async () => {
    client = await connectClient(db);
    const { json } = await callJson(client, "search_lore", {
      query: "nonexistent topic xyz",
    });
    expect(json.results).toEqual([]);
    expect(typeof json.next).toBe("string");
    expect(json.next).toContain("record_absence");
  });

  it("surfaces an absence_marker on a zero-hit query that matches one", async () => {
    recordAbsence(db, {
      query: "kafka exactly-once",
      reason: "no team policy yet",
      recordedBy: "human",
    });
    client = await connectClient(db);
    const { json } = await callJson(client, "search_lore", {
      query: "kafka exactly-once",
    });
    expect(json.results).toEqual([]);
    expect(json.absence_marker.reason).toBe("no team policy yet");
    expect(json.next).toBeUndefined(); // marker wins over coach
  });

  it("reports truncation when more match than the limit", async () => {
    for (let i = 0; i < 8; i++) {
      addLore(db, { title: `widget tracker ${i}`, summary: "s", body: "b" });
    }
    client = await connectClient(db);
    const { json } = await callJson(client, "search_lore", {
      query: "widget tracker",
      limit: 3,
    });
    expect(json.results).toHaveLength(3);
    expect(json.truncated.shown).toBe(3);
    expect(json.truncated.total).toBe(8);
  });

  it("excludes restricted records unless the env gate is set", async () => {
    addLore(db, {
      title: "Restricted argon secret",
      summary: "s",
      body: "b",
      restricted: true,
      tags: ["security"],
    });
    // Gate OFF: includeRestricted is ignored.
    client = await connectClient(db);
    const off = await callJson(client, "search_lore", {
      query: "restricted argon",
      includeRestricted: true,
    });
    expect(off.json.results.every((r: any) => r.restricted === false)).toBe(true);
    await client.close();

    // Gate ON: restricted record surfaces.
    process.env["MEMORY_ALLOW_RESTRICTED_MCP"] = "1";
    client = await connectClient(db);
    const on = await callJson(client, "search_lore", {
      query: "restricted argon",
      includeRestricted: true,
    });
    expect(on.json.results.some((r: any) => r.restricted === true)).toBe(true);
  });

  it("rejects an out-of-range limit at the schema boundary", async () => {
    client = await connectClient(db);
    const { isError, text } = await callJson(client, "search_lore", {
      query: "x",
      limit: 999,
    });
    expect(isError).toBe(true);
    expect(text).toContain("validation");
  });
});

describe("MCP — get_lore + restricted gate", () => {
  it("returns the full body for a non-restricted record", async () => {
    const lore = addLore(db, {
      title: "Visible",
      summary: "s",
      body: "the full body text",
    });
    client = await connectClient(db);
    const { json } = await callJson(client, "get_lore", { id: lore.id });
    expect(json.body).toBe("the full body text");
  });

  it("redacts a restricted record when the gate is off (id only, no body)", async () => {
    const lore = addLore(db, {
      title: "Secret",
      summary: "s",
      body: "do not leak",
      restricted: true,
    });
    client = await connectClient(db);
    const { json } = await callJson(client, "get_lore", { id: lore.id });
    expect(json.error).toBe("restricted");
    expect(json.id).toBe(lore.id);
    expect(json.body).toBeUndefined();
    expect(json.title).toBeUndefined();
    expect(JSON.stringify(json)).not.toContain("do not leak");
  });

  it("returns the body of a restricted record when the gate is on", async () => {
    const lore = addLore(db, {
      title: "Secret",
      summary: "s",
      body: "now visible",
      restricted: true,
    });
    process.env["MEMORY_ALLOW_RESTRICTED_MCP"] = "1";
    client = await connectClient(db);
    const { json } = await callJson(client, "get_lore", { id: lore.id });
    expect(json.body).toBe("now visible");
  });

  it("returns null for an unknown id", async () => {
    client = await connectClient(db);
    const { text } = await callJson(client, "get_lore", { id: "zzzzzzzz" });
    expect(text).toBe("null");
  });
});

describe("MCP — suggest_lore", () => {
  it("creates a draft hidden from default search until approved", async () => {
    client = await connectClient(db);
    const { json } = await callJson(client, "suggest_lore", {
      title: "New convention",
      summary: "s",
      body: "b",
    });
    expect(json.status).toBe("draft");
    expect(json.id).toMatch(/^[a-z2-9]{8}$/);
    // Not in default search.
    const search = await callJson(client, "search_lore", { query: "New convention" });
    expect(search.json.results).toEqual([]);
  });

  it("emits structuredContent that deep-equals the parsed text body", async () => {
    client = await connectClient(db);
    const { json, structuredContent } = await callJson(client, "suggest_lore", {
      title: "New convention",
      summary: "s",
      body: "b",
    });
    expect(structuredContent).toBeDefined();
    expect(structuredContent).toEqual(json);
  });

  it("clamps a draft's confidence below high even when asked", async () => {
    client = await connectClient(db);
    const { json } = await callJson(client, "suggest_lore", {
      title: "Bold claim",
      summary: "s",
      body: "b",
      source: "https://example.com/x",
      confidence: "high",
    });
    // Re-fetch via get_lore to read the stored confidence.
    const got = await callJson(client, "get_lore", { id: json.id });
    expect(got.json.confidence).toBe("medium");
  });

  it("returns a structured error (not isError) when the title is over cap", async () => {
    client = await connectClient(db);
    const { json, isError } = await callJson(client, "suggest_lore", {
      title: "x".repeat(250),
      summary: "s",
      body: "b",
    });
    expect(isError).toBe(false);
    expect(json.error).toBe("title_too_long");
    expect(typeof json.suggested_cut).toBe("string");
  });

  it("surfaces possibleDuplicates for a near-duplicate title", async () => {
    addLore(db, {
      title: "Password hashing uses Argon2id",
      summary: "s",
      body: "b",
      tags: ["security"],
    });
    client = await connectClient(db);
    const { json } = await callJson(client, "suggest_lore", {
      title: "Password hashing Argon2id rules",
      summary: "s",
      body: "b",
      tags: ["security"],
    });
    expect(Array.isArray(json.possibleDuplicates)).toBe(true);
    expect(json.possibleDuplicates.length).toBeGreaterThan(0);
  });
});

describe("MCP — report_conflict", () => {
  it("creates a draft counter-record linked to the challenged active record", async () => {
    const existing = addLore(db, {
      title: "All timestamps are UTC",
      summary: "s",
      body: "b",
    });
    client = await connectClient(db);
    const { json } = await callJson(client, "report_conflict", {
      existingId: existing.id,
      observation: "found a callsite storing local time in orders.ts",
    });
    expect(json.status).toBe("draft");
    expect(json.conflictsWith).toEqual([existing.id]);
  });

  it("refuses to challenge a restricted record (even with the gate on)", async () => {
    const secret = addLore(db, {
      title: "Restricted rule",
      summary: "s",
      body: "b",
      restricted: true,
    });
    process.env["MEMORY_ALLOW_RESTRICTED_MCP"] = "1";
    client = await connectClient(db);
    const { isError, json } = await callJson(client, "report_conflict", {
      existingId: secret.id,
      observation: "this contradicts the code",
    });
    expect(isError).toBe(true);
    expect(json.error).toBe("restricted");
  });

  it("errors with a typed reason for an unknown existingId", async () => {
    client = await connectClient(db);
    const { isError, text } = await callJson(client, "report_conflict", {
      existingId: "zzzzzzzz",
      observation: "x",
    });
    expect(isError).toBe(true);
    expect(text).toContain("unknown_existing_id");
  });
});

describe("MCP — record_absence (env gated)", () => {
  it("is refused by default (gate off)", async () => {
    client = await connectClient(db);
    const { isError, json } = await callJson(client, "record_absence", {
      query: "kafka exactly-once",
      reason: "no policy",
    });
    expect(isError).toBe(true);
    expect(json.error).toBe("mcp_record_absence_disabled");
  });

  it("records a marker when the gate is on, surfaced on the next zero-hit search", async () => {
    process.env["MEMORY_ALLOW_MCP_ABSENCE"] = "1";
    client = await connectClient(db);
    const rec = await callJson(client, "record_absence", {
      query: "kafka exactly-once",
      reason: "no team policy yet",
    });
    expect(rec.json.id).toMatch(/^[a-z2-9]{8}$/);
    const search = await callJson(client, "search_lore", {
      query: "kafka exactly-once",
    });
    expect(search.json.absence_marker.reason).toBe("no team policy yet");
  });
});

describe("MCP — find_dependents + declare_boundary", () => {
  it("find_dependents splits providers from consumers across spellings", async () => {
    addBoundary(db, { repo: "orders-svc", contract: "OrderSubmitted", role: "provides" });
    addBoundary(db, { repo: "reporting-svc", contract: "order-submitted", role: "consumes" });
    client = await connectClient(db);
    const { json } = await callJson(client, "find_dependents", {
      contract: "order_submitted",
    });
    expect(json.contract).toBe("order-submitted");
    expect(json.providers.map((b: any) => b.repo)).toEqual(["orders-svc"]);
    expect(json.consumers.map((b: any) => b.repo)).toEqual(["reporting-svc"]);
  });

  it("find_dependents on an unknown contract returns empty + a not-proof-of-safety nudge", async () => {
    client = await connectClient(db);
    const { json } = await callJson(client, "find_dependents", { contract: "nope" });
    expect(json.providers).toEqual([]);
    expect(json.consumers).toEqual([]);
    expect(json.next).toContain("NOT proof");
  });

  it("declare_boundary lands a draft, invisible to find_dependents until approved", async () => {
    client = await connectClient(db);
    const { json } = await callJson(client, "declare_boundary", {
      repo: "billing-svc",
      contract: "order-submitted",
      role: "consumes",
      kind: "event",
    });
    expect(json.status).toBe("draft");
    // Draft is not in the default (active-only) map.
    const dep = await callJson(client, "find_dependents", {
      contract: "order-submitted",
    });
    expect(dep.json.consumers).toEqual([]);
  });

  it("declare_boundary cannot mutate a human-ratified active edge (trust gate)", async () => {
    // A human ratifies an edge directly in the DB the server is using.
    addBoundary(db, {
      repo: "orders-svc",
      contract: "order-submitted",
      role: "provides",
      kind: "event",
      detail: "human detail",
      source: "https://example.com/legit",
    });
    client = await connectClient(db);
    // Agent re-declares the SAME (repo, contract, role) with hostile content.
    await callJson(client, "declare_boundary", {
      repo: "orders-svc",
      contract: "OrderSubmitted", // same normalised contract
      role: "provides",
      detail: "agent-injected",
      source: "https://attacker.example/evil",
    });
    // find_dependents must still serve the human's original source/detail.
    const dep = await callJson(client, "find_dependents", {
      contract: "order-submitted",
    });
    const provider = dep.json.providers[0];
    expect(provider.source).toBe("https://example.com/legit");
    expect(provider.detail).toBe("human detail");
    expect(JSON.stringify(dep.json)).not.toContain("attacker.example");
  });

  it("declare_boundary rejects a bad role at the schema boundary", async () => {
    client = await connectClient(db);
    const { isError, text } = await callJson(client, "declare_boundary", {
      repo: "r",
      contract: "c",
      role: "uses",
    });
    expect(isError).toBe(true);
    expect(text).toContain("validation");
  });
});

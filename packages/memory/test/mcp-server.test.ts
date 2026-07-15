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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createHash } from "node:crypto";

import { addBoundary } from "../src/core/boundaries.js";
import { addLore } from "../src/core/lore.js";
import { recordAbsence } from "../src/core/absence.js";
import { upsertFileCard } from "../src/core/fileCards.js";
import { buildMcpServer } from "../src/mcp/server.js";
import { runMigrations } from "../src/db/migrations.js";
import type { Database } from "better-sqlite3";

const ENV_KEYS = [
  "MEMORY_ALLOW_RESTRICTED_MCP",
  "MEMORY_ALLOW_MCP_ABSENCE",
  "MEMORY_AUTO_APPROVE",
  "MEMORY_AUDIT_OFF",
  "MEMORY_AUDIT_LOG",
];
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

/**
 * Redirect the audit log to a fresh temp file and turn auditing ON for
 * the current test, returning a reader for the parsed JSONL rows. Used by
 * the restricted-gate tests that must prove the audit row reflects the
 * gate decision (E-1: the audit trail is part of the trust boundary, not
 * just the response body). The temp dir is cleaned up in afterEach.
 */
function captureAudit(): { rows: () => Array<Record<string, unknown>> } {
  const dir = mkdtempSync(join(tmpdir(), "memory-audit-"));
  const path = join(dir, "audit.jsonl");
  // Pre-create so reads never hit ENOENT even if no row is written, and so
  // the audit module's lazy ensureFile is a no-op against this path.
  writeFileSync(path, "");
  auditDirs.push(dir);
  delete process.env["MEMORY_AUDIT_OFF"];
  process.env["MEMORY_AUDIT_LOG"] = path;
  return {
    rows: () =>
      readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

const auditDirs: string[] = [];

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  // Silence the audit log so tests don't write ~/.memory/audit.jsonl.
  // (captureAudit re-enables + redirects it for the tests that assert rows.)
  process.env["MEMORY_AUDIT_OFF"] = "1";
  delete process.env["MEMORY_AUDIT_LOG"];
  delete process.env["MEMORY_ALLOW_RESTRICTED_MCP"];
  delete process.env["MEMORY_ALLOW_MCP_ABSENCE"];
  delete process.env["MEMORY_AUTO_APPROVE"];
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
  while (auditDirs.length > 0) {
    const dir = auditDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
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
        "cards_for_scope",
        "declare_boundary",
        "find_dependents",
        "get_file_card",
        "get_lore",
        "get_repo_digest",
        "list_features",
        "record_absence",
        "report_conflict",
        "search_file_cards",
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
    // The agent-authored reason is quarantined at serve time (envelope + notice).
    expect(json.absence_marker.reason).toBe(
      "<untrusted-absence>no team policy yet</untrusted-absence>",
    );
    expect(json.security).toContain("<untrusted-*>");
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

  it("audits a restricted hit's id when the gate surfaces it (on-path trail)", async () => {
    const audit = captureAudit();
    const secret = addLore(db, {
      title: "Restricted argon secret",
      summary: "s",
      body: "b",
      restricted: true,
      tags: ["security"],
    });
    process.env["MEMORY_ALLOW_RESTRICTED_MCP"] = "1";
    client = await connectClient(db);
    const { json } = await callJson(client, "search_lore", {
      query: "restricted argon",
      includeRestricted: true,
    });
    expect(json.results.some((r: any) => r.id === secret.id)).toBe(true);

    // E-1: with the gate ON the restricted record is genuinely served, so
    // the search_lore audit row records its id. With the gate OFF the
    // server forces includeRestricted=false and this id never appears —
    // inverting server.ts's `=== "1"` flips which branch runs and fails
    // both the response and this audit assertion.
    const row = audit.rows().find((r) => r["tool"] === "search_lore");
    expect(row?.["resultIds"]).toContain(secret.id);
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
    // Agent-derived lore text is served inside the quarantine envelope.
    expect(json.body).toBe("<untrusted-lore>the full body text</untrusted-lore>");
  });

  it("redacts a restricted record when the gate is off, and audits blocked:restricted", async () => {
    const audit = captureAudit();
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

    // E-1: the gate decision must also land in the audit trail. With the
    // env flag OFF the get_lore row is marked blocked:"restricted" (the id
    // resolved, but the body was withheld). Inverting server.ts's
    // `=== "1"` would return the body AND drop this blocked marker.
    const row = audit.rows().find((r) => r["tool"] === "get_lore");
    expect(row?.["blocked"]).toBe("restricted");
    expect(row?.["resultIds"]).toEqual([lore.id]);
  });

  it("returns the body of a restricted record when the gate is on, with no blocked audit", async () => {
    const audit = captureAudit();
    const lore = addLore(db, {
      title: "Secret",
      summary: "s",
      body: "now visible",
      restricted: true,
    });
    process.env["MEMORY_ALLOW_RESTRICTED_MCP"] = "1";
    client = await connectClient(db);
    const { json } = await callJson(client, "get_lore", { id: lore.id });
    expect(json.body).toBe("<untrusted-lore>now visible</untrusted-lore>");

    // E-1 mutation sanity (the ON direction): the audited get_lore call is
    // an ordinary, NON-blocked access. If the gate check were inverted, the
    // body assertion above would fail; this also pins that the granted
    // access is NOT recorded as blocked.
    const row = audit.rows().find((r) => r["tool"] === "get_lore");
    expect(row).toBeDefined();
    expect(row?.["blocked"]).toBeUndefined();
    expect(row?.["resultIds"]).toEqual([lore.id]);
  });

  it("returns a structured {found:false} sentinel with isError for an unknown id", async () => {
    client = await connectClient(db);
    const { isError, json } = await callJson(client, "get_lore", { id: "zzzzzzzz" });
    expect(isError).toBe(true);
    expect(json.found).toBe(false);
    expect(json.id).toBe("zzzzzzzz");
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

/**
 * E-1: the MEMORY_AUTO_APPROVE autonomy flag, exercised end-to-end through
 * the MCP suggest_lore handler (server.ts reads
 * `process.env["MEMORY_AUTO_APPROVE"] === "1"` and passes `autoApprove` to
 * suggestLore). The unit gate (suggestLore({ autoApprove })) is covered in
 * lore.test.ts; what was untested is the handler-level env wiring itself.
 *
 * Both directions are asserted so a one-char mutation of the env check
 * (`=== "1"` → `!== "1"`, or dropping the flag) fails the suite:
 *   - OFF (default): the suggestion lands `draft` and is invisible to the
 *     default active-only search until a human approves it.
 *   - ON: the suggestion lands `active` immediately and is searchable with
 *     no approval step — the operator-trust path.
 */
describe("MCP — suggest_lore + MEMORY_AUTO_APPROVE (env gated)", () => {
  it("keeps a suggestion in draft (hidden from default search) when the flag is off", async () => {
    // Gate explicitly off (beforeEach already deletes it; assert the
    // default behaviour is the safe one).
    client = await connectClient(db);
    const { json } = await callJson(client, "suggest_lore", {
      title: "Auto approve default convention",
      summary: "s",
      body: "b",
    });
    expect(json.status).toBe("draft");

    // Draft is NOT in the default (active-only) search. If the env check
    // were inverted, this record would be `active` and would show up here.
    const search = await callJson(client, "search_lore", {
      query: "auto approve default convention",
    });
    expect(search.json.results).toEqual([]);

    // It only becomes visible once includeDrafts is requested — proving it
    // really is parked in the governed draft state, not just missing.
    const drafts = await callJson(client, "search_lore", {
      query: "auto approve default convention",
      includeDrafts: true,
    });
    expect(drafts.json.results.some((r: any) => r.id === json.id)).toBe(true);
  });

  it("lands a suggestion active and immediately searchable when the flag is on", async () => {
    process.env["MEMORY_AUTO_APPROVE"] = "1";
    client = await connectClient(db);
    const { json } = await callJson(client, "suggest_lore", {
      title: "Auto approve enabled convention",
      summary: "s",
      body: "b",
    });
    // Handler-level proof: the env flag short-circuits the human-approval
    // step, so the record is born `active`. With the flag off (above) the
    // identical call yields `draft` — the two assertions bracket the gate.
    expect(json.status).toBe("active");

    // Active records ARE in the default search with no approval step.
    const search = await callJson(client, "search_lore", {
      query: "auto approve enabled convention",
    });
    expect(search.json.results.some((r: any) => r.id === json.id)).toBe(true);
  });

  it("treats any non-1 flag value as off (draft) — only an exact 1 auto-approves", async () => {
    // The gate is a strict `=== "1"`; a truthy-but-not-"1" value must NOT
    // auto-approve. This pins the comparison shape, not just truthiness.
    process.env["MEMORY_AUTO_APPROVE"] = "true";
    client = await connectClient(db);
    const { json } = await callJson(client, "suggest_lore", {
      title: "Truthy but not one",
      summary: "s",
      body: "b",
    });
    expect(json.status).toBe("draft");
  });

  it("audits the auto-approved suggestion's id through the handler", async () => {
    const audit = captureAudit();
    process.env["MEMORY_AUTO_APPROVE"] = "1";
    client = await connectClient(db);
    const { json } = await callJson(client, "suggest_lore", {
      title: "Audited auto approve",
      summary: "s",
      body: "b",
    });
    expect(json.status).toBe("active");
    const row = audit.rows().find((r) => r["tool"] === "suggest_lore");
    expect(row?.["resultIds"]).toEqual([json.id]);
  });

  it("omits the 'run memory review' instruction in the message when auto-approve is on", async () => {
    process.env["MEMORY_AUTO_APPROVE"] = "1";
    client = await connectClient(db);
    const { json } = await callJson(client, "suggest_lore", {
      title: "No review needed",
      summary: "s",
      body: "b",
    });
    expect(json.status).toBe("active");
    expect(json.message).not.toMatch(/memory review/i);
    expect(json.message).not.toMatch(/memory approve/i);
  });

  it("includes the 'run memory review' instruction in the message when auto-approve is off", async () => {
    // Gate explicitly off (beforeEach already deletes it).
    client = await connectClient(db);
    const { json } = await callJson(client, "suggest_lore", {
      title: "Human review required",
      summary: "s",
      body: "b",
    });
    expect(json.status).toBe("draft");
    expect(json.message).toMatch(/memory review/i);
    expect(json.message).toMatch(/memory approve/i);
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
    expect(search.json.absence_marker.reason).toBe(
      "<untrusted-absence>no team policy yet</untrusted-absence>",
    );
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
    // Boundary detail is model/agent-authored → quarantined in the envelope on serve.
    expect(provider.detail).toBe("<untrusted-boundary>human detail</untrusted-boundary>");
    expect(dep.json.security).toContain("<untrusted-*>");
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

// ── N2: the repo-key mismatch diagnostic is an OPERATOR concern and must go to
// stderr — never into the agent-facing MCP result (it names other repos' keys
// and is untrusted context noise). ─────────────────────────────────────────
describe("MCP — repo-key mismatch diagnostic stays out of agent context (N2)", () => {
  const SSH = "git@github.com:acme/widget.git";
  const HTTPS = "https://github.com/acme/widget.git";
  const REPO = "widget";
  const LEGACY_KEY = createHash("sha256").update(SSH).digest("hex");

  /** Seed a legacy card under the un-normalised key so the normalised query
   *  resolves to 0 cards while cards DO exist under another key. */
  function seedLegacyCard(): void {
    upsertFileCard(db, {
      repoKey: LEGACY_KEY,
      canonical: undefined,
      repo: REPO,
      path: "src/api/price.ts",
      contentHash: "a".repeat(64),
      loc: 42,
      symbols: ["getPrice"],
      source: "onboard",
      tldr: "price lookup",
      modelStatus: "active",
    });
  }

  /** Capture everything written to process.stderr while `fn` runs. */
  async function withCapturedStderr(fn: () => Promise<void>): Promise<string> {
    const chunks: string[] = [];
    const original = process.stderr.write.bind(process.stderr);

    (process.stderr as any).write = (chunk: any, ...rest: any[]): boolean => {
      chunks.push(String(chunk));
      // Swallow — don't spam the test reporter with the operator log line.
      if (typeof rest[rest.length - 1] === "function") rest[rest.length - 1]();
      return true;
    };
    try {
      await fn();
    } finally {
      process.stderr.write = original;
    }
    return chunks.join("");
  }

  it("search_file_cards on a mismatch returns 0 cards WITHOUT a diagnostics field", async () => {
    seedLegacyCard();
    client = await connectClient(db);
    let json: any;
    const err = await withCapturedStderr(async () => {
      ({ json } = await callJson(client, "search_file_cards", {
        repoCanonical: HTTPS,
        repo: REPO,
        query: "price",
      }));
    });
    // The result the agent sees carries NO diagnostic leak.
    expect(json.count).toBe(0);
    expect(json).not.toHaveProperty("diagnostics");
    expect(JSON.stringify(json)).not.toContain("mismatch");
    // But the operator DOES get told, on stderr.
    expect(err).toContain("mismatch");
  });

  it("cards_for_scope on a mismatch omits diagnostics from the packet too", async () => {
    seedLegacyCard();
    client = await connectClient(db);
    let json: any;
    const err = await withCapturedStderr(async () => {
      ({ json } = await callJson(client, "cards_for_scope", {
        repoCanonical: HTTPS,
        repo: REPO,
        query: "price",
      }));
    });
    expect(json.cards).toHaveLength(0);
    expect(json).not.toHaveProperty("diagnostics");
    expect(JSON.stringify(json)).not.toContain("mismatch");
    expect(err).toContain("mismatch");
  });
});

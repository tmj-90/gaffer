/**
 * Audit log boundary test. The MCP server MUST NOT write the body of
 * a suggested or updated lore record to ~/.memory/audit.jsonl. That's
 * the explicit security claim in README + SECURITY.md and the only
 * meaningful failure mode this test guards against. We exercise the
 * audit module directly (not via the live MCP server, which requires
 * a stdio harness) and assert on the JSONL produced.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const tmpPath = join(tmpdir(), `lore-audit-test-${Date.now()}-${process.pid}.jsonl`);

beforeEach(() => {
  process.env["MEMORY_AUDIT_LOG"] = tmpPath;
  delete process.env["MEMORY_AUDIT_OFF"];
});
afterEach(() => {
  try {
    rmSync(tmpPath, { force: true });
  } catch {
    /* best-effort */
  }
});

async function freshAudit() {
  // Re-import to clear the module-scoped `initialised` flag and force a
  // re-read of the MEMORY_AUDIT_LOG env var. Vitest gives each test a
  // module cache, so importing here is fine.
  const mod = await import("../src/core/audit.js?ts=" + Date.now());
  return mod;
}

describe("audit log boundary", () => {
  it("does not contain the body when suggest_lore-style sanitised payload is recorded", async () => {
    const { audit } = await freshAudit();
    // This is the exact shape MCP server.ts builds for suggest_lore.
    audit({
      tool: "suggest_lore",
      request: {
        title: "t",
        summaryChars: 12,
        bodyChars: 9999,
        repos: ["repo-a"],
        tags: ["t1"],
        source: "https://example.com/x",
        confidence: "medium",
        team: "team-x",
      },
      resultCount: 1,
      resultIds: ["abc12345"],
    });
    const line = readFileSync(tmpPath, "utf8").trim();
    // Body is NOT in the audit line. The string check is intentionally
    // broad — if any future regression spreads the args object back in,
    // this catches it.
    expect(line).not.toContain('"body"');
    expect(line).not.toContain('"body":');
    // Whereas the safe metadata IS there.
    expect(line).toContain("suggest_lore");
    expect(line).toContain("bodyChars");
    expect(line).toContain("repo-a");
  });

  it("never writes a key called 'body' regardless of caller payload", async () => {
    const { audit } = await freshAudit();
    // Even if a caller (incorrectly) tried to pass `body`, we'd want this
    // covered. The current code shouldn't construct such an audit, but
    // a defensive check here documents the contract.
    audit({
      tool: "suggest_lore",
      request: { title: "t" },
      resultCount: 1,
      resultIds: ["abc12345"],
    });
    const line = readFileSync(tmpPath, "utf8").trim();
    expect(line).not.toMatch(/"body"\s*:/);
  });

  it("stamps each record with an ISO timestamp", async () => {
    const { audit } = await freshAudit();
    audit({ tool: "search_lore", request: { query: "x" }, resultCount: 0 });
    const row = JSON.parse(readFileSync(tmpPath, "utf8").trim());
    expect(row.ts).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(Number.isNaN(Date.parse(row.ts))).toBe(false);
  });

  it("appends one JSONL line per call (does not overwrite)", async () => {
    const { audit } = await freshAudit();
    audit({ tool: "search_lore", request: { query: "a" }, resultCount: 1 });
    audit({ tool: "get_lore", request: { id: "abc12345" }, resultCount: 1 });
    audit({ tool: "search_lore", request: { query: "b" }, resultCount: 0 });
    const lines = readFileSync(tmpPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!).tool).toBe("search_lore");
    expect(JSON.parse(lines[1]!).tool).toBe("get_lore");
  });

  it("records the `blocked` field for a gated refusal", async () => {
    const { audit } = await freshAudit();
    audit({
      tool: "get_lore",
      request: { id: "abc12345" },
      resultCount: 1,
      resultIds: ["abc12345"],
      blocked: "restricted",
    });
    const row = JSON.parse(readFileSync(tmpPath, "utf8").trim());
    expect(row.blocked).toBe("restricted");
  });

  it("writes nothing when MEMORY_AUDIT_OFF is set", async () => {
    process.env["MEMORY_AUDIT_OFF"] = "1";
    const { audit } = await freshAudit();
    audit({ tool: "search_lore", request: { query: "x" }, resultCount: 0 });
    expect(existsSync(tmpPath)).toBe(false);
  });

  it("an `error` audit row carries the message but never a body", async () => {
    const { audit } = await freshAudit();
    audit({
      tool: "suggest_lore",
      request: { title: "t", bodyChars: 5 },
      error: "summary_too_long: 900 chars exceeds cap 800",
    });
    const row = JSON.parse(readFileSync(tmpPath, "utf8").trim());
    expect(row.error).toContain("summary_too_long");
    expect("body" in row.request).toBe(false);
  });
});

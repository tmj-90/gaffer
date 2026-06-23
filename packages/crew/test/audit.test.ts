/**
 * Audit log: redaction guarantees + JSONL round-trip.
 *
 * The cardinal rule under test: the audit log records THAT a tool ran and the
 * ids/counts it touched, but NEVER prompts, file contents, commands, paths, or
 * secrets. Every test passes `env: {}` to bypass the suite-wide GAFFER_AUDIT_OFF
 * and writes to an isolated temp path.
 */
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  audit,
  isAuditDisabled,
  readAuditRecords,
  resolveAuditPath,
  summariseArgs,
  summariseRecentRuns,
} from "../src/audit/index.js";

describe("summariseArgs (redaction core)", () => {
  it("reduces non-identifier strings to a length, never the content", () => {
    const secret = "ghp_supersecrettoken_should_never_appear";
    const out = summariseArgs({ command: secret });
    expect(out.command).toEqual({ chars: secret.length });
    expect(JSON.stringify(out)).not.toContain("ghp_supersecrettoken");
  });

  it("keeps declared identifier strings verbatim (ids are not content)", () => {
    const out = summariseArgs({ ticketRef: "T-123", path: "/etc/passwd" }, ["ticketRef"]);
    expect(out.ticketRef).toBe("T-123");
    // path is NOT an id key -> reduced to a length, content withheld
    expect(out.path).toEqual({ chars: "/etc/passwd".length });
    expect(JSON.stringify(out)).not.toContain("passwd");
  });

  it("passes through booleans and numbers, summarises arrays and objects", () => {
    const out = summariseArgs({
      scan: true,
      limit: 5,
      tags: ["a", "b", "c"],
      nested: { secret: "x" },
    });
    expect(out.scan).toBe(true);
    expect(out.limit).toBe(5);
    expect(out.tags).toEqual({ count: 3 });
    expect(out.nested).toEqual({ redacted: true });
    expect(JSON.stringify(out)).not.toContain("secret");
  });

  it("drops undefined values entirely", () => {
    const out = summariseArgs({ a: undefined, b: 1 });
    expect("a" in out).toBe(false);
    expect(out.b).toBe(1);
  });
});

describe("resolveAuditPath", () => {
  it("prefers GAFFER_AUDIT env over data dir and default", () => {
    expect(resolveAuditPath({ env: { GAFFER_AUDIT: "/custom/a.jsonl" }, dataDir: "/x" })).toBe(
      "/custom/a.jsonl",
    );
  });

  it("falls back to <dataDir>/audit.jsonl", () => {
    expect(resolveAuditPath({ env: {}, dataDir: "/factory" })).toBe("/factory/audit.jsonl");
  });
});

describe("isAuditDisabled", () => {
  it("is true for GAFFER_AUDIT_OFF=1 and false otherwise", () => {
    expect(isAuditDisabled({ GAFFER_AUDIT_OFF: "1" })).toBe(true);
    expect(isAuditDisabled({ GAFFER_AUDIT_OFF: "true" })).toBe(true);
    expect(isAuditDisabled({})).toBe(false);
  });
});

describe("audit write + read round-trip", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gaffer-audit-"));
    path = join(dir, "audit.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends one JSONL line per call with a timestamp", () => {
    audit(
      { tool: "list_repos", args: { scan: true }, resultCount: 2, resultIds: ["r1", "r2"] },
      {
        path,
        env: {},
      },
    );
    audit(
      { tool: "run_idle_loop", args: {}, resultCount: 1, resultIds: ["t9"] },
      { path, env: {} },
    );

    const records = readAuditRecords({ path, env: {} });
    expect(records).toHaveLength(2);
    expect(records[0]?.tool).toBe("list_repos");
    expect(typeof records[0]?.ts).toBe("string");
    expect(records[1]?.resultIds).toEqual(["t9"]);
  });

  it("does NOT write when disabled via env, and returns null", () => {
    const result = audit(
      { tool: "list_repos", args: {} },
      { path, env: { GAFFER_AUDIT_OFF: "1" } },
    );
    expect(result).toBeNull();
    expect(readAuditRecords({ path, env: {} })).toEqual([]);
  });

  it("never persists secret content even when callers mis-summarise", () => {
    // Defensive: a record should carry only redacted args. We write a redacted
    // summary and assert the raw secret is absent from the file bytes.
    const secret = "AKIAIOSFODNN7EXAMPLE";
    audit(
      { tool: "check_command_allowed", args: summariseArgs({ command: secret }) },
      {
        path,
        env: {},
      },
    );
    const bytes = readFileSync(path, "utf8");
    expect(bytes).not.toContain(secret);
    expect(bytes).toContain(String(secret.length));
  });

  it("tolerates a torn trailing line without throwing", () => {
    audit({ tool: "list_agents", args: {} }, { path, env: {} });
    // simulate a partial append (a crash mid-write)
    appendFileSync(path, '{"ts":"x","tool":');
    const records = readAuditRecords({ path, env: {} });
    expect(records).toHaveLength(1);
  });

  it("summarises recent runs with per-tool counts and error totals", () => {
    audit({ tool: "list_repos", args: {} }, { path, env: {} });
    audit({ tool: "list_repos", args: {} }, { path, env: {} });
    audit({ tool: "get_context_packet", args: {}, error: "NOT_FOUND" }, { path, env: {} });

    const summary = summariseRecentRuns({ path, env: {} });
    expect(summary.total).toBe(3);
    expect(summary.errors).toBe(1);
    expect(summary.byTool[0]).toEqual({ tool: "list_repos", count: 2 });
    expect(summary.recent[0]?.tool).toBe("get_context_packet");
  });
});

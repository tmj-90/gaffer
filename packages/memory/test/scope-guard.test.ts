/**
 * Repo-scope guard for DIRECT-APPLY memory writes — pure-function unit
 * tests (no stdio harness required). The end-to-end wiring through the real
 * MCP tools is exercised in mcp-repo-understanding.test.ts; here we pin the
 * decision helpers and the refusal shape, mirroring mcp-redaction.test.ts.
 */
import { describe, expect, it } from "vitest";

import {
  parseTicketRepos,
  repoInScope,
  repoOutOfScopeRefusal,
  scopeEnforcementActive,
} from "../src/mcp/scopeGuard.js";

describe("scopeEnforcementActive", () => {
  it("is active only when GAFFER_FACTORY is exactly '1'", () => {
    expect(scopeEnforcementActive({ GAFFER_FACTORY: "1" })).toBe(true);
  });

  it("is inert (standalone) when GAFFER_FACTORY is unset — the default", () => {
    expect(scopeEnforcementActive({})).toBe(false);
  });

  it("is inert for any non-'1' value (strict equality, not truthiness)", () => {
    expect(scopeEnforcementActive({ GAFFER_FACTORY: "0" })).toBe(false);
    expect(scopeEnforcementActive({ GAFFER_FACTORY: "true" })).toBe(false);
    expect(scopeEnforcementActive({ GAFFER_FACTORY: "" })).toBe(false);
  });
});

describe("parseTicketRepos", () => {
  it("returns [] for undefined / empty", () => {
    expect(parseTicketRepos(undefined)).toEqual([]);
    expect(parseTicketRepos("")).toEqual([]);
    expect(parseTicketRepos("   ")).toEqual([]);
  });

  it("splits on colons AND newlines, trimming each name", () => {
    expect(parseTicketRepos("a:b:c")).toEqual(["a", "b", "c"]);
    expect(parseTicketRepos("a\nb\nc")).toEqual(["a", "b", "c"]);
    expect(parseTicketRepos("  a : b \n c ")).toEqual(["a", "b", "c"]);
  });

  it("drops empty segments (collapsed separators, trailing colon)", () => {
    expect(parseTicketRepos("a::b:")).toEqual(["a", "b"]);
  });
});

describe("repoInScope", () => {
  const env = { GAFFER_TICKET_REPOS: "payments-svc:orders-svc" };

  it("true when the repo is in the allowed set", () => {
    expect(repoInScope("payments-svc", env)).toBe(true);
    expect(repoInScope("orders-svc", env)).toBe(true);
  });

  it("trims the target before comparing (mirrors normaliseRepo trim rule)", () => {
    expect(repoInScope("  payments-svc  ", env)).toBe(true);
  });

  it("false when the repo is NOT in the allowed set", () => {
    expect(repoInScope("victim-svc", env)).toBe(false);
  });

  it("fail-closed: empty / missing GAFFER_TICKET_REPOS refuses every repo", () => {
    expect(repoInScope("payments-svc", {})).toBe(false);
    expect(repoInScope("payments-svc", { GAFFER_TICKET_REPOS: "" })).toBe(false);
    expect(repoInScope("payments-svc", { GAFFER_TICKET_REPOS: "   " })).toBe(false);
  });

  it("fail-closed: an empty target repo is never in scope", () => {
    expect(repoInScope("   ", env)).toBe(false);
  });
});

describe("repoOutOfScopeRefusal", () => {
  it("returns a minimal typed refusal — error + the target repo + a hint, nothing else", () => {
    const r = repoOutOfScopeRefusal("victim-svc");
    expect(r.error).toBe("repo_out_of_scope");
    expect(r.repo).toBe("victim-svc");
    expect(typeof r.hint).toBe("string");
    // Minimal-leak posture: the allowed set is NEVER echoed back to the agent.
    expect(Object.keys(r).sort()).toEqual(["error", "hint", "repo"]);
    expect(r.hint).not.toContain("payments-svc");
  });
});

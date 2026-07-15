/**
 * MCP restricted-get gate. `search_lore` env-gates restricted records via
 * MEMORY_ALLOW_RESTRICTED_MCP; `get_lore` must enforce the same gate so an
 * agent with a known id can't sidestep the search filter. These tests
 * exercise the pure helpers (no stdio harness required).
 */
import { describe, expect, it } from "vitest";

import {
  ABSENCE_DISABLED_REFUSAL,
  CONFLICT_AGAINST_RESTRICTED_REFUSAL,
  redactRestricted,
  shouldGateAbsenceWrite,
  shouldGateRestrictedGet,
  shouldRefuseConflictAgainstRestricted,
  stripPossibleConflicts,
} from "../src/mcp/redact.js";

describe("redactRestricted", () => {
  it("returns a minimal refusal shape — no title, summary, body, source, or timestamps", () => {
    const r = redactRestricted("abc12345");
    expect(r).toEqual({
      id: "abc12345",
      restricted: true,
      error: "restricted",
      hint: "Set MEMORY_ALLOW_RESTRICTED_MCP=1 to allow MCP access to restricted lore.",
    });
    // Spell out the negatives in case the shape grows by accident later.
    const keys = Object.keys(r);
    expect(keys).not.toContain("title");
    expect(keys).not.toContain("summary");
    expect(keys).not.toContain("body");
    expect(keys).not.toContain("source");
    expect(keys).not.toContain("repos");
    expect(keys).not.toContain("tags");
    expect(keys).not.toContain("updatedAt");
    expect(keys).not.toContain("createdAt");
  });
});

describe("shouldGateRestrictedGet", () => {
  it("returns false when the record is null (unknown id)", () => {
    expect(shouldGateRestrictedGet(null, {})).toBe(false);
  });

  it("returns false for non-restricted records, gate set or not", () => {
    expect(shouldGateRestrictedGet({ restricted: false }, {})).toBe(false);
    expect(
      shouldGateRestrictedGet({ restricted: false }, { MEMORY_ALLOW_RESTRICTED_MCP: "1" }),
    ).toBe(false);
  });

  it("returns true when restricted and the env gate is unset", () => {
    expect(shouldGateRestrictedGet({ restricted: true }, {})).toBe(true);
  });

  it("returns true when restricted and the env gate is anything other than '1'", () => {
    expect(shouldGateRestrictedGet({ restricted: true }, { MEMORY_ALLOW_RESTRICTED_MCP: "" })).toBe(
      true,
    );
    expect(
      shouldGateRestrictedGet({ restricted: true }, { MEMORY_ALLOW_RESTRICTED_MCP: "yes" }),
    ).toBe(true);
    expect(
      shouldGateRestrictedGet({ restricted: true }, { MEMORY_ALLOW_RESTRICTED_MCP: "0" }),
    ).toBe(true);
    expect(
      shouldGateRestrictedGet({ restricted: true }, { MEMORY_ALLOW_RESTRICTED_MCP: "true" }),
    ).toBe(true);
  });

  it("returns false when restricted and the env gate is explicitly '1'", () => {
    expect(
      shouldGateRestrictedGet({ restricted: true }, { MEMORY_ALLOW_RESTRICTED_MCP: "1" }),
    ).toBe(false);
  });
});

describe("stripPossibleConflicts", () => {
  it("removes possibleConflicts from every hit before MCP serialisation", () => {
    const hits = [
      {
        id: "abcd2345",
        title: "a",
        repos: ["payments-svc"],
        tags: ["security"],
        possibleConflicts: ["bcde2345"],
      },
      {
        id: "bcde2345",
        title: "b",
        repos: ["payments-svc"],
        tags: ["security"],
        possibleConflicts: ["abcd2345"],
      },
      {
        // A hit with no overlap — possibleConflicts absent. Should be
        // returned unchanged (just without the optional field).
        id: "cdef2345",
        title: "c",
        repos: ["other-svc"],
        tags: [],
      },
    ];
    const stripped = stripPossibleConflicts(hits);
    expect(stripped).toHaveLength(3);
    for (const h of stripped) {
      expect(Object.keys(h)).not.toContain("possibleConflicts");
    }
    // The other fields survive verbatim — only the conflict hint is dropped.
    expect(stripped[0]).toEqual({
      id: "abcd2345",
      title: "a",
      repos: ["payments-svc"],
      tags: ["security"],
    });
  });

  it("does not mutate the input array or its records", () => {
    const original = [
      {
        id: "abcd2345",
        possibleConflicts: ["bcde2345"],
      },
    ];
    const snapshot = JSON.parse(JSON.stringify(original));
    stripPossibleConflicts(original);
    expect(original).toEqual(snapshot);
  });
});

describe("buildSearchResponseBody", () => {
  it("hits present → only `results` is set", async () => {
    const { buildSearchResponseBody } = await import("../src/mcp/redact.js");
    const r = buildSearchResponseBody({
      hits: [{ id: "abcd2345", title: "x" }],
      query: "anything",
      absenceMarker: null,
    });
    expect(r).toEqual({ results: [{ id: "abcd2345", title: "x" }] });
    expect("next" in r).toBe(false);
    expect("absence_marker" in r).toBe(false);
  });

  it("zero hits + active marker → marker wins, no `next` field", async () => {
    const { buildSearchResponseBody } = await import("../src/mcp/redact.js");
    const { QUARANTINE_NOTICE } = await import("../src/mcp/quarantine.js");
    const r = buildSearchResponseBody({
      hits: [],
      query: "team retry policy",
      absenceMarker: {
        reason: "no policy yet",
        recordedAt: "2026-05-01T00:00:00Z",
        expiresAt: "2026-05-31T00:00:00Z",
      },
    });
    expect(r).toEqual({
      results: [],
      absence_marker: {
        // The agent-authored reason is quarantined (envelope) at serve time.
        reason: "<untrusted-absence>no policy yet</untrusted-absence>",
        recordedAt: "2026-05-01T00:00:00Z",
        expiresAt: "2026-05-31T00:00:00Z",
      },
      security: QUARANTINE_NOTICE,
    });
    expect("next" in r).toBe(false);
  });

  it("zero hits + no marker + query → `next` coach is present", async () => {
    const { buildSearchResponseBody, SEARCH_NO_HIT_COACH } = await import("../src/mcp/redact.js");
    const r = buildSearchResponseBody({
      hits: [],
      query: "obscure thing",
      absenceMarker: null,
    });
    expect(r["results"]).toEqual([]);
    expect(r["next"]).toBe(SEARCH_NO_HIT_COACH);
    expect("absence_marker" in r).toBe(false);
  });

  it("the coach mentions all three behaviours we want to nudge", async () => {
    const { SEARCH_NO_HIT_COACH } = await import("../src/mcp/redact.js");
    expect(SEARCH_NO_HIT_COACH).toContain("record_absence");
    expect(SEARCH_NO_HIT_COACH).toContain("suggest_lore");
    // Cross-repo retry nudge
    expect(SEARCH_NO_HIT_COACH).toContain("without `repo`");
  });

  it("zero hits + no marker + no query → no `next` (blank list-recent has no useful coach)", async () => {
    const { buildSearchResponseBody } = await import("../src/mcp/redact.js");
    const r = buildSearchResponseBody({
      hits: [],
      query: undefined,
      absenceMarker: null,
    });
    expect(r).toEqual({ results: [] });
    expect("next" in r).toBe(false);
  });

  it("hits present + totalMatches > shown → `truncated` block", async () => {
    const { buildSearchResponseBody, SEARCH_TRUNCATED_HINT } = await import("../src/mcp/redact.js");
    const hits = [{ id: "a" }, { id: "b" }];
    const r = buildSearchResponseBody({
      hits,
      query: "popular topic",
      absenceMarker: null,
      totalMatches: 7,
    });
    expect(r["results"]).toEqual(hits);
    expect(r["truncated"]).toEqual({
      shown: 2,
      total: 7,
      hint: SEARCH_TRUNCATED_HINT,
    });
  });

  it("hits present + totalMatches === shown → no `truncated` block", async () => {
    const { buildSearchResponseBody } = await import("../src/mcp/redact.js");
    const hits = [{ id: "a" }, { id: "b" }];
    const r = buildSearchResponseBody({
      hits,
      query: "x",
      absenceMarker: null,
      totalMatches: 2,
    });
    expect("truncated" in r).toBe(false);
  });

  it("totalMatches omitted → bare `results` (back-compat with existing callers)", async () => {
    const { buildSearchResponseBody } = await import("../src/mcp/redact.js");
    const r = buildSearchResponseBody({
      hits: [{ id: "a" }],
      query: "x",
      absenceMarker: null,
    });
    expect(r).toEqual({ results: [{ id: "a" }] });
  });

  it("truncation is not reported alongside an absence marker (mutually exclusive shapes)", async () => {
    const { buildSearchResponseBody } = await import("../src/mcp/redact.js");
    // Marker only applies on zero hits; with a marker present we return
    // early and never attach `truncated`.
    const r = buildSearchResponseBody({
      hits: [],
      query: "x",
      absenceMarker: {
        reason: "gap",
        recordedAt: "2026-05-01T00:00:00Z",
        expiresAt: "2026-05-31T00:00:00Z",
      },
      totalMatches: 0,
    });
    expect("truncated" in r).toBe(false);
    expect("absence_marker" in r).toBe(true);
  });
});

describe("shouldGateAbsenceWrite", () => {
  it("gates when env is empty (default off)", () => {
    expect(shouldGateAbsenceWrite({})).toBe(true);
  });

  it("gates when env has unrelated keys", () => {
    expect(shouldGateAbsenceWrite({ HOME: "/x", PATH: "/usr/bin" })).toBe(true);
  });

  it("gates when the var is set to anything other than exactly '1'", () => {
    expect(shouldGateAbsenceWrite({ MEMORY_ALLOW_MCP_ABSENCE: "0" })).toBe(true);
    expect(shouldGateAbsenceWrite({ MEMORY_ALLOW_MCP_ABSENCE: "true" })).toBe(true);
    expect(shouldGateAbsenceWrite({ MEMORY_ALLOW_MCP_ABSENCE: "yes" })).toBe(true);
    expect(shouldGateAbsenceWrite({ MEMORY_ALLOW_MCP_ABSENCE: "" })).toBe(true);
  });

  it("opens the gate only when the var is exactly '1'", () => {
    expect(shouldGateAbsenceWrite({ MEMORY_ALLOW_MCP_ABSENCE: "1" })).toBe(false);
  });
});

describe("ABSENCE_DISABLED_REFUSAL", () => {
  it("uses the structured error code agents can branch on", () => {
    expect(ABSENCE_DISABLED_REFUSAL.error).toBe("mcp_record_absence_disabled");
  });

  it("points the agent at the human-side CLI command, not at the env var", () => {
    // The refusal mentions setting the env var so operators can find it, but
    // the primary hint should direct the agent to escalate to the human —
    // the agent itself cannot flip the gate.
    expect(ABSENCE_DISABLED_REFUSAL.hint).toMatch(/memory absent record/);
    expect(ABSENCE_DISABLED_REFUSAL.hint).toMatch(/human|operator/i);
  });

  it("does not echo any user-provided query or reason text", () => {
    // Pure constant: nothing dynamic can leak into the refusal body.
    const keys = Object.keys(ABSENCE_DISABLED_REFUSAL);
    expect(keys).toEqual(["error", "hint"]);
  });
});

describe("shouldRefuseConflictAgainstRestricted", () => {
  it("returns false when the looked-up record is null (unknown id)", () => {
    expect(shouldRefuseConflictAgainstRestricted(null)).toBe(false);
  });

  it("returns false for non-restricted records", () => {
    expect(shouldRefuseConflictAgainstRestricted({ restricted: false })).toBe(false);
  });

  it("returns true for restricted records — env gate doesn't matter", () => {
    // Distinct from get_lore: there is no env override that unlocks
    // conflict-against-restricted. Restricted lore can only be revised
    // by humans via the CLI.
    expect(shouldRefuseConflictAgainstRestricted({ restricted: true })).toBe(true);
  });
});

describe("CONFLICT_AGAINST_RESTRICTED_REFUSAL", () => {
  it("uses the structured 'restricted' error code", () => {
    expect(CONFLICT_AGAINST_RESTRICTED_REFUSAL.error).toBe("restricted");
  });

  it("does not suggest setting any env var (no such override exists)", () => {
    expect(CONFLICT_AGAINST_RESTRICTED_REFUSAL.hint).not.toMatch(/MEMORY_ALLOW_RESTRICTED_MCP/);
    expect(CONFLICT_AGAINST_RESTRICTED_REFUSAL.hint).not.toMatch(/environment variable|env var/i);
  });

  it("directs the agent to the human-side CLI revision path", () => {
    expect(CONFLICT_AGAINST_RESTRICTED_REFUSAL.hint).toMatch(/memory update|memory supersede/);
  });

  it("is a pure constant — no dynamic record fields can leak in", () => {
    const keys = Object.keys(CONFLICT_AGAINST_RESTRICTED_REFUSAL);
    expect(keys).toEqual(["error", "hint"]);
  });
});

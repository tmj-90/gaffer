/**
 * The retrieval rule emitted by `memory print-claude-instructions`.
 * It's the agent-side trust contract, so pin that it names the key tools
 * and the trust posture — a regression here silently changes how every
 * downstream agent behaves.
 */
import { describe, expect, it } from "vitest";

import { CLAUDE_INSTRUCTIONS, renderClaudeInstructions } from "../src/cli/instructions.js";

describe("CLAUDE_INSTRUCTIONS", () => {
  it("tells the agent to search before non-trivial changes", () => {
    expect(CLAUDE_INSTRUCTIONS).toMatch(/search .*lore.* .*before|before non-trivial/i);
    expect(CLAUDE_INSTRUCTIONS).toContain("search_lore");
  });

  it("names get_lore, report_conflict, and suggest_lore with their roles", () => {
    expect(CLAUDE_INSTRUCTIONS).toContain("get_lore");
    expect(CLAUDE_INSTRUCTIONS).toContain("report_conflict");
    expect(CLAUDE_INSTRUCTIONS).toContain("suggest_lore");
  });

  it("states the trust posture: stale/low-confidence/conflicting are clues, not authority", () => {
    expect(CLAUDE_INSTRUCTIONS).toMatch(/clues, not authority/i);
  });

  it("explains cross-repo guidance vs repo-local authority", () => {
    expect(CLAUDE_INSTRUCTIONS).toMatch(/cross-repo guidance/i);
  });
});

describe("renderClaudeInstructions", () => {
  it("returns the rule with a single trailing newline", () => {
    const out = renderClaudeInstructions();
    expect(out.startsWith(CLAUDE_INSTRUCTIONS)).toBe(true);
    expect(out.endsWith("\n")).toBe(true);
    expect(out).toBe(CLAUDE_INSTRUCTIONS + "\n");
  });
});

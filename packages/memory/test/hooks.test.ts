/**
 * Stop-hook session-end review nudge.
 *
 * Closes the dogfood-failure-mode the maker called out: agents
 * suggest drafts mid-session, drafts rot, future agents never
 * benefit. The hook nudges exactly once per session when drafts
 * are pending.
 *
 * Pure decision lives in `decideNudge`; the marker / JSON
 * shape / settings.json merge logic is testable without spinning
 * up an actual Claude session.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  decideNudge,
  mergeHookSettings,
  parseHookInput,
  renderHookSettings,
} from "../src/cli/hooks.js";

describe("decideNudge", () => {
  it("no drafts → silent pass (empty object)", () => {
    expect(decideNudge({ pendingDraftCount: 0, sessionAlreadyNudged: false })).toEqual({});
  });

  it("drafts + already nudged → silent pass (don't loop)", () => {
    expect(decideNudge({ pendingDraftCount: 3, sessionAlreadyNudged: true })).toEqual({});
  });

  it("drafts + first nudge → block with prompt", () => {
    const out = decideNudge({
      pendingDraftCount: 2,
      sessionAlreadyNudged: false,
    });
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("2 pending lore drafts");
    expect(out.reason).toContain("memory review");
    // The copy asks rather than demands — never "you must review".
    expect(out.reason).not.toMatch(/must|required/i);
  });

  it("singular vs plural copy", () => {
    const one = decideNudge({
      pendingDraftCount: 1,
      sessionAlreadyNudged: false,
    });
    expect(one.reason).toContain("is 1 pending lore draft");
    expect(one.reason).not.toContain("drafts");
    const many = decideNudge({
      pendingDraftCount: 4,
      sessionAlreadyNudged: false,
    });
    expect(many.reason).toContain("are 4 pending lore drafts");
  });

  it("nudgeEveryTime overrides the once-per-session guard", () => {
    const out = decideNudge({
      pendingDraftCount: 1,
      sessionAlreadyNudged: true,
      nudgeEveryTime: true,
    });
    expect(out.decision).toBe("block");
  });

  it("nudgeEveryTime is still gated on draft count > 0", () => {
    expect(
      decideNudge({
        pendingDraftCount: 0,
        sessionAlreadyNudged: true,
        nudgeEveryTime: true,
      }),
    ).toEqual({});
  });
});

describe("parseHookInput", () => {
  it("extracts session_id and cwd from a typical Claude hook payload", () => {
    const r = parseHookInput(
      JSON.stringify({
        session_id: "abc-123",
        cwd: "/Users/x/proj",
        transcript_path: "/tmp/x.jsonl",
      }),
    );
    expect(r.sessionId).toBe("abc-123");
    expect(r.cwd).toBe("/Users/x/proj");
  });

  it("falls back to 'unknown' for missing session_id (don't crash the hook)", () => {
    expect(parseHookInput("{}").sessionId).toBe("unknown");
    expect(parseHookInput("not-json").sessionId).toBe("unknown");
    expect(parseHookInput("").sessionId).toBe("unknown");
  });

  it("cwd is undefined when missing", () => {
    expect(parseHookInput("{}").cwd).toBeUndefined();
  });
});

describe("renderHookSettings + mergeHookSettings", () => {
  it("renderHookSettings produces valid JSON with the expected shape", () => {
    const json = renderHookSettings();
    const parsed = JSON.parse(json) as {
      hooks: { Stop: Array<{ hooks: Array<{ type: string; command: string }> }> };
    };
    expect(parsed.hooks.Stop).toHaveLength(1);
    expect(parsed.hooks.Stop[0]!.hooks[0]!.type).toBe("command");
    expect(parsed.hooks.Stop[0]!.hooks[0]!.command).toBe("memory hooks review-nudge");
  });

  it("merge into empty settings produces fresh shape", () => {
    expect(JSON.parse(mergeHookSettings(null))).toEqual(JSON.parse(renderHookSettings()));
    expect(JSON.parse(mergeHookSettings(""))).toEqual(JSON.parse(renderHookSettings()));
  });

  it("idempotent — re-merging the same hook returns the input unchanged", () => {
    const initial = renderHookSettings();
    const merged = mergeHookSettings(initial);
    expect(merged).toBe(initial);
  });

  it("preserves unrelated user-authored settings", () => {
    const userSettings = JSON.stringify(
      {
        model: "claude-opus-4-7",
        env: { FOO: "bar" },
        hooks: {
          PreToolUse: [{ hooks: [{ type: "command", command: "echo pretool" }] }],
        },
      },
      null,
      2,
    );
    const merged = JSON.parse(mergeHookSettings(userSettings)) as {
      model: string;
      env: { FOO: string };
      hooks: Record<string, unknown[]>;
    };
    expect(merged.model).toBe("claude-opus-4-7");
    expect(merged.env.FOO).toBe("bar");
    // Other hooks survive.
    expect(merged.hooks["PreToolUse"]).toHaveLength(1);
    // Our hook was added under Stop.
    expect(merged.hooks["Stop"]).toHaveLength(1);
  });

  it("appends Stop entry without clobbering an existing Stop hook chain", () => {
    const existing = JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "echo stop-existing" }] }],
      },
    });
    const merged = JSON.parse(mergeHookSettings(existing)) as {
      hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(merged.hooks.Stop).toHaveLength(2);
    const commands = merged.hooks.Stop.flatMap((s) => s.hooks.map((h) => h.command));
    expect(commands).toContain("echo stop-existing");
    expect(commands).toContain("memory hooks review-nudge");
  });

  it("throws on malformed JSON rather than corrupting settings", () => {
    expect(() => mergeHookSettings("{ this is not json")).toThrow(/not valid JSON/);
  });
});

describe("nudge marker file round-trip", () => {
  let tmpHome: string;
  let origHome: string | undefined;

  beforeEach(() => {
    origHome = process.env["HOME"];
    tmpHome = mkdtempSync(join(tmpdir(), "memory-hooks-"));
    process.env["HOME"] = tmpHome;
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = origHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("sessionAlreadyNudged returns false then true after markSessionNudged", async () => {
    // Re-import after HOME swap so homedir() picks up the override.
    // (Node caches some os helpers; dynamic import avoids the trap.)
    const { sessionAlreadyNudged, markSessionNudged, nudgeMarkerPath } =
      await import("../src/cli/hooks.js");
    const session = "abc-123";
    expect(sessionAlreadyNudged(session)).toBe(false);
    markSessionNudged(session);
    expect(sessionAlreadyNudged(session)).toBe(true);
    // Marker lives under ~/.memory/hooks/
    expect(nudgeMarkerPath(session)).toContain(".memory/hooks/");
    expect(readFileSync(nudgeMarkerPath(session), "utf8")).toBe("");
  });

  it("session ids with unsafe chars get sanitised to underscores", async () => {
    const { nudgeMarkerPath } = await import("../src/cli/hooks.js");
    const p = nudgeMarkerPath("with/slash and space");
    // No slash, no space in the basename.
    expect(p).not.toContain("with/slash");
    expect(p).toMatch(/session-with_slash_and_space\.nudged$/);
  });
});

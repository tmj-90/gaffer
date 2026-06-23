import { describe, expect, it } from "vitest";

import { createMergeRunner, MERGE_CMD_ENV, parseCommand } from "../src/api/mergeRunner.js";

/**
 * Exercise the auto-merge trigger fired when a ticket is approved. We point
 * DISPATCH_MERGE_CMD at a harmless `node -e` so a real process spawns and exits
 * (proving the no-shell argv path), and assert the env-strip + skip behaviour.
 */

describe("merge runner: command parsing", () => {
  it("splits a configured command into argv tokens on whitespace", () => {
    expect(parseCommand("node /path/merge-ticket.mjs")).toEqual(["node", "/path/merge-ticket.mjs"]);
  });

  it("treats a blank/whitespace command as empty (unconfigured)", () => {
    expect(parseCommand("   ")).toEqual([]);
    expect(parseCommand("")).toEqual([]);
  });

  it("parses a JSON-array command verbatim, preserving a space-containing path", () => {
    // The robust form: a checkout path with spaces stays a SINGLE argv element.
    expect(parseCommand('["node","/Users/My Repo/bin/merge-ticket.mjs"]')).toEqual([
      "node",
      "/Users/My Repo/bin/merge-ticket.mjs",
    ]);
  });

  it("keeps the legacy whitespace split for non-JSON commands (back-compat)", () => {
    expect(parseCommand("node /path/merge-ticket.mjs --foo")).toEqual([
      "node",
      "/path/merge-ticket.mjs",
      "--foo",
    ]);
  });

  it("drops empty elements from a JSON-array command, empty array → unconfigured", () => {
    expect(parseCommand('["node","","/path/m.mjs"]')).toEqual(["node", "/path/m.mjs"]);
    expect(parseCommand("[]")).toEqual([]);
  });

  it("falls back to whitespace split when JSON is malformed or not a string array", () => {
    // A bracketed but non-JSON value must not silently drop the command.
    expect(parseCommand("[not json")).toEqual(["[not", "json"]);
    // A JSON array that isn't all strings falls through to the legacy split.
    expect(parseCommand("[1,2]")).toEqual(["[1,2]"]);
  });
});

describe("merge runner: JSON-array command with a space-containing path", () => {
  it("spawns the JSON-array argv with the spaced path as ONE argument", async () => {
    const { mkdtempSync, mkdirSync, readFileSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    // A directory whose name contains a space — the exact case the string form breaks.
    const base = mkdtempSync(join(tmpdir(), "wg-merge-json-"));
    const spaced = join(base, "My Repo");
    mkdirSync(spaced, { recursive: true });
    const outFile = join(base, "out.json");
    const scriptFile = join(spaced, "fake-merge.cjs");
    writeFileSync(
      scriptFile,
      "const fs=require('fs');" +
        "fs.writeFileSync(process.env.WG_MERGE_OUT," +
        "JSON.stringify({argv:process.argv.slice(2),script:__filename}));",
    );

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      WG_MERGE_OUT: outFile,
      // JSON-array form: the spaced script path is a single argv element.
      [MERGE_CMD_ENV]: JSON.stringify([process.execPath, scriptFile]),
    };
    const runner = createMergeRunner(env);
    const res = runner.trigger({ ticketNumber: 13 });
    expect(res.triggered).toBe(true);

    const deadline = Date.now() + 4000;
    let raw: string | null = null;
    while (Date.now() < deadline) {
      try {
        raw = readFileSync(outFile, "utf8");
        if (raw) break;
      } catch {
        // not written yet
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as { argv: string[]; script: string };
    // The child actually ran from the spaced path (proves it resolved as one arg).
    // Match on the spaced suffix — macOS realpath prefixes /private to tmpdir.
    expect(parsed.script).toContain("My Repo/fake-merge.cjs");
    // `--ticket 13` appended as discrete argv elements.
    expect(parsed.argv[parsed.argv.length - 2]).toBe("--ticket");
    expect(parsed.argv[parsed.argv.length - 1]).toBe("13");
  });
});

describe("merge runner: trigger behaviour", () => {
  it("skips silently when DISPATCH_MERGE_CMD is unset", () => {
    const logs: string[] = [];
    const runner = createMergeRunner({}, (m) => logs.push(m));
    const res = runner.trigger({ ticketNumber: 7 });
    expect(res.triggered).toBe(false);
    expect(res.skipped).toBe("not_configured");
    expect(res.pid).toBeNull();
    expect(logs).toHaveLength(0);
  });

  it("spawns the configured command with --ticket <number> appended", async () => {
    // A tiny node script (no embedded spaces in the command line — the real merge
    // command is `node …/merge-ticket.mjs`): write its argv + the (stripped) token.
    const { mkdtempSync, readFileSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "wg-merge-"));
    const outFile = join(dir, "out.json");
    const scriptFile = join(dir, "fake-merge.cjs");
    writeFileSync(
      scriptFile,
      "const fs=require('fs');" +
        "fs.writeFileSync(process.env.WG_MERGE_OUT," +
        "JSON.stringify({argv:process.argv.slice(2),token:process.env.DISPATCH_API_TOKEN??null}));",
    );

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DISPATCH_API_TOKEN: "super-secret-bearer",
      WG_MERGE_OUT: outFile,
      [MERGE_CMD_ENV]: `${process.execPath} ${scriptFile}`,
    };
    const runner = createMergeRunner(env);
    const res = runner.trigger({ ticketNumber: 42 });
    expect(res.triggered).toBe(true);

    // Wait for the detached child to write the file.
    const deadline = Date.now() + 4000;
    let raw: string | null = null;
    while (Date.now() < deadline) {
      try {
        raw = readFileSync(outFile, "utf8");
        if (raw) break;
      } catch {
        // not written yet
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as { argv: string[]; token: string | null };
    // `--ticket 42` is appended as discrete argv elements.
    expect(parsed.argv).toContain("--ticket");
    expect(parsed.argv).toContain("42");
    expect(parsed.argv[parsed.argv.length - 2]).toBe("--ticket");
    expect(parsed.argv[parsed.argv.length - 1]).toBe("42");
    // The bearer token is STRIPPED from the child env (defence-in-depth).
    expect(parsed.token).toBeNull();
  });

  it("does not throw and logs when the command cannot be spawned", () => {
    const logs: string[] = [];
    const env: NodeJS.ProcessEnv = {
      [MERGE_CMD_ENV]: "/no/such/binary/at/all --flag",
    };
    const runner = createMergeRunner(env, (m) => logs.push(m));
    // spawn() with stdio:ignore reports ENOENT via the 'error' event, not a throw;
    // either way the trigger must return without throwing.
    expect(() => runner.trigger({ ticketNumber: 9 })).not.toThrow();
  });
});

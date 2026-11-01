/**
 * Exploratory finding cli-wg/F-15: zod-backed validation printed
 * `{"ok":false,"code":"VALIDATION_ERROR","issues":[…]}` with no `message` (a wrapper
 * reading `.message` printed nothing) and raw zod text ("Expected number, received
 * nan"), while every other error carried `message` and `details`. Now every error is
 * `{ ok:false, code, message, details? }`; a validation failure's message names the
 * flag and the rule, and the raw issues sit under `details.issues`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";

import { CLI_BUILT, oneLineError, runBin } from "./helpers/cliBin.js";

let dir: string;
let db: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "wg-err-shape-"));
  db = join(dir, "d.sqlite");
  const wg = Dispatch.open(db);
  wg.createTicket({ title: "t" }, { type: "human", id: "test" });
  wg.db.close();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(!CLI_BUILT)(
  "cli-wg F-15: one error shape with a human message",
  { timeout: 60_000 },
  () => {
    const P = "--priority must be a whole number between 0 and 1000";
    it.each([
      ["--priority abc", ["ticket", "create", "-t", "x", "--priority", "abc"], P],
      ["--priority 1001", ["ticket", "create", "-t", "x", "--priority", "1001"], P],
      ["--priority 1.5", ["ticket", "create", "-t", "x", "--priority", "1.5"], P],
      [
        "an empty title",
        ["ticket", "create", "-t", ""],
        "--title must be 1 to 300 characters on one line",
      ],
      [
        "a 301-char title",
        ["ticket", "create", "-t", "x".repeat(301)],
        "--title must be 1 to 300 characters on one line",
      ],
      [
        "--budget 0",
        ["ticket", "create", "-t", "x", "--budget", "0"],
        "--budget must be a number greater than 0 (US dollars)",
      ],
      [
        "budget --usd -2",
        ["ticket", "budget", "1", "--usd", "-2"],
        "--usd must be a number greater than 0 (US dollars)",
      ],
      ["edit --priority -1", ["ticket", "edit", "1", "--priority", "-1"], P],
      [
        "a 2001-char criterion",
        ["ac", "add", "1", "-t", "y".repeat(2001)],
        "--text must be 1 to 2000 characters on one line",
      ],
    ])("%s", (_label, args, message) => {
      const r = runBin(db, args as string[]);
      expect(r.status).toBe(1);
      const e = oneLineError(r.stderr);
      expect(Object.keys(e).sort()).toEqual(["code", "details", "message", "ok"]);
      expect(e.ok).toBe(false);
      expect(e.code).toBe("VALIDATION_ERROR");
      expect(e.message).toBe(message);
      const issues = (e.details as { issues: Array<{ path: unknown[]; message: string }> }).issues;
      expect(Array.isArray(issues) && issues.length > 0).toBe(true);
      expect(typeof issues[0]!.message).toBe("string");
    });

    it("a DispatchError keeps the same shape (message + details)", () => {
      const r = runBin(db, ["ticket", "move", "1", "bogus"]);
      const e = oneLineError(r.stderr);
      expect(e).toMatchObject({ ok: false, code: "VALIDATION_ERROR" });
      expect(typeof e.message).toBe("string");
      expect(e.message.length).toBeGreaterThan(0);
    });
  },
);

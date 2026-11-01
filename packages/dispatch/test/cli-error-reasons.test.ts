/**
 * Exploratory finding cli-wg/F-19: errors that hid the real reason.
 *  - `claim-ticket` refused a ticket blocked by an open decision with "not claimable by
 *    this agent" and no word of the decision;
 *  - `decisions resolve <prefix>` of an already-resolved decision said "not found"
 *    (the full id said "already 'accepted'");
 *  - a prefix shorter than the 4-char minimum said "not found", and the minimum was
 *    only in the source;
 *  - `ticket dep rm` NOT_FOUND leaked the internal `<uuid>-><uuid>` key;
 *  - `import` into a non-empty DB said "Pass force", not `--force`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";

import { errorCode, runCli } from "./helpers/cli.js";
import { CLI_BUILT, oneLineError, runBin } from "./helpers/cliBin.js";

let dir: string;
let db: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wg-reasons-"));
  db = join(dir, "d.sqlite");
  Dispatch.open(db).db.close();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const msg = (e: unknown): string => String((e as Error).message);
const json = <T>(r: { json: unknown }): T => r.json as T;

describe("cli-wg F-19: errors name the real reason", { timeout: 60_000 }, () => {
  it("claim-ticket blocked by an open decision names the decision", () => {
    const agent = json<{ agent: { id: string } }>(runCli(db, ["agent", "register", "-n", "a"]))
      .agent.id;
    runCli(db, ["ticket", "create", "-t", "blocked one"]);
    runCli(db, ["ac", "add", "1", "-t", "it works"]);
    expect(runCli(db, ["ticket", "ready", "1"]).error).toBeUndefined();
    const d = json<{ decision: { id: string } }>(
      runCli(db, [
        "decision",
        "--title",
        "Pick a store",
        "--question",
        "pg or sqlite?",
        "--ticket",
        "1",
      ]),
    ).decision.id;
    const r = runCli(db, ["claim-ticket", "1", "-a", agent]);
    expect(errorCode(r.error)).toBe("TICKET_NOT_CLAIMABLE");
    expect(msg(r.error)).toContain(d.slice(0, 8));
    expect(msg(r.error)).toContain("Pick a store");
    expect(msg(r.error)).toMatch(/decisions resolve/);
  });

  it("decisions resolve: a too-short prefix says so, and help states the minimum", () => {
    const r = runCli(db, ["decisions", "resolve", "abc", "--answer", "x"]);
    expect(errorCode(r.error)).toBe("VALIDATION_ERROR");
    expect(msg(r.error)).toMatch(/too short.*at least 4 characters/);
    const help = runCli(db, ["decisions", "resolve", "--help"]);
    expect(help.stdout.replace(/\s+/g, " ")).toMatch(/at least 4 characters/);
  });

  it("decisions resolve: an already-resolved decision by prefix is reported as resolved", () => {
    const d = json<{ decision: { id: string } }>(
      runCli(db, ["decision", "--title", "t", "--question", "q"]),
    ).decision.id;
    expect(
      runCli(db, ["decisions", "resolve", d.slice(0, 8), "--answer", "pg"]).error,
    ).toBeUndefined();
    const again = runCli(db, ["decisions", "resolve", d.slice(0, 8), "--answer", "pg"]);
    expect(errorCode(again.error)).toBe("STATE_CONFLICT");
    expect(msg(again.error)).toMatch(/already 'accepted'/);
  });

  it("dep rm of a missing dependency names the tickets, not the internal key", () => {
    runCli(db, ["ticket", "create", "-t", "a"]);
    runCli(db, ["ticket", "create", "-t", "b"]);
    const r = runCli(db, ["ticket", "dep", "rm", "2", "1"]);
    expect(errorCode(r.error)).toBe("NOT_FOUND");
    expect(msg(r.error)).toContain("#2");
    expect(msg(r.error)).toContain("#1");
    expect(msg(r.error)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(msg(r.error)).not.toContain("->");
  });

  it.skipIf(!CLI_BUILT)("import into a non-empty database says --force", () => {
    const bundle = join(dir, "b.json");
    runCli(db, ["ticket", "create", "-t", "a"]);
    const out = runBin(db, ["export", "--out", bundle]);
    expect(out.status).toBe(0);
    const other = join(dir, "other.sqlite");
    Dispatch.open(other).db.close();
    runBin(other, ["ticket", "create", "-t", "x"]);
    const r = runBin(other, ["import", bundle]);
    const e = oneLineError(r.stderr);
    expect(e.code).toBe("DB_NOT_EMPTY");
    expect(e.message).toContain("--force");
    expect(e.message).not.toMatch(/Pass force\b/);
  });
});

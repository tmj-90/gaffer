import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";

import { errorCode, runCli } from "./helpers/cli.js";

/**
 * Exploratory finding cli-wg/F-20: contradictory flags were accepted silently, one of
 * them winning: `ticket budget --usd 2 --clear` cleared, `agent rename --no-number
 * --number 5` set 5, and `principal create --read --admin` minted a read-scoped admin.
 * Each is now refused (VALIDATION_ERROR) before anything is written.
 */
const human: Actor = { type: "human", id: "tom" };

describe("cli-wg F-20: contradictory flags are refused", () => {
  let dir: string;
  let db: string;
  let agentId: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wg-flags-"));
    db = join(dir, "d.sqlite");
    const wg = Dispatch.open(db);
    wg.createTicket({ title: "t", delivery_budget_usd: 3 }, human);
    agentId = wg.registerAgent({ display_name: "Bez" }, human).id;
    wg.db.close();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("ticket budget --usd with --clear", () => {
    expect(errorCode(runCli(db, ["ticket", "budget", "1", "--usd", "2", "--clear"]).error)).toBe(
      "VALIDATION_ERROR",
    );
    const wg = Dispatch.open(db);
    expect(wg.resolveTicket("1").delivery_budget_usd).toBe(3);
    wg.db.close();
    expect(runCli(db, ["ticket", "budget", "1", "--clear"]).error).toBeUndefined();
  });

  it("agent rename --number with --no-number, in either order", () => {
    for (const args of [
      ["--no-number", "--number", "5"],
      ["--number", "5", "--no-number"],
    ]) {
      expect(
        errorCode(runCli(db, ["agent", "rename", agentId, ...args]).error),
        args.join(" "),
      ).toBe("VALIDATION_ERROR");
    }
    expect(runCli(db, ["agent", "rename", agentId, "--number", "7"]).error).toBeUndefined();
    expect(runCli(db, ["agent", "rename", agentId, "--no-number"]).error).toBeUndefined();
  });

  it("principal create --read with --admin", () => {
    expect(errorCode(runCli(db, ["principal", "create", "both", "--read", "--admin"]).error)).toBe(
      "VALIDATION_ERROR",
    );
    const wg = Dispatch.open(db);
    expect(wg.listPrincipals()).toHaveLength(0);
    wg.db.close();
  });
});

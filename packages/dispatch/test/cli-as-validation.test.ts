import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerAgent } from "../src/cli/commands/agent.js";
import { registerReview } from "../src/cli/commands/review.js";
import { registerTicket } from "../src/cli/commands/ticket.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { DispatchError } from "../src/util/errors.js";

/**
 * A `--as` typo used to pick a DIFFERENT actor type silently: `review approve --as
 * agnet` recorded a HUMAN approval, `mark-merged`/`reopen-for-review` turned anything
 * but `admin` into system, and an unknown tester `--as` became agent:tester. Every
 * one is now a VALIDATION_ERROR raised before the DB is opened, so nothing is
 * written. `ticket budget` with neither flag exited 0 with {ok:false} on stdout; it
 * is now a VALIDATION_ERROR too (main() prints it to stderr and exits 1).
 * `delivery-artifact --as agnet` recorded the artifact as a HUMAN, skipping the
 * CLAIM_REQUIRED check that `--as agent` enforces.
 */

const human: Actor = { type: "human", id: "tom" };

function run(dbPath: string, ...args: string[]): void {
  const program = new Command();
  program.exitOverride().option("--db <path>", "SQLite database path");
  registerTicket(program);
  registerReview(program);
  registerAgent(program);
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    program.parse(["node", "dispatch", "--db", dbPath, ...args]);
  } finally {
    process.stdout.write = realWrite;
  }
}

function eventCount(dbPath: string): number {
  const wg = Dispatch.open(dbPath);
  try {
    return (wg.db.prepare("SELECT COUNT(*) AS n FROM work_events").get() as { n: number }).n;
  } finally {
    wg.db.close();
  }
}

function thrown(fn: () => void): DispatchError | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof DispatchError) return err;
    throw err;
  }
  return undefined;
}

describe("CLI --as is validated", () => {
  let dir: string;
  let dbPath: string;
  beforeEach(() => {
    process.env.DISPATCH_AUDIT_OFF = "1";
    dir = mkdtempSync(join(tmpdir(), "wg-cli-as-"));
    dbPath = join(dir, "dispatch.sqlite");
    const wg = Dispatch.open(dbPath);
    wg.createTicket({ title: "t", description: "", policy_pack: "solo_loose" }, human);
    wg.db.close();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  for (const args of [
    ["review", "approve", "1", "--as", "agnet"],
    ["ticket", "mark-merged", "1", "--as", "sys"],
    ["ticket", "reopen-for-review", "1", "--reason", "r", "--resolution", "x", "--as", "Admin"],
    ["ticket", "tester-pass", "1", "--summary", "ok", "--as", "humna"],
    ["ticket", "tester-fail", "1", "--summary", "bad", "--as", "robot"],
    ["delivery-artifact", "1", "--branch", "feat/x", "--as", "agnet"],
  ]) {
    const name = args[0] === "delivery-artifact" ? args[0] : args.slice(0, 2).join(" ");
    it(`${name} --as ${args[args.length - 1]} is refused and writes nothing`, () => {
      const before = eventCount(dbPath);
      const err = thrown(() => run(dbPath, ...args));
      expect(err?.code).toBe("VALIDATION_ERROR");
      expect(err?.message).toMatch(/--as must be one of/);
      expect(eventCount(dbPath)).toBe(before);
    });
  }

  it("ticket reopen-for-review --cause takes only a known cause, and writes nothing", () => {
    const before = eventCount(dbPath);
    const err = thrown(() =>
      run(
        dbPath,
        "ticket",
        "reopen-for-review",
        "1",
        "--reason",
        "r",
        "--resolution",
        "x",
        "--cause",
        "because",
      ),
    );
    expect(err?.code).toBe("VALIDATION_ERROR");
    expect(err?.message).toMatch(/--cause must be one of merge_conflict, moved_since_review/);
    expect(eventCount(dbPath)).toBe(before);
  });

  it("a valid --as still reaches the service (its own refusal, not a validation error)", () => {
    const err = thrown(() => run(dbPath, "ticket", "mark-merged", "1", "--as", "system"));
    expect(err).toBeDefined();
    expect(err?.code).not.toBe("VALIDATION_ERROR");
  });

  it("delivery-artifact --as agent still requires a claim token", () => {
    const err = thrown(() =>
      run(dbPath, "delivery-artifact", "1", "--branch", "feat/x", "--as", "agent"),
    );
    expect(err?.code).toBe("CLAIM_REQUIRED");
  });

  it("ticket budget with neither --usd nor --clear is a VALIDATION_ERROR", () => {
    const err = thrown(() => run(dbPath, "ticket", "budget", "1"));
    expect(err?.code).toBe("VALIDATION_ERROR");
    expect(err?.message).toMatch(/--usd <amount> or --clear/);
  });
});

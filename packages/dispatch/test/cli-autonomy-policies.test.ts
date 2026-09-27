import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerAutonomy } from "../src/cli/commands/autonomy.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";

/**
 * B17 — `dispatch autonomy policies`: the read-only view the runner consults at
 * start-up to warn that per-repo `auto` grants are INERT under REVIEW_MODE=human
 * (the policies are consulted only by the agent review pass). Drives the real
 * commander command against a file-backed DB and captures its JSON.
 */
const human: Actor = { type: "human", id: "operator" };

function runCli(dbPath: string, ...args: string[]): { out: unknown; code: number | undefined } {
  const program = new Command();
  program.exitOverride().option("--db <path>", "SQLite database path");
  registerAutonomy(program);
  const chunks: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  let code: number | undefined;
  try {
    program.parse(["node", "dispatch", "--db", dbPath, "autonomy", "policies", ...args]);
  } catch (err) {
    // commander's own exit (help / usage error) is reported as a code; a command error
    // (DispatchError) propagates so the test can assert on it.
    const exitCode = (err as { exitCode?: number }).exitCode;
    if (typeof exitCode !== "number") throw err;
    code = exitCode;
  } finally {
    process.stdout.write = realWrite;
  }
  const text = chunks.join("");
  return { out: text ? JSON.parse(text) : null, code };
}

describe("CLI: autonomy policies (read-only view for the runner's inert-grant warning)", () => {
  let dir: string;
  let dbPath: string;
  let repoId: string;

  beforeEach(() => {
    process.env.DISPATCH_AUDIT_OFF = "1";
    dir = mkdtempSync(join(tmpdir(), "wg-cli-autonomy-"));
    dbPath = join(dir, "dispatch.sqlite");
    const wg = Dispatch.open(dbPath);
    repoId = wg.registerRepository(
      { name: "cli-repo", default_branch: "main", local_path: process.cwd() },
      human,
    ).id;
    wg.db.close();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports no policies on a fresh DB", () => {
    const { out } = runCli(dbPath);
    expect(out).toEqual({ ok: true, count: 0, policies: [] });
  });

  it("lists every stored row, and --mode auto narrows to the grants that can act", () => {
    const wg = Dispatch.open(dbPath);
    wg.setAutonomyPolicy(
      { repoId, riskLevel: "low", gate: "approve", mode: "auto", confirm: true },
      human,
    );
    wg.setAutonomyPolicy({ repoId, riskLevel: "high", gate: "merge", mode: "off" }, human);
    wg.db.close();

    const all = runCli(dbPath).out as { count: number; policies: { mode: string }[] };
    expect(all.count).toBe(2);
    expect(all.policies.map((p) => p.mode).sort()).toEqual(["auto", "off"]);

    const auto = runCli(dbPath, "--mode", "auto").out as {
      count: number;
      policies: { mode: string; gate: string; risk_level: string; repo_name: string }[];
    };
    expect(auto.count).toBe(1);
    expect(auto.policies[0]).toMatchObject({
      mode: "auto",
      gate: "approve",
      risk_level: "low",
      repo_name: "cli-repo",
    });
  });

  it("rejects an unknown --mode", () => {
    expect(() => runCli(dbPath, "--mode", "yolo")).toThrow(/--mode must be one of/);
  });
});

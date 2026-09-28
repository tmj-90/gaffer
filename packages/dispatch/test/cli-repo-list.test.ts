import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerRepo } from "../src/cli/commands/repo.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";

/**
 * `dispatch repo list [--all]` — the registered-repo listing `gaffer status` feeds its
 * "repos (registered)" section from, and the answer to "what repo NAME do I give
 * `wg ticket repo-access set`?" on a fresh factory. Before it existed the CLI could
 * register, hide and un-hide repos but never list the visible ones.
 */
const human: Actor = { type: "human", id: "operator" };

type Row = {
  name: string;
  local_path: string | null;
  default_branch: string;
  stack: string | null;
  test_command: string | null;
  lint_command: string | null;
  hidden: boolean;
};

function runCli(dbPath: string, ...args: string[]): Row[] {
  const program = new Command();
  program.exitOverride().option("--db <path>", "SQLite database path");
  registerRepo(program);
  const chunks: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    program.parse(["node", "dispatch", "--db", dbPath, "repo", "list", ...args]);
  } finally {
    process.stdout.write = realWrite;
  }
  return JSON.parse(chunks.join("")) as Row[];
}

describe("dispatch repo list", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "repo-list-"));
    dbPath = join(dir, "dispatch.sqlite");
    const wg = Dispatch.open(dbPath);
    wg.registerRepository(
      {
        name: "notes-cli",
        local_path: "/srv/repos/notes-cli",
        default_branch: "main",
        stack: "node",
        test_command: "npm test",
      },
      human,
    );
    wg.registerRepository({ name: "attic", default_branch: "master" }, human);
    wg.setRepoHidden("attic", true, human);
    wg.db.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists the visible repos with the fields an operator needs (path, branch, stack, gates)", () => {
    const rows = runCli(dbPath);
    expect(rows.map((r) => r.name)).toEqual(["notes-cli"]);
    const r = rows[0]!;
    expect(r.local_path).toBe("/srv/repos/notes-cli");
    expect(r.default_branch).toBe("main");
    expect(r.stack).toBe("node");
    expect(r.test_command).toBe("npm test");
    expect(r.lint_command).toBeNull();
    expect(r.hidden).toBe(false);
  });

  it("--all includes hidden repos and flags them", () => {
    const rows = runCli(dbPath, "--all");
    expect(rows.map((r) => r.name).sort()).toEqual(["attic", "notes-cli"]);
    expect(rows.find((r) => r.name === "attic")?.hidden).toBe(true);
    expect(rows.find((r) => r.name === "attic")?.default_branch).toBe("master");
  });

  it("an empty registry lists nothing (status pane degrades to its onboarding hint)", () => {
    const empty = join(dir, "empty.sqlite");
    Dispatch.open(empty).db.close();
    expect(runCli(empty)).toEqual([]);
  });
});

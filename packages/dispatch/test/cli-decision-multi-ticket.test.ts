import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerDecisions } from "../src/cli/commands/decisions.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";

/**
 * `dispatch decision --ticket <ref>` is repeatable: one question that holds several
 * tickets until a person answers it. The greenfield bootstrap uses it when it creates a
 * repo with no remote while PR mode is on: the epic's tickets for that repo would each
 * fail to open a pull request, so they wait on the one decision. Before, commander kept
 * only the last `--ticket`, so every earlier ticket went ahead unheld.
 */
const human: Actor = { type: "human", id: "tom" };

function runCli(dbPath: string, ...args: string[]): { ok: boolean; decision: { id: string } } {
  const program = new Command();
  program.exitOverride().option("--db <path>", "SQLite database path");
  registerDecisions(program);
  const chunks: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    program.parse(["node", "dispatch", "--db", dbPath, "decision", ...args]);
  } finally {
    process.stdout.write = realWrite;
  }
  return JSON.parse(chunks.join("")) as { ok: boolean; decision: { id: string } };
}

describe("dispatch decision --ticket (repeatable)", () => {
  let dir: string;
  let dbPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "decision-multi-"));
    dbPath = join(dir, "dispatch.sqlite");
    const wg = Dispatch.open(dbPath);
    for (const t of ["Core store", "CLI", "Docs"]) {
      wg.createTicket({ title: t, description: "d" }, human);
    }
    wg.db.close();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const blockers = (ref: string): string[] => {
    const wg = Dispatch.open(dbPath);
    try {
      const id = wg.resolveTicket(ref).id;
      return (
        wg.db
          .prepare(
            "SELECT decision_id FROM ticket_decisions WHERE ticket_id = ? AND relation = 'blocks'",
          )
          .all(id) as { decision_id: string }[]
      ).map((r) => r.decision_id);
    } finally {
      wg.db.close();
    }
  };

  it("one decision blocks every named ticket", () => {
    const out = runCli(
      dbPath,
      "--title",
      "Add a remote",
      "--question",
      "Where does task-app live?",
      "--severity",
      "human_required",
      "--ticket",
      "1",
      "--ticket",
      "#2",
    );
    expect(out.ok).toBe(true);
    expect(blockers("1")).toEqual([out.decision.id]);
    expect(blockers("2")).toEqual([out.decision.id]);
    expect(blockers("3")).toEqual([]);
  });

  it("a single --ticket still links exactly that ticket", () => {
    const out = runCli(dbPath, "--title", "Pick", "--question", "Which?", "--ticket", "3");
    expect(blockers("3")).toEqual([out.decision.id]);
    expect(blockers("1")).toEqual([]);
  });

  it("the same ticket named twice is linked once", () => {
    runCli(dbPath, "--title", "Pick", "--question", "Which?", "--ticket", "2", "--ticket", "2");
    expect(blockers("2")).toHaveLength(1);
  });
});

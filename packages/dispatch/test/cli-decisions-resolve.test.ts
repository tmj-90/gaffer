import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerDecisions } from "../src/cli/commands/decisions.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";

/**
 * `dispatch decisions resolve <id>` — the terminal path to answer a decision. Before
 * it, only the dashboard / REST could clear one, so `gaffer status` listed items a
 * terminal-only operator could never resolve.
 */
const agent: Actor = { type: "agent", id: "delivery" };

function runCli(dbPath: string, ...args: string[]): unknown {
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
    program.parse(["node", "dispatch", "--db", dbPath, "decisions", "resolve", ...args]);
  } finally {
    process.stdout.write = realWrite;
  }
  return JSON.parse(chunks.join(""));
}

describe("dispatch decisions resolve", () => {
  let dir: string;
  let dbPath: string;
  let id: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "decisions-resolve-"));
    dbPath = join(dir, "dispatch.sqlite");
    const wg = Dispatch.open(dbPath);
    id = wg.createDecision(
      { title: "Ledger store", question: "Postgres or SQLite?", severity: "human_required" },
      agent,
    ).id;
    wg.db.close();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const pending = (): string[] => {
    const wg = Dispatch.open(dbPath);
    try {
      return wg.listPendingDecisions().map((d) => d.id);
    } finally {
      wg.db.close();
    }
  };

  it("resolves by the 8-char prefix `gaffer status` shows, recording the answer", () => {
    const out = runCli(dbPath, id.slice(0, 8), "--answer", "SQLite") as {
      ok: boolean;
      decision: { id: string; status: string };
    };
    expect(out).toEqual({ ok: true, decision: { id, status: "accepted" } });
    expect(pending()).not.toContain(id);
    const wg = Dispatch.open(dbPath);
    try {
      const row = wg.db
        .prepare("SELECT resolved_answer, resolved_by FROM decisions WHERE id = ?")
        .get(id) as {
        resolved_answer: string;
        resolved_by: string;
      };
      expect(row.resolved_answer).toBe("SQLite");
    } finally {
      wg.db.close();
    }
  });

  it("--status rejected is accepted; an invalid status is refused by the REST schema", () => {
    expect(() => runCli(dbPath, id, "--status", "maybe")).toThrow();
    expect(pending()).toContain(id);
    const out = runCli(dbPath, id, "--status", "rejected") as { decision: { status: string } };
    expect(out.decision.status).toBe("rejected");
  });

  it("refuses an unknown ref, a too-short prefix, and a second resolve", () => {
    expect(() => runCli(dbPath, "zzzzzzzz")).toThrow(/not found/i);
    expect(() => runCli(dbPath, id.slice(0, 3))).toThrow(/too short.*at least 4/);
    runCli(dbPath, id, "--answer", "x");
    expect(() => runCli(dbPath, id, "--answer", "y")).toThrow(/already/);
  });
});

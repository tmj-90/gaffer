import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerReview } from "../src/cli/commands/review.js";
import { loadCliModules } from "../src/cli/runtime.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";

await loadCliModules();

/**
 * REVIEW COMMENTS on the CLI: `wg review comment` (recorded as the person running it),
 * `wg review comments`, `wg review resolve` / `reopen-comment` / `withdraw-comment` by id
 * prefix, and `wg review fix` (Fix these), driven through the real commander commands
 * against a file-backed DB.
 */
const human: Actor = { type: "human", id: "tom" };
const agentActor: Actor = { type: "agent", id: "runner" };

function seedInReview(dbPath: string): number {
  const wg = Dispatch.open(dbPath);
  wg.registerRepository({ name: "svc", default_branch: "main" }, human);
  const t = wg.createTicket(
    { title: "Ship it", description: "d", policy_pack: "team_light" },
    human,
  );
  wg.linkRepository(t.id, "svc", "primary", human);
  wg.addAcceptanceCriterion({ ticket_id: t.id, text: "Returns 200" }, human);
  wg.markReady(t.id, human);
  const agent = wg.registerAgent({ display_name: "a" }, human);
  const claim = wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, agentActor);
  wg.submitForReview(
    { claimToken: claim!.claimToken, ticket_id: t.id, reason: "done" },
    agentActor,
  );
  wg.db.close();
  return t.number ?? 0;
}

function run(dbPath: string, ...args: string[]): Record<string, unknown> {
  const program = new Command();
  program.exitOverride().option("--db <path>", "SQLite database path");
  registerReview(program);
  const chunks: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    program.parse(["node", "dispatch", "--db", dbPath, "review", ...args]);
  } finally {
    process.stdout.write = realWrite;
  }
  return JSON.parse(chunks.join("")) as Record<string, unknown>;
}

describe("CLI: review comment / comments / resolve / fix", () => {
  let dir: string;
  let dbPath: string;
  let number: number;
  const user = process.env.USER;
  beforeEach(() => {
    process.env.DISPATCH_AUDIT_OFF = "1";
    process.env.USER = "alice";
    dir = mkdtempSync(join(tmpdir(), "wg-cli-comments-"));
    dbPath = join(dir, "dispatch.sqlite");
    number = seedInReview(dbPath);
  });
  afterEach(() => {
    if (user === undefined) delete process.env.USER;
    else process.env.USER = user;
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes, lists, resolves and sends back with the comments", () => {
    const made = run(dbPath, "comment", String(number), "--body", "add a test", "--must-fix");
    const c = made.comment as { id: string; short_id: string; author_id: string; severity: string };
    expect(c).toMatchObject({ author_id: "alice", severity: "must_fix" });
    run(dbPath, "comment", String(number), "--body", "maybe rename");
    const list = run(dbPath, "comments", String(number), "--open");
    expect(list.counts).toEqual({ open: 2, open_must_fix: 1, resolved: 0, withdrawn: 0 });
    expect((run(dbPath, "resolve", c.short_id).comment as { status: string }).status).toBe(
      "resolved",
    );
    expect((run(dbPath, "reopen-comment", c.short_id).comment as { status: string }).status).toBe(
      "open",
    );
    const fix = run(dbPath, "fix", String(number));
    expect(fix).toMatchObject({ ok: true, status: "refining", requirements: [c.short_id] });
    expect((fix.reject_outcome as { kind: string }).kind).toBe("to_refining");
    const wg = Dispatch.open(dbPath);
    try {
      const ev = wg.db
        .prepare(
          "SELECT json_extract(payload_json, '$.reason') AS r FROM work_events WHERE event_type = 'ticket.transitioned' ORDER BY rowid DESC LIMIT 1",
        )
        .get() as { r: string };
      expect(ev.r).toBe(`Fix these: 1 requirement (${c.short_id})`);
    } finally {
      wg.db.close();
    }
  });
});

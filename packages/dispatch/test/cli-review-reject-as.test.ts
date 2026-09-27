import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerReview } from "../src/cli/commands/review.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";

/**
 * B20d — `dispatch review reject --as agent|system`. The runner's two rejection sites
 * (the reviewer agent's CHANGES verdict in review.sh, the CI gate in tick.sh) had no
 * way to say who was rejecting, so every runner rejection was recorded as a HUMAN
 * decision — and the autonomy recommendations, which count only human/admin decisions
 * as ground truth, treated runner rework as human disagreement. Drives the real
 * commander command against a file-backed DB and reads the recorded actor back.
 */
const human: Actor = { type: "human", id: "tom" };
const agentActor: Actor = { type: "agent", id: "runner" };

function seedInReview(dbPath: string): number {
  const wg = Dispatch.open(dbPath);
  wg.registerRepository({ name: "svc", default_branch: "main" }, human);
  const t = wg.createTicket(
    { title: "Ship it", description: "deliver", policy_pack: "team_light" },
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

function runReject(dbPath: string, ...args: string[]): unknown {
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
    program.parse(["node", "dispatch", "--db", dbPath, "review", "reject", ...args]);
  } finally {
    process.stdout.write = realWrite;
  }
  const text = chunks.join("");
  return text ? JSON.parse(text) : null;
}

/** The actor recorded on the ticket's most recent transition event. */
function lastTransitionActor(dbPath: string): { actor_type: string; actor_id: string | null } {
  const wg = Dispatch.open(dbPath);
  try {
    return wg.db
      .prepare(
        "SELECT actor_type, actor_id FROM work_events WHERE event_type = 'ticket.transitioned' " +
          "ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get() as { actor_type: string; actor_id: string | null };
  } finally {
    wg.db.close();
  }
}

describe("CLI: review reject --as (runner rejections are not human decisions)", () => {
  let dir: string;
  let dbPath: string;
  let number: number;

  beforeEach(() => {
    process.env.DISPATCH_AUDIT_OFF = "1";
    dir = mkdtempSync(join(tmpdir(), "wg-cli-reject-"));
    dbPath = join(dir, "dispatch.sqlite");
    number = seedInReview(dbPath);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("defaults to a human reviewer (unchanged behaviour)", () => {
    const out = runReject(dbPath, String(number), "--reason", "nope", "--reviewer", "tom") as {
      ok: boolean;
      status: string;
    };
    expect(out.ok).toBe(true);
    expect(out.status).toBe("refining");
    expect(lastTransitionActor(dbPath)).toEqual({ actor_type: "human", actor_id: "tom" });
  });

  it("--as agent records the reviewer agent's verdict as an AGENT decision", () => {
    const out = runReject(
      dbPath,
      String(number),
      "--reason",
      "RECOMMEND CHANGES: add a test",
      "--to",
      "ready",
      "--as",
      "agent",
      "--reviewer",
      "agent-1/reviewer",
    ) as { status: string };
    expect(out.status).toBe("ready");
    expect(lastTransitionActor(dbPath)).toEqual({
      actor_type: "agent",
      actor_id: "agent-1/reviewer",
    });
  });

  it("--as system records a runner gate (CI) as a SYSTEM decision, keeping the gate's id", () => {
    runReject(
      dbPath,
      String(number),
      "--reason",
      "H3: CI checks failed",
      "--as",
      "system",
      "--reviewer",
      "factory-ci",
    );
    expect(lastTransitionActor(dbPath)).toEqual({ actor_type: "system", actor_id: "factory-ci" });
  });

  it("runner rejections do not count toward the autonomy recommendations' ground truth", () => {
    // The recommendation service treats only human/admin decisions as evidence; a
    // system/agent rejection must leave the human-decision tally untouched.
    const countTransitions = (actorTypes: string): number => {
      const wg = Dispatch.open(dbPath);
      try {
        return (
          wg.db
            .prepare(
              "SELECT COUNT(*) AS n FROM work_events WHERE event_type = 'ticket.transitioned' " +
                `AND actor_type IN (${actorTypes})`,
            )
            .get() as { n: number }
        ).n;
      } finally {
        wg.db.close();
      }
    };
    const humanBefore = countTransitions("'human','admin'");
    const systemBefore = countTransitions("'system'");
    runReject(dbPath, String(number), "--reason", "CI red", "--as", "system", "--reviewer", "ci");
    expect(countTransitions("'system'")).toBe(systemBefore + 1);
    expect(countTransitions("'human','admin'")).toBe(humanBefore);
  });

  it("rejects an unknown --as", () => {
    expect(() => runReject(dbPath, String(number), "--reason", "x", "--as", "robot")).toThrow(
      /--as must be/,
    );
  });
});

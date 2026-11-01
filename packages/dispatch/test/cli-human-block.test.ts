import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { listEvents } from "../src/events/eventWriter.js";

import { errorCode, runCli } from "./helpers/cli.js";

/**
 * Exploratory finding cli-wg/F-03: `wg block <n> --reason …` always acted as an
 * agent and demanded a claim token (CLAIM_REQUIRED), `ticket move <n> blocked` from
 * ready was an illegal transition, and there was no `unblock` (the runner's park
 * message said "then unblock" without naming a command). A human now blocks a draft,
 * refining, ready or by-hand (human-owned in_progress) ticket with `wg block` (no
 * --token: the actor is $USER) and returns it with `wg unblock`. The new edges are
 * legal only through that human path; an agent's block keeps its claim-token rule.
 */
const human: Actor = { type: "human", id: "tom" };
const agentActor: Actor = { type: "agent", id: "runner" };

function lastEvent(db: string, ref: string, type: string) {
  const wg = Dispatch.open(db);
  try {
    const t = wg.resolveTicket(ref);
    const evs = listEvents(wg.db, "ticket", t.id).filter((e) => e.event_type === type);
    return evs[evs.length - 1];
  } finally {
    wg.db.close();
  }
}

function status(db: string, ref: string): string {
  const wg = Dispatch.open(db);
  try {
    return wg.resolveTicket(ref).status;
  } finally {
    wg.db.close();
  }
}

describe("cli-wg F-03: a human blocks and unblocks from the CLI", () => {
  let dir: string;
  let db: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wg-block-"));
    db = join(dir, "d.sqlite");
    const wg = Dispatch.open(db);
    wg.registerRepository({ name: "svc", default_branch: "main" }, human);
    const ids: string[] = [];
    for (const title of ["one", "two", "three"]) {
      const t = wg.createTicket({ title, description: "d" }, human);
      wg.linkRepository(t.id, "svc", "primary", human);
      wg.addAcceptanceCriterion({ ticket_id: t.id, text: "works" }, human);
      ids.push(t.id);
    }
    wg.markReady(ids[0]!, human);
    wg.moveTicket(ids[1]!, "refining", human);
    wg.db.close();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("blocks a ready ticket as $USER without a token, and unblock returns it to ready", () => {
    const r = runCli(db, ["block", "1", "--reason", "waiting on infra"], { USER: "alice" });
    expect(r.error).toBeUndefined();
    expect(status(db, "1")).toBe("blocked");
    const ev = lastEvent(db, "1", "ticket.blocked")!;
    expect(`${ev.actor_type}:${ev.actor_id}`).toBe("human:alice");
    expect(JSON.parse(ev.payload_json ?? "{}")).toMatchObject({
      reason: "waiting on infra",
      from: "ready",
    });

    const u = runCli(db, ["unblock", "1"], { USER: "alice" });
    expect(u.error).toBeUndefined();
    expect((u.json as { status: string }).status).toBe("ready");
    expect(status(db, "1")).toBe("ready");
    const ue = lastEvent(db, "1", "ticket.unblocked")!;
    expect(`${ue.actor_type}:${ue.actor_id}`).toBe("human:alice");
  });

  it("a draft or refining ticket returns to where it was blocked from", () => {
    expect(runCli(db, ["block", "3", "--reason", "x"]).error).toBeUndefined();
    expect(runCli(db, ["block", "2", "--reason", "x"]).error).toBeUndefined();
    expect(runCli(db, ["unblock", "3"]).error).toBeUndefined();
    expect(runCli(db, ["unblock", "2"]).error).toBeUndefined();
    expect(status(db, "3")).toBe("draft");
    expect(status(db, "2")).toBe("refining");
  });

  it("--to picks the status; unblocking a ticket that is not blocked is refused", () => {
    runCli(db, ["block", "1", "--reason", "x"]);
    expect(runCli(db, ["unblock", "1", "--to", "refining"]).error).toBeUndefined();
    expect(status(db, "1")).toBe("refining");
    expect(errorCode(runCli(db, ["unblock", "1"]).error)).toBe("STATE_CONFLICT");
    expect(errorCode(runCli(db, ["unblock", "1", "--to", "done"]).error)).toBe("VALIDATION_ERROR");
  });

  it("blocks a ticket the human took by hand; an agent-claimed ticket needs the token path", () => {
    let wg = Dispatch.open(db);
    wg.humanClaimTicket("1", human);
    wg.db.close();
    expect(status(db, "1")).toBe("in_progress");
    expect(runCli(db, ["block", "1", "--reason", "stuck"]).error).toBeUndefined();
    expect(status(db, "1")).toBe("blocked");
    expect(runCli(db, ["unblock", "1"]).error).toBeUndefined();
    expect(status(db, "1")).toBe("ready");

    wg = Dispatch.open(db);
    const agent = wg.registerAgent({ display_name: "a" }, human);
    const claim = wg.claimTicket(
      { ticket_id: wg.resolveTicket("1").id, agent_id: agent.id, ttl_seconds: 600 },
      agentActor,
    );
    wg.db.close();
    // No token: a human cannot block an agent's live claim from here.
    expect(errorCode(runCli(db, ["block", "1", "--reason", "x"]).error)).toBe("STATE_CONFLICT");
    expect(status(db, "1")).toBe("claimed");
    // The agent's own claim-token path is unchanged.
    const viaToken = runCli(db, [
      "block",
      "1",
      "--reason",
      "agent stuck",
      "--token",
      claim.claimToken,
    ]);
    expect(viaToken.error).toBeUndefined();
    expect(status(db, "1")).toBe("blocked");
    const ev = lastEvent(db, "1", "ticket.blocked")!;
    expect(ev.actor_type).toBe("agent");
  });

  it("a board move still cannot block a ready ticket, and only a human or admin may take the edge", () => {
    expect(errorCode(runCli(db, ["ticket", "move", "1", "blocked"]).error)).toBe(
      "ILLEGAL_TRANSITION",
    );
    const wg = Dispatch.open(db);
    try {
      expect(() => wg.humanBlockTicket("1", "x", agentActor)).toThrow(/human or admin/);
      expect(() => wg.humanBlockTicket("1", "x", { type: "system" })).toThrow(/human or admin/);
      expect(wg.resolveTicket("1").status).toBe("ready");
    } finally {
      wg.db.close();
    }
  });

  it("the runner's park messages name the unblock command", () => {
    const tick = readFileSync(join(__dirname, "../../../runner/tick.sh"), "utf8");
    const parks = tick.split("\n").filter((l) => /then unblock/.test(l));
    expect(parks.length).toBeGreaterThan(0);
    // Single quotes inside the bash double-quoted message: literal, and $NUM expands.
    for (const line of parks) expect(line).toMatch(/then unblock it \('gaffer wg unblock \$NUM'\)/);
  });
});

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { listEvents } from "../src/events/eventWriter.js";
import { makeHandlers } from "../src/mcp/tools.js";
import { contractHash } from "../src/util/contractHash.js";

import { errorCode, runCli } from "./helpers/cli.js";

/**
 * Adversarial review of Package B1 (cli-editing-and-actors): the edges the package's own
 * tests do not reach. The contract freeze must cover every write that feeds the tester's
 * contract hash (`ticket test-contract` included), a refused ready-ticket edit must leave
 * every field as it was, the human block edges must not open a way past a ready gate, and
 * an unblock returns a ticket to the status it was really blocked from.
 */
const human: Actor = { type: "human", id: "tom" };
const agentActor: Actor = { type: "agent", id: "runner" };

function ticketEvents(wg: Dispatch, ref: string) {
  return listEvents(wg.db, "ticket", wg.resolveTicket(ref).id);
}

describe("B1 review: contract freeze edges", () => {
  let dir: string;
  let db: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wg-b1-review-"));
    db = join(dir, "d.sqlite");
    const wg = Dispatch.open(db);
    wg.registerRepository({ name: "svc", default_branch: "main" }, human);
    wg.db.close();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a ready-ticket edit that fails the gate changes nothing: title, description, version, events", () => {
    runCli(db, ["ticket", "create", "-t", "orig title", "-d", "orig desc", "-p", "team_light"]);
    runCli(db, ["ac", "add", "1", "-t", "only"]);
    runCli(db, ["ticket", "repo-access", "set", "1", "svc"]);
    expect(runCli(db, ["ticket", "ready", "1"]).error).toBeUndefined();
    let wg = Dispatch.open(db);
    const before = wg.resolveTicket("1");
    const nEvents = ticketEvents(wg, "1").length;
    wg.db.close();

    const r = runCli(db, ["ticket", "edit", "1", "-t", "new title", "-d", ""]);
    expect(errorCode(r.error)).toBe("POLICY_DENIED");

    wg = Dispatch.open(db);
    const after = wg.resolveTicket("1");
    expect(after.title).toBe("orig title");
    expect(after.description).toBe("orig desc");
    expect(after.row_version).toBe(before.row_version);
    expect(after.status).toBe("ready");
    expect(ticketEvents(wg, "1").length).toBe(nEvents);
    wg.db.close();
  });

  it("removing the last criterion of a ready solo_loose ticket is refused (ready needs one)", () => {
    runCli(db, ["ticket", "create", "-t", "loose"]);
    runCli(db, ["ac", "add", "1", "-t", "only"]);
    runCli(db, ["ticket", "repo-access", "set", "1", "svc"]);
    expect(runCli(db, ["ticket", "ready", "1"]).error).toBeUndefined();
    expect(errorCode(runCli(db, ["ac", "rm", "1", "1"]).error)).toBe("POLICY_DENIED");
    const wg = Dispatch.open(db);
    expect(wg.resolveTicket("1").status).toBe("ready");
    expect(wg.view("1").acceptanceCriteria).toHaveLength(1);
    wg.db.close();
  });

  it("ticket test-contract is frozen from in_testing on (the tester's contract hash), editable before", () => {
    runCli(db, ["ticket", "create", "-t", "x"]);
    runCli(db, ["ac", "add", "1", "-t", "a"]);
    const set = (status: string) => {
      const wg = Dispatch.open(db);
      wg.db.prepare("UPDATE tickets SET status = ? WHERE number = 1").run(status);
      wg.db.close();
    };
    // Before testing the implementer, the reviewer or a person writes the handover.
    for (const status of [
      "draft",
      "refining",
      "ready",
      "blocked",
      "claimed",
      "in_progress",
      "in_review",
    ]) {
      set(status);
      const r = runCli(db, ["ticket", "test-contract", "1", "--run", `npm start ${status}`]);
      expect(r.error, status).toBeUndefined();
    }
    for (const status of [
      "in_testing",
      "ready_for_merge",
      "done",
      "cancelled",
      "failed",
      "paused",
    ]) {
      set(status);
      const wg = Dispatch.open(db);
      const hash = contractHash(wg.db, wg.resolveTicket("1").id);
      wg.db.close();
      const r = runCli(db, ["ticket", "test-contract", "1", "--run", "echo pwned"]);
      expect(errorCode(r.error), status).toBe("CONTRACT_FROZEN");
      const wg2 = Dispatch.open(db);
      expect(contractHash(wg2.db, wg2.resolveTicket("1").id), status).toBe(hash);
      wg2.db.close();
    }
  });

  it("MCP set_test_contract on the mount's own in_testing ticket is refused", () => {
    const keys = ["GAFFER_FACTORY", "GAFFER_SCOPE_TICKET"] as const;
    const saved = keys.map((k) => process.env[k]);
    const wg = Dispatch.open(":memory:");
    try {
      const t = wg.createTicket({ title: "x" }, human);
      wg.addAcceptanceCriterion({ ticket_id: t.id, text: "a" }, human);
      wg.db.prepare("UPDATE tickets SET status = 'in_testing' WHERE id = ?").run(t.id);
      process.env.GAFFER_FACTORY = "1";
      process.env.GAFFER_SCOPE_TICKET = String(t.number);
      const h = makeHandlers(wg, { type: "agent", id: "mcp-agent" });
      const res = h.set_test_contract({ ticket_id: t.id, changed_surfaces: ["nothing"] });
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res)).toMatch(/CONTRACT_FROZEN/);
      expect(wg.resolveTicket(t.id).test_contract).toBeNull();
    } finally {
      keys.forEach((k, i) => {
        if (saved[i] === undefined) delete process.env[k];
        else process.env[k] = saved[i];
      });
      wg.db.close();
    }
  });

  it("a ticket blocked after an attempt is editable, every edit is an event, and the next claim sees it", () => {
    let wg = Dispatch.open(db);
    const t = wg.createTicket({ title: "first", description: "d" }, human);
    wg.linkRepository(t.id, "svc", "primary", human);
    wg.addAcceptanceCriterion({ ticket_id: t.id, text: "old criterion" }, human);
    wg.markReady(t.id, human);
    const agent = wg.registerAgent({ display_name: "a" }, human);
    const claim = wg.claimTicket(
      { ticket_id: t.id, agent_id: agent.id, ttl_seconds: 600 },
      agentActor,
    );
    wg.markBlocked({ claimToken: claim.claimToken, ticket_id: t.id, reason: "stuck" }, agentActor);
    expect(wg.resolveTicket(t.id).status).toBe("blocked");
    const hashBefore = contractHash(wg.db, t.id);
    wg.db.close();

    expect(runCli(db, ["ticket", "edit", "1", "-t", "second"], { USER: "alice" }).error).toBe(
      undefined,
    );
    expect(
      runCli(db, ["ac", "edit", "1", "1", "-t", "new criterion"], { USER: "alice" }).error,
    ).toBeUndefined();
    expect(runCli(db, ["ac", "add", "1", "-t", "another"], { USER: "alice" }).error).toBe(
      undefined,
    );

    wg = Dispatch.open(db);
    const evs = ticketEvents(wg, "1");
    for (const type of ["ticket.edited", "ac.edited", "ac.added"]) {
      const ev = evs.filter((e) => e.event_type === type).pop();
      expect(ev, type).toBeDefined();
      expect(`${ev!.actor_type}:${ev!.actor_id}`).toBe("human:alice");
    }
    expect(contractHash(wg.db, t.id)).not.toBe(hashBefore);
    wg.db.close();

    expect(runCli(db, ["unblock", "1"]).error).toBeUndefined();
    wg = Dispatch.open(db);
    expect(wg.resolveTicket(t.id).status).toBe("ready");
    const again = wg.claimTicket(
      { ticket_id: t.id, agent_id: agent.id, ttl_seconds: 600 },
      agentActor,
    );
    expect(again.claimToken).toBeTruthy();
    const view = wg.view(t.id);
    expect(view.ticket.title).toBe("second");
    expect(view.acceptanceCriteria.map((a) => a.text)).toEqual(["new criterion", "another"]);
    expect(view.acceptanceCriteria.every((a) => a.status === "pending")).toBe(true);
    wg.db.close();
  });
});

describe("B1 review: one-line text on every surface, multi-line descriptions kept", () => {
  it("MCP create_ticket / add_acceptance_criterion refuse a newline; descriptions keep theirs", () => {
    const wg = Dispatch.open(":memory:");
    try {
      const h = makeHandlers(wg, human);
      const bad = h.create_ticket({ title: "a\nb" });
      expect(bad.isError).toBe(true);
      const good = h.create_ticket({ title: "ok", description: "line one\nline two" });
      expect(good.isError).toBeUndefined();
      const id = (good.structuredContent as { ticket_id: string }).ticket_id;
      expect(wg.resolveTicket(id).description).toBe("line one\nline two");
      const badAc = h.add_acceptance_criterion({ ticket_id: id, text: "x\u0000y" });
      expect(badAc.isError).toBe(true);
      expect(wg.view(id).acceptanceCriteria).toHaveLength(0);
      // ticket edit keeps a multi-line description too, and refuses a newline title.
      const edited = wg.editTicket(id, { description: "a\nb\n\nc" }, human);
      expect(edited.ticket.description).toBe("a\nb\n\nc");
      expect(() => wg.editTicket(id, { title: "x\ry" }, human)).toThrow();
      expect(() =>
        wg.editAcceptanceCriterion(id, "1", { text: "late\n" + "line" }, human),
      ).toThrow();
    } finally {
      wg.db.close();
    }
  });

  it("a planner's multi-line title and criterion collapse to one line; the description keeps its lines", () => {
    const wg = Dispatch.open(":memory:");
    try {
      const res = wg.createEpic(
        {
          epic: { name: "E", description: "brief" },
          tickets: [
            {
              title: "Build\nthe\tthing",
              description: "para one\n\npara two",
              acceptanceCriteria: ["it\nworks"],
            },
          ],
        },
        human,
      );
      const t = wg.resolveTicket(String(res.ticketNumbers[0]));
      expect(t.title).toBe("Build the thing");
      expect(t.description).toBe("para one\n\npara two");
      expect(wg.view(t.id).acceptanceCriteria[0]!.text).toBe("it works");
    } finally {
      wg.db.close();
    }
  });
});

describe("B1 review: the runner delivers against the frozen contract", () => {
  it("tick.sh re-reads the ticket after its claim, before the prompt uses it", () => {
    const tick = readFileSync(join(__dirname, "../../../runner/tick.sh"), "utf8");
    const claimAt = tick.indexOf('wg claim-ticket "$_cand"');
    const rereadAt = tick.indexOf('wg ticket show "$_cand"', claimAt);
    const useAt = tick.indexOf('SHOW="$_cshow"', claimAt);
    expect(claimAt).toBeGreaterThan(0);
    expect(rereadAt).toBeGreaterThan(claimAt);
    expect(useAt).toBeGreaterThan(rereadAt);
  });
});

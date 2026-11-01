import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApiServer } from "../src/api/server.js";
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

describe("B1 review: the human block edges cannot skip a gate", () => {
  let dir: string;
  let db: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wg-b1-block-"));
    db = join(dir, "d.sqlite");
    const wg = Dispatch.open(db);
    wg.registerRepository({ name: "svc", default_branch: "main" }, human);
    // #1: a draft with no criterion at all.
    const bare = wg.createTicket({ title: "bare draft" }, human);
    wg.linkRepository(bare.id, "svc", "primary", human);
    // #2: a ready ticket.
    const ok = wg.createTicket({ title: "ready one", description: "d" }, human);
    wg.linkRepository(ok.id, "svc", "primary", human);
    wg.addAcceptanceCriterion({ ticket_id: ok.id, text: "works" }, human);
    wg.markReady(ok.id, human);
    wg.db.close();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("unblock --to ready on a ticket with no criterion is refused and it stays blocked", () => {
    expect(runCli(db, ["block", "1", "--reason", "parked"]).error).toBeUndefined();
    const r = runCli(db, ["unblock", "1", "--to", "ready"]);
    expect(errorCode(r.error)).toBe("POLICY_DENIED");
    let wg = Dispatch.open(db);
    expect(wg.resolveTicket("1").status).toBe("blocked");
    wg.db.close();
    // Nor does a board drag of the blocked card get it there.
    expect(errorCode(runCli(db, ["ticket", "move", "1", "ready"]).error)).toBe("POLICY_DENIED");
    wg = Dispatch.open(db);
    expect(wg.resolveTicket("1").status).toBe("blocked");
    wg.db.close();
    // Its default target is where it came from.
    expect(runCli(db, ["unblock", "1"]).error).toBeUndefined();
    wg = Dispatch.open(db);
    expect(wg.resolveTicket("1").status).toBe("draft");
    wg.db.close();
  });

  it("board moves (CLI, agent, system) cannot take the block-only edges", () => {
    const wg = Dispatch.open(db);
    try {
      for (const actor of [human, agentActor, { type: "system" } as Actor]) {
        expect(() => wg.moveTicket("2", "blocked", actor), actor.type).toThrow();
        expect(wg.resolveTicket("2").status).toBe("ready");
      }
      wg.humanBlockTicket("1", "parked", human);
      for (const actor of [human, agentActor, { type: "system" } as Actor]) {
        let code: string | undefined;
        try {
          wg.moveTicket("1", "draft", actor);
        } catch (e) {
          code = errorCode(e);
        }
        expect(code, actor.type).toBe("ILLEGAL_TRANSITION");
      }
      expect(wg.resolveTicket("1").status).toBe("blocked");
      // An agent and the runner cannot use the human block / unblock paths at all.
      expect(() => wg.humanUnblockTicket("1", agentActor)).toThrow(/human or admin/);
      expect(() => wg.humanUnblockTicket("1", { type: "system" })).toThrow(/human or admin/);
    } finally {
      wg.db.close();
    }
  });

  it("unblock follows the LAST block, not an older human block from draft", () => {
    // A human blocks #2's twin from draft and returns it; later it is readied, taken by
    // hand and parked from in_progress by a board move. Unblock must go to ready.
    let wg = Dispatch.open(db);
    const t = wg.createTicket({ title: "twin", description: "d" }, human);
    wg.linkRepository(t.id, "svc", "primary", human);
    wg.addAcceptanceCriterion({ ticket_id: t.id, text: "works" }, human);
    wg.humanBlockTicket(t.id, "wait", human);
    wg.humanUnblockTicket(t.id, human);
    expect(wg.resolveTicket(t.id).status).toBe("draft");
    wg.markReady(t.id, human);
    wg.humanClaimTicket(t.id, human);
    expect(wg.resolveTicket(t.id).status).toBe("in_progress");
    wg.moveTicket(t.id, "blocked", human);
    expect(wg.resolveTicket(t.id).status).toBe("blocked");
    const res = wg.humanUnblockTicket(t.id, human);
    expect(res.status).toBe("ready");
    wg.db.close();
    wg = Dispatch.open(db);
    expect(wg.resolveTicket(t.id).status).toBe("ready");
    expect(wg.resolveTicket(t.id).human_owner).toBeNull();
    wg.db.close();
  });

  describe("REST", () => {
    let close: (() => Promise<void>) | undefined;
    const savedToken = process.env.DISPATCH_API_TOKEN;
    afterEach(async () => {
      await close?.();
      close = undefined;
      if (savedToken === undefined) delete process.env.DISPATCH_API_TOKEN;
      else process.env.DISPATCH_API_TOKEN = savedToken;
    });

    it("POST /tickets/:id/move (the dashboard card Move) cannot block or un-block to draft", async () => {
      process.env.DISPATCH_API_TOKEN = "b1-review-test-token-0123456789abcdef";
      const wg = Dispatch.open(db);
      const server = createApiServer(wg);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      close = () =>
        new Promise<void>((resolve) =>
          server.close(() => {
            wg.db.close();
            resolve();
          }),
        );
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const move = async (ref: string, to: string) => {
        const id = wg.resolveTicket(ref).id;
        const res = await fetch(`${base}/tickets/${id}/move`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${process.env.DISPATCH_API_TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ to }),
        });
        return { status: res.status, body: (await res.json()) as { error?: { code: string } } };
      };
      const r1 = await move("2", "blocked");
      expect(r1.status).toBe(409);
      expect(r1.body.error?.code).toBe("ILLEGAL_TRANSITION");
      expect(wg.resolveTicket("2").status).toBe("ready");
      wg.humanBlockTicket("1", "parked", human);
      const r2 = await move("1", "draft");
      expect(r2.status).toBe(409);
      expect(r2.body.error?.code).toBe("ILLEGAL_TRANSITION");
      const r3 = await move("1", "ready");
      expect(r3.body.error?.code).toBe("POLICY_DENIED");
      expect(wg.resolveTicket("1").status).toBe("blocked");
    });
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

describe("B1 review: the greenfield inherit is recorded as system, and only for the epic's own repo", () => {
  let dir: string;
  let db: string;
  let outside: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wg-b1-inherit-"));
    db = join(dir, "d.sqlite");
    const wg = Dispatch.open(db);
    // A greenfield epic: #1 bootstrap (onboarded "app"), #2 its sibling (a greenfield
    // epic always gets its acceptance ticket too). "other" is an unrelated repo, and
    // `outside` a ticket in no epic.
    const epic = wg.createEpic(
      {
        epic: { name: "App", description: "brief" },
        tickets: [
          { title: "Bootstrap app", bootstrap: true, acceptanceCriteria: ["scaffolded"] },
          { title: "Feature", acceptanceCriteria: ["works"], dependsOn: [0] },
        ],
      },
      human,
    );
    expect(epic.ticketNumbers.slice(0, 2)).toEqual([1, 2]);
    wg.registerRepository({ name: "app", default_branch: "main" }, human);
    wg.registerRepository({ name: "other", default_branch: "main" }, human);
    wg.linkRepository(wg.resolveTicket("1").id, "app", "primary", { type: "system" });
    outside = String(wg.createTicket({ title: "unrelated" }, human).number);
    wg.db.close();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("ticket repo-access inherit sets write+confirmed on the sibling as system", () => {
    const r = runCli(db, ["ticket", "repo-access", "inherit", "2", "app"], { USER: "alice" });
    expect(r.error).toBeUndefined();
    const wg = Dispatch.open(db);
    try {
      const packet = wg.workPacketRepos("2");
      expect(packet.writeRepos.map((l) => l.name)).toEqual(["app"]);
      const ev = ticketEvents(wg, "2")
        .filter((e) => e.event_type === "ticket.repo_access_set")
        .pop()!;
      expect(`${ev.actor_type}:${ev.actor_id ?? ""}`).toBe("system:");
      expect(JSON.parse(ev.payload_json ?? "{}")).toMatchObject({
        access: "write",
        relation: "confirmed",
      });
    } finally {
      wg.db.close();
    }
  });

  it("refuses any other repo, the bootstrap itself, a ticket outside the epic, and a non-system actor", () => {
    for (const args of [
      ["ticket", "repo-access", "inherit", "2", "other"],
      ["ticket", "repo-access", "inherit", "1", "app"],
      ["ticket", "repo-access", "inherit", outside, "app"],
    ]) {
      expect(errorCode(runCli(db, args).error), args.join(" ")).toBe("ACTOR_NOT_PERMITTED");
    }
    const wg = Dispatch.open(db);
    try {
      for (const actor of [human, agentActor, { type: "admin", id: "root" } as Actor]) {
        let code: string | undefined;
        try {
          wg.inheritBootstrapRepoAccess("2", "app", actor);
        } catch (e) {
          code = errorCode(e);
        }
        expect(code, actor.type).toBe("ACTOR_NOT_PERMITTED");
      }
      expect(wg.workPacketRepos("2").writeRepos).toHaveLength(0);
      // The person's boundary rule is unchanged: the system still cannot use `set`.
      expect(() =>
        wg.setTicketRepoAccess({ ticket_id: "2", repo_id: "app" }, { type: "system" }),
      ).toThrow(/human or admin/);
    } finally {
      wg.db.close();
    }
  });

  it("lib/greenfield.sh links through the system path, never `repo-access set`", () => {
    const lib = readFileSync(join(__dirname, "../../../runner/lib/greenfield.sh"), "utf8");
    const writes = lib
      .split("\n")
      .filter((l) => !/^\s*#/.test(l) && /\bwg ticket repo-access\b/.test(l));
    expect(writes).toHaveLength(2);
    for (const line of writes) expect(line, line.trim()).toMatch(/repo-access inherit\b/);
  });
});

describe("B1 review: the runner's park messages name commands that exist", () => {
  it("the no-local-checkout park names onboard + repo-access set, never a `repo update`", () => {
    const tick = readFileSync(join(__dirname, "../../../runner/tick.sh"), "utf8");
    expect(tick).not.toMatch(/repo update/);
    const parks = tick
      .split("\n")
      .filter((l) => /gaffer_release_delivery blocked .*no local checkout/.test(l));
    expect(parks).toHaveLength(2);
    for (const line of parks) {
      expect(line).toMatch(/'gaffer onboard <dir>'/);
      expect(line).toMatch(/'gaffer wg ticket repo-access set \$NUM <repo>'/);
      expect(line).toMatch(/then unblock it \('gaffer wg unblock \$NUM'\)/);
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

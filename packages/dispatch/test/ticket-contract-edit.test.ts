import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApiServer } from "../src/api/server.js";
import { Dispatch } from "../src/core.js";
import type { Actor, TicketStatus } from "../src/domain/types.js";
import { listEvents } from "../src/events/eventWriter.js";
import { makeHandlers } from "../src/mcp/tools.js";

import { errorCode, runCli } from "./helpers/cli.js";

/**
 * Exploratory findings cli-wg/F-02 + F-17 and api-robustness/F3.
 *
 * F-02: a ticket and its criteria could not be edited, so a ready-gate refusal on a
 * missing field (DESCRIPTION_REQUIRED, AC_VERIFICATION_REQUIRED) could never be fixed;
 * the only way out was won't-do and re-create. `wg ticket edit`, `wg ac edit`, `wg ac
 * rm` and REST PATCH /tickets/{id}, PATCH/DELETE /tickets/{id}/acceptance-criteria/{acId}
 * now exist, each writing an event.
 *
 * F3: the contract (title, description, criteria, check commands, policy) was
 * changeable at any status: a done ticket accepted a new criterion, and a factory
 * mount added a check command to its own in_review ticket. From claimed onward the
 * review and the tester are bound to the contract, so every contract edit (the
 * existing AC add included) is refused there with 409 CONTRACT_FROZEN.
 *
 * F-17: the quickstart's strict-pack recipe did not make Mark ready succeed.
 */
const human: Actor = { type: "human", id: "tom" };
const agentActor: Actor = { type: "agent", id: "runner" };
const FROZEN: TicketStatus[] = [
  "claimed",
  "in_progress",
  "in_review",
  "in_testing",
  "ready_for_merge",
  "done",
  "cancelled",
  "failed",
  "paused",
];

function setStatus(db: string, number: number, status: TicketStatus): void {
  const wg = Dispatch.open(db);
  wg.db.prepare("UPDATE tickets SET status = ? WHERE number = ?").run(status, number);
  wg.db.close();
}

function events(db: string, ref: string): Array<{ event_type: string; payload_json: string }> {
  const wg = Dispatch.open(db);
  try {
    const t = wg.resolveTicket(ref);
    return listEvents(wg.db, "ticket", t.id) as unknown as Array<{
      event_type: string;
      payload_json: string;
    }>;
  } finally {
    wg.db.close();
  }
}

describe("cli-wg F-02: wg ticket edit / ac edit / ac rm fix every ready-gate refusal", () => {
  let dir: string;
  let db: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wg-edit-"));
    db = join(dir, "d.sqlite");
    const wg = Dispatch.open(db);
    wg.registerRepository({ name: "svc", default_branch: "main" }, human);
    wg.db.close();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("team_light without a description warns at create; ticket edit -d makes it readyable", () => {
    const created = runCli(db, ["ticket", "create", "-t", "team ticket", "-p", "team_light"]);
    expect(created.error).toBeUndefined();
    expect(created.stderr).toMatch(/DESCRIPTION_REQUIRED/);
    expect(created.stderr).toMatch(/ticket edit 1 -d/);
    expect((created.json as { warnings: Array<{ code: string }> }).warnings[0]!.code).toBe(
      "DESCRIPTION_REQUIRED",
    );
    runCli(db, ["ac", "add", "1", "-t", "works"]);
    runCli(db, ["ticket", "repo-access", "set", "1", "svc"]);
    const denied = runCli(db, ["ticket", "ready", "1"]);
    expect(errorCode(denied.error)).toBe("POLICY_DENIED");

    const edit = runCli(db, ["ticket", "edit", "1", "-d", "what and why"]);
    expect(edit.error).toBeUndefined();
    expect(runCli(db, ["ticket", "ready", "1"]).error).toBeUndefined();
    const ev = events(db, "1").find((e) => e.event_type === "ticket.edited");
    expect(ev).toBeDefined();
    expect(JSON.parse(ev!.payload_json).changed).toEqual(["description"]);
  });

  it("solo_loose without a description does not warn", () => {
    const created = runCli(db, ["ticket", "create", "-t", "loose"]);
    expect(created.stderr).toBe("");
    expect((created.json as { warnings?: unknown }).warnings).toBeUndefined();
  });

  it("ticket edit changes title, policy and priority and records the old and new values", () => {
    runCli(db, ["ticket", "create", "-t", "old", "-d", "d"]);
    const r = runCli(db, [
      "ticket",
      "edit",
      "1",
      "-t",
      "new 🚀",
      "-p",
      "team_light",
      "--priority",
      "7",
    ]);
    expect(r.error).toBeUndefined();
    const wg = Dispatch.open(db);
    const t = wg.resolveTicket("1");
    expect([t.title, t.policy_pack, t.priority]).toEqual(["new 🚀", "team_light", 7]);
    wg.db.close();
    const ev = events(db, "1").find((e) => e.event_type === "ticket.edited")!;
    const p = JSON.parse(ev.payload_json);
    expect(p.changes.title).toEqual({ from: "old", to: "new 🚀" });
    expect(p.changes.policy_pack).toEqual({ from: "solo_loose", to: "team_light" });
  });

  it("ticket edit refuses nothing-to-change, a bad policy and a control character", () => {
    runCli(db, ["ticket", "create", "-t", "x"]);
    expect(errorCode(runCli(db, ["ticket", "edit", "1"]).error)).toBe("VALIDATION_ERROR");
    expect(runCli(db, ["ticket", "edit", "1", "-p", "bogus"]).error).toBeDefined();
    expect(runCli(db, ["ticket", "edit", "1", "-t", "a\nb"]).error).toBeDefined();
    expect(runCli(db, ["ticket", "edit", "1", "-t", "  "]).error).toBeDefined();
  });

  it("factory_strict: ac edit --verify fixes AC_VERIFICATION_REQUIRED; ac rm removes a criterion", () => {
    runCli(db, ["ticket", "create", "-t", "x", "-d", "d", "-p", "factory_strict"]);
    runCli(db, ["ac", "add", "1", "-t", "a"]);
    runCli(db, ["ac", "add", "1", "-t", "b", "--verify", "unit test"]);
    runCli(db, ["ac", "add", "1", "-t", "stray"]);
    runCli(db, ["ticket", "repo-access", "set", "1", "svc"]);
    runCli(db, ["ticket", "set-reviewer", "1", "--reviewer", "tom"]);
    const denied = runCli(db, ["ticket", "ready", "1"]);
    expect(errorCode(denied.error)).toBe("POLICY_DENIED");

    // By position (1 = the first criterion) and by id.
    expect(runCli(db, ["ac", "edit", "1", "1", "--verify", "unit test"]).error).toBeUndefined();
    const wg = Dispatch.open(db);
    const stray = wg.view("1").acceptanceCriteria[2]!;
    wg.db.close();
    expect(runCli(db, ["ac", "rm", "1", stray.id]).error).toBeUndefined();
    expect(runCli(db, ["ticket", "ready", "1"]).error).toBeUndefined();

    const types = events(db, "1").map((e) => e.event_type);
    expect(types).toContain("ac.edited");
    expect(types).toContain("ac.removed");
    const wg2 = Dispatch.open(db);
    expect(wg2.view("1").acceptanceCriteria.map((a) => [a.text, a.verification_method])).toEqual([
      ["a", "unit test"],
      ["b", "unit test"],
    ]);
    wg2.db.close();
  });

  it("ac edit sets and clears a check command, and refuses contradictory flags", () => {
    runCli(db, ["ticket", "create", "-t", "x"]);
    runCli(db, ["ac", "add", "1", "-t", "suite passes"]);
    expect(runCli(db, ["ac", "edit", "1", "1", "--check", "npm test"]).error).toBeUndefined();
    let wg = Dispatch.open(db);
    expect(wg.view("1").acceptanceCriteria[0]!.check_command).toBe("npm test");
    wg.db.close();
    expect(
      errorCode(runCli(db, ["ac", "edit", "1", "1", "--check", "x", "--clear-check"]).error),
    ).toBe("VALIDATION_ERROR");
    expect(
      runCli(db, ["ac", "edit", "1", "1", "--clear-check", "-t", "renamed"]).error,
    ).toBeUndefined();
    wg = Dispatch.open(db);
    const ac = wg.view("1").acceptanceCriteria[0]!;
    expect([ac.text, ac.check_command]).toEqual(["renamed", null]);
    wg.db.close();
    expect(errorCode(runCli(db, ["ac", "edit", "1", "9", "-t", "y"]).error)).toBe("NOT_FOUND");
    expect(errorCode(runCli(db, ["ac", "edit", "1", "1"]).error)).toBe("VALIDATION_ERROR");
  });

  it("an edit that would make a READY ticket fail its own ready gate is refused and rolled back", () => {
    runCli(db, ["ticket", "create", "-t", "x", "-d", "d", "-p", "team_light"]);
    runCli(db, ["ac", "add", "1", "-t", "only"]);
    runCli(db, ["ticket", "repo-access", "set", "1", "svc"]);
    expect(runCli(db, ["ticket", "ready", "1"]).error).toBeUndefined();
    expect(errorCode(runCli(db, ["ticket", "edit", "1", "-d", ""]).error)).toBe("POLICY_DENIED");
    expect(errorCode(runCli(db, ["ac", "rm", "1", "1"]).error)).toBe("POLICY_DENIED");
    const wg = Dispatch.open(db);
    expect(wg.resolveTicket("1").description).toBe("d");
    expect(wg.view("1").acceptanceCriteria).toHaveLength(1);
    wg.db.close();
    // A ready ticket may still be edited within its gate.
    expect(runCli(db, ["ticket", "edit", "1", "-t", "clearer"]).error).toBeUndefined();
  });

  it("contract edits are refused with CONTRACT_FROZEN from claimed onward (ac add included)", () => {
    runCli(db, ["ticket", "create", "-t", "x"]);
    runCli(db, ["ac", "add", "1", "-t", "a"]);
    for (const status of FROZEN) {
      setStatus(db, 1, status);
      for (const args of [
        ["ticket", "edit", "1", "-t", "y"],
        ["ticket", "edit", "1", "-p", "team_light"],
        ["ac", "add", "1", "-t", "late"],
        ["ac", "edit", "1", "1", "--check", "echo pwned"],
        ["ac", "rm", "1", "1"],
      ]) {
        const r = runCli(db, args);
        expect(errorCode(r.error), `${status}: ${args.join(" ")}`).toBe("CONTRACT_FROZEN");
      }
    }
    for (const status of ["draft", "refining", "blocked"] as const) {
      setStatus(db, 1, status);
      expect(
        runCli(db, ["ticket", "edit", "1", "-t", `t-${status}`]).error,
        status,
      ).toBeUndefined();
    }
  });

  it("F-17: the quickstart's strict-pack recipe, run as written, makes Mark ready succeed", () => {
    const quickstart = readFileSync(join(__dirname, "../../../quickstart.md"), "utf8");
    const recipe = [
      'runner/gaffer wg ticket edit <n> -d "<what + why>"',
      "runner/gaffer wg ticket set-reviewer <n> --reviewer <your-name>",
      'runner/gaffer wg ac edit <n> 1 --verify "unit test"',
      "runner/gaffer wg ticket approve-ready <n>",
    ];
    for (const line of recipe) expect(quickstart).toContain(line);
    // The --admin the old recipe asked for is not needed.
    expect(quickstart).not.toMatch(/set-reviewer <n> --reviewer <your-name> --admin/);

    let n = 0;
    for (const pack of ["factory_strict", "regulated"]) {
      n += 1;
      runCli(db, ["ticket", "create", "-t", `strict ${pack}`, "-p", pack]);
      runCli(db, ["ac", "add", String(n), "-t", "works"]);
      runCli(db, ["ticket", "repo-access", "set", String(n), "svc"]);
      for (const line of recipe) {
        const argv = line
          .replace("runner/gaffer wg ", "")
          .replace("<n>", String(n))
          .replace("<your-name>", "tom")
          .match(/"[^"]*"|\S+/g)!
          .map((a) => a.replace(/^"|"$/g, ""));
        const r = runCli(db, argv);
        expect(r.error, `${pack}: ${line}`).toBeUndefined();
      }
      const ready = runCli(db, ["ticket", "ready", String(n)]);
      expect(ready.error, pack).toBeUndefined();
      expect((ready.json as { status: string }).status).toBe("ready");
    }
  });
});

describe("api-robustness F3: the contract guard holds on every surface", () => {
  it("service: a done ticket refuses a new criterion", () => {
    const wg = Dispatch.open(":memory:");
    const t = wg.createTicket({ title: "x" }, human);
    wg.db.prepare("UPDATE tickets SET status = 'done' WHERE id = ?").run(t.id);
    expect(() => wg.addAcceptanceCriterion({ ticket_id: t.id, text: "late" }, human)).toThrow(
      /frozen/i,
    );
    wg.db.close();
  });

  it("MCP: a factory mount scoped to its own in_review ticket cannot add a check command", () => {
    const keys = ["GAFFER_FACTORY", "GAFFER_SCOPE_TICKET"] as const;
    const saved = keys.map((k) => process.env[k]);
    const wg = Dispatch.open(":memory:");
    try {
      wg.registerRepository({ name: "svc", default_branch: "main" }, human);
      const t = wg.createTicket({ title: "x", description: "d", policy_pack: "team_light" }, human);
      wg.linkRepository(t.id, "svc", "primary", human);
      wg.addAcceptanceCriterion({ ticket_id: t.id, text: "Returns 200" }, human);
      wg.markReady(t.id, human);
      const agent = wg.registerAgent({ display_name: "a" }, human);
      const claim = wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, agentActor);
      wg.submitForReview(
        { claimToken: claim!.claimToken, ticket_id: t.id, reason: "done" },
        agentActor,
      );
      expect(wg.resolveTicket(t.id).status).toBe("in_review");
      process.env.GAFFER_FACTORY = "1";
      process.env.GAFFER_SCOPE_TICKET = String(t.number);
      const h = makeHandlers(wg, { type: "agent", id: "mcp-agent" });
      const res = h.add_acceptance_criterion({
        ticket_id: t.id,
        text: "pwned",
        check_command: "echo pwned",
      });
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res)).toMatch(/CONTRACT_FROZEN/);
      expect(wg.view(t.id).acceptanceCriteria).toHaveLength(1);
    } finally {
      keys.forEach((k, i) => {
        if (saved[i] === undefined) delete process.env[k];
        else process.env[k] = saved[i];
      });
      wg.db.close();
    }
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

    it("PATCH /tickets/{id}, PATCH and DELETE …/acceptance-criteria/{acId}, 409 once frozen", async () => {
      process.env.DISPATCH_API_TOKEN = "contract-edit-test-token-0123456789abcdef";
      const wg = Dispatch.open(":memory:");
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
      const call = async (method: string, path: string, body?: unknown) => {
        const res = await fetch(`${base}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${process.env.DISPATCH_API_TOKEN}`,
            "content-type": "application/json",
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
      };

      const created = await call("POST", "/tickets", { title: "x", policy_pack: "team_light" });
      expect(created.status).toBe(201);
      expect((created.body.warnings as Array<{ code: string }>)[0]!.code).toBe(
        "DESCRIPTION_REQUIRED",
      );
      const id = (created.body.ticket as { id: string }).id;

      const patched = await call("PATCH", `/tickets/${id}`, {
        description: "now described",
        priority: 3,
      });
      expect(patched.status).toBe(200);
      expect((patched.body.ticket as { description: string }).description).toBe("now described");
      expect(typeof patched.body.event_id).toBe("string");
      expect((await call("PATCH", `/tickets/${id}`, {})).status).toBe(422);
      expect((await call("PATCH", `/tickets/${id}`, { title: "a\tb" })).status).toBe(422);

      const ac = await call("POST", `/tickets/${id}/acceptance-criteria`, { text: "works" });
      const acId = (ac.body.acceptance_criterion as { id: string }).id;
      const acPatched = await call("PATCH", `/tickets/${id}/acceptance-criteria/${acId}`, {
        verification_method: "unit test",
        check_command: "npm test",
      });
      expect(acPatched.status).toBe(200);
      expect((acPatched.body.acceptance_criterion as { check_command: string }).check_command).toBe(
        "npm test",
      );
      const cleared = await call("PATCH", `/tickets/${id}/acceptance-criteria/${acId}`, {
        check_command: null,
      });
      expect(
        (cleared.body.acceptance_criterion as { check_command: unknown }).check_command,
      ).toBeNull();
      const second = await call("POST", `/tickets/${id}/acceptance-criteria`, { text: "extra" });
      const secondId = (second.body.acceptance_criterion as { id: string }).id;
      expect((await call("DELETE", `/tickets/${id}/acceptance-criteria/${secondId}`)).status).toBe(
        200,
      );
      expect(wg.view(id).acceptanceCriteria).toHaveLength(1);

      wg.db.prepare("UPDATE tickets SET status = 'in_review' WHERE id = ?").run(id);
      for (const [method, path, body] of [
        ["PATCH", `/tickets/${id}`, { title: "y" }],
        [
          "POST",
          `/tickets/${id}/acceptance-criteria`,
          { text: "late", check_command: "echo pwned" },
        ],
        ["PATCH", `/tickets/${id}/acceptance-criteria/${acId}`, { text: "z" }],
        ["DELETE", `/tickets/${id}/acceptance-criteria/${acId}`, undefined],
      ] as const) {
        const r = await call(method, path, body);
        expect(r.status, `${method} ${path}`).toBe(409);
        expect((r.body.error as { code: string }).code).toBe("CONTRACT_FROZEN");
      }
    });
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";

import { runCli } from "./helpers/cli.js";

/**
 * Exploratory finding cli-wg/F-12: `wg ticket list --claimable` ("only tickets whose
 * dependencies are all done (what a claim can take)") listed every ticket with no unmet
 * dependency whatever its status (done, draft, blocked …) and kept tickets held by an
 * open blocking decision. It now lists exactly what a claim could take: ready, not
 * taken by hand, every dependency done and no open blocking decision, the same answer
 * GET /tickets/{id}/claimability gives (which now names an open blocking decision too).
 */
const human: Actor = { type: "human", id: "tom" };

describe("cli-wg F-12: ticket list --claimable lists only what a claim could take", () => {
  let dir: string;
  let db: string;
  const n: Record<string, number> = {};
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wg-claimable-"));
    db = join(dir, "d.sqlite");
    const wg = Dispatch.open(db);
    wg.registerRepository({ name: "svc", default_branch: "main" }, human);
    const make = (title: string, ready = true) => {
      const t = wg.createTicket({ title }, human);
      wg.linkRepository(t.id, "svc", "primary", human);
      wg.addAcceptanceCriterion({ ticket_id: t.id, text: "a" }, human);
      if (ready) wg.markReady(t.id, human);
      n[title] = t.number!;
      return t;
    };
    make("draft", false);
    make("plain");
    const prereq = make("prereq");
    const dependant = make("dependant");
    wg.addDependency({ ticket: dependant.id, depends_on: prereq.id }, human);
    const held = make("held");
    wg.createDecision(
      {
        title: "which db?",
        question: "pg or sqlite?",
        severity: "human_required",
        ticketId: held.id,
      },
      human,
    );
    const byHand = make("byhand");
    wg.humanClaimTicket(byHand.id, human);
    const done = make("done");
    wg.db.prepare("UPDATE tickets SET status = 'done' WHERE id = ?").run(done.id);
    const blocked = make("blocked");
    wg.db.prepare("UPDATE tickets SET status = 'blocked' WHERE id = ?").run(blocked.id);
    wg.db.close();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("lists only ready, unheld tickets whose dependencies are done", () => {
    const r = runCli(db, ["ticket", "list", "--claimable"]);
    expect(r.error).toBeUndefined();
    const numbers = (r.json as Array<{ number: number }>)
      .map((t) => t.number)
      .sort((a, b) => a - b);
    expect(numbers).toEqual([n.plain!, n.prereq!].sort((a, b) => a - b));
    // -s ready --claimable (the runner's scan) gives the same list.
    const scan = runCli(db, ["ticket", "list", "-s", "ready", "--claimable"]);
    expect((scan.json as unknown[]).length).toBe(2);
  });

  it("claimability names the open blocking decision", () => {
    const wg = Dispatch.open(db);
    try {
      const c = wg.claimability(String(n.held));
      expect(c.ready).toBe(false);
      expect(c.blockers.map((b) => b.code)).toContain("DECISION_BLOCKED");
      expect(wg.claimability(String(n.plain)).ready).toBe(true);
    } finally {
      wg.db.close();
    }
  });
});

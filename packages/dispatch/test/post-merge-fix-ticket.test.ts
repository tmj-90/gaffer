/**
 * "Open a fix ticket" from a post-merge finding (backlog 59, part 4).
 *
 *  - The fix ticket is a normal ticket (the ticket service), at the change's risk, delivering
 *    to its write repo, the finding quoted in its description, linked as a regression of the
 *    change through the regression service: ONE link (the escaped-defect numbers count it
 *    once) and no second finding from the link's note.
 *  - The link steps autonomy down when the change worked automatically (an agent approved
 *    it) and not when a person approved and landed it; the preview the confirm reads says
 *    which, in plain words, and matches what the act then does.
 *  - A person's act (and a person's read): an agent, the runner and the server are refused;
 *    a withdrawn finding, or one that already has a fix ticket, is refused.
 *  - REST: GET (preview) and POST (open) /tickets/:id/findings/:fid/fix-ticket; the CLI
 *    `wg ticket finding fix-ticket [--preview]`; no MCP tool.
 */
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setPrincipalResolver } from "../src/api/auth.js";
import { createApiServer } from "../src/api/server.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { writeEvent } from "../src/events/eventWriter.js";
import { makeHandlers } from "../src/mcp/tools.js";
import { TestClock } from "../src/util/clock.js";
import { CLI_BUILT, runBin } from "./helpers/cliBin.js";
import { humanActor as human, landedChange, repoNamed } from "./helpers/autonomyLadder.js";

const system: Actor = { type: "system" };
const agent: Actor = { type: "agent", id: "gaffer-factory" };
const TEXT = "The empty export lost its header row.\nNobody tested the empty case.";

/** A landed change on `api` (approved by `approver`) with one finding on it. */
function changeWithFinding(wg: Dispatch, approver?: Actor) {
  const change = landedChange(wg, "api", "low", approver);
  writeEvent(wg.db, {
    entity_type: "ticket",
    entity_id: change.id,
    actor: system,
    event_type: "ticket.delivery_recorded",
    payload: { diff_summary: " src/export/csv.ts | 3 ++-\n 1 file changed" },
  });
  const f = wg.addFinding(change.id, { text: TEXT, category: "test_gap" }, human).finding;
  return { change, f };
}

const linksOf = (wg: Dispatch, originalId: string) =>
  wg.regressionLinkRows().filter((l) => l.regressionOf === originalId);

describe("open a fix ticket", () => {
  let wg: Dispatch;
  beforeEach(() => {
    wg = Dispatch.open(":memory:", new TestClock());
  });
  afterEach(() => wg.db.close());

  it("a person approved the change: a normal ticket, linked once, the finding quoted, no step-down", () => {
    const { change, f } = changeWithFinding(wg, human);
    const preview = wg.fixTicketPreview(change.id, f.id, human);
    expect(preview.steps_down).toBe(false);
    expect(preview.step_downs).toEqual([]);
    expect(preview.message).toMatch(/takes no automatic approval back/);
    const r = wg.openFixTicket(change.id, f.id, human);
    expect(r.stepped_down).toEqual([]);
    const fix = wg.view(r.ticket.id);
    expect(fix.ticket.title).toBe(
      `Fix after #${change.number}: The empty export lost its header row. Nobody tested the empty case.`,
    );
    expect(fix.ticket.risk_level).toBe("low");
    expect(fix.ticket.description).toContain(
      "> The empty export lost its header row.\n> Nobody tested the empty case.",
    );
    expect(fix.ticket.description).toContain(`linked as a regression of #${change.number}`);
    expect(fix.repositories.map((x) => `${x.name}/${x.access}`)).toEqual(["api/write"]);
    // One link, carrying the finding; the escaped-defect count reads links, so once.
    const links = linksOf(wg, change.id);
    expect(links).toHaveLength(1);
    expect(links[0]!.ticketId).toBe(r.ticket.id);
    // The link records no second finding (the note IS this finding).
    const findings = wg.findingsOf(change.id);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.fix_ticket).toEqual({ ticket_id: r.ticket.id, number: r.ticket.number });
    expect(r.finding.fix_ticket?.ticket_id).toBe(r.ticket.id);
    // Created by the person, as `wg ticket create` would.
    const created = wg.db
      .prepare(
        `SELECT actor_type, actor_id FROM work_events WHERE entity_id = ? AND event_type = 'ticket.created'`,
      )
      .get(r.ticket.id) as { actor_type: string; actor_id: string };
    expect(created).toEqual({ actor_type: "human", actor_id: "tom" });
  });

  it("an agent approved the change: the preview says autonomy steps down, and the act does exactly that", () => {
    const { change, f } = changeWithFinding(wg);
    const preview = wg.fixTicketPreview(change.id, f.id, human);
    expect(preview.steps_down).toBe(true);
    expect(preview.message).toMatch(/^This also takes automatic approval back for api at low risk/);
    const r = wg.openFixTicket(change.id, f.id, human);
    const repo = repoNamed(wg, "api");
    const did = r.stepped_down.map((s) => `${s.repoId}/${s.riskLevel}/${s.gate}`).sort();
    const said = preview.step_downs.map((s) => `${repo}/${s.risk_level}/${s.gate}`).sort();
    expect(did.length).toBeGreaterThan(0);
    expect(did).toEqual(said);
    expect(preview.step_downs.every((s) => s.repo === "api")).toBe(true);
    // Asked again after the act, nothing is left to step down (and the finding has its fix).
    expect(() => wg.fixTicketPreview(change.id, f.id, human)).toThrow(/already opened/);
  });

  it("refuses an agent, the runner and the server, a withdrawn finding and a second fix ticket", () => {
    const { change, f } = changeWithFinding(wg, human);
    for (const who of [agent, system])
      for (const act of [
        () => wg.fixTicketPreview(change.id, f.id, who),
        () => wg.openFixTicket(change.id, f.id, who),
      ])
        expect(act).toThrow(/Only a person/);
    expect(linksOf(wg, change.id)).toHaveLength(0);
    wg.openFixTicket(change.id, f.id, human);
    expect(() => wg.openFixTicket(change.id, f.id, human)).toThrow(/already opened/);
    expect(linksOf(wg, change.id)).toHaveLength(1);
    const g = wg.addFinding(change.id, { text: "Second thing went wrong here" }, human).finding;
    wg.withdrawFinding(change.id, g.id, "not real", human);
    expect(() => wg.openFixTicket(change.id, g.id, human)).toThrow(/withdrawn/);
  });

  it("a failure inside the act leaves nothing behind (one transaction)", () => {
    const { change, f } = changeWithFinding(wg, human);
    const before = (wg.db.prepare("SELECT COUNT(*) AS n FROM tickets").get() as { n: number }).n;
    // The original is no longer done: the regression link refuses, the create rolls back.
    wg.db.prepare(`UPDATE tickets SET status='in_review' WHERE id=?`).run(change.id);
    expect(() => wg.openFixTicket(change.id, f.id, human)).toThrow(/not an accepted change/);
    expect((wg.db.prepare("SELECT COUNT(*) AS n FROM tickets").get() as { n: number }).n).toBe(
      before,
    );
    expect(wg.findingsOf(change.id)[0]!.fix_ticket).toBeNull();
  });

  it("no MCP tool opens a fix ticket", () => {
    const names = Object.keys(makeHandlers(wg, agent));
    expect(names.some((n) => /fix|finding|lesson|regression/i.test(n))).toBe(false);
  });
});

describe("REST", () => {
  let wg: Dispatch;
  let baseUrl: string;
  let close: () => Promise<void>;
  const saved = process.env.DISPATCH_API_TOKEN;
  const FULL = "full-secret-for-fix-tickets-0123456789";
  beforeEach(async () => {
    process.env.DISPATCH_AUDIT_OFF = "1";
    process.env.DISPATCH_API_TOKEN = FULL;
    wg = Dispatch.open(":memory:", new TestClock());
    const server = createApiServer(wg);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () =>
      new Promise<void>((resolve) =>
        server.close(() => {
          wg.db.close();
          resolve();
        }),
      );
  });
  afterEach(async () => {
    await close();
    setPrincipalResolver(null);
    if (saved === undefined) delete process.env.DISPATCH_API_TOKEN;
    else process.env.DISPATCH_API_TOKEN = saved;
  });
  const call = async (method: string, path: string) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${FULL}` },
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, any> };
  };

  it("previews, then opens; the second open is a conflict", async () => {
    const { change, f } = changeWithFinding(wg);
    const p = await call("GET", `/tickets/${change.id}/findings/${f.id}/fix-ticket`);
    expect(p.status).toBe(200);
    expect(p.body.steps_down).toBe(true);
    expect(p.body.message).toMatch(/takes automatic approval back for api/);
    const o = await call("POST", `/tickets/${change.id}/findings/${f.id}/fix-ticket`);
    expect(o.status).toBe(201);
    expect(o.body.ticket.number).toBeGreaterThan(change.number);
    expect(o.body.stepped_down.length).toBeGreaterThan(0);
    expect(o.body.finding.fix_ticket.ticket_id).toBe(o.body.ticket.id);
    const again = await call("POST", `/tickets/${change.id}/findings/${f.id}/fix-ticket`);
    expect(again.status).toBe(409);
  });
});

describe.skipIf(!CLI_BUILT)("wg ticket finding fix-ticket", () => {
  it("--preview opens nothing; without it, opens the ticket as the person running it", () => {
    const dir = mkdtempSync(join(tmpdir(), "gaffer-fix-"));
    try {
      const db = join(dir, "dispatch.sqlite");
      const wg = Dispatch.open(db, new TestClock());
      const { change, f } = changeWithFinding(wg, human);
      wg.db.close();
      const ref = String(change.number);
      const pv = runBin(db, [
        "ticket",
        "finding",
        "fix-ticket",
        ref,
        f.id.slice(0, 8),
        "--preview",
      ]);
      expect(pv.status, pv.stderr).toBe(0);
      expect(JSON.parse(pv.stdout).preview.steps_down).toBe(false);
      const op = runBin(db, ["ticket", "finding", "fix-ticket", ref, f.id.slice(0, 8)]);
      expect(op.status, op.stderr).toBe(0);
      const out = JSON.parse(op.stdout) as { ticket: { id: string }; message: string };
      expect(out.message).toMatch(/takes no automatic approval back/);
      const check = Dispatch.open(db, new TestClock());
      expect(check.regressionLinkRows()).toHaveLength(1);
      expect(check.view(out.ticket.id).ticket.risk_level).toBe("low");
      check.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

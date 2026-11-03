/**
 * REVIEW-RULE DRAFTS end to end (D6): a person's repeated send-back reason or must-fix
 * comment on three tickets in a repo is proposed once as a lore `convention` draft tagged
 * review-rule; an agent's or the tester's feedback never seeds one; "Fix these:" reasons are
 * left out; an agent cannot propose; the reject route proposes fail-soft; GET
 * /api/review-rules reports the rule, its lore status and its measure; and through the
 * real memory CLI the draft stays a draft with MEMORY_AUTO_APPROVE=1.
 */
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMemoryReader, type MemoryReader } from "../src/api/memoryReader.js";
import { createPlanBuildRunner } from "../src/api/planBuild.js";
import { createApiServer } from "../src/api/server.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { writeEvent } from "../src/events/eventWriter.js";
import {
  proposeReviewRules,
  readFeedbackItems,
  type RuleDraft,
} from "../src/services/reviewRuleService.js";
import { TestClock } from "../src/util/clock.js";
import { CLI_BUILT, runBin } from "./helpers/cliBin.js";

const human: Actor = { type: "human", id: "tom" };
const admin: Actor = { type: "admin", id: "ops" };
const agent: Actor = { type: "agent", id: "reviewer" };
const system: Actor = { type: "system" };

const RULE = "Repository methods must return null, not undefined";

function seed(wg: Dispatch): { repoId: string; tickets: Array<{ id: string; number: number }> } {
  const repo = wg.registerRepository({ name: "app", default_branch: "main" }, human);
  const tickets = Array.from({ length: 6 }, (_, i) => {
    const t = wg.createTicket({ title: `T${i}` }, human);
    wg.linkRepository(t.id, "app", "primary", human);
    return { id: t.id, number: t.number ?? 0 };
  });
  return { repoId: repo.id, tickets };
}

function sendBack(wg: Dispatch, ticketId: string, actor: Actor, reason: string): void {
  writeEvent(wg.db, {
    entity_type: "ticket",
    entity_id: ticketId,
    actor,
    event_type: "ticket.transitioned",
    payload: { from: "in_review", to: "refining", reason },
  });
}

function mustFix(wg: Dispatch, ticketId: string, repoId: string, body: string, status = "open") {
  wg.db
    .prepare(
      `INSERT INTO review_comments (id, ticket_id, repo_id, body, severity, status, author_type, author_id)
       VALUES (?, ?, ?, ?, 'must_fix', ?, 'human', 'tom')`,
    )
    .run(`c-${Math.random().toString(36).slice(2)}`, ticketId, repoId, body, status);
}

describe("proposeReviewRules", () => {
  let wg: Dispatch;
  beforeEach(() => {
    process.env.DISPATCH_AUDIT_OFF = "1";
    wg = Dispatch.open(":memory:", new TestClock());
  });
  afterEach(() => wg.db.close());

  it("only a person's feedback seeds a rule, proposed once, as a convention draft", () => {
    const { repoId, tickets: t } = seed(wg);
    sendBack(wg, t[0]!.id, human, `${RULE}: src/repo/user.ts`);
    sendBack(wg, t[1]!.id, agent, RULE); // the agent reviewer: never
    sendBack(wg, t[2]!.id, system, RULE); // the tester / runner: never
    sendBack(wg, t[3]!.id, human, "Fix these: 2 requirements (ab12cd34, ef56ab78)");
    mustFix(wg, t[4]!.id, repoId, `${RULE}.`, "withdrawn"); // withdrawn: not feedback
    const drafts: RuleDraft[] = [];
    const proposer = (d: RuleDraft) => {
      drafts.push(d);
      return { ok: true as const, id: "abcd2345" };
    };
    // One person's ticket so far: nothing.
    expect(proposeReviewRules(wg.db, human, { threshold: 3, proposer }).proposed).toEqual([]);

    sendBack(wg, t[4]!.id, admin, `${RULE}!`);
    mustFix(wg, t[5]!.id, repoId, `${RULE} (#12)`);
    const r = proposeReviewRules(wg.db, system, { threshold: 3, proposer });
    expect(r.proposed).toEqual([
      {
        repo: "app",
        key: "repository methods must return null not undefined",
        count: 3,
        lore_id: "abcd2345",
      },
    ]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ repo: "app", kind: "convention", tags: ["review-rule"] });
    expect(drafts[0]!.title).toMatch(/^Review rule \(app\): Repository methods must return null/);
    expect(drafts[0]!.body).toMatch(/repeated on 3 tickets \(the threshold is 3\)/);
    expect(drafts[0]!.body).toMatch(/must-fix comment by tom/);
    expect(drafts[0]!.body).toMatch(/send-back reason by ops/);
    expect(drafts[0]!.body).not.toMatch(/by reviewer|by system/);
    const ev = wg.db
      .prepare(
        "SELECT entity_type, entity_id, payload_json FROM work_events WHERE event_type = 'review_rule.proposed'",
      )
      .all() as Array<{ entity_type: string; entity_id: string; payload_json: string }>;
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ entity_type: "repository", entity_id: repoId });
    expect(JSON.parse(ev[0]!.payload_json)).toMatchObject({ lore_id: "abcd2345", threshold: 3 });

    // Proposed once.
    const again = proposeReviewRules(wg.db, human, { threshold: 3, proposer });
    expect(again).toMatchObject({ proposed: [], already: 1 });
    expect(drafts).toHaveLength(1);
  });

  it("a memory failure records nothing, so the rule is tried again; an agent is refused", () => {
    const { tickets: t } = seed(wg);
    for (const x of t.slice(0, 3)) sendBack(wg, x.id, human, RULE);
    const down = proposeReviewRules(wg.db, human, {
      threshold: 3,
      proposer: () => ({ ok: false, reason: "memory down" }),
    });
    expect(down.failed).toEqual([
      {
        repo: "app",
        key: "repository methods must return null not undefined",
        reason: "memory down",
      },
    ]);
    const up = proposeReviewRules(wg.db, human, {
      threshold: 3,
      proposer: () => ({ ok: true, id: null }),
    });
    expect(up.proposed).toHaveLength(1);
    expect(() =>
      proposeReviewRules(wg.db, agent, { threshold: 3, proposer: () => ({ ok: true, id: null }) }),
    ).toThrow(/Only a person/);
  });

  it("reads the retry cap's reason without its prefix", () => {
    const { tickets: t } = seed(wg);
    writeEvent(wg.db, {
      entity_type: "ticket",
      entity_id: t[0]!.id,
      actor: human,
      event_type: "ticket.transitioned",
      payload: { from: "in_review", to: "blocked", reason: `retry_cap_reached:${RULE}` },
    });
    expect(readFeedbackItems(wg.db).map((i) => i.text)).toEqual([RULE]);
  });
});

describe("the reject route and GET /api/review-rules", () => {
  it("a person's third send-back proposes the draft; the report shows its status and measure", async () => {
    process.env.DISPATCH_AUDIT_OFF = "1";
    const saved = process.env.MEMORY_CLI_BIN;
    process.env.MEMORY_CLI_BIN = "/configured/memory.js";
    const wg = Dispatch.open(":memory:", new TestClock());
    const filed: Array<{ repo: string; tags: readonly string[] }> = [];
    const memoryReader: MemoryReader = {
      ...createMemoryReader({} as NodeJS.ProcessEnv),
      proposeReviewRule: (input) => {
        filed.push(input);
        return { available: true, id: "rule2345" };
      },
      loreHistory: (id) => ({
        available: true,
        id,
        approvedAt: null,
        current: { version: 1, status: "draft", at: "", title: "", summary: "" },
        versions: [],
      }),
    };
    const noop = { run: () => ({ started: true }) } as never;
    const server = createApiServer(
      wg,
      noop,
      createPlanBuildRunner(),
      noop,
      noop,
      "127.0.0.1",
      memoryReader,
    );
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const { tickets: t } = seed(wg);
      sendBack(wg, t[0]!.id, human, RULE);
      sendBack(wg, t[1]!.id, human, RULE);
      // The third, through the real route: put it in review first.
      wg.db.prepare("UPDATE tickets SET status='in_review' WHERE id=?").run(t[2]!.id);
      const res = await fetch(`${base}/tickets/${t[2]!.id}/review/reject`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: "refining", reason: RULE }),
      });
      expect(res.status).toBe(200);
      // The proposal runs once the response is sent (it never delays the person's reject).
      for (let i = 0; i < 100 && filed.length === 0; i++)
        await new Promise((r) => setTimeout(r, 20));
      expect(filed).toHaveLength(1);
      expect(filed[0]!.tags).toEqual(["review-rule"]);

      const report = (await (await fetch(`${base}/api/review-rules`)).json()) as {
        threshold: number;
        candidates: unknown[];
        proposed: Array<{ lore_id: string; lore_status: string; measure: { state: string } }>;
        note: string;
      };
      expect(report.threshold).toBe(3);
      expect(report.candidates).toEqual([]);
      expect(report.proposed).toMatchObject([
        { lore_id: "rule2345", lore_status: "draft", measure: { state: "not_approved" } },
      ]);
      expect(report.note).toMatch(/never auto-approves/);
    } finally {
      if (saved === undefined) delete process.env.MEMORY_CLI_BIN;
      else process.env.MEMORY_CLI_BIN = saved;
      await new Promise<void>((r) => server.close(() => r()));
      wg.db.close();
    }
  });
});

const MEMORY_BIN = resolve(__dirname, "..", "..", "memory", "dist", "bin", "memory.js");

describe.skipIf(!CLI_BUILT)("wg review-rules propose through the real memory CLI", () => {
  it("files a draft that stays a draft under MEMORY_AUTO_APPROVE=1, and lists it", () => {
    const dir = mkdtempSync(join(tmpdir(), "gaffer-review-rules-"));
    try {
      const db = join(dir, "dispatch.sqlite");
      const wg = Dispatch.open(db, new TestClock());
      const { tickets: t } = seed(wg);
      for (const x of t.slice(0, 3)) sendBack(wg, x.id, human, RULE);
      wg.db.close();
      const env = {
        MEMORY_CLI_BIN: MEMORY_BIN,
        MEMORY_DB: join(dir, "memory.sqlite"),
        MEMORY_AUTO_APPROVE: "1",
      };
      const p = runBin(db, ["review-rules", "propose"], { env });
      expect(p.status).toBe(0);
      const out = JSON.parse(p.stdout) as { proposed: Array<{ lore_id: string | null }> };
      expect(out.proposed).toHaveLength(1);
      const loreId = out.proposed[0]!.lore_id!;
      expect(loreId).toMatch(/^[a-z2-9]{8}$/);
      const list = runBin(db, ["review-rules"], { env });
      expect(list.status).toBe(0);
      const rep = JSON.parse(list.stdout) as {
        proposed: Array<{ lore_id: string; lore_status: string }>;
      };
      expect(rep.proposed).toMatchObject([{ lore_id: loreId, lore_status: "draft" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

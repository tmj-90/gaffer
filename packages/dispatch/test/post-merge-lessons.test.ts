/**
 * POST-MERGE FINDINGS TEACH (backlog 59).
 *
 *  (a) A person's findings count as feedback in the repeated-feedback rules with the same
 *      threshold: the same category AND normalised reason on N changes in a repo proposes
 *      one draft rule; a withdrawn finding, another category or fewer changes do not.
 *  (b) "Propose as a lesson now" turns ONE finding into a lore draft scoped to the repo and
 *      the paths, tagged post-merge-finding: a person's act, once per finding, never for a
 *      withdrawn finding or one with no path, and nothing is recorded when memory fails.
 *      Through the real memory CLI the draft is a `gotcha` that stays a draft under
 *      MEMORY_AUTO_APPROVE=1 and is served by path only after a person approves it.
 */
import { spawnSync } from "node:child_process";
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
import { makeHandlers } from "../src/mcp/tools.js";
import { type LessonDraft } from "../src/services/findingService.js";
import {
  proposeReviewRules,
  readFeedbackItems,
  type RuleDraft,
} from "../src/services/reviewRuleService.js";
import { TestClock } from "../src/util/clock.js";
import { CLI_BUILT, runBin } from "./helpers/cliBin.js";

const human: Actor = { type: "human", id: "tom" };
const agent: Actor = { type: "agent", id: "gaffer-factory" };
const system: Actor = { type: "system" };

const REASON = "Empty exports must keep the header row";

function landed(
  wg: Dispatch,
  title: string,
  paths = "src/export/csv.ts",
): { id: string; number: number } {
  const r = wg.repos.findByName("app") ?? wg.registerRepository({ name: "app" }, human);
  const t = wg.createTicketWithLinks(
    { title, description: "" },
    { repoAccess: [{ repo_id: r.id, access: "write" }] },
    human,
  );
  writeEvent(wg.db, {
    entity_type: "ticket",
    entity_id: t.id,
    actor: system,
    event_type: "ticket.delivery_recorded",
    payload: { branch_name: "gaffer/x", diff_summary: ` ${paths} | 3 ++-\n 1 file changed` },
  });
  wg.db.prepare(`UPDATE tickets SET status='done' WHERE id=?`).run(t.id);
  return { id: t.id, number: t.number ?? 0 };
}

describe("(a) findings in the repeated-feedback rules", () => {
  let wg: Dispatch;
  beforeEach(() => {
    process.env.DISPATCH_AUDIT_OFF = "1";
    wg = Dispatch.open(":memory:", new TestClock());
  });
  afterEach(() => wg.db.close());

  const propose = () => {
    const drafts: RuleDraft[] = [];
    const r = proposeReviewRules(wg.db, human, {
      threshold: 3,
      proposer: (d) => {
        drafts.push(d);
        return { ok: true, id: `rule${drafts.length}abcd` };
      },
    });
    return { r, drafts };
  };

  it("the same category and reason on three changes proposes one draft rule", () => {
    const t = [1, 2, 3, 4].map((i) => landed(wg, `Change ${i}`));
    wg.addFinding(t[0]!.id, { text: `${REASON} (src/export/csv.ts)`, category: "test_gap" }, human);
    wg.addFinding(t[1]!.id, { text: `${REASON}.`, category: "test_gap" }, human);
    // Another category with the same words is another rule.
    wg.addFinding(t[3]!.id, { text: REASON, category: "convention" }, human);
    expect(propose().r.proposed).toEqual([]);
    // A withdrawn finding does not count.
    const w = wg.addFinding(t[2]!.id, { text: REASON, category: "test_gap" }, human).finding;
    wg.withdrawFinding(t[2]!.id, w.id, "wrong ticket", human);
    expect(propose().r.proposed).toEqual([]);
    wg.addFinding(t[2]!.id, { text: REASON, category: "test_gap" }, human);
    const { r, drafts } = propose();
    expect(r.proposed).toMatchObject([
      { repo: "app", key: "test gap: empty exports must keep the header row", count: 3 },
    ]);
    expect(drafts[0]!.tags).toEqual(["review-rule"]);
    expect(drafts[0]!.body).toMatch(/post-merge finding by tom/);
    // Proposed once.
    expect(propose().r).toMatchObject({ proposed: [], already: 1 });
  });

  it("feedback items carry a finding's repo, category and person; an uncategorised one keys on its text", () => {
    const t = landed(wg, "Change");
    wg.addFinding(t.id, { text: REASON }, human);
    const items = readFeedbackItems(wg.db).filter((i) => i.source === "post_merge_finding");
    expect(items).toMatchObject([
      { repo: "app", text: REASON, actorType: "human", actorId: "tom", category: null },
    ]);
  });
});

describe("(b) propose as a lesson now", () => {
  let wg: Dispatch;
  beforeEach(() => {
    process.env.DISPATCH_AUDIT_OFF = "1";
    wg = Dispatch.open(":memory:", new TestClock());
  });
  afterEach(() => wg.db.close());

  it("files one finding as a draft scoped to the repo and paths, once", () => {
    const t = landed(wg, "CSV export");
    const f = wg.addFinding(t.id, { text: REASON, category: "test_gap" }, human).finding;
    const filed: LessonDraft[] = [];
    const proposer = (d: LessonDraft) => {
      filed.push(d);
      return { ok: true as const, id: "less2345" };
    };
    const r = wg.proposeLesson(t.id, f.id, human, proposer);
    expect(r.loreId).toBe("less2345");
    expect(r.finding.lesson).toMatchObject({ lore_id: "less2345", proposed_by: "tom" });
    expect(filed[0]).toMatchObject({
      title: `Lesson from #${t.number} (test gap): ${REASON}`,
      summary: REASON,
      repo: "app",
      paths: ["src/export/csv.ts"],
      tags: ["post-merge-finding", `from-ticket-${t.number}`],
    });
    expect(filed[0]!.body).toMatch(/Approve it to show it to later changes on these paths/);
    expect(() => wg.proposeLesson(t.id, f.id, human, proposer)).toThrow(/already proposed/);
    expect(filed).toHaveLength(1);
  });

  it("refuses an agent, a withdrawn finding and one with no path; a memory failure records nothing", () => {
    const t = landed(wg, "CSV export");
    const ok = () => ({ ok: true as const, id: "x2345678" });
    const f = wg.addFinding(t.id, { text: REASON }, human).finding;
    expect(() => wg.proposeLesson(t.id, f.id, agent, ok)).toThrow(/Only a person/);
    expect(() => wg.proposeLesson(t.id, f.id, system, ok)).toThrow(/Only a person/);
    expect(() =>
      wg.proposeLesson(t.id, f.id, human, () => ({ ok: false, reason: "memory down" })),
    ).toThrow(/memory down/);
    expect(wg.findingsOf(t.id)[0]!.lesson).toBeNull();
    const bare = wg.createTicket({ title: "No repo" }, human);
    wg.db.prepare(`UPDATE tickets SET status='done' WHERE id=?`).run(bare.id);
    const nf = wg.addFinding(bare.id, { text: "no path" }, human).finding;
    expect(() => wg.proposeLesson(bare.id, nf.id, human, ok)).toThrow(/names no repository/);
    wg.withdrawFinding(t.id, f.id, "dup", human);
    expect(() => wg.proposeLesson(t.id, f.id, human, ok)).toThrow(/withdrawn/);
  });

  it("POST /tickets/:id/findings/:fid/lesson files through the memory reader", async () => {
    const filed: LessonDraft[] = [];
    const memoryReader: MemoryReader = {
      ...createMemoryReader({} as NodeJS.ProcessEnv),
      proposeLesson: (input) => {
        filed.push(input as LessonDraft);
        return { available: true, id: "less2345" };
      },
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
      const t = landed(wg, "CSV export");
      const f = wg.addFinding(t.id, { text: REASON }, human).finding;
      const res = await fetch(`${base}/tickets/${t.id}/findings/${f.id}/lesson`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ lore_id: "less2345", finding: { id: f.id } });
      expect(filed[0]!.paths).toEqual(["src/export/csv.ts"]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("no MCP tool proposes or approves a lesson", () => {
    const h = makeHandlers(wg, agent);
    expect(Object.keys(h).filter((k) => /lesson|finding|approve|lore/i.test(k))).toEqual([]);
  });
});

const MEMORY_BIN = resolve(__dirname, "..", "..", "memory", "dist", "bin", "memory.js");

describe.skipIf(!CLI_BUILT)("wg ticket finding lesson through the real memory CLI", () => {
  it("files a gotcha draft that stays a draft under auto-approve and is served by path once approved", () => {
    const dir = mkdtempSync(join(tmpdir(), "gaffer-lesson-"));
    try {
      const db = join(dir, "dispatch.sqlite");
      const wg = Dispatch.open(db, new TestClock());
      const t = landed(wg, "CSV export");
      const f = wg.addFinding(t.id, { text: REASON, category: "test_gap" }, human).finding;
      wg.db.close();
      const env = {
        MEMORY_CLI_BIN: MEMORY_BIN,
        MEMORY_DB: join(dir, "memory.sqlite"),
        MEMORY_AUTO_APPROVE: "1",
      };
      const p = runBin(db, ["ticket", "finding", "lesson", String(t.number), f.id], { env });
      expect(p.status, p.stderr).toBe(0);
      const loreId = (JSON.parse(p.stdout) as { lore_id: string }).lore_id;
      expect(loreId).toMatch(/^[a-z2-9]{8}$/);
      const mem = (args: string[]) =>
        spawnSync(process.execPath, [MEMORY_BIN, ...args], {
          encoding: "utf8",
          env: { ...process.env, MEMORY_DB: env.MEMORY_DB },
        });
      const listed = JSON.parse(mem(["list", "--json"]).stdout) as {
        items: Array<{ id: string; status: string; kind: string; tags: string[]; repos: string[] }>;
      };
      const show = listed.items.find((i) => i.id === loreId)!;
      expect(show).toMatchObject({ status: "draft", kind: "gotcha", repos: ["app"] });
      expect(show.tags).toContain("post-merge-finding");
      const serve = (path: string) =>
        JSON.parse(mem(["lessons", "--repo", "app", "--paths", path, "--json"]).stdout) as Array<{
          id: string;
        }>;
      expect(serve("src/export/csv.ts")).toEqual([]);
      // The approval gate: a person approves it (the Memory view calls this CLI verb).
      expect(mem(["approve", loreId]).status).toBe(0);
      expect(serve("src/export/csv.ts").map((l) => l.id)).toEqual([loreId]);
      expect(serve("src/billing/invoice.ts")).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

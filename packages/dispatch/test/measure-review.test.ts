/**
 * Independent review of the measure package (escaped defects, lane value, review rules):
 * the cases the builder's tests did not pin, each hand-worked.
 *
 *  - Lane value: a delivery paused at a cap and resumed is ONE attempt (a resume is not a
 *    start of work); two lanes that both blocked a send-back are neither one's unique
 *    catch; the cost per attempt names the basis of the ledger's attempt ids.
 *  - Review rules: a six-character comment-id prefix (the shortest the CLI accepts) is an
 *    id and drops out of the key, so the same feedback citing two comments matches; two
 *    reasons that differ only in paths and numbers share one key.
 *  - The review-rule proposal after a person's send-back runs once the response is sent,
 *    so a slow or failing memory CLI neither delays nor fails the person's reject, and a
 *    failure is not retried on every following reject.
 *  - CLI principals: a scoped principal files a regression link only when it can see both
 *    tickets (the REST rule); a read-only principal may read `wg review-rules`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { MemoryReader } from "../src/api/memoryReader.js";
import { createMemoryReader } from "../src/api/memoryReader.js";
import { createPlanBuildRunner } from "../src/api/planBuild.js";
import { createApiServer } from "../src/api/server.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { writeEvent } from "../src/events/eventWriter.js";
import type { HealthRow } from "../src/health/healthAggregator.js";
import { laneValueReport } from "../src/health/laneValue.js";
import { normaliseFeedback, reviewRuleCandidates } from "../src/health/reviewRules.js";
import { TestClock } from "../src/util/clock.js";
import { CLI_BUILT, runBin } from "./helpers/cliBin.js";

vi.setConfig({ testTimeout: 60_000 });

const human: Actor = { type: "human", id: "tom" };
const MIN = 60_000;
const T0 = Date.parse("2026-06-01T09:00:00.000Z");
const at = (m: number) => T0 + m * MIN;
const tr = (id: string, from: string | null, to: string, m: number, actorType = "system") => ({
  ticketId: id,
  actorType,
  fromStatus: from,
  toStatus: to,
  reason: null,
  atMs: at(m),
});
const v = (id: string, lane: string, verdict: string, m: number) => ({
  ticketId: id,
  lane,
  verdict,
  atMs: at(m),
});

describe("lane value: the cases the builder's fixture did not pin", () => {
  it("a delivery paused at a cap and resumed is one attempt", () => {
    // P: claimed at 0, paused at 5, resumed at 10, review verdict approve at 12, into
    // review at 15, the person approves at 20, done at 25. One attempt, decided by a person.
    const r = laneValueReport({
      transitions: [
        tr("P", "ready", "claimed", 0),
        tr("P", "claimed", "in_progress", 1),
        tr("P", "in_progress", "paused", 5),
        tr("P", "paused", "in_progress", 10, "human"),
        tr("P", "in_progress", "in_review", 15),
        tr("P", "in_review", "ready_for_merge", 20, "human"),
        tr("P", "ready_for_merge", "done", 25),
      ],
      verdicts: [v("P", "agent-review", "approve", 12)],
      ledger: [],
    });
    expect(r.attempts).toBe(1);
    expect(r.attempts_with_person_decision).toBe(1);
    expect(r.lanes.find((l) => l.lane === "agent-review")).toMatchObject({
      attempts_judged: 1,
      compared: 1,
      differed: 0,
    });
  });

  it("two lanes that both blocked a send-back: neither is the only lane that caught it", () => {
    const r = laneValueReport({
      transitions: [
        tr("Q", "ready", "in_progress", 0),
        tr("Q", "in_progress", "in_review", 10),
        tr("Q", "in_review", "refining", 20, "human"),
      ],
      verdicts: [v("Q", "agent-review", "changes", 11), v("Q", "security-review", "changes", 11)],
      ledger: [],
    });
    expect(r.send_backs).toBe(1);
    expect(r.send_backs_no_lane_caught).toBe(0);
    for (const lane of ["agent-review", "security-review"])
      expect(r.lanes.find((l) => l.lane === lane)).toMatchObject({
        unique_catches: 0,
        compared: 1,
        differed: 0,
      });
  });

  it("names the basis of the attempt ids it divides spend by", () => {
    const row = (attempt_id: string | null): HealthRow => ({
      ts: new Date(at(0)).toISOString(),
      ticket: 1,
      kind: "review",
      measured: true,
      total_cost_usd: 0.2,
      estimated_cost_usd: 0,
      num_turns: 1,
      duration_ms: 1,
      models: {},
      attempt_id,
    });
    const r = laneValueReport({
      transitions: [],
      verdicts: [],
      ledger: [row("c/1"), row("c/1"), row(null)],
    });
    const review = r.lanes.find((l) => l.lane === "agent-review")!;
    // $0.60 over two attempts: c/1 and the id-less row on its own.
    expect(review.cost_per_attempt_usd).toBe(0.3);
    expect(review.ledger_attempts).toBe(2);
    expect(r.cost_per_attempt_basis).toBe("ledger_attempt_id");
    expect(r.limits.join(" ")).toMatch(/latest delivery row/);
  });
});

describe("review-rule keys: ids drop out", () => {
  it("a six-character comment-id prefix is an id", () => {
    expect(normaliseFeedback("See comment 3fa85f: add a test for the empty list")).toBe(
      normaliseFeedback("See comment 9bc12e: add a test for the empty list"),
    );
    expect(normaliseFeedback("See comment 3fa85f: add a test for the empty list")).toBe(
      "see comment add a test for the empty list",
    );
  });

  it("two reasons that differ only in paths, files and numbers share one key", () => {
    const item = (ticketId: string, text: string) => ({
      ticketId,
      ticketNumber: Number(ticketId.slice(1)),
      repo: "app",
      source: "send_back_reason" as const,
      text,
      actorType: "human",
      actorId: "tom",
      atMs: at(Number(ticketId.slice(1))),
    });
    const c = reviewRuleCandidates(
      [
        item("t1", "Add a regression test in src/export/csv.ts for #41"),
        item("t2", "add a regression test in lib/report.js:120 for T-7!"),
        item("t3", "Add a regression test in packages/app/test/a.test.ts for 3"),
      ],
      3,
    );
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ key: "add a regression test in for", count: 3 });
  });
});

/** A server whose memory reader files review rules through `propose`. */
async function serverWith(propose: MemoryReader["proposeReviewRule"]) {
  process.env.DISPATCH_AUDIT_OFF = "1";
  const wg = Dispatch.open(":memory:", new TestClock());
  const memoryReader: MemoryReader = {
    ...createMemoryReader({} as NodeJS.ProcessEnv),
    proposeReviewRule: propose,
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
  const order: string[] = [];
  server.prependListener("request", (_req, res) =>
    res.once("finish", () => order.push("response")),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const repo = wg.registerRepository({ name: "app", default_branch: "main" }, human);
  void repo;
  const tickets = Array.from({ length: 5 }, (_, i) => {
    const t = wg.createTicket({ title: `T${i}` }, human);
    wg.linkRepository(t.id, "app", "primary", human);
    return t;
  });
  const sendBack = (id: string) =>
    writeEvent(wg.db, {
      entity_type: "ticket",
      entity_id: id,
      actor: human,
      event_type: "ticket.transitioned",
      payload: { from: "in_review", to: "refining", reason: RULE },
    });
  const reject = async (id: string) => {
    wg.db.prepare("UPDATE tickets SET status='in_review' WHERE id=?").run(id);
    return fetch(`${base}/tickets/${id}/review/reject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "refining", reason: RULE }),
    });
  };
  const close = () =>
    new Promise<void>((r) =>
      server.close(() => {
        wg.db.close();
        r();
      }),
    );
  return { wg, tickets, sendBack, reject, order, close };
}

const RULE = "Repository methods must return null, not undefined";
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
};
const proposedRows = (wg: Dispatch) =>
  (
    wg.db
      .prepare("SELECT COUNT(*) AS n FROM work_events WHERE event_type = 'review_rule.proposed'")
      .get() as { n: number }
  ).n;

describe("the review-rule proposal never delays or fails the person's reject", () => {
  it("runs after the response is sent, and still files the draft", async () => {
    const saved = process.env.MEMORY_CLI_BIN;
    process.env.MEMORY_CLI_BIN = "/configured/memory.js";
    const s = await serverWith(() => {
      s.order.push("propose");
      return { available: true, id: "rule2345" };
    });
    try {
      s.sendBack(s.tickets[0]!.id);
      s.sendBack(s.tickets[1]!.id);
      const res = await s.reject(s.tickets[2]!.id);
      expect(res.status).toBe(200);
      await until(() => s.order.includes("propose"));
      expect(s.order).toEqual(["response", "propose"]);
      expect(proposedRows(s.wg)).toBe(1);
    } finally {
      if (saved === undefined) delete process.env.MEMORY_CLI_BIN;
      else process.env.MEMORY_CLI_BIN = saved;
      await s.close();
    }
  });

  it("a memory failure (or a throw) leaves the reject's status alone and is not retried on every reject", async () => {
    const saved = process.env.MEMORY_CLI_BIN;
    process.env.MEMORY_CLI_BIN = "/configured/memory.js";
    let calls = 0;
    const s = await serverWith(() => {
      calls += 1;
      if (calls === 1) throw new Error("memory CLI hung");
      return { available: false, reason: "memory down" };
    });
    try {
      s.sendBack(s.tickets[0]!.id);
      s.sendBack(s.tickets[1]!.id);
      const first = await s.reject(s.tickets[2]!.id);
      expect(first.status).toBe(200);
      await until(() => calls > 0);
      const second = await s.reject(s.tickets[3]!.id);
      expect(second.status).toBe(200);
      const third = await s.reject(s.tickets[4]!.id);
      expect(third.status).toBe(200);
      await new Promise((r) => setTimeout(r, 100));
      // One attempt, then a back-off: a broken memory does not spawn on every reject.
      expect(calls).toBe(1);
      expect(proposedRows(s.wg)).toBe(0);
    } finally {
      if (saved === undefined) delete process.env.MEMORY_CLI_BIN;
      else process.env.MEMORY_CLI_BIN = saved;
      await s.close();
    }
  });
});

describe.skipIf(!CLI_BUILT)("CLI principals and the measure verbs", () => {
  it("a scoped principal files a link only when it can see both tickets; a reader reads review-rules", () => {
    const dir = mkdtempSync(join(tmpdir(), "measure-review-"));
    try {
      const db = join(dir, "d.sqlite");
      const wg = Dispatch.open(db, new TestClock());
      const app = wg.registerRepository({ name: "app", default_branch: "main" }, human);
      const svc = wg.registerRepository({ name: "svc", default_branch: "main" }, human);
      const mk = (title: string, repo: string, done = false) => {
        const t = wg.createTicketWithLinks(
          { title, description: "", policy_pack: "solo_loose", risk_level: "low" },
          { repoAccess: [{ repo_id: repo, access: "write" }] },
          human,
        );
        if (done) wg.db.prepare("UPDATE tickets SET status='done' WHERE id=?").run(t.id);
        return t;
      };
      const changeOnApp = mk("change on app", app.id, true);
      const changeOnSvc = mk("change on svc", svc.id, true);
      const defect = mk("defect on app", app.id);
      const scoped = wg.createPrincipal({ name: "app-bot", repos: ["app"] }, human);
      const reader = wg.createPrincipal({ name: "app-reader", capability: "read" }, human);
      wg.db.close();
      const as = (token: string) => ({
        env: { GAFFER_PRINCIPAL_TOKEN: token, DISPATCH_AUDIT_OFF: "1" },
      });

      const ok = runBin(
        db,
        ["ticket", "regression-of", defect.id, "--of", changeOnApp.id],
        as(scoped.token),
      );
      expect(ok.status, ok.stderr).toBe(0);
      expect(JSON.parse(ok.stdout)).toMatchObject({ recorded: true });

      const out = runBin(
        db,
        ["ticket", "regression-of", defect.id, "--of", changeOnSvc.id],
        as(scoped.token),
      );
      expect(out.status).not.toBe(0);
      expect(out.stderr).toMatch(/SCOPE_DENIED/);

      const readerWrite = runBin(
        db,
        ["ticket", "regression-of", defect.id, "--of", changeOnApp.id, "--withdraw"],
        as(reader.token),
      );
      expect(readerWrite.status).not.toBe(0);

      const read = runBin(db, ["review-rules"], as(reader.token));
      expect(read.status, read.stderr).toBe(0);
      const propose = runBin(db, ["review-rules", "propose"], as(reader.token));
      expect(propose.status).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

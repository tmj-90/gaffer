/**
 * ROUTING SCORECARD (delta roadmap gap 4, P1): per provider x model x role x work class,
 * from the usage ledger, the replay manifests and the outcomes dispatch owns. Every figure
 * carries its n; a cell under the minimum reads "too few to compare" with no rate; cells
 * are never ranked and there is no composite score; unknown and estimated costs are
 * labelled, never imputed. Hand-worked fixture.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createApiServer } from "../src/api/server.js";
import { computeStats, renderStats } from "../src/cli/ops.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { writeEvent } from "../src/events/eventWriter.js";
import {
  parseRoutingLine,
  readManifestFacts,
  renderRoutingScorecard,
  routingScorecard,
  TOO_FEW,
  type ManifestFact,
  type RoutingRow,
  type ScorecardTransition,
} from "../src/health/routingScorecard.js";
import { TestClock } from "../src/util/clock.js";

const T0 = Date.parse("2026-06-01T09:00:00.000Z");
const iso = (m: number) => new Date(T0 + m * 60_000).toISOString();

function row(
  ticket: number,
  attempt: number,
  model: string,
  usd: number | "unknown",
  extra: Partial<RoutingRow> = {},
): RoutingRow {
  const line = JSON.stringify({
    ts: iso(ticket * 10 + attempt),
    started_at: iso(ticket * 10 + attempt),
    ticket,
    kind: "delivery",
    measured: usd !== "unknown",
    total_cost_usd: usd,
    attempt_id: `c${ticket}/${attempt}`,
    model_requested: model,
    risk: "low",
    repo: "app",
    ...extra,
  });
  return parseRoutingLine(line) as RoutingRow;
}

// model-a: tickets 1..12, one attempt each, all done; tickets 1 and 2 were sent back after
// review (not first-pass); ticket 3 is linked to a later regression and its tester passed.
// Ticket 13 started on model-a and was escalated to model-b on its second attempt.
// model-b: tickets 20..22, one attempt each: three attempts, under the minimum.
const tickets: Array<{ id: string; number: number; status: string }> = [];
const transitions: ScorecardTransition[] = [];
const rows: RoutingRow[] = [];
const manifests: ManifestFact[] = [];
for (let n = 1; n <= 12; n += 1) {
  tickets.push({ id: `t${n}`, number: n, status: "done" });
  rows.push(row(n, 1, "model-a", 0.5));
  manifests.push({ ticket: n, attemptId: `c${n}/1`, result: "submit", stack: "node" });
  const tr = (from: string, to: string, m: number, actorType = "human"): void => {
    transitions.push({
      ticketId: `t${n}`,
      actorType,
      fromStatus: from,
      toStatus: to,
      reason: null,
      atMs: T0 + n * 600_000 + m,
    });
  };
  tr("in_progress", "in_review", 1, "system");
  if (n <= 2) {
    tr("in_review", "refining", 2);
    tr("refining", "in_progress", 3, "system");
    tr("in_progress", "in_review", 4, "system");
  }
  tr("in_review", "done", 5);
}
tickets.push({ id: "t13", number: 13, status: "blocked" });
rows.push(row(13, 1, "model-a", 0.4));
rows.push(row(13, 2, "model-b", 1.2));
manifests.push({
  ticket: 13,
  attemptId: "c13/1",
  result: "rework:definition-of-done",
  stack: "node",
});
manifests.push({
  ticket: 13,
  attemptId: "c13/2",
  result: "park:definition-of-done",
  stack: "node",
});
for (const n of [20, 21, 22]) {
  tickets.push({ id: `t${n}`, number: n, status: "done" });
  rows.push(row(n, 1, "model-b", n === 22 ? "unknown" : 1.0));
}
// A reviewer call: another role, its own cell.
rows.push(
  parseRoutingLine(
    JSON.stringify({
      ts: iso(1),
      ticket: 1,
      kind: "review",
      measured: true,
      total_cost_usd: 0.1,
      model_requested: "model-b",
      risk: "low",
      repo: "app",
    }),
  ) as RoutingRow,
);

const card = routingScorecard({
  rows,
  manifests,
  tickets,
  transitions,
  retries: [],
  escaped: new Set(["t3"]),
  testerVerdict: new Map([["t3", "pass"]]),
  repoStack: new Map([["app", "node"]]),
});
const cell = (role: string, model: string) =>
  card.cells.find((c) => c.role === role && c.model === model);

describe("routing scorecard", () => {
  it("a cell with enough attempts shows every measure with its n", () => {
    const a = cell("implement", "model-a");
    expect(a).toMatchObject({
      provider: "claude-code",
      risk: "low",
      stack: "node",
      n: 13,
      too_few: false,
      attempts: 13,
      calls: 13,
      outcome_known: 13,
      submission_pct: { value: 92.3, n: 13 },
      rework_pct: { value: 7.7, n: 13 },
      tickets: 13,
      accepted: 12,
      first_pass_pct: { value: 83.3, n: 12 },
      escaped_defect_pct: { value: 8.3, n: 12 },
      tester_false_greens: { value: 1, n: 12 },
    });
    // Ticket 13's escalated second attempt ($1.2, model-b) counts in model-a's cost per
    // accepted change: the ticket started there; so does ticket 1's reviewer call ($0.1).
    // 12 x 0.5 + 0.1 + 0.4 + 1.2 = 7.7 over 12 accepted.
    expect(a?.cost_per_accepted_change_usd).toEqual({ value: 0.641667, n: 12 });
    expect(a?.attempts_per_accepted_change).toEqual({ value: 1.17, n: 12 });
  });

  it("a cell under the minimum reads too few to compare, with its n and no rate", () => {
    const b = cell("implement", "model-b");
    expect(b).toMatchObject({ n: 4, too_few: true, note: TOO_FEW, spend_usd: null });
    expect(b?.first_pass_pct).toBeNull();
    expect(b?.cost_per_accepted_change_usd).toBeNull();
    expect(b?.submission_pct).toBeNull();
  });

  it("an unknown cost is counted and labelled, never imputed", () => {
    const b = cell("implement", "model-b");
    expect(b?.unknown_rows).toBe(1);
    const lowMin = routingScorecard({ ...baseInput(), minN: 2 });
    const bb = lowMin.cells.find((c) => c.role === "implement" && c.model === "model-b");
    expect(bb?.spend_usd).toBe(3.2);
    expect(bb?.unknown_rows).toBe(1);
  });

  it("a rate whose denominator is under the minimum is suppressed in an otherwise full cell", () => {
    const strict = routingScorecard({ ...baseInput(), minN: 13 });
    const a = strict.cells.find((c) => c.role === "implement" && c.model === "model-a");
    expect(a?.too_few).toBe(false);
    expect(a?.submission_pct).toEqual({ value: 92.3, n: 13 });
    expect(a?.first_pass_pct).toEqual({ value: null, n: 12 });
  });

  it("another role's cell carries calls and spend only", () => {
    const r = routingScorecard({ ...baseInput(), minN: 1 }).cells.find((c) => c.role === "review");
    expect(r).toMatchObject({ model: "model-b", calls: 1, spend_usd: 0.1, first_pass_pct: null });
  });

  it("is never ranked and has no composite score", () => {
    const keys = card.cells.map((c) => [c.role, c.provider, c.model, c.risk, c.stack].join("|"));
    expect(keys).toEqual([...keys].sort());
    expect(JSON.stringify(card)).not.toMatch(/"(?:score|rank|best|winner)"/);
    expect(card.report_only).toBe(true);
    expect(card.footnote).toMatch(/Report only/);
    expect(Object.keys(card.definitions)).toEqual(
      expect.arrayContaining(["cell", "n", "first_pass_pct", "cost_per_accepted_change_usd"]),
    );
  });

  it("renders n everywhere and the suppression wording", () => {
    const text = renderRoutingScorecard(card);
    expect(text).toMatch(/implement · claude-code · model-a · risk low · stack node: n=13/);
    expect(text).toMatch(/first pass 83\.3% \(n=12\)/);
    expect(text).toMatch(/model-b · risk low · stack node: n=4 · too few to compare/);
    expect(text).not.toMatch(/recommend/i);
  });
});

function baseInput() {
  return {
    rows,
    manifests,
    tickets,
    transitions,
    retries: [],
    escaped: new Set(["t3"]),
    testerVerdict: new Map([["t3", "pass"]]),
    repoStack: new Map([["app", "node"]]),
  };
}

describe("readManifestFacts", () => {
  it("reads the runner's manifests and skips anything else", () => {
    const dir = mkdtempSync(join(tmpdir(), "rsc-m-"));
    try {
      writeFileSync(
        join(dir, "4-1.json"),
        JSON.stringify({
          schema: "gaffer.replay-manifest/1",
          ticket: { number: 4 },
          ledger: { attempt_id: "c4/1" },
          outcome: { result: "submit" },
          repos: [{ stack: "node" }],
        }),
      );
      writeFileSync(join(dir, "4-2.json"), "{not json");
      writeFileSync(join(dir, "notes.txt"), "x");
      expect(readManifestFacts(dir)).toEqual([
        { ticket: 4, attemptId: "c4/1", result: "submit", stack: "node" },
      ]);
      expect(readManifestFacts(join(dir, "absent"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("GET /api/health routing_scorecard and wg stats", () => {
  it("serves the scorecard from the ledger and manifests under GAFFER_DATA", async () => {
    process.env.DISPATCH_AUDIT_OFF = "1";
    const data = mkdtempSync(join(tmpdir(), "rsc-d-"));
    const prev = { data: process.env.GAFFER_DATA, ledger: process.env.GAFFER_USAGE_LEDGER };
    process.env.GAFFER_DATA = data;
    delete process.env.GAFFER_USAGE_LEDGER;
    const wg = Dispatch.open(":memory:", new TestClock());
    const server = createApiServer(wg);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const human: Actor = { type: "human", id: "tom" };
      const t = wg.createTicket({ title: "Routed" }, human);
      writeEvent(wg.db, {
        entity_type: "ticket",
        entity_id: t.id,
        actor: { type: "system" },
        event_type: "ticket.transitioned",
        payload: { from: "ready", to: "in_progress" },
      });
      writeFileSync(
        join(data, "usage-ledger.jsonl"),
        JSON.stringify({
          ts: iso(0),
          ticket: t.number,
          kind: "delivery",
          measured: true,
          total_cost_usd: 0.3,
          attempt_id: "c1/1",
          model_requested: "model-a",
          risk: "medium",
        }) + "\n",
      );
      mkdirSync(join(data, "manifests"));
      writeFileSync(
        join(data, "manifests", `${t.number}-1.json`),
        JSON.stringify({
          schema: "gaffer.replay-manifest/1",
          ticket: { number: t.number },
          ledger: { attempt_id: "c1/1" },
          outcome: { result: "submit" },
          repos: [],
        }),
      );
      const port = (server.address() as AddressInfo).port;
      const body = (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()) as {
        routing_scorecard: {
          min_n: number;
          rows: number;
          manifests: number;
          cells: Array<Record<string, unknown>>;
        };
      };
      expect(body.routing_scorecard).toMatchObject({ min_n: 10, rows: 1, manifests: 1 });
      expect(body.routing_scorecard.cells[0]).toMatchObject({
        role: "implement",
        model: "model-a",
        risk: "medium",
        n: 1,
        too_few: true,
        note: TOO_FEW,
      });
      // `wg stats` is unchanged; the scorecard is its own command.
      expect(renderStats(computeStats(wg.db, new Date().toISOString(), {}))).not.toMatch(
        /Routing scorecard/,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      wg.db.close();
      if (prev.data === undefined) delete process.env.GAFFER_DATA;
      else process.env.GAFFER_DATA = prev.data;
      if (prev.ledger !== undefined) process.env.GAFFER_USAGE_LEDGER = prev.ledger;
      rmSync(data, { recursive: true, force: true });
    }
  });
});

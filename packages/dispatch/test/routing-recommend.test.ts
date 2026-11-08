/**
 * ADVISORY ROUTING RECOMMENDATIONS (delta roadmap gap 4, P3): `wg routing recommend` reads
 * the scorecard and experiment results and PRINTS a proposed model-registry.json change as
 * a diff with its evidence. It never writes the registry (byte-identical after), never
 * proposes for a safety lane, never proposes from a stub-mode experiment, and proposes
 * nothing under the minimum n.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import { writeEvent } from "../src/events/eventWriter.js";
import {
  NON_INFERIORITY_MARGIN,
  readRegistry,
  recommendRouting,
  renderRecommendation,
  routingHealthLine,
  type ExperimentResults,
} from "../src/health/routingRecommend.js";
import {
  parseRoutingLine,
  routingScorecard,
  type RoutingRow,
  type ScorecardTransition,
} from "../src/health/routingScorecard.js";
import { TestClock } from "../src/util/clock.js";

import { CLI_BUILT, runBin } from "./helpers/cliBin.js";

const T0 = Date.parse("2026-06-01T09:00:00.000Z");
const REGISTRY = resolve(__dirname, "..", "..", "..", "runner", "model-registry.json");
/** The shipped registry with its tiers pointed at neutral test model ids. */
const registryText = readFileSync(REGISTRY, "utf8")
  .replace(/("cheap"\s*:\s*)"[^"]*"/, '$1"model-a"')
  .replace(/("mid"\s*:\s*)"[^"]*"/, '$1"model-b"')
  .replace(/("strong"\s*:\s*)"[^"]*"/, '$1"model-c"');

interface Spec {
  model: string;
  role?: string;
  usd: number;
  sentBack?: number;
  escaped?: number;
  from: number;
  count: number;
}

/** Build scorecard inputs: `count` tickets per spec, each one attempt, all done. */
function world(specs: Spec[]) {
  const tickets: Array<{ id: string; number: number; status: string }> = [];
  const transitions: ScorecardTransition[] = [];
  const rows: RoutingRow[] = [];
  const escaped = new Set<string>();
  for (const s of specs) {
    for (let i = 0; i < s.count; i += 1) {
      const n = s.from + i;
      tickets.push({ id: `t${n}`, number: n, status: "done" });
      rows.push(
        parseRoutingLine(
          JSON.stringify({
            ts: new Date(T0 + n * 60_000).toISOString(),
            ticket: n,
            kind: s.role === "review" ? "review" : "delivery",
            measured: true,
            total_cost_usd: s.usd,
            attempt_id: `c${n}/1`,
            model_requested: s.model,
            risk: "medium",
            repo: "app",
          }),
        ) as RoutingRow,
      );
      const at = T0 + n * 600_000;
      const tr = (from: string, to: string, d: number, actorType = "human") =>
        transitions.push({
          ticketId: `t${n}`,
          actorType,
          fromStatus: from,
          toStatus: to,
          reason: null,
          atMs: at + d,
        });
      tr("in_progress", "in_review", 1, "system");
      if (i < (s.sentBack ?? 0)) {
        tr("in_review", "refining", 2);
        tr("refining", "in_progress", 3, "system");
        tr("in_progress", "in_review", 4, "system");
      }
      tr("in_review", "done", 5);
      if (i < (s.escaped ?? 0)) escaped.add(`t${n}`);
    }
  }
  return routingScorecard({
    rows,
    manifests: [],
    tickets,
    transitions,
    retries: [],
    escaped,
    testerVerdict: new Map(),
    repoStack: new Map([["app", "node"]]),
  });
}

const reg = (() => {
  const dir = mkdtempSync(join(tmpdir(), "rr-reg-"));
  try {
    writeFileSync(join(dir, "r.json"), registryText);
    return readRegistry(join(dir, "r.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

const recommend = (card: ReturnType<typeof world>, experiments: ExperimentResults[] = []) =>
  recommendRouting({
    scorecard: card,
    registry: reg!.registry,
    registryText,
    registryPath: "/r.json",
    experiments,
  });

// Newcombe paired score intervals, as runner/eval/experiment.mjs computes them
// (runner/test/eval-experiment-interval.test.mjs checks the same figures).
// 20 tickets: 17 both accepted, 3 only the cheaper arm → within the margin.
const NEWCOMBE_WITHIN = {
  mean: 0.15,
  ci95: [-0.0384, 0.3604] as [number, number],
  method: "newcombe_paired_score",
  discordant: 3,
  favours_arm: 3,
  favours_baseline: 0,
};
// 31 tickets: 30 both accepted, 1 only the cheaper arm → within 0.10, outside 0.05
// (review14/3).
const NEWCOMBE_PILOT = {
  mean: 0.0323,
  ci95: [-0.0811, 0.1619] as [number, number],
  method: "newcombe_paired_score",
  discordant: 1,
  favours_arm: 1,
  favours_baseline: 0,
};
// 10 tickets, all ties: no information about the difference.
const NEWCOMBE_TIES = {
  mean: 0,
  ci95: [-0.2775, 0.2775] as [number, number],
  method: "newcombe_paired_score",
  discordant: 0,
  favours_arm: 0,
  favours_baseline: 0,
};
// 24 tickets: 20 both, 1 only the arm, 3 only the baseline → outside the margin.
const NEWCOMBE_OUTSIDE = {
  mean: -0.0833,
  ci95: [-0.2742, 0.1026] as [number, number],
  method: "newcombe_paired_score",
  discordant: 4,
  favours_arm: 1,
  favours_baseline: 3,
};

describe("routing recommend", () => {
  it("proposes a cheaper tier that is no worse, as a registry diff with its evidence", () => {
    const card = world([
      { model: "model-a", usd: 0.3, from: 1, count: 12, sentBack: 1 },
      { model: "model-b", usd: 0.9, from: 101, count: 12, sentBack: 2 },
    ]);
    const r = recommend(card);
    expect(r.advisory).toBe(true);
    expect(r.proposals).toHaveLength(1);
    const p = r.proposals[0]!;
    expect(p).toMatchObject({
      role: "implement",
      from_tier: "mid",
      to_tier: "cheap",
      kind: "cheaper_no_worse",
    });
    expect(p.evidence[0]).toMatchObject({
      work_class: "provider claude-code, risk medium, stack node",
      to: { model: "model-a", n: 12, first_pass_pct: 91.7 },
      from: { model: "model-b", n: 12, first_pass_pct: 83.3 },
      delta_first_pass_points: 8.4,
      delta_cost_usd: -0.6,
    });
    expect(p.diff).toMatch(
      /^--- a\/runner\/model-registry\.json\n\+\+\+ b\/runner\/model-registry\.json\n@@ /,
    );
    expect(p.diff).toMatch(/\n-\s+"implement": "mid",\n\+\s+"implement": "cheap",\n/);
    const text = renderRecommendation(r);
    expect(text).toMatch(/advisory: nothing was changed/);
    expect(text).toMatch(/1\. implement: default tier mid -> cheap/);
    expect(text).toMatch(/model-a n=12 first pass 91\.7%/);
    expect(text).toMatch(/apply it yourself by editing the registry/);
  });

  it("proposes nothing under the minimum n", () => {
    const card = world([
      { model: "model-a", usd: 0.3, from: 1, count: 9 },
      { model: "model-b", usd: 0.9, from: 101, count: 12 },
    ]);
    const r = recommend(card);
    expect(r.proposals).toEqual([]);
    expect(r.not_proposed.join("\n")).toMatch(/no other tier is cheaper and no worse/);
    expect(renderRecommendation(r)).toMatch(/No change proposed\./);
    const none = recommend(world([{ model: "model-b", usd: 0.9, from: 1, count: 3 }]));
    expect(none.not_proposed.join("\n")).toMatch(/no cell has 10 attempts yet/);
  });

  it("never proposes a tier that escaped more defects, however cheap", () => {
    const card = world([
      { model: "model-a", usd: 0.3, from: 1, count: 12, escaped: 3 },
      { model: "model-b", usd: 0.9, from: 101, count: 12, sentBack: 2 },
    ]);
    expect(recommend(card).proposals).toEqual([]);
  });

  it("never proposes for the reviewer or the tester (safety lanes)", () => {
    const card = world([
      { model: "model-a", role: "review", usd: 0.01, from: 1, count: 20 },
      { model: "model-b", role: "review", usd: 0.9, from: 101, count: 20 },
    ]);
    const r = recommend(card);
    expect(r.proposals).toEqual([]);
    expect(r.not_proposed.join("\n")).toMatch(
      /security second opinion \(a safety lane\); never proposed/,
    );
    expect(r.not_proposed.join("\n")).toMatch(/the tester is a safety lane; never proposed/);
  });

  it("a stub-mode experiment never proposes; a live one with a clear paired difference does", () => {
    const card = world([{ model: "model-b", usd: 0.9, from: 1, count: 12 }]);
    const cmp = {
      arm: "cheap",
      vs: "baseline",
      n: 12,
      differs_in: ["tier"],
      overrides: { tier: "cheap" },
      vs_overrides: {},
      acceptance: NEWCOMBE_WITHIN,
      spend_usd: { mean: -0.4, ci95: [-0.6, -0.2] as [number, number] },
      attempts: { mean: 0 },
    };
    const stub = recommend(card, [{ path: "s/results.json", mode: "stub", comparisons: [cmp] }]);
    expect(stub.proposals).toEqual([]);
    expect(stub.not_proposed.join("\n")).toMatch(/stub mode proves the pipeline, not a model/);
    const live = recommend(card, [{ path: "l/results.json", mode: "live", comparisons: [cmp] }]);
    expect(live.proposals).toHaveLength(1);
    expect(live.proposals[0]).toMatchObject({ basis: "experiment", to_tier: "cheap" });
    const few = recommend(card, [
      { path: "f/results.json", mode: "live", comparisons: [{ ...cmp, n: 4 }] },
    ]);
    expect(few.proposals).toEqual([]);
    expect(few.not_proposed.join("\n")).toMatch(/4 tickets, under the minimum 10/);
  });

  it("an experiment proposes only against a baseline that ran the default tier", () => {
    // Review: `--arm a:tier=premium --arm b:tier=cheap` differs only in the tier, but its
    // evidence compares cheap with premium, not with the default tier the diff replaces.
    const card = world([{ model: "model-b", usd: 0.9, from: 1, count: 12 }]);
    const cmp = {
      arm: "cheap",
      vs: "baseline",
      n: 12,
      differs_in: ["tier"],
      overrides: { tier: "cheap" },
      acceptance: NEWCOMBE_WITHIN,
      spend_usd: { mean: -0.4, ci95: [-0.6, -0.2] as [number, number] },
      attempts: { mean: 0 },
    };
    const other = Object.keys(reg!.registry.tiers).find(
      (t) => t !== "cheap" && t !== reg!.registry.phaseDefaults.implement,
    ) as string;
    const onOther = recommend(card, [
      {
        path: "o/results.json",
        mode: "live",
        comparisons: [{ ...cmp, vs_overrides: { tier: other } }],
      },
    ]);
    expect(onOther.proposals).toEqual([]);
    expect(onOther.not_proposed.join("\n")).toMatch(
      /its baseline did not run the default implement tier/,
    );
    const unsaid = recommend(card, [{ path: "u/results.json", mode: "live", comparisons: [cmp] }]);
    expect(unsaid.proposals).toEqual([]);
    const named = recommend(card, [
      {
        path: "n/results.json",
        mode: "live",
        comparisons: [
          { ...cmp, vs_overrides: { tier: reg!.registry.phaseDefaults.implement as string } },
        ],
      },
    ]);
    expect(named.proposals).toHaveLength(1);
  });

  describe("acceptance is a paired proportion (review13/2)", () => {
    const card = world([{ model: "model-b", usd: 0.9, from: 1, count: 12 }]);
    const cmp = (acceptance: Record<string, unknown>, n: number) => ({
      arm: "cheap",
      vs: "baseline",
      n,
      differs_in: ["tier"],
      overrides: { tier: "cheap" },
      vs_overrides: {},
      acceptance,
      spend_usd: { mean: -0.4, ci95: [-0.6, -0.2] as [number, number] },
      attempts: { mean: 0 },
    });
    const run = (acceptance: Record<string, unknown>, n: number) =>
      recommend(card, [
        {
          path: "x/results.json",
          mode: "live",
          comparisons: [cmp(acceptance, n) as unknown as ExperimentResults["comparisons"][0]],
        },
      ]);

    it("ten ties recommend nothing and say why", () => {
      const r = run(NEWCOMBE_TIES, 10);
      expect(r.proposals).toEqual([]);
      expect(r.not_proposed.join("\n")).toMatch(
        /no discordant pairs \(both arms had the same outcome on all 10 tickets\), so the run says nothing/,
      );
      // The old t interval would have read [0, 0] with a lower bound at zero.
      expect(run({ mean: 0, ci95: [0, 0] }, 10).proposals).toEqual([]);
    });

    it("discordant pairs favouring the cheaper arm within the margin recommend", () => {
      const r = run(NEWCOMBE_WITHIN, 20);
      expect(r.proposals).toHaveLength(1);
      expect(r.proposals[0]).toMatchObject({ basis: "experiment", to_tier: "cheap" });
      expect(NON_INFERIORITY_MARGIN).toBe(0.1);
      const text = renderRecommendation(r);
      expect(text).toMatch(/95% Newcombe paired score interval \[-0\.0384, 0\.3604\]/);
      expect(text).toMatch(/3 discordant pair\(s\): 3 favour cheap, 0 the baseline/);
      expect(text).toMatch(/non-inferiority margin 0\.1/);
    });

    it("a results.json written before the paired interval never recommends, however good it looks", () => {
      // The old t interval, no method, no discordant count: even a bound well above zero.
      const r = run({ mean: 0.3, ci95: [0.1, 0.5] }, 20);
      expect(r.proposals).toEqual([]);
      expect(r.not_proposed.join("\n")).toMatch(
        /not the paired-proportion interval \(results written before it\); run its report again/,
      );
    });

    it("a lower bound outside the margin does not recommend, and says why", () => {
      const r = run(NEWCOMBE_OUTSIDE, 24);
      expect(r.proposals).toEqual([]);
      expect(r.not_proposed.join("\n")).toMatch(
        /reaches -0\.2742, below the non-inferiority margin of -0\.1/,
      );
    });
  });

  // review14/3: the margin is the owner's policy, not a statistical default: an explicit
  // input (default 0.10), printed in every recommendation, and an experiment's own stored
  // margin is honoured (the tighter of the two applies).
  describe("the non-inferiority margin is an explicit input (review14/3)", () => {
    const card = world([{ model: "model-b", usd: 0.9, from: 1, count: 12 }]);
    const ex = (margin?: number): ExperimentResults =>
      ({
        path: "x/results.json",
        mode: "live",
        ...(margin !== undefined ? { margin } : {}),
        comparisons: [
          {
            arm: "cheap",
            vs: "baseline",
            n: 31,
            differs_in: ["tier"],
            overrides: { tier: "cheap" },
            vs_overrides: {},
            acceptance: NEWCOMBE_PILOT,
            spend_usd: { mean: -0.4, ci95: [-0.6, -0.2] as [number, number] },
            attempts: { mean: 0 },
          },
        ],
      }) as unknown as ExperimentResults;
    const withMargin = (margin: number | undefined, e: ExperimentResults) =>
      recommendRouting({
        scorecard: card,
        registry: reg!.registry,
        registryText,
        registryPath: "/r.json",
        experiments: [e],
        ...(margin !== undefined ? { margin } : {}),
      });

    it("a margin of 0.05 withholds what 0.10 proposes, and says which margin", () => {
      const at10 = withMargin(0.1, ex());
      expect(at10.proposals).toHaveLength(1);
      expect(at10.margin).toBe(0.1);
      const at05 = withMargin(0.05, ex());
      expect(at05.proposals).toEqual([]);
      expect(at05.margin).toBe(0.05);
      expect(at05.not_proposed.join("\n")).toMatch(
        /reaches -0\.0811, below the non-inferiority margin of -0\.05/,
      );
      expect(renderRecommendation(at05)).toMatch(/non-inferiority margin 0\.05/);
    });

    it("the default is 0.10 and every recommendation prints it", () => {
      const r = withMargin(undefined, ex());
      expect(r.margin).toBe(0.1);
      expect(renderRecommendation(r)).toMatch(/^minimum n .*non-inferiority margin 0\.1/m);
      const none = recommend(world([{ model: "model-b", usd: 0.9, from: 1, count: 3 }]));
      expect(renderRecommendation(none)).toMatch(/non-inferiority margin 0\.1/);
    });

    it("an experiment's own stored margin is honoured: the tighter one applies", () => {
      const r = withMargin(0.1, ex(0.05));
      expect(r.proposals).toEqual([]);
      expect(r.not_proposed.join("\n")).toMatch(
        /below the non-inferiority margin of -0\.05 \(the experiment's own\)/,
      );
      const p = withMargin(0.1, ex(0.2));
      expect(p.proposals).toHaveLength(1);
      expect(p.proposals[0]!.experiment).toMatchObject({ margin: 0.1 });
    });

    it("a margin outside 0 < m < 0.5 is refused", () => {
      for (const m of [0, -0.1, 0.5, 0.7, Number.NaN])
        expect(() => withMargin(m, ex())).toThrow(/margin/);
    });
  });

  it("the Health line is report-only wording", () => {
    expect(routingHealthLine(null).available).toBe(false);
    const r = recommend(world([{ model: "model-b", usd: 0.9, from: 1, count: 3 }]));
    expect(routingHealthLine(r).line).toBe("Routing: no registry change proposed. Report only.");
  });
});

describe.skipIf(!CLI_BUILT)(
  "wg routing recommend / wg stats routing (built CLI)",
  { timeout: 60_000 },
  () => {
    it("prints a diff only and leaves the registry byte-identical", () => {
      const dir = mkdtempSync(join(tmpdir(), "rr-cli-"));
      try {
        const db = join(dir, "d.sqlite");
        const data = join(dir, "data");
        mkdirSync(data);
        const regPath = join(dir, "model-registry.json");
        writeFileSync(regPath, registryText);
        const before = createHash("sha256").update(readFileSync(regPath)).digest("hex");
        const wg = Dispatch.open(db, new TestClock());
        const ledger: string[] = [];
        for (const [model, usd, base] of [
          ["model-a", 0.3, 0],
          ["model-b", 0.9, 100],
        ] as const) {
          for (let i = 0; i < 12; i += 1) {
            const t = wg.createTicket({ title: `t${base + i}` }, { type: "human", id: "tom" });
            for (const [from, to] of [
              ["ready", "in_progress"],
              ["in_progress", "in_review"],
              ["in_review", "done"],
            ] as const)
              writeEvent(wg.db, {
                entity_type: "ticket",
                entity_id: t.id,
                actor: to === "done" ? { type: "human", id: "tom" } : { type: "system" },
                event_type: "ticket.transitioned",
                payload: { from, to },
              });
            wg.db.prepare("UPDATE tickets SET status = 'done' WHERE id = ?").run(t.id);
            ledger.push(
              JSON.stringify({
                ts: new Date(T0).toISOString(),
                ticket: t.number,
                kind: "delivery",
                measured: true,
                total_cost_usd: usd,
                attempt_id: `c${t.number}/1`,
                model_requested: model,
                risk: "medium",
              }),
            );
          }
        }
        wg.db.close();
        writeFileSync(join(data, "usage-ledger.jsonl"), ledger.join("\n") + "\n");
        const env = {
          GAFFER_DATA: data,
          GAFFER_USAGE_LEDGER: undefined,
          GAFFER_MODEL_REGISTRY: undefined,
        };
        const out = runBin(db, ["routing", "recommend", "--registry", regPath], { env });
        expect(out.status).toBe(0);
        expect(out.stdout).toMatch(/implement: default tier mid -> cheap/);
        expect(out.stdout).toMatch(/-\s+"implement": "mid",\n\s+\+\s+"implement": "cheap",/);
        const after = createHash("sha256").update(readFileSync(regPath)).digest("hex");
        expect(after).toBe(before);
        const json = runBin(db, ["routing", "recommend", "--registry", regPath, "--json"], { env });
        expect(JSON.parse(json.stdout)).toMatchObject({
          measure: "routing_recommendation",
          advisory: true,
          margin: 0.1,
        });
        // review14/3: --margin is the owner's choice, printed with the advice and checked.
        const tight = runBin(
          db,
          ["routing", "recommend", "--registry", regPath, "--margin", "0.05"],
          {
            env,
          },
        );
        expect(tight.status).toBe(0);
        expect(tight.stdout).toMatch(/non-inferiority margin 0\.05/);
        const badMargin = runBin(
          db,
          ["routing", "recommend", "--registry", regPath, "--margin", "0.6"],
          {
            env,
          },
        );
        expect(badMargin.status).not.toBe(0);
        expect(`${badMargin.stdout}${badMargin.stderr}`).toMatch(
          /--margin must be a number with 0 < m < 0\.5/,
        );
        const stats = runBin(db, ["stats", "routing", "--min", "13"], { env });
        expect(stats.status).toBe(0);
        expect(stats.stdout).toMatch(
          /implement · claude-code · model-a · risk medium · stack unknown: n=12 · too few to compare/,
        );
        const bad = runBin(db, ["stats", "routing", "--min", "0"], { env });
        expect(bad.status).not.toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);

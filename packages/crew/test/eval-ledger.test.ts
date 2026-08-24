import { describe, expect, it } from "vitest";

import { formatRecord, parseLedger, summarize, type EvalRecord } from "../src/eval/evalLedger.js";
import { buildRecordLine, flag, renderSummary } from "../src/eval/evalLedgerCli.js";

const rec = (over: Partial<EvalRecord>): EvalRecord => ({
  ts: "2026-01-01T00:00:00Z",
  ticketId: "1",
  overall: "pass",
  score: 4,
  blocking: false,
  memoryPresent: false,
  dims: {},
  ...over,
});

describe("parseLedger / formatRecord", () => {
  it("round-trips a record", () => {
    const r = rec({ ticketId: "42", repo: "api", score: 3.5, dims: { correctness: 4 } });
    const [parsed] = parseLedger(formatRecord(r));
    expect(parsed).toEqual(r);
  });

  it("skips blank and corrupt lines and records missing required fields", () => {
    const jsonl = [
      "",
      "not json",
      JSON.stringify({ ticketId: "1", score: 5, overall: "pass" }),
      JSON.stringify({ ticketId: "no-score" }), // missing score → skipped
      "   ",
    ].join("\n");
    const recs = parseLedger(jsonl);
    expect(recs).toHaveLength(1);
    expect(recs[0]?.ticketId).toBe("1");
  });

  it("coerces an unknown overall to fail", () => {
    const [r] = parseLedger(JSON.stringify({ ticketId: "1", score: 2, overall: "weird" }));
    expect(r?.overall).toBe("fail");
  });
});

describe("summarize", () => {
  it("empty ledger → zeroed summary, lift null", () => {
    const s = summarize([]);
    expect(s.count).toBe(0);
    expect(s.meanScore).toBe(0);
    expect(s.memoryLift.lift).toBeNull();
  });

  it("computes pass rate, block rate, and mean score", () => {
    const s = summarize([
      rec({ overall: "pass", score: 5 }),
      rec({ overall: "fail", score: 1, blocking: true }),
      rec({ overall: "borderline", score: 3 }),
      rec({ overall: "pass", score: 4 }),
    ]);
    expect(s.count).toBe(4);
    expect(s.passRate).toBe(0.5);
    expect(s.blockRate).toBe(0.25);
    expect(s.meanScore).toBe(3.25);
  });

  it("computes per-dimension means only over records that scored them", () => {
    const s = summarize([
      rec({ dims: { correctness: 4, security: 5 } }),
      rec({ dims: { correctness: 2 } }),
    ]);
    expect(s.dimensionMeans.correctness).toBe(3);
    expect(s.dimensionMeans.security).toBe(5);
    expect(s.dimensionMeans.minimalism).toBeUndefined();
  });

  it("MEMORY LIFT: mean score with memory minus without", () => {
    const s = summarize([
      rec({ memoryPresent: true, score: 5 }),
      rec({ memoryPresent: true, score: 4 }),
      rec({ memoryPresent: false, score: 3 }),
      rec({ memoryPresent: false, score: 2 }),
    ]);
    expect(s.memoryLift.withMemory).toEqual({ count: 2, meanScore: 4.5 });
    expect(s.memoryLift.withoutMemory).toEqual({ count: 2, meanScore: 2.5 });
    expect(s.memoryLift.lift).toBe(2); // memory is worth +2.0 here
  });

  it("lift is null when one side has no data (not a fake 0)", () => {
    const s = summarize([rec({ memoryPresent: true, score: 5 })]);
    expect(s.memoryLift.lift).toBeNull();
    expect(s.memoryLift.withoutMemory.count).toBe(0);
  });

  it("COST: aggregates only costed records; costPerPass amortises failures", () => {
    const s = summarize([
      rec({ overall: "pass", costUsd: 0.4 }),
      rec({ overall: "fail", score: 1, costUsd: 0.2 }),
      rec({ overall: "pass", costUsd: 0.6 }),
      rec({ overall: "pass" }), // uncosted — excluded from cost aggregates
    ]);
    expect(s.cost.costedCount).toBe(3);
    expect(s.cost.totalCostUsd).toBe(1.2);
    expect(s.cost.meanCostUsd).toBe(0.4);
    // $1.20 spent for 2 costed passes → $0.60 per passing delivery
    expect(s.cost.costPerPass).toBe(0.6);
  });

  it("COST: costPerPass is null with no costed passes (never divide-by-zero)", () => {
    const s = summarize([rec({ overall: "fail", score: 1, costUsd: 0.3 })]);
    expect(s.cost.costPerPass).toBeNull();
    expect(s.cost.totalCostUsd).toBe(0.3);
  });
});

describe("evalLedgerCli", () => {
  it("flag() reads values / empties", () => {
    expect(flag(["--file", "x"], "--file")).toBe("x");
    expect(flag([], "--file")).toBe("");
  });

  it("buildRecordLine converts a judge verdict (dimensions[]) into a ledger line", () => {
    const verdictJson = JSON.stringify({
      ticketId: "7",
      repo: "api",
      memoryPresent: true,
      overall: "pass",
      score: 4.6,
      blocking: false,
      dimensions: [
        { dimension: "correctness", score: 5 },
        { dimension: "security", score: 4 },
      ],
    });
    const line = buildRecordLine(verdictJson, "2026-02-02T00:00:00Z");
    const [r] = parseLedger(line);
    expect(r?.ts).toBe("2026-02-02T00:00:00Z");
    expect(r?.ticketId).toBe("7");
    expect(r?.repo).toBe("api");
    expect(r?.memoryPresent).toBe(true);
    expect(r?.dims.correctness).toBe(5);
    expect(r?.dims.security).toBe(4);
  });

  it("buildRecordLine is total on garbage (fail record, never throws)", () => {
    const [r] = parseLedger(buildRecordLine("not json", "t"));
    expect(r?.overall).toBe("fail");
    expect(r?.score).toBe(0);
    expect(r?.blocking).toBe(false);
  });

  it("buildRecordLine accepts costUsd as number or bash '$0.1234' string; omits 'unknown'", () => {
    const base = { ticketId: "1", score: 4, overall: "pass" };
    const [num] = parseLedger(buildRecordLine(JSON.stringify({ ...base, costUsd: 0.25 }), "t"));
    expect(num?.costUsd).toBe(0.25);
    const [str] = parseLedger(
      buildRecordLine(JSON.stringify({ ...base, costUsd: "$0.1234" }), "t"),
    );
    expect(str?.costUsd).toBe(0.1234);
    const [unk] = parseLedger(
      buildRecordLine(JSON.stringify({ ...base, costUsd: "unknown" }), "t"),
    );
    expect(unk?.costUsd).toBeUndefined();
  });

  it("renderSummary parses a ledger and surfaces the memory-lift block", () => {
    const jsonl = [
      formatRecord(rec({ memoryPresent: true, score: 5 })),
      formatRecord(rec({ memoryPresent: false, score: 3 })),
    ].join("\n");
    const summary = JSON.parse(renderSummary(jsonl));
    expect(summary.count).toBe(2);
    expect(summary.memoryLift.lift).toBe(2);
  });
});

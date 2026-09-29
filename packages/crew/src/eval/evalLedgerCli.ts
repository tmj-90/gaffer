#!/usr/bin/env node
// =====================================================================
// Node entrypoint for the eval ledger. Two modes:
//
//   append a record (stdin = a JSON record from the runner: the judge verdict
//   plus ticket context); the CLI stamps the timestamp and appends one line:
//     printf '%s' "$record_json" | node evalLedgerCli.js --mode append --file "$LEDGER"
//
//   summarise the ledger (prints the quality summary as JSON):
//     node evalLedgerCli.js --mode summarize --file "$LEDGER"
//
// The pure logic (buildRecordLine, renderSummary) is exported + unit-tested; the
// fs read/append and the timestamp live in the script guard so this file stays
// covered without mocking the filesystem.
// =====================================================================

import { appendFileSync, readFileSync } from "node:fs";

import { type Overall, type RubricDimension } from "./deliveryJudge.js";
import { formatRecord, parseLedger, summarize, type EvalRecord } from "./evalLedger.js";

export function flag(argv: string[], name: string): string {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name) return argv[i + 1] ?? "";
  }
  return "";
}

/** Normalise a `dimensions: [{dimension,score}]` array (judge shape) to a `dims` map. */
function toDimsMap(input: unknown): Partial<Record<RubricDimension, number>> {
  const dims: Partial<Record<RubricDimension, number>> = {};
  if (Array.isArray(input)) {
    for (const d of input) {
      if (d && typeof d === "object") {
        const e = d as Record<string, unknown>;
        if (typeof e.dimension === "string" && typeof e.score === "number") {
          dims[e.dimension as RubricDimension] = e.score;
        }
      }
    }
  } else if (input && typeof input === "object") {
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (typeof v === "number") dims[k as RubricDimension] = v;
    }
  }
  return dims;
}

/**
 * Pull the judge's per-dimension rationale out of the `dimensions[]` shape (or a
 * pre-built `rationale` map). Strings only, trimmed, capped at 500 chars — the same
 * cap parseJudgeVerdict applies — so a verbose judge cannot bloat the ledger.
 */
function toRationaleMap(
  dimensions: unknown,
  prebuilt: unknown,
): Partial<Record<RubricDimension, string>> {
  const out: Partial<Record<RubricDimension, string>> = {};
  const put = (k: unknown, v: unknown) => {
    if (typeof k !== "string" || typeof v !== "string") return;
    const text = v.trim().slice(0, 500);
    if (text) out[k as RubricDimension] = text;
  };
  if (Array.isArray(dimensions)) {
    for (const d of dimensions) {
      if (d && typeof d === "object") {
        const e = d as Record<string, unknown>;
        put(e.dimension, e.rationale);
      }
    }
  }
  if (prebuilt && typeof prebuilt === "object") {
    for (const [k, v] of Object.entries(prebuilt as Record<string, unknown>)) put(k, v);
  }
  return out;
}

/** Build one JSONL ledger line from a runner-supplied record JSON + a timestamp. Pure. */
export function buildRecordLine(recordJson: string, ts: string): string {
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(recordJson);
    if (parsed && typeof parsed === "object") raw = parsed as Record<string, unknown>;
  } catch {
    raw = {};
  }
  const overall = (
    raw.overall === "pass" || raw.overall === "borderline" ? raw.overall : "fail"
  ) as Overall;
  // Cost arrives from bash, which reads the spend helper's "$0.1234" / "unknown"
  // output — accept a number or a numeric string (with or without the $), and
  // OMIT the field otherwise (absent ≠ free; a fake 0 would poison cost means).
  const rawCost = raw.costUsd;
  const cost =
    typeof rawCost === "number"
      ? rawCost
      : typeof rawCost === "string"
        ? Number.parseFloat(rawCost.replace(/^\$/, ""))
        : Number.NaN;
  const record: EvalRecord = {
    ts,
    ticketId: String(raw.ticketId ?? ""),
    ...(typeof raw.repo === "string" ? { repo: raw.repo } : {}),
    overall,
    score: typeof raw.score === "number" ? raw.score : 0,
    blocking: Boolean(raw.blocking),
    memoryPresent: Boolean(raw.memoryPresent),
    dims: toDimsMap(raw.dims ?? raw.dimensions),
    ...(Number.isFinite(cost) && cost >= 0 ? { costUsd: cost } : {}),
    ...(typeof raw.judgeModel === "string" && raw.judgeModel.trim()
      ? { judgeModel: raw.judgeModel.trim() }
      : {}),
  };
  const rationale = toRationaleMap(raw.dimensions, raw.rationale);
  if (Object.keys(rationale).length > 0) record.rationale = rationale;
  return formatRecord(record);
}

/** Read a ledger's JSONL and render its summary as pretty JSON. Pure. */
export function renderSummary(jsonl: string): string {
  return JSON.stringify(summarize(parseLedger(jsonl)), null, 2);
}

// Entrypoint: run only when executed as a script, not when imported by a test.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const mode = flag(argv, "--mode") || "summarize";
  const file = flag(argv, "--file");

  if (mode === "append") {
    let stdin: string;
    try {
      stdin = readFileSync(0, "utf8");
    } catch {
      stdin = "";
    }
    const ts = flag(argv, "--ts") || new Date().toISOString();
    if (file) appendFileSync(file, buildRecordLine(stdin, ts) + "\n");
  } else {
    let jsonl: string;
    try {
      jsonl = file ? readFileSync(file, "utf8") : "";
    } catch {
      jsonl = "";
    }
    process.stdout.write(renderSummary(jsonl) + "\n");
  }
}

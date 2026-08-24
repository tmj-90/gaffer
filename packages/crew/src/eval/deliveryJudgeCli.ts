#!/usr/bin/env node
// =====================================================================
// Node entrypoint for the delivery-quality judge. Two modes, both stdin-driven
// (the payloads are large multi-line untrusted text — stdin avoids any
// argv/shell-escaping risk), mirroring the other crew CLI seams:
//
//   render the judge prompt (runner then feeds it to a model):
//     printf '%s' "$judge_input_json" | node deliveryJudgeCli.js --mode prompt
//
//   parse the model's reply into a verdict the gate + telemetry act on:
//     printf '%s' "$model_reply" | node deliveryJudgeCli.js --mode parse
//
// --mode parse OUTPUT (so bash can act without a JSON parser, and telemetry gets
// the full record):
//   line 1  overall     (pass | borderline | fail)
//   line 2  blocking     (1 = do not auto-advance, 0 = ok)
//   line 3  score        (0.00–5.00)
//   line 4  <json verdict>   (one line, for the eval ledger)
//
// The decision logic is the pure, exported `runJudgeCli` so it is unit-tested
// directly; `main()` only wires stdin/argv/stdout and runs when executed as a
// script (not when imported).
// =====================================================================

import { readFileSync } from "node:fs";

import { parseJudgeVerdict, renderJudgePrompt, type JudgeInput } from "./deliveryJudge.js";

export function flag(argv: string[], name: string): string {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name) return argv[i + 1] ?? "";
  }
  return "";
}

/** Pure CLI core: (argv, stdin) → (stdout, exitCode). No I/O, fully testable. */
export function runJudgeCli(argv: string[], stdin: string): { stdout: string; exitCode: number } {
  const mode = flag(argv, "--mode") || "parse";

  if (mode === "prompt") {
    let parsed: Partial<JudgeInput>;
    try {
      parsed = JSON.parse(stdin) as Partial<JudgeInput>;
    } catch {
      parsed = {};
    }
    const judgeInput: JudgeInput = {
      ticketTitle: String(parsed.ticketTitle ?? ""),
      acceptanceCriteria: Array.isArray(parsed.acceptanceCriteria) ? parsed.acceptanceCriteria : [],
      diff: String(parsed.diff ?? ""),
      ...(parsed.evidence != null ? { evidence: String(parsed.evidence) } : {}),
      ...(parsed.testOutput != null ? { testOutput: String(parsed.testOutput) } : {}),
    };
    return { stdout: renderJudgePrompt(judgeInput), exitCode: 0 };
  }

  const verdict = parseJudgeVerdict(stdin);
  // Line 2 is `judged:blocking` (e.g. "1:0") so a bash caller can tell a real
  // grading (judged=1) from a refusal/garbled reply (judged=0) — the latter
  // must NOT be recorded as a quality verdict, or a judge refusal lands as a
  // fake score-0 fail and poisons the metric.
  const stdout =
    [
      verdict.overall,
      `${verdict.judged ? "1" : "0"}:${verdict.blocking ? "1" : "0"}`,
      verdict.score.toFixed(2),
      JSON.stringify(verdict),
    ].join("\n") + "\n";
  // Exit: 0 = judged & ok · 1 = judged & blocking · 2 = NOT judged (an infra
  // outcome, not a quality fail) so a caller can branch three ways.
  return { stdout, exitCode: !verdict.judged ? 2 : verdict.blocking ? 1 : 0 };
}

// Entrypoint: run only when executed as a script, not when imported by a test.
// The decision logic is the pure, tested `runJudgeCli`; this block is just the
// stdin→stdout wiring (a few lines, exercised end-to-end by the parity/e2e path,
// not the unit tests — which is why it is left uncovered rather than mocked).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  let stdin: string;
  try {
    stdin = readFileSync(0, "utf8");
  } catch {
    stdin = "";
  }
  const { stdout, exitCode } = runJudgeCli(process.argv.slice(2), stdin);
  process.stdout.write(stdout);
  process.exitCode = exitCode;
}

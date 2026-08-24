# Eval harness — measuring delivery quality (judge → ledger → metrics)

Status: **live behind `GAFFER_EVAL_JUDGE=1`** (default off for a soak cycle).
Telemetry only — the verdict never gates a delivery; the human review gate stays
the sole arbiter.

## Why

Gaffer's delivery gates are boolean (DoD, hygiene, minimalism, CI): they prove a
delivery didn't break the rules, not how *good* it is. The eval harness scores
every submitted delivery so quality is a **measured number, not an assertion** —
and makes the project's core thesis ("durable memory primes better deliveries")
falsifiable.

## The pipeline

1. **Judge** (`packages/crew/src/eval/deliveryJudge.ts`, CLI `deliveryJudgeCli`)
   — an independent LLM-as-judge grades the submitted diff against the ticket's
   acceptance criteria on five dimensions (0–5 each): `ac_coverage`,
   `correctness`, `minimalism`, `test_adequacy`, `security`. Aggregation:
   weighted mean → `pass` / `borderline` / `fail`, with correctness + security as
   hard gates (≤1 fails regardless of the mean). The judged inputs are
   agent-produced and therefore untrusted — they're wrapped in `<untrusted-*>`
   envelopes with closing-tag neutralisation so a delivery cannot prompt-inject
   its own grade.
2. **Runner seam** (`runner/lib/eval-judge.sh`, wired post-submit in `tick.sh`)
   — after a successful submit, renders the judge prompt, runs ONE model turn
   through `worker_deliver` (the single env-scrubbed, timeout-bounded `claude -p`
   seam) with an **empty MCP config** (the judge gets no tools), parses the reply
   via `worker.mjs parse-result result-text`, and appends the verdict to the
   ledger. Additive + fail-soft: any failure (unbuilt crew, dead model turn,
   empty reply) records nothing and never blocks the delivery. An empty reply is
   treated as an infra failure, not a quality fail — it must not poison the
   metric. `DRY_RUN` is a no-op.
3. **Ledger** (`packages/crew/src/eval/evalLedger.ts`, CLI `evalLedgerCli`) —
   append-only JSONL at `$GAFFER_DATA/eval-ledger.jsonl`. Each record: verdict +
   per-dimension scores, ticket/repo, `memoryPresent` (was durable
   product-context primed into the delivery?), and `costUsd` (the attempt's real
   spend from the usage envelope; omitted — never faked to 0 — when unreadable).

## The metrics (`evalLedgerCli --mode summarize`)

- **passRate / blockRate / meanScore / dimensionMeans** — the quality baseline.
- **memoryLift** — mean score with memory context minus without. Positive lift
  is evidence the memory asset earns its keep; ~zero says it doesn't. `null`
  until both arms have data (never a fake 0).
- **cost.costPerPass** — total real spend over the costed records divided by the
  number of judge-passing deliveries: what a *good* delivery costs, with spend
  on failures amortised in. The FinOps headline.

```sh
node packages/crew/dist/eval/evalLedgerCli.js --mode summarize \
  --file "$GAFFER_DATA/eval-ledger.jsonl"
```

## Knobs

| Env | Default | Meaning |
|---|---|---|
| `GAFFER_EVAL_JUDGE` | `0` | `1` enables post-submit judging |
| `GAFFER_JUDGE_MODEL_FLAG` | impl model flag | model for the judge turn |
| `GAFFER_EVAL_LEDGER` | `$GAFFER_DATA/eval-ledger.jsonl` | ledger path |

## Later (deliberately not in this slice)

- **Enforcement** — acting on a `blocking` verdict (e.g. auto-park) is a
  separate, separately-flagged decision after the judge has soaked.
- **Benchmark runs** — a reproducible SWE-bench-subset harness for a headline
  number sits on top of the same judge + ledger.

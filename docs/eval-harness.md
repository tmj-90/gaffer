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

## Honest limits of the current metrics (read before trusting a number)

These are real conditioning biases, not polish — surfaced by an adversarial audit
of this harness and left visible rather than hidden:

- **Submit-success sampling.** Judging runs only after a *successful* submit
  (post-gate). Deliveries that fail DoD, park, or fail submit are never judged,
  so `passRate`/`memoryLift`/`cost.costPerPass` are conditioned on gate-passing
  work. In particular `costPerPass`'s "amortised failure spend" only includes
  deliveries that passed every boolean gate and *then* scored badly — it does
  **not** capture burn on parked/failed attempts, so it understates true
  cost-per-good-delivery. `memoryLift` is likewise measured only within
  gate-passers, so if memory mostly helps work *clear the gates*, the effect is
  conditioned away. Widening judging to failed attempts is future work.
- **Self-grading by default.** The judge turn uses
  `GAFFER_JUDGE_MODEL_FLAG`, falling back to the implementation model flag — so
  out of the box the judge shares the implementer's blind spots. Set
  `GAFFER_JUDGE_MODEL_FLAG` to a *different* (ideally stronger) model for real
  independence. Every record now carries `judgeModel` so a model swap is visible
  and doesn't silently break longitudinal comparability.
- **Prefix grading on huge diffs.** Diffs over `GAFFER_JUDGE_DIFF_BYTES`
  (120 KB default) are truncated; the judge is told so and instructed to treat
  unseen changes as ungraded, not absent — but `minimalism`/`security` on a very
  large delivery are still graded on a prefix.

## Later (deliberately not in this slice)

- **Enforcement** — acting on a `blocking` verdict (e.g. auto-park) is a
  separate, separately-flagged decision after the judge has soaked.
- **Benchmark runs** — a reproducible SWE-bench-subset harness for a headline
  number sits on top of the same judge + ledger.

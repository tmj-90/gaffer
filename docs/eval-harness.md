# Eval harness — measuring delivery quality (judge → ledger → metrics)

Status: **an opt-in feature, `GAFFER_EVAL_JUDGE=1`**. It stays off by default
because it adds a paid model call to every delivery, not because its plumbing is
unfinished. Advisory only: the verdict never gates a delivery, the human review
gate stays the sole arbiter. Whether its score is worth that call on your factory
is a measurement, not an open question: see [Is the judge worth having?](#is-the-judge-worth-having)
for the procedure (`gaffer eval agreement`) and what the evidence so far does and
does not show.

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
   ledger. The judge grades the ticket's title and acceptance criteria, the
   evidence on the ticket as it stands after the delivery (read fresh, not the
   pre-delivery snapshot), the bounded diff, and the Definition-of-Done checklist
   the delivery passed (tick.sh hands it over in `GAFFER_EVAL_TEST_OUTPUT`, because
   its results file is gone by then); the ledger record names the primary write
   repo, not the per-ticket worktree directory. The verdict also goes onto the ticket
   (`wg ticket eval-score --as system`, a `ticket.eval_judged` event), where the
   Review view's verdict strip shows it (the score, then every dimension scored 3 or
   lower with the judge's reason, labelled as a model's grade that nothing gates on)
   and `wg ticket show` carries it as `evalJudgment`. Only the runner or an admin can
   record one: the safety hook denies `eval-score` to an agent shell, so a delivery
   cannot grade itself. Additive + fail-soft: any failure (unbuilt crew, dead model turn,
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
- **memoryLift — read it as the *memory score gap*, not an uplift.** It is the mean
  judge score of submitted deliveries that had memory primed minus the mean of those
  that did not. The two arms are **different tickets** (memory tends to be primed on
  repos and tasks the factory already knows, which are also easier), and the judge
  only scores work that cleared every gate and was submitted, so the number answers
  neither "does memory cause better work" nor "what does it cost". `gaffer eval`
  prints it as `memory score gap` with each arm's sample size, the exclusion, and a
  pointer to the honest measurement below; the JSON carries
  `measure: "judge_score_gap_on_submitted_work"`, `label`, `sample`
  (`withMemory` / `withoutMemory` / `distinctTickets`), `excludes`, and
  `matched: null` with `matchedReason`. `null` until both arms have data (never a
  fake 0).
- **cost.costPerPass** — total real spend over the costed records divided by the
  number of judge-passing deliveries: what a *good* delivery costs, with spend
  on failures amortised in. The FinOps headline.

```sh
node packages/crew/dist/eval/evalLedgerCli.js --mode summarize \
  --file "$GAFFER_DATA/eval-ledger.jsonl"
```

## Matched-ticket comparison (the honest measurement — not built yet)

The question the memory gap cannot answer is causal: *for the same work, does
priming memory produce better outcomes at lower total cost?* The measurement that
answers it, and the seam it would fill (`memoryLift.matched`, today `null`):

1. **Same tickets, both arms.** Take a fixed set of tickets (the gate-replay
   fixtures, or real tickets re-run from their recorded base commit) and deliver
   each twice: once with the durable memory primed, once with priming disabled (no
   product context, lore or file cards in the primer — a per-arm switch the
   experiment runner adds; no setting suppresses priming today). Randomise the order
   so model drift does not favour one arm.
2. **Count every attempt, not only submissions.** For each ticket and arm record
   the attempts until submission or park, the total spend from the usage ledger
   (including killed and timed-out calls), whether it was submitted at all, the
   judge score when it was, and whether a human accepted it (approved without a
   rework).
3. **Report paired differences.** Per ticket: Δ acceptance, Δ total spend, Δ
   attempts, Δ judge score; then the mean and a confidence interval over tickets,
   with the ticket count. A ticket that one arm never submitted counts as a failure
   for that arm, not as missing data.

It is not built because it needs a second, paid delivery of every ticket and an
experiment runner that suppresses priming per arm; the ledger today records judged
submissions only. Until then treat the memory score gap as a description of the
work that was submitted, never as evidence that memory improved it.

## Knobs

| Env | Default | Meaning |
|---|---|---|
| `GAFFER_EVAL_JUDGE` | `0` | `1` enables post-submit judging (one extra paid model call per delivery) |
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

## Is the judge worth having?

A judge score is worth its model call only if it tells the reviewer something the
gates do not: a low score should come before a send-back, a high one before an
acceptance. This is the procedure for finding out on a real factory, and what I could
establish without one.

**The case for it.** The gates are blind to a class of poor deliveries. Three gate
replay fixtures are deliveries a careful reviewer rejects that pass hygiene,
minimalism, the Definition of Done, the acceptance checks and the gate-integrity scan:
`duplicated-helper` (copies `addTask` as a private `appendTask` instead of reusing it),
`weakened-assertion` (stops setting `done` and replaces the assertion that would catch
it with `assert.ok(task)`) and `trivial-replacement` (an inverted `removeTask` filter,
with a real test deleted and an existence check added in another file). Each replays
to `submit`, and `gaffer eval replay` keeps it that way. Only the reviewer, or the
judge, can see what is wrong with them.

**What the evidence shows so far: the plumbing, not the judge.** No factory I have
recorded data for has run the judge against a live model (there is no eval ledger on
any of them), so whether a real judge model scores those deliveries low is not shown.
What is shown, by `packages/crew/test/eval-judge-fixtures.test.ts`, is everything
between a judge reply and the report: each fixture that carries a `judge` block is
committed to a real repository and submitted to review in a real dispatch, the
runner's diff goes through the real judge prompt, a deterministic stub judge returns
the rubric the fixture records (what a careful reviewer would score), the real parse
and aggregation turn it into a verdict, the verdict is recorded on the ticket and in
the ledger, the fixture's review decision is applied, and the agreement report pairs
them. It also pins one fact about the design: minimalism is not a hard gate, so a
delivery whose only fault is a copied helper reads *borderline*, not *fail*. The
warning a reviewer can act on is any verdict short of *pass*, and that is what the
report counts.

**The measurement.** `gaffer eval agreement` (`wg judge-agreement`, `--json` for the
fields) pairs every judged delivery with what happened to that delivery next, from
the factory's own records: *accepted* (approved, and nothing sent it back before it
reached Ready for merge, through the tester when the ticket uses one), *sent back* (by
you, the agent review, or the tester), *cancelled* from review, or *pending*. A CI or
merge-gate hold is not a quality decision and is skipped. It reads the judgments on
the tickets and, for judgments recorded before they reached the ticket, the eval
ledger (paired by ticket number and time; a ledger line with a matching ticket event
is counted once). It reports:

- the verdict by outcome table (pass / borderline / fail against accepted / rejected
  / pending), and who decided each (people, the agent review, the tester: the agent
  review is a model too, so read agreement with people first);
- the rejection rate, the share of non-pass verdicts that were then rejected
  (precision) and its *lift* over the base rate, and the share of rejections the
  judge warned of (recall);
- the mean score of accepted and rejected work and the AUC (the chance an accepted
  delivery scored above a rejected one; 0.5 is no signal), and the same gap per
  dimension, which says which part of the rubric carries the signal;
- the *misses* (judged pass, then sent back, with the reviewer's reason) and the
  *false alarms* (judged short of pass, then accepted, with the weakest dimension):
  the cases to read before changing anything;
- *coverage*: how many entries into review since the first judged one were judged
  at all, so a judge failing quietly (an unbuilt crew, a dead turn, a refusal) shows
  instead of shrinking the sample unseen.

**The reading** applies a fixed rule: below 20 decided deliveries, or fewer than 5
accepted or 5 rejected, it says there is not enough data to tell. Above that, the
judge *separates* when the AUC is at least 0.7 and a non-pass verdict raises the
chance of a rejection to at least 1.5 times the base rate; otherwise it *does not
separate*, and its call is not paying for itself on that factory. The thresholds are
in the report (`thresholds`) so a reading can always be checked.

**The decision.** The judge stays off by default: it costs one extra model call per
delivery (booked in the usage ledger as kind `eval-judge`, so the budget caps and the
cost tiles see it), and on a factory I have not measured I cannot say it is worth
that. It is a documented feature, not an experiment: turn it on for a run of at least
20 reviewed deliveries, review as you normally would, then run `gaffer eval
agreement`. If it separates, keep it on and read its reasons on the Review page. If it
does not, read the misses, then try a different judge model
(`GAFFER_JUDGE_MODEL_FLAG`) or turn it off. What a change costs once every attempt is
counted, the judge's own spend included, is the *cost per accepted change* metric that
comes with the attempt accounting from external review #9 (`gaffer wg stats`, the
Health view's wage bill); the judge does not duplicate it.

## Gate replay — the offline, deterministic half

The judge measures *how good* a delivery is; the gates decide *whether it ships*
without a human. `runner/eval/replay.sh` (`gaffer eval replay`) pins the gates:
each fixture under `runner/eval/fixtures/` is a base repo plus a **recorded
delivery patch** and an `expected` block, and the driver commits the delivery on a
work branch and runs the same library functions `tick.sh` runs, in tick order —
`gaffer_assert_clean_delivery`, `gaffer_diff_stats` + `gaffer_check_minimalism`,
`gaffer_run_dod_gates`, `gaffer_run_ac_checks` — then derives the outcome tick.sh
would take (`submit` or `rework:<gate>`) and the review flags it would carry
(`missing_note`, `oversized_diff`, `unverified_note`, `zero_gates`, …). Only the
dispatch CLI is stubbed (a recorder), so the replay needs no model, database or
network and runs in seconds on every push (CI step `Gate replay (golden
fixtures)`), writing `results.json` with per-fixture expected / actual / gate rows.

The sixteen fixtures cover a known-good delivery, a test-breaking one, two hygiene
leaks (`node_modules/` + `.crew/`, a copied `src-copy/` tree), an oversized diff,
missing / boilerplate notes under both note policies, a failing acceptance check,
a repo with no gate commands under both `GAFFER_ALLOW_NO_DOD` settings, a failing
detected typecheck script, and the three gate-passing poor deliveries above. A
fixture may carry a `judge` block (its quality, the review decision a careful
reviewer makes with the reason, and the rubric that reviewer would score) which the
judge fixture run reads; the replay ignores it.
`runner/test/eval-replay.test.sh` proves the harness catches an edited
expectation **and** a weakened gate. Adding a fixture is documented in
[`runner/eval/README.md`](../runner/eval/README.md).

This closes the "submit-success sampling" blind spot from the *outside*: the
judge sees only gate-passers, the replay proves what the gates pass and bounce.

## Later (deliberately not in this slice)

- **Enforcement** — acting on a `blocking` verdict (e.g. auto-park) is a
  separate, separately-flagged decision, and only worth making on a factory where
  `gaffer eval agreement` reads *separates*.
- **Benchmark runs** — a reproducible SWE-bench-subset harness for a headline
  number sits on top of the same judge + ledger. The gate replay above is the
  deterministic scaffold it would reuse (fixture repo + recorded delivery +
  expected verdict); the missing piece is a live model producing the delivery.

# Eval harness: measuring delivery quality

Status: **an opt-in feature, `GAFFER_EVAL_JUDGE=1`**. It stays off by default
because it adds a paid model call to every delivery, not because its plumbing is
unfinished. Advisory only: the verdict never gates a delivery, the human review
gate stays the sole arbiter. Whether its score is worth that call on your factory
is a measurement, not an open question: see [Is the judge worth having?](#is-the-judge-worth-having)
for the procedure (`gaffer eval agreement`) and what the evidence so far does and
does not show.

## Why

Gaffer's delivery gates are boolean (DoD, hygiene, minimalism, CI): they prove a
delivery didn't break the rules, not how good it is. The eval harness scores every
submitted delivery so quality is a measured number, and so is whether that score
predicts what a reviewer then decides.

## The pipeline

1. **Judge** (`packages/crew/src/eval/deliveryJudge.ts`, CLI `deliveryJudgeCli`):
   an independent LLM-as-judge grades the submitted diff against the ticket's
   acceptance criteria on five dimensions (0–5 each): `ac_coverage`,
   `correctness`, `minimalism`, `test_adequacy`, `security`. Aggregation:
   weighted mean → `pass` / `borderline` / `fail`, with correctness + security as
   hard gates (≤1 fails regardless of the mean). The judged inputs are
   agent-produced and therefore untrusted: they're wrapped in `<untrusted-*>`
   envelopes with closing-tag neutralisation so a delivery cannot prompt-inject
   its own grade. The verdict is computed from the rubric scores, never read from an
   `overall` field or a "verdict: pass" line, and a reply that carries two different
   gradings (one could be a rubric the diff planted and the judge quoted) is read as
   not judged rather than taking either.
2. **Runner seam** (`runner/lib/eval-judge.sh`, wired post-submit in `tick.sh`):
   after a successful submit, renders the judge prompt, runs ONE model turn
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
   and `wg ticket show` carries it as `evalJudgment` (hidden while the ticket waits in
   review; see *Blinding* below). Only the runner or an admin can
   record one: the safety hook denies `eval-score` to an agent shell, so a delivery
   cannot grade itself. Additive + fail-soft: any failure (unbuilt crew, dead model turn,
   empty reply) records nothing and never blocks the delivery. An empty reply is
   treated as an infra failure, not a quality fail; it must not poison the
   metric. `DRY_RUN` is a no-op.
3. **Ledger** (`packages/crew/src/eval/evalLedger.ts`, CLI `evalLedgerCli`):
   append-only JSONL at `$GAFFER_DATA/eval-ledger.jsonl`. Each record: verdict +
   per-dimension scores, ticket/repo, `memoryPresent` (was durable
   product-context primed into the delivery?), and `costUsd` (the attempt's real
   spend from the usage envelope; omitted, never faked to 0, when unreadable).

## The metrics (`evalLedgerCli --mode summarize`)

- **passRate / blockRate / meanScore / dimensionMeans**: the quality baseline.
- **memoryLift, read it as the *memory score gap*, not an uplift.** It is the mean
  judge score of submitted deliveries that had memory primed minus the mean of those
  that did not. The two arms are **different tickets** (memory tends to be primed on
  repos and tasks the factory already knows, which are also easier), and the judge
  only scores work that cleared every gate and was submitted, so the number answers
  neither "does memory cause better work" nor "what does it cost". `gaffer eval`
  prints it as `memory score gap` with each arm's sample size, the exclusion, and a
  pointer to the honest measurement below; the JSON carries
  `measure: "judge_score_gap_on_submitted_work"`, `label`, `sample`
  (`withMemory` / `withoutMemory` / `distinctTickets`), `excludes`, and
  `matched` (null unless a matched priming experiment is given, see below) with
  `matchedReason`. `null` until both arms have data (never a fake 0).
- **cost.costPerPass**: total real spend over the costed records divided by the
  number of judge-passing deliveries: what a *good judged* delivery costs, with
  spend on judged failures amortised in. It leaves out every attempt the judge
  never saw (see the limits below), so read the next metric for what a change
  really costs.

## Cost per accepted change (every attempt counted)

The judge only sees submitted work, so `costPerPass` cannot say what a change a
person accepted really cost. This metric is computed from the usage ledger, which
records every model call the runner makes, against the ticket outcomes in dispatch
(`packages/dispatch/src/health/acceptedChange.ts`):

- **cost_per_accepted_change_usd**: the spend attributed to *any* ticket, every
  attempt and every kind (delivery, review, tester, merge resolver, planning for the
  ticket), whatever the ticket's outcome (done, parked, failed, abandoned or still in
  flight), divided by the tickets that reached `done`.
- **accepted_only_cost_per_change_usd**: what the done tickets alone cost each, the
  figure you would get by leaving failures out. The gap between the two is the price
  of the work that did not land.
- **attempts_per_accepted_change**: delivery attempts on every ticket (one per
  attempt id) divided by the tickets that reached done.
- **by_outcome**: spend, tickets and attempts for accepted, parked or failed
  (`blocked`, `refining`, `paused`, `failed`), abandoned (`cancelled`) and in-flight
  tickets.
- **reviewer_time**: for every human or admin decision that took a ticket out of
  `in_review`, the time since it last entered `in_review`: the number of recorded
  reviews, their mean, and the review time on done tickets per accepted change.

`gaffer eval` prints the headline line, `gaffer wg stats` (and `--json`,
`acceptedChange`) the detail, and the Health view's wage bill shows it as
*Per accepted change*.

Its limits, also listed in the report's `limits` field:

- Spend with no ticket (onboarding, idle loops, planning before a ticket exists) is
  reported as `unattributed_usd` and left out of the ratio.
- A ticket still in flight adds its spend to the numerator but nothing to the
  denominator until it lands, so the figure reads high in the middle of a run.
- Reviewer time is wall-clock time in review that ended in a human decision. It is
  not time spent reading (the transition log cannot show attention), and a review an
  agent decided has none. The median, p75 and p90 per accepted ticket are in
  `/api/health` `review_time`, which subtracts the queue wait where the Review view
  recorded when a person opened the ticket (`ticket.review_opened`) and says which
  basis it used.
- Spend is the API-equivalent cost the CLI reports; a killed call counts at its
  labelled estimate.
- There is no baseline: the same changes made with the coding agent directly are not
  measured, so this number says what Gaffer cost per accepted change, not whether
  that is cheaper.

```sh
node packages/crew/dist/eval/evalLedgerCli.js --mode summarize \
  --file "$GAFFER_DATA/eval-ledger.jsonl"
```

## Matched-ticket comparison

The question the memory gap cannot answer is causal: *for the same work, does a
setting (memory priming, the scout packet, a model tier) produce better outcomes at
lower total cost?* `gaffer eval experiment` (`runner/eval/experiment.sh` and
`experiment.mjs`) measures it:

1. **Same tickets, every arm.** Give the tickets (the gate-replay fixtures,
   `--fixtures <dir> [--only a,b]`, or recorded tickets, `--manifests
   $GAFFER_DATA/manifests [--tickets 3,4]`) and two or more arms, each a set of
   setting overrides: `--arm baseline --arm cheap:tier=cheap --arm nomem:memory=off`.
   The settings are `tier` (a registry tier), `model`, `provider`, `memory` (on/off),
   `packet` (the scout packet, 0/1), `context` (full/minimal), `scout` and, in stub
   mode, `stub` (apply/noop/patch:<file>). The first arm is the baseline. Each
   (ticket, arm) run re-creates the repo at the recorded base (a fixture's base repo,
   or a shared clone of the manifest's repo at its base commit), delivers through the
   same worker seam a tick uses (`worker_deliver`: budget admission as kind
   `experiment`, the agent-env scrub, the verified safety-hook settings, the timeout,
   an empty MCP config) and runs the same gate pipeline (`runner/eval/gates.sh`,
   shared with the gate replay), with a rework attempt on a failed gate. The runs go in
   a random order drawn from `--seed` (recorded, so an order can be reproduced) so model
   drift does not favour one arm.
2. **Count every attempt, not only submissions.** For each ticket and arm it records
   the attempts until submission or the attempt cap (`--max-attempts`, 2), the spend
   (every call booked in the usage ledger, unknown spend counted as unknown), whether
   it was submitted, whether it was **accepted** (every gate passed and, where the
   ticket names one, its hidden `experiment.acceptance_test` passed on the submitted
   head), and the judge score where the fixture records one for the change the run
   delivered.
3. **Report paired differences.** Per ticket: Δ acceptance, Δ attempts, Δ spend, Δ
   judge score against the baseline; then the mean, a 95% interval and n over
   tickets, in `results.json` (`comparisons`) and `report.md`. A ticket an arm never
   submitted counts as a failure for that arm, not as missing data; a run a cap or a
   refusal stopped is left out of every pair, and the report says how many.

   Acceptance is a paired yes or no, so its interval is **Newcombe's paired score
   interval** (Newcombe 1998, method 10: a Wilson score interval for each arm's
   acceptance rate, combined through the correlation of the 2x2 table of outcomes;
   `method: "newcombe_paired_score"` in `results.json`). The report also gives the
   **discordant pairs**, the tickets where one arm was accepted and the other was not,
   and which arm each favours: only those tickets say anything about the difference.
   A t interval on the -1/0/+1 differences used to give ten tied tickets the interval
   [0, 0], as if ten tickets proved there was no difference at all; Newcombe's interval
   for the same ten ties is about -0.28 to 0.28. With no discordant ticket at all the
   method's own formula collapses to [0, 0] when some tickets passed on both arms and the
   rest failed on both, so for any run with no discordant ticket the report gives the
   bound on the discordant rate instead (plus or minus z²/(n + z²), the same -0.28 to 0.28
   for ten tickets). Attempts, spend and judge score are
   continuous, so they keep the paired t interval.

**Stub mode** is the default: the agent is `runner/eval/experiment-stub-agent.sh`,
which applies the ticket's recorded change (nothing for `stub=noop`), so the whole
pipeline runs in CI for free with its own data dir under `--out`. It proves the
pipeline, not a model. **Live mode** (`--live`) runs the real agent and needs a hard
USD cap for the run (`--max-usd` or `GAFFER_EXPERIMENT_MAX_USD`), which also caps every
call at what is left; a call whose spend cannot be read (killed, timed out, no
envelope) counts its whole cap, so the run stops after it. It stops at the ticket cap (`GAFFER_EXPERIMENT_MAX_TICKETS`, 5),
at the factory's own budget admission and at the usage pause, and books every call in
the factory's ledger as kind `experiment` with no ticket, so the daily caps see it and
no ticket's figures move. Nothing is recorded to dispatch (`wg` is a recorder, as in the
gate replay), nothing lands, nothing pushes. The safety hook denies every launch form to
an agent, and the script refuses `--live` when it sees an agent's write roots.

Arms are compared on their effective settings (`memory=on` against a baseline that
names no memory is the same arm, since priming is on unless an arm turns it off). When
two arms differ only in `memory`, `results.json` carries `memory_matched` over the
tickets where the setting took effect (a fixture with memory to prime), and
`evalLedgerCli --mode summarize --matched-experiment <results.json>` puts it in
`memoryLift.matched` (with `matchedReason` saying where it came from); without one
`matched` stays null.

Its limits, also in the report:

- The delivery brief is the experiment's own (the task, the acceptance criteria, the
  arm's memory and scout blocks), not the factory's rendered delivery prompt: that
  needs the ticket in dispatch, which an offline run never touches.
- Live mode re-delivers fixtures only. A manifest keeps a hash of the prompt, not its
  text, so a recorded ticket can be replayed in stub mode (its recorded base..head
  change through the gates) but not re-prompted.
- Accepted means the gates and the hidden acceptance test, not a person's review.
- The model scout is not run by the experiment, so the `scout` setting is recorded as
  not applied; so is any setting a ticket gives it nothing to apply to (memory on a
  fixture with no `memory`, the packet on one with no `scout` files).

`gaffer wg routing recommend` reads these results beside the routing scorecard; a
stub-mode experiment never proposes anything, and a live one proposes a tier only when
all of these hold, and otherwise prints which one failed:

- the arm differs from a baseline that ran the default implement tier only in its tier;
- it ran at least the scorecard's minimum number of tickets (10 by default);
- at least one ticket is discordant (with none, both arms did the same on every ticket
  and the run carries no information about the difference);
- the lower bound of the acceptance difference's 95% Newcombe interval is at or above
  **minus the non-inferiority margin, 0.10** (`NON_INFERIORITY_MARGIN` in
  `routingRecommend.ts`);
- its mean spend difference is below zero.

The margin says how much acceptance a cheaper tier may plausibly give up and still be
proposed: ten percentage points, the usual starting margin for a non-inferiority
comparison of two proportions and the same size as the scorecard's own threshold for a
difference worth acting on (`BETTER_BY_POINTS`). A bound at or above zero would demand
proof that the cheaper tier is better, which a cost saving does not need. Results
written before this interval have no `method` and never propose; run their report
again (`experiment.mjs report`).

## Knobs

| Env | Default | Meaning |
|---|---|---|
| `GAFFER_EVAL_JUDGE` | `0` | `1` enables post-submit judging (one extra paid model call per delivery) |
| `GAFFER_ROLE_MODELS` `judge=` | plan model flag, else impl model flag | model for the judge turn |
| `GAFFER_EVAL_LEDGER` | `$GAFFER_DATA/eval-ledger.jsonl` | ledger path |
| `GAFFER_EXPERIMENT_MAX_USD` | _(empty)_ | hard USD cap of one live experiment run; required for `--live` |
| `GAFFER_EXPERIMENT_MAX_TICKETS` | `5` | tickets per experiment |
| `GAFFER_EXPERIMENT_MAX_ATTEMPTS` | `2` | attempts per ticket and arm |

## Honest limits of the current metrics (read before trusting a number)

These are real conditioning biases, left visible rather than hidden:

- **Submit-success sampling.** Judging runs only after a *successful* submit
  (post-gate). Deliveries that fail DoD, park, or fail submit are never judged,
  so `passRate`/`memoryLift`/`cost.costPerPass` are conditioned on gate-passing
  work. In particular `costPerPass`'s "amortised failure spend" only includes
  deliveries that passed every boolean gate and *then* scored badly; it does
  **not** capture burn on parked/failed attempts, so it understates true
  cost-per-good-delivery. `memoryLift` is likewise measured only within
  gate-passers, so if memory mostly helps work *clear the gates*, the effect is
  conditioned away. The spend on failed attempts is counted in *cost per accepted
  change* above.
- **Self-grading when no plan model is set.** The judge turn uses
  `GAFFER_ROLE_MODELS` `judge=`, else the plan model flag (`GAFFER_PLAN_MODEL_FLAG`),
  and only when neither is set the implementation model flag, when it shares the
  implementer's blind spots. Set `judge=` to a *different*
  (ideally stronger) model for real independence. Every record carries
  `judgeModel` so a model swap is visible and doesn't silently break longitudinal
  comparability.
- **Prefix grading on huge diffs.** Diffs over 120 KB are truncated; the judge is told so and instructed to treat
  unseen changes as ungraded, not absent, but `minimalism`/`security` on a very
  large delivery are still graded on a prefix.

## Is the judge worth having?

A judge score is worth its model call only if it tells the reviewer something the
gates do not: a low score should come before a send-back, a high one before an
acceptance. This is the procedure for finding out on a real factory.

**The case for it.** The gates are blind to a class of poor deliveries. Three gate
replay fixtures are deliveries a careful reviewer rejects that pass hygiene,
minimalism, the Definition of Done, the acceptance checks and the gate-integrity scan:
`duplicated-helper` (copies `addTask` as a private `appendTask` instead of reusing it),
`weakened-assertion` (stops setting `done` and replaces the assertion that would catch
it with `assert.ok(task)`) and `trivial-replacement` (an inverted `removeTask` filter,
with a real test deleted and an existence check added in another file). Each replays
to `submit`, and `gaffer eval replay` keeps it that way. Only the reviewer, or the
judge, can see what is wrong with them.

**What the tests show: the plumbing.** Whether a real judge model scores those
deliveries low depends on the model and is what `gaffer eval agreement` measures on
your factory. `packages/crew/test/eval-judge-fixtures.test.ts` pins everything between
a judge reply and the report: each fixture with a `judge` block is committed and
submitted to review in a real dispatch, the runner's diff goes through the real judge
prompt, a deterministic stub judge returns the rubric the fixture records, the real
parse and aggregation turn it into a verdict, the verdict is recorded, the fixture's
review decision is applied, and the agreement report pairs them. Minimalism is not a
hard gate, so a delivery whose only fault is a copied helper reads *borderline*, not
*fail*; the warning a reviewer can act on is any verdict short of *pass*, and that is
what the report counts.

**The measurement.** `gaffer eval agreement` (`wg judge-agreement`, `--json` for the
fields) pairs every judged delivery with what happened to that delivery next, from
the factory's own records: *accepted* (approved, and nothing sent it back before it
reached Ready for merge, through the tester when the ticket uses one), *sent back* (by
you, the agent review, or the tester), *cancelled* from review, or *pending*. A CI or
merge-gate hold is not a quality decision and is skipped; what you then do with the held
ticket is (back to work counts as sent back, won't do as cancelled). When required CI
goes red after the submit, the runner itself sends the delivery back before anyone
reviews it: that is a gate's verdict, not a reviewer's, so it is counted apart as
*gated* and left out of every figure. A judgment is never paired with a later
delivery's outcome. It reads the judgments on
the tickets and, for judgments recorded before they reached the ticket, the eval
ledger (paired by ticket number and time; a ledger line with a matching ticket event
is counted once). It reports (over the blind decisions; see *Blinding* below):

- the verdict by outcome table (pass / borderline / fail against accepted / rejected
  / pending), and who decided each (people, the agent review, the tester: the agent
  review is a model too, so read agreement with people first);
- the rejection rate, the share of non-pass verdicts that were then rejected
  (precision) and its *lift* over the base rate, the share of pass verdicts that were
  then rejected and the *relative risk* (the first over the second), and the share of
  rejections the judge warned of (recall);
- the mean score of accepted and rejected work and the AUC (the chance an accepted
  delivery scored above a rejected one; 0.5 is no signal), and the same gap per
  dimension, which says which part of the rubric carries the signal;
- the *misses* (judged pass, then sent back, with the reviewer's reason) and the
  *false alarms* (judged short of pass, then accepted, with the weakest dimension):
  the cases to read before changing anything;
- *blinding*: how many decisions were blind and how many came after the grade was
  revealed, with the revealed ones' table, rates and AUC apart;
- *coverage*: how many of the runner's deliveries into review since the first judged
  one were judged at all (a conflict reopen or a delivery you made by hand is never
  judged and is not counted), so a judge failing quietly (an unbuilt crew, a dead
  turn, a refusal) shows instead of shrinking the sample unseen.

**Blinding.** If the reviewer reads the judge's grade before deciding, agreement partly
measures the judge persuading the reviewer, not the judge seeing what the reviewer sees.
So the Review page keeps the grade collapsed behind **Show the judge's view**: no
verdict, score or colour shows until you open it. Opening it while the ticket is in
review records a reveal on the ticket (`ticket.review_judge_revealed`, once per review
round, through `POST /tickets/:id/judge-revealed`; `wg review judge-view <ref>` is the
terminal's way to open it and is recorded the same way). Until then the grade is kept
out of the other places a reviewer could read it too: the ticket page's match report
says "Eval judge: hidden until you decide", the eval judge's events in
`GET /tickets/:id`, `GET /tickets/:id/events` and the batched details carry
`{ "hidden": true }` in place of the grade, and `wg ticket show` prints `evalJudgment:
null` with `evalJudgmentHidden` saying how to see it. Once the view is opened, or the
ticket leaves review, they show it again. A decision is *revealed* when a
reveal on the ticket falls between the judgment and the decision, or when a person
decided before this factory started hiding the grade (the database upgrade that added
the hidden view stamps that moment; a factory created since has no such decisions);
every other decision is *blind*. The agreement figures above and the reading count
blind decisions only, and the report gives the count of each and the revealed decisions'
own figures apart, labelled as possibly swayed by the grade. The Health view's *What
each lane changed* card splits the eval judge's differed-from-the-person counts the same
way. Opening the view is your call and nothing stops you; it only moves your decision
out of the headline.

**The reading** applies a fixed rule: below 20 blind decided deliveries, or fewer than 5
accepted or 5 rejected, it says there is not enough data to tell. Above that, the
judge *separates* when the AUC is at least 0.7 and the work it warned of was rejected
at least 1.5 times as often as the work it passed (any rejection after a warning
counts when nothing it passed was rejected); otherwise it *does not separate*, and its
call is not paying for itself on that factory. The comparison is with the pass
verdicts, not the base rate, because a lift over the base rate can be at most one over
that rate: on a factory that sends back two thirds of its deliveries, even a judge
that warned of every rejection and nothing else would read a lift of 1.5 at best. The
figures are compared unrounded (the report prints them to two places), and the
thresholds are in the report (`thresholds`) so a reading can always be checked.

**The decision.** The judge stays off by default: it costs one extra model call per
delivery (booked in the usage ledger as kind `eval-judge`, so the budget caps and the
cost tiles see it), and whether that is worth it depends on the factory. Turn it on for a run of at least
20 reviewed deliveries, review as you normally would, then run `gaffer eval
agreement`. If it separates, keep it on and open its view on the Review page when you want its
reasons (that decision then counts as revealed). If it
does not, read the misses, then try a different judge model
(`GAFFER_ROLE_MODELS` `judge=`) or turn it off. What a change costs once every attempt is
counted, the judge's own spend included, is the *cost per accepted change* metric above (`gaffer wg stats`, the Health view's
wage bill); the judge does not duplicate it.

## Gate replay: the offline, deterministic half

The judge measures *how good* a delivery is; the gates decide *whether it ships*
without a human. `runner/eval/replay.sh` (`gaffer eval replay`) pins the gates:
each fixture under `runner/eval/fixtures/` is a base repo plus a **recorded
delivery patch** and an `expected` block, and the driver commits the delivery on a
work branch and runs the same library functions `tick.sh` runs, in tick order,
`gaffer_assert_clean_delivery`, `gaffer_diff_stats` + `gaffer_check_minimalism`,
`gaffer_run_dod_gates`, `gaffer_run_ac_checks`, then derives the outcome tick.sh
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

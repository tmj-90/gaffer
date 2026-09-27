# Gate replay — golden fixtures for the delivery gates

`replay.sh` replays **recorded deliveries** through the **real** post-delivery gate
pipeline and checks every verdict against the fixture's expectation. It is the
offline, deterministic half of the eval harness (the judge/ledger half is described
in [`docs/eval-harness.md`](../../docs/eval-harness.md)); it needs no model, no
database and no network, and runs on every push in CI (`Gate replay (golden
fixtures)`), plus locally:

```sh
gaffer eval replay                    # every fixture, summary on stdout
gaffer eval replay --out /tmp/replay  # keep results.json + per-fixture gate output
gaffer eval replay --only breaks-tests -v
```

## What it pins

For each fixture the driver builds the base repo, commits the delivery patch on a
work branch, and calls the same library functions `tick.sh` calls, in the same
order, over that branch:

| Step | Function | Verdicts |
|---|---|---|
| hygiene | `gaffer_assert_clean_delivery` (`lib/hygiene.sh`) | `ok` · `violation` |
| minimalism | `gaffer_diff_stats` + `gaffer_check_minimalism` (`lib/minimalism.sh`) | `ok` · `missing_note` · `oversized_diff` · `unverified_note` |
| Definition of Done | `gaffer_run_dod_gates` (`lib/dod.sh`) | `PASS` · `FAIL` (+ the failing gates) |
| acceptance checks | `gaffer_run_ac_checks` (`lib/ac-checks.sh`) | `PASS` · `FAIL` · `none` |

and derives the **outcome** `tick.sh` would take for a committed delivery:
`submit`, or `rework:<gate>` for the first failure in tick order (hygiene →
minimalism under `MINIMALISM_REQUIRE_NOTE=1` → definition-of-done, including zero
executed gates unless `GAFFER_ALLOW_NO_DOD=1` → acceptance-check). Review-only
signals are reported as **flags**: `missing_note`, `unverified_note`,
`oversized_diff`, `zero_gates`, `zero_gates_waived`, `dod_disabled`.

Only the control plane is stubbed: `wg` (the dispatch CLI the acceptance-check
library records through) is a recorder, so `<out>/<fixture>/wg-calls.log` shows
exactly what the runner would have recorded.

## The fixture set

| Fixture | Delivery | Expected |
|---|---|---|
| `clean-feature` | `removeTask` + test, relevant note, passing AC check | `submit` |
| `breaks-tests` | `completeTask` regression | `rework:definition-of-done`, `tests` fails |
| `leaks-node-modules` | good change + committed `node_modules/`, `.crew/` | `rework:hygiene` |
| `copied-src-tree` | good change + `src-copy/` | `rework:hygiene` |
| `oversized-diff` | good change + 450-line generated file | `submit` flagged `oversized_diff` |
| `missing-note` | good change, no smallest-change note | `submit` flagged `missing_note` |
| `missing-note-required` | same under `MINIMALISM_REQUIRE_NOTE=1` | `rework:minimalism` |
| `boilerplate-note` | note naming none of the changed files | `submit` flagged `unverified_note` |
| `ac-check-fails` | ticket AC demands `archiveTask` | `rework:acceptance-check` |
| `no-gates-configured` | no test/lint command configured | `rework:definition-of-done` flagged `zero_gates` |
| `no-gates-waived` | same under `GAFFER_ALLOW_NO_DOD=1` | `submit` flagged `zero_gates_waived` |

`runner/test/eval-replay.test.sh` proves the harness itself: it fails on an edited
expectation **and** on a weakened gate (the hygiene rule list emptied flips the leak
fixture to `submit`).

## Adding a fixture

1. Create `fixtures/<name>/fixture.json`:

   ```json
   {
     "title": "one line: what the delivery does",
     "why": "what this fixture protects against",
     "base": "_base/taskflow-mini",
     "delivery": "delivery.patch",
     "note": "smallest-change: … (names a changed file; \"\" = no note)",
     "acceptance": [ { "text": "…", "check": "grep -q … src/x.js" }, { "text": "prose AC" } ],
     "gates": { "tests": "node --test", "typecheck": "", "lint": "node -e \"process.exit(0)\"" },
     "env": { "MINIMALISM_REQUIRE_NOTE": "1" },
     "expected": { "hygiene": "ok", "minimalism": "ok", "dod": "PASS", "ac": "PASS",
                   "outcome": "submit", "flags": [], "dod_failed": [] }
   }
   ```

   A gate value `""` means enabled with no command (the gate is SKIPPED); `false`
   disables it. `env` applies to that fixture only. Any `expected` key may be
   omitted; `flags` and `dod_failed` compare as sets.

2. Record `delivery.patch`: copy the base repo somewhere, `git init` and commit it,
   make the delivery's edits, `git add -A`, then `git diff --cached --binary >
   delivery.patch`. New, deleted and binary files are all fine; the replay applies
   it with `git apply --index` and reports a patch that no longer applies as a
   harness error, never as a verdict.

3. Run `gaffer eval replay --only <name> -v` and set `expected` to what the gates
   *should* say. If they say something else, that is a finding about the gates.

Shared base repos live under `fixtures/_base/` (directories starting with `_` are
inputs, not fixtures). Keep fixtures small: the whole set runs in a few seconds and
is part of every CI run.

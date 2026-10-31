# UI regression (opt-in, browser-driven)

Drives the **real dashboard** end to end with a stub worker standing in for
`claude`, so the whole loop runs without a model key:

onboard a sample repo → create a ticket → add a machine-checkable AC → mark ready →
Poll for work (a live tick: worktree, delivery, DoD gate, AC check, hygiene,
minimalism, submit) → Review (server diff, arm + confirm Approve) → merge → done →
Suggest work (product-owner run) → every view renders with no console errors →
the board refreshes itself over the live event stream.

```bash
pnpm -r build
npx playwright@1.63.0 install chromium # once, same version as the pinned playwright-core (or PLAYWRIGHT_CHROMIUM=/path/to/chromium)
bash scripts/ui-regression/run.sh      # ~2 minutes
```

Output: `/tmp/gaffer-ui-regression/shots/` (one screenshot per step) and
`results.json` (every check, console errors, failed requests). Exit code 1 on any
hard failure. `KEEP_DASHBOARD=1` leaves the dashboard up with its token printed.

Runs in CI as the `ui-regression` job (`.github/workflows/ci.yml`). Run it locally too
before a release or after touching `app.js`, the runner's delivery loop, or the review gate.

## Accessibility audit

Every rendered view in the "views" pass (the primary views plus the ticket and
repo detail pages) is audited with [axe-core](https://github.com/dequelabs/axe-core)
against WCAG 2.1 A + AA (`wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`) at 1400px, and
again at 390px in the layout sweep. A **critical** or **serious** violation fails the
run and is reported with the rule id, the impact, the node count and the first
offending selector (colour-contrast findings add the computed foreground/background
and ratio); **moderate/minor** findings are printed as notes.

Contrast is actually measured, not skipped: axe reports text it cannot compute
(over a pseudo-element or an image) as *incomplete*, which once let 1.8:1 chips
pass. Decorative `::before`/`::after` are neutralised for the audit, more than a
small budget of incomplete colour-contrast nodes per view fails the run, and a
self-test plants a 1.8:1 chip behind a `::before` and requires the gate to catch it.
axe is installed into the throwaway out dir next to playwright-core and injected
per view through an indirect eval, which the page CSP (`script-src 'self'`) does not
govern — the dashboard's real CSP stays in force for everything the page itself loads.

## Layout sweep

Every view is loaded at 390, 768, 1024, 1280 and 1440px (and the Overview/Work at
360 and 320px). Each must be no wider than the viewport, keep the header's Search,
New and Logout controls on screen, render no 24-grid icon wider than 48px, keep the
Overview's development-flow strip a scrolling flex row, and show the first board
card / the team sheet above the fold. The Review step also checks that a live
refresh never moves the reader's scroll position.

## Scenario suites

`run.sh` + `regress.mjs` stay the golden path. Every other product flow the
dashboard can drive has a scenario suite under `suites/<name>.mjs`, run by:

```bash
bash scripts/ui-regression/run-suites.sh                 # every suite, in run order
bash scripts/ui-regression/run-suites.sh s1-rework s3-blocked   # just these
```

It builds the same world as `run.sh` (both source `setup.sh`: throwaway
GAFFER_DATA, the taskflow-mini sample repo, the stub worker, `gaffer dashboard
--restart`), adds canned planning bins (`suites/bin/decompose-stub.mjs`,
`suites/bin/spec-author-stub.mjs` as GAFFER_DECOMPOSE_BIN / GAFFER_SPEC_AUTHOR_BIN)
and one operator-exported setting (GAFFER_NOTIFY_DESKTOP=0, to prove env-locking),
then runs the chosen suites in one browser: one summary line per suite and
`UI scenarios: N ok, N FAIL`, exit 1 on any FAIL. Results land in
`/tmp/gaffer-ui-scenarios/shots/results.json`.

Suites share `lib.mjs` (REST, waits, toasts, the axe gate and the layout probe,
seed helpers, the stub-mode file) and the context `run-suites.mjs` builds
(`t.visit` audits each view it opens once, `t.poll`, `t.setSetting`,
`t.saveSettings`, `t.approve`). After each suite the driver restores
settings.json and closes every ticket left open, so a suite never inherits
another's queue.

The stub worker takes a per-ticket MODE from `$GAFFER_DATA/stub-mode.json` (the
agent runs under `env -i`, so a STUB_* variable never reaches it): ok, fail_first,
fail_always, changes_verdict, tester_pass, tester_fail, tester_no_verdict, clarify, slow_claim,
pause_first, conflict. `stub-claude.sh`'s header documents each, and every call is
recorded (env, argv, prompt) in `$GAFFER_DATA/stub-calls.jsonl`.

`run-suites.sh --serve` builds the world and leaves the dashboard up, printing the
env to drive `node scripts/ui-regression/run-suites.mjs <suite>` against it while
writing a suite.

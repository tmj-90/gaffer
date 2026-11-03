# Testing

How I run Gaffer's tests, what CI runs and when, and the knobs that keep the runner
suite fast and honest. The commands themselves are in [CONTRIBUTING.md](../CONTRIBUTING.md);
this page is the reference behind them.

## The three test layers

| layer | where | how it runs |
| --- | --- | --- |
| package tests | `packages/*/test/*.test.ts` | `pnpm -r test` (vitest) |
| runner tests | `runner/test/*.test.sh`, `*.test.mjs` | `pnpm test:runner` (`runner/test/run.sh`) |
| browser suites | `scripts/ui-regression/` | `run.sh` (golden path), `run-suites.sh` (scenario suites) |

Build first (`pnpm -r build`): the runner tests and the browser suites drive the built
`dist/`, and a runner test skips (or under `GAFFER_TEST_STRICT=1` fails) without it.

## Runner tests: `runner/test/run.sh`

### Caps

Every test runs under a wall-clock cap (a perl alarm, because GNU `timeout` is not on
macOS):

| kind | default | override |
| --- | --- | --- |
| `.test.sh` | 120 s | `GAFFER_RUN_CAP_SH` |
| `.test.mjs` | 300 s | `GAFFER_RUN_CAP_MJS` |
| long tests (`LONG_RE`) | 600 s | `GAFFER_RUN_CAP_LONG` |

A test that hits its cap is reported as `TIMED OUT`, a failure.

### Long tests (`LONG_RE`)

`LONG_RE` in `run.sh` names the long end-to-end tests. They get the long cap and are
queued first, so they never form a serial tail at the end of a run. A test belongs
there once its observed CI time reaches two thirds of its short cap (80 s for a
`.sh`, 200 s for a `.mjs`). `run-harness.test.sh` H10 enforces that against the
observed times in `lib/shard-weights.tsv`, and also fails a `LONG_RE` test that has
no weight line.

### Load-scaled caps

On a machine that is already busy when a run starts (other builds, other people's
runs), a test can time out and then pass alone. So `run.sh` reads the 1-minute load
average before any test starts (`/proc/loadavg` on Linux, `sysctl -n vm.loadavg` on
macOS), divides it by the CPU count, clamps the result to 1..2 and multiplies every
cap by it. It never lowers a cap, and an unreadable load counts as 1. The banner
prints the factor and the caps it gave:

```
run.sh: 4 test file(s), -j 2 (2 long, queued first), strict, caps x1.97 (load 7.88 on 4 CPUs: ...)
```

`GAFFER_RUN_CAP_SCALE=<1..2>` fixes the factor instead. CI sets it to 1, so a hang
is reported well inside the job's own timeout.

### Shards and weights

`--shard K/N` (or `GAFFER_RUN_SHARD=K/N`) runs shard K of N. The N shards partition
the files exactly (no file in two, none in neither), and the split depends only on
the file names and `lib/shard-weights.tsv`, never on the machine. `lib/shard.mjs`
balances them with LPT: the heaviest file first, onto the lightest shard.

`lib/shard-weights.tsv` holds each test's observed CI time in seconds: the slowest of
the four CI cells on the run its header names, from the passing runs. A test missing
from it counts 10 s. After adding a slow test, or making one much faster, I refresh
its line; an off weight only unbalances the shards, it never drops or duplicates a
test.

Shard 1 of a macOS cell also runs the package tests, so it starts with a head start
in the split (`GAFFER_RUN_SHARD1_HEAD_START`, weight-seconds, 300 by default). CI
passes it per cell, the same value to every shard of that cell, so the partition
stays exact.

### Compile cache

`run.sh` exports `NODE_COMPILE_CACHE` to a directory of its own for the run. A test
starts many short node processes (every `wg` call is one), and with the cache they
reuse each other's compiled modules instead of compiling the dispatch CLI again each
time.

### Strict mode, the tripwire, operator state

- `GAFFER_TEST_STRICT=1` (what CI runs): a skip whose reason is not on
  `lib/skip.sh`'s allowlist fails the test.
- A `claude` stub is first on `PATH`: it answers `--version`, and any other call is
  logged and fails the run. No test makes a real model call.
- `GAFFER_DATA` points at a private dir, and anything a test writes into the
  checkout's `.gaffer` / `.dispatch` / `.crew` dirs is reported.

### Cheap by default, exhaustive at night

Some tests have a quick default form and a full one under
`GAFFER_TEST_EXHAUSTIVE=1`. `direct-run-isolation.test.sh` re-runs only its quick
tests directly by default and every listed test under the exhaustive form, which the
nightly CI run sets.

### Writing a fast runner test

- Start fewer node processes. Each `wg` call costs about 250 ms of module loading. A
  test that sets up several tickets can do it in one process with
  `lib/wg-batch.mjs` (create, criteria, repo access, testable, ready), which makes the
  same service calls the CLI commands make; `wg-batch-parity.test.sh` proves it
  leaves the database exactly as the CLI sequence does, events and hash chain
  included. It only writes a dispatch database the test made under `$TMPDIR`, and
  only as the operator: anything else (another path, a file `wg init` never ran on,
  a set `GAFFER_PRINCIPAL_TOKEN`) is refused with nothing written.
- Use the test world's loop pacing (`TICK_SLEEP=0`, a small `EMPTY_POLL_LIMIT`), not
  the 30 s defaults.
- Never bind a fixed port. Use `GAFFER_TEST_PORT_BASE` (a test takes `+0`, `+1`, ...)
  or a random port, so two runs on one machine never collide.
- Bash 3.2 (macOS): no GNU `timeout`, no associative arrays, no `${!name}`, guard
  empty arrays with `${arr[@]+"${arr[@]}"}`, temp dirs through `lib/tmpdir.sh`.

### Conventions

- Drive the real function or CLI and assert the outcome. A grep over source is fine
  only as a second guard on top of a behavioural assertion, never as the only check
  of a real invariant.
- Include a negative control where you can: show the test fails when the thing it
  guards is broken (a stranded claim, an empty diff, a missing marker).
- Keep it hermetic: a scratch database and git repo from `lib/tmpdir.sh`, cleaned up
  on exit, and nothing written to the checkout.
- Never weaken `runner/safety-hook.mjs`, and keep the parity tests between the hook
  and the crew classifier green: the two are derived from one data module on purpose.

### Linux failures on a Mac

CI runs Linux with GNU coreutils; macOS ships the BSD tools. A runner test can pass on
a Mac and fail in CI over `grep`, `sed`, `awk` or `date` semantics (a bare `\t` in a
`grep` pattern is the usual one). To reproduce, put the GNU tools first on `PATH` for
one run:

```bash
brew install coreutils grep gnu-sed gawk   # ggrep, gsed, gawk, gdate
SHIM="$(mktemp -d)"
ln -s "$(command -v ggrep)" "$SHIM/grep"
ln -s "$(command -v gsed)"  "$SHIM/sed"
ln -s "$(command -v gawk)"  "$SHIM/awk"
ln -s "$(command -v gdate)" "$SHIM/date"
PATH="$SHIM:$PATH" bash runner/test/<suspect>.test.sh
```

Prefer portable constructs in new tests (`perl -0777` for multiline matching,
`printf` over `echo -e`, `$'\t'` for a tab) so the shim stays a diagnostic.

## Package tests

Vitest's default timeout is 5 s. A test that starts a process or runs real git
(`spawnSync`, `execFileSync`, directly or through a helper in its file) takes a
20 s timeout (`it("...", () => { ... }, 20_000)`), because a loaded machine can take longer than 5 s for that
and the failure says nothing about the code. A test that needs a port asks the OS
for a free one (listen on port 0) rather than using a fixed number.

## What CI runs, and when

`.github/workflows/ci.yml` runs on every push and pull request; the runner shards'
steps are in `runner-shard.yml`, which `nightly.yml` calls too.

| cell | when | shards |
| --- | --- | --- |
| runner, ubuntu, node 22 | every push | 3 |
| runner, ubuntu, node 24 | every push | 3 |
| runner, macOS, node 22 | every push | 3 (shard 1 also runs the package tests and the macOS e2e) |
| runner, macOS, node 24 | nightly (03:17 UTC) and on demand (`workflow_dispatch`) | 3, `GAFFER_TEST_EXHAUSTIVE=1` |

macOS node 24 moved to the nightly run because GitHub runs at most 5 macOS jobs at
once: with six, the sixth queued for 755 s on run 41338925244 and the run took
26.4 min. The nightly run has the same strictness, the same caps and the same
evidence upload on a failure, so a regression only that cell catches is at most a
day old. A failed night is a red run on the Actions tab and the Nightly badge.

The browser suites run as `ui-regression` (the golden path) and `ui-scenarios`, five
groups of scenario suites; `runner/test/ci-matrix.test.sh` checks that every suite is
in exactly one group.

## Browser scenario suites in parallel

`bash scripts/ui-regression/run-suites.sh -j N` gives every suite its own world (own
port, data dir, sample repo, stub worker and dashboard) and runs N at once. The
default is 1, which is what CI runs. Details are in
[scripts/ui-regression/README.md](../scripts/ui-regression/README.md#several-worlds-at-once--j-n).

## Screenshots: `scripts/screenshots.mjs`

Every image under `docs/img` comes from one script, so the README, the quickstart and
[FEATURES.md](FEATURES.md) show the dashboard as it is on the commit that holds them.

```bash
pnpm -r build
npx playwright@1.63.0 install chromium   # once, or set PLAYWRIGHT_CHROMIUM
node scripts/screenshots.mjs             # about 25 minutes; rewrites docs/img/*.png
```

It builds the browser harness's world (`scripts/ui-regression/setup.sh`: a throwaway
data dir, the stub worker in place of the agent CLI, the dashboard), so no model is
called and nothing is spent. Into it go three small TaskFlow repos with real code and
passing tests (`scripts/screenshots-world.mjs`), onboarded through the API, and five
epics of tickets. Every ticket that is delivered goes through the live path: Poll for
work, the stub's scripted change, the gates and criteria checks, the tester first with
its clean replay and a `cli` acceptance profile, an approval of the tested commit, and
Merge now with the tester's replay on the merge candidate. On the way the script leaves
a rework attempt, a tester FAIL, review comments and a Fix-these round, a paused, a
blocked and a held ticket, and an escaped-defect link.

The run takes minutes, so the script then moves every timestamp it wrote (both
databases, the usage ledger, the replay manifests) onto a timeline of a few weeks that
ends now, and recomputes the event log's hash chain over the moved rows. What a person
adds by hand comes last: approved lore, digests, the Factory Map, the club and squad
names, open decisions, agents holding claims, and enough usage-ledger rows for call
kinds the run made too few of (onboarding, the tester) that the routing scorecard has
numbers to show.

The captures are 1440x900 at device scale 2, with fonts loaded and animations stopped,
each cut to its content, and written as palette PNGs through
[sharp](https://sharp.pixelplumbing.com/), which the script installs into the
harness's Playwright cache dir beside playwright-core when it does not resolve. If that
install fails the PNGs are written as captured, two to three times larger. `--keep` leaves the
dashboard up afterwards, `--reuse --only health,ticket-testing` recaptures a few shots
from that kept world, and `--from <phase>` picks a stopped run up again. `SCREENS_OUT`
(default `/tmp/gaffer-screenshots`) and `SCREENS_PORT` (default 8799) move it. The
docs-drift test checks that every image a doc shows exists and every file in `docs/img`
is shown somewhere.

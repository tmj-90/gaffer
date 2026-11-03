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
- Never weaken `runner/safety-hook.mjs` (its rules live in `runner/safety-hook-core.mjs`,
  `runner/lib/hook/` and the deny list `runner/lib/dangerous-commands.mjs`), and keep the parity tests between the hook and the crew
  classifier green: the two are derived from one data module on purpose.

### The safety hook's golden corpus

`runner/test/safety-hook-golden-corpus.test.mjs` pins what the hook decides, not why.
`runner/test/fixtures/safety-hook-corpus.json` holds every tool call the hook suites
feed it (the nine `safety-hook*.test.mjs` files and `skills-hook-claims`, which feeds
it the Bash commands in the skills), deduplicated, plus a few entries marked `by-hand`
that pin a rule no suite call reaches with its own reason, with the verdict the hook gave under
three fixed environments (configured roots, no roots, a bootstrap install): allow or
deny, the exit code, the reason up to its first colon, the whole reason and the stdout
of an allowed Grep. The test decides every entry again in a scratch fixture (its
paths are placeholders, documented in the file) and fails on any difference, so a
refactor that moves one verdict shows up there even when no focused test notices.
A reason echoes the refused command cut at a fixed length, so the test always decides
with the path lengths the corpus was recorded at: the scratch base is a direct child
of `/tmp` padded to a fixed length, and the checkout is reached through a fixed-length
symlink. It passes the same from any checkout and any `TMPDIR`.
When you change a rule on purpose, refresh it deliberately and review the fixture's
diff, one entry per line: `node runner/test/safety-hook-golden-corpus.test.mjs
--update` re-records every verdict. When you add hook test cases,
`node runner/test/lib/hook-corpus-harvest.mjs` reruns the suites through a recording
shim and adds the calls the corpus lacks (it never re-records an existing verdict).
Run it from a checkout directory named `gaffer`: the front-door suite names the
checkout as `~/<its directory name>`, and the corpus records that as `~/gaffer`.
A normal run never writes the fixture.

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

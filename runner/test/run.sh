#!/usr/bin/env bash
# =====================================================================
# runner/test/run.sh — THE runner test harness (`pnpm test:runner`; CI runs it).
# ---------------------------------------------------------------------
# Runs every runner/test/*.test.sh and *.test.mjs (or just the FILEs given), N at
# a time, and exits 1 if ANY of them failed — unlike a bare `for t in …; do bash
# "$t"; done`, whose status is only the last test's. Each test:
#
#   * runs under a wall-clock cap (perl alarm: GNU `timeout` is not on macOS) —
#     .sh 120s, .mjs 300s. The long end-to-end tests (LONG_RE: ~70-110s alone,
#     about twice that under -j load) get 600s and are queued FIRST, so they never
#     hit a cap sized for a quiet machine and never form a serial tail at the end.
#     On a machine that is already busy when the run starts (1-minute load average
#     above the CPU count: other builds, other agents' runs) every cap is scaled by
#     load / CPUs, at most 2x, so "timed out under load, passes alone" stops being a
#     failure. GAFFER_RUN_CAP_SCALE=<1..2> fixes the factor instead (CI sets 1, so a
#     hang is reported well inside the job's timeout); the banner prints the factor.
#   * has its output buffered to a file and printed whole when it ends (a GitHub
#     ::group:: in CI; locally only a failing test's output), so -j never
#     interleaves logs.
#   * SKIP accounting: exit 77 is a skipped test (lib/skip.sh `gaffer_skip`), and
#     every "SKIP…" / "ok SKIP…" line a test prints is a skipped section. Skips are
#     listed, never counted as passes. Under GAFFER_TEST_STRICT=1 (CI) a skip whose
#     reason is not on lib/skip.sh's allowlist FAILS the test: CI builds every
#     package, so "dispatch CLI not built" there is a broken job, not a platform gap.
#   * claude TRIPWIRE: a `claude` stub is first on PATH and in CLAUDE_BIN. It answers
#     `--version`; any other call is logged and exits 97, and a logged call fails the
#     run. No test may make a real, billed model call on a contributor's machine.
#   * NODE_COMPILE_CACHE points at a per-run dir, so the many short node processes a
#     test starts (each `wg` call is one) reuse each other's compiled modules.
#   * OS isolation opt-out: GAFFER_STRICT_REQUIRE=0 is exported, because every agent
#     launch needs an OS sandbox by default and every agent here is a stub (the tests
#     of that requirement set their own value; isolation-default.test.sh unsets it).
#   * dollar-cap opt-out: GAFFER_ALLOW_UNCAPPED=1 is exported, because a live run with
#     no GAFFER_DAILY_BUDGET_USD / GAFFER_BUDGET_USD refuses to start and every agent
#     here is a stub (spend-cap-required.test.sh unsets it to prove the refusal).
#   * HOME isolation: every test runs with HOME set to a private scratch dir (holding
#     a copy of the operator's ~/.gitconfig, so git behaves as before). Code under
#     test writes the agent CLI's global config through HOME (trust-workspace.mjs
#     rewrites ~/.claude.json and takes ~/.claude.json.gaffer-trust.lock), and a run
#     once left a stale lock in the operator's real HOME that blocked every live
#     trust write. Afterwards the HOME the run started with (GAFFER_RUN_OPERATOR_HOME
#     overrides it, for run-harness.test.sh) is checked like operator state below: a
#     ~/.claude.json.gaffer-* file (the trust lock, temp file, backup) newer than the
#     run's start fails a strict run; a ~/.claude.json project entry under the temp dir
#     added during the run is listed (not failed: the file is machine-wide, and another
#     checkout's run may add one; the operator's own agent CLI rewrites it as well).
#   * operator-state isolation: GAFFER_DATA points at a private dir, and DISPATCH_DB /
#     DISPATCH_AUDIT / MEMORY_DB / GAFFER_CREW_EVENTS / CLAUDE_FLAGS / MCP_CONFIG
#     inherited from the operator's shell are cleared. Afterwards any file written
#     under the checkout's .gaffer / .dispatch / .crew dirs during the run is
#     reported — a failure under strict, a warning locally (a live factory running
#     from this checkout writes there too).
#
# A summary (failures, skips, tripwire hits, slowest 10) is printed and, in CI,
# appended to $GITHUB_STEP_SUMMARY.
#
# SHARDING (CI spreads the suite over several runners): `--shard K/N` (or
# GAFFER_RUN_SHARD=K/N) runs only shard K of N. The N shards PARTITION the file set
# exactly — no file in two shards, none in neither — and the split depends only on
# the file names and lib/shard-weights.tsv, never on the machine. lib/shard.mjs
# balances them by expected duration (LPT: heaviest file first, onto the lightest
# shard; a file missing from the weights table counts 10s; shard 1 starts with a
# head start, 300 weight-seconds unless GAFFER_RUN_SHARD1_HEAD_START says otherwise:
# CI sets it per cell, identically for every shard of that cell, because only the
# macOS cells' shard 1 also runs the package tests). Within a shard
# everything above still holds: LONG_RE caps and queue-first, strict skips, the
# tripwire, the operator-state guard and the summary. After adding or removing a
# slow test, refresh its line in lib/shard-weights.tsv (its slowest CI cell, seconds),
# and add it to LONG_RE once it weighs two thirds of its cap (80s for a .sh):
# run-harness.test.sh H10 fails on a heavy test left on the short cap.
#
# Usage: runner/test/run.sh [-j N] [--strict] [-v] [--shard K/N] [--list] [--] [FILE...]
#   -j N         parallel jobs (default: $JOBS, else the CPU count)
#   --strict     same as GAFFER_TEST_STRICT=1
#   -v           print every test's output, not only failures'
#   --shard K/N  run only shard K of N (default: $GAFFER_RUN_SHARD, else all)
#   --list       print the files that would run (after --shard), run nothing
#   --           ignored (pnpm forwards it: `pnpm test:runner -- -j 2` works too)
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SELF="$HERE/run.sh"
# shellcheck source=lib/skip.sh
. "$HERE/lib/skip.sh"

# Long end-to-end tests: queued first, with a roomier cap. A test belongs here once
# its observed CI time (lib/shard-weights.tsv, the slowest of the four cells) reaches
# two thirds of the short cap; run-harness.test.sh H10 fails when one is missing.
# usage-limit-tick (119 s), tick-deadline (97 s) and resume-abort (89 s) were left on
# the 120 s cap until CI run 41338925244 showed them that close to it.
# direct-run-isolation is quick by default but stays here for its nightly
# GAFFER_TEST_EXHAUSTIVE=1 form (~220 s). gaffer-plan and poll-overlap-run-state came in
# with the integration branch (poll-overlap-run-state runs two real Polls, ~90 s), and
# round 4 of it added sandbox-docker-delivery-seam, worker-command, land-ignored-file and
# git-hooks-host.
LONG_RE='^(gate-integrity-e2e(-retry)?|dashboard-lifecycle|gaffer-plan|eval-replay|auth-gate-delivery|merge-lane|land-tester-replay(-proof|-contract)?|tester-overlap|eval-experiment|parallel-stop(-live)?|waste-controls|security-review-lane|direct-run-isolation|review-wedge|review-once-per-head|tester-unprovable(-escape)?|afk-review-hold|branch-retention|branch-switch-fresh|branch-switch-recovery|rework-final-trail|memory-index-after-merge|rework-cost-live|landing-revocation|landing-recovery|secondary-pr-landing|cleanup-ownership|poll-overlap-run-state|usage-limit-tick|tick-deadline|resume-abort|replay-manifest|e2e-.*|sandbox-docker-delivery-seam|worker-command|land-ignored-file|git-hooks-host|trust-fail-closed)\.test\.(sh|mjs)$|^safety-hook\.test\.mjs$'
CAP_SH="${GAFFER_RUN_CAP_SH:-120}" CAP_MJS="${GAFFER_RUN_CAP_MJS:-300}" CAP_LONG="${GAFFER_RUN_CAP_LONG:-600}"

in_ci() { [ "${GITHUB_ACTIONS:-}" = "true" ]; }

# ---------------------------------------------------------------------------
# Worker: run ONE queued test (invoked by xargs as `run.sh --one IDX`). Writes
# $GAFFER_RUN_RES/IDX.{rc,dur,out} and prints its block under a mkdir lock.
# ---------------------------------------------------------------------------
if [ "${1:-}" = "--one" ]; then
  idx="$2"; R="$GAFFER_RUN_RES"
  file="$(cat "$R/$idx.file")"; cap="$(cat "$R/$idx.cap")"; name="$(basename "$file")"
  priv="$R/data/$idx"; mkdir -p "$priv/.gaffer"
  case "$file" in *.mjs) interp=node ;; *) interp=bash ;; esac
  t0="$(date +%s)"
  (
    cd "$ROOT" || exit 1
    # GAFFER_RUN_SHARD too: a test that drives run.sh itself (run-harness) must not
    # have its nested runs sharded by the CI job's shard.
    unset DISPATCH_DB DISPATCH_AUDIT MEMORY_DB GAFFER_CREW_EVENTS CLAUDE_FLAGS MCP_CONFIG GAFFER_RUN_SHARD
    export GAFFER_DATA="$priv/.gaffer" GAFFER_TEST_NAME="$name"
    # A private HOME: nothing a test runs can write the operator's ~/.claude.json, its
    # trust lock or any other dotfile. The operator's git config is copied in (not
    # linked: a test's `git config --global` must not reach the real one).
    mkdir -p "$priv/home"
    [ -f "$GAFFER_RUN_OPERATOR_HOME/.gitconfig" ] && cp "$GAFFER_RUN_OPERATOR_HOME/.gitconfig" "$priv/home/.gitconfig" 2>/dev/null
    export HOME="$priv/home"
    export PATH="$R/tripwire:$PATH" CLAUDE_BIN="$R/tripwire/claude"
    # Every agent here is a stub, so a "live" run spends nothing: opt the suite out of
    # the dollar-cap requirement (lib/budget.sh gaffer_spend_cap_ok). A test of that
    # refusal unsets it for its own runs (spend-cap-required.test.sh).
    export GAFFER_ALLOW_UNCAPPED=1
    # OS isolation opt-out: every agent launch requires an OS sandbox by default
    # (lib/sandbox.sh), and every agent here is a stub that a real sandbox would only get
    # in the way of (a CI runner's docker has no sandbox image built; macOS runners would
    # wrap the stubs in sandbox-exec). So the suite runs with the documented opt-out in
    # the environment. SANDBOX_PROVIDER is left alone. The tests of the requirement set
    # their own value (isolation-default, strict-mode, strict-require, sandbox-*,
    # autonomy-containment, worker-command, ...).
    export GAFFER_STRICT_REQUIRE=0
    exec perl -e 'alarm shift; exec @ARGV' "$cap" "$interp" "$file"
  ) >"$R/$idx.out" 2>&1 </dev/null
  rc=$?
  echo "$rc" >"$R/$idx.rc"
  echo $(($(date +%s) - t0)) >"$R/$idx.dur"
  # Skip reasons: exit 77's message plus every section-skip line.
  grep -E '^[[:space:]]*(ok[[:space:]]+)?SKIP([^A-Za-z_]|$)' "$R/$idx.out" \
    | sed -E 's/^[[:space:]]*(ok[[:space:]]+)?SKIP:?[[:space:]]*//' >"$R/$idx.skips" || true
  # Strict: a skip off the allowlist is a failure.
  : >"$R/$idx.badskips"
  if [ "${GAFFER_TEST_STRICT:-0}" = "1" ]; then
    while IFS= read -r why; do
      gaffer_skip_allowed "$why" || printf '%s\n' "$why" >>"$R/$idx.badskips"
    done <"$R/$idx.skips"
  fi
  until mkdir "$R/.lock" 2>/dev/null; do perl -e 'select(undef,undef,undef,0.05)'; done
  status=PASS
  case "$rc" in
    0) [ -s "$R/$idx.skips" ] && status="PASS (skipped $(wc -l <"$R/$idx.skips" | tr -d ' ') section(s))" ;;
    77) status=SKIP ;;
    124 | 142) status="TIMED OUT (${cap}s)" ;;
    *) status="FAILED (exit $rc)" ;;
  esac
  [ -s "$R/$idx.badskips" ] && status="FAILED (strict: skip not on the allowlist)"
  if in_ci; then
    echo "::group::$name — $status ($(cat "$R/$idx.dur")s)"
    cat "$R/$idx.out"
    echo "::endgroup::"
  else
    printf '%4ss  %s  %s\n' "$(cat "$R/$idx.dur")" "$name" "$status"
    case "$status" in PASS* | SKIP) [ "${GAFFER_RUN_VERBOSE:-0}" = 1 ] && sed 's/^/    | /' "$R/$idx.out" ;; *) sed 's/^/    | /' "$R/$idx.out" ;; esac
  fi
  rmdir "$R/.lock"
  exit 0
fi

# ---------------------------------------------------------------------------
# Driver.
# ---------------------------------------------------------------------------
JOBS="${JOBS:-$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 2)}"
SHARD="${GAFFER_RUN_SHARD:-}" LIST=0
FILES=()
while [ $# -gt 0 ]; do
  case "$1" in
    # pnpm 10 forwards `pnpm test:runner -- -j 2`'s `--` literally: drop it and keep
    # parsing, so the options after it still count as options.
    --) shift ;;
    -j) JOBS="${2:-}"; shift $(($# < 2 ? 1 : 2)) ;;
    -j*) JOBS="${1#-j}"; shift ;;
    --strict) export GAFFER_TEST_STRICT=1; shift ;;
    -v) export GAFFER_RUN_VERBOSE=1; shift ;;
    --shard) SHARD="${2:-}"; shift $(($# < 2 ? 1 : 2)) ;;
    --shard=*) SHARD="${1#--shard=}"; shift ;;
    --list) LIST=1; shift ;;
    -h | --help) sed -n '2,/^# =====/p' "$SELF" | sed 's/^# \{0,1\}//'; exit 0 ;;
    # An unknown option or a missing FILE is a usage error, never a "test" to run.
    -*) echo "run.sh: unknown option '$1' (see --help)" >&2; exit 2 ;;
    *)
      [ -f "$1" ] || { echo "run.sh: no such test file: $1" >&2; exit 2; }
      FILES+=("$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"); shift ;;
  esac
done
[[ "$JOBS" =~ ^[1-9][0-9]*$ ]] || { echo "run.sh: -j needs a positive integer (got '$JOBS')" >&2; exit 2; }
SHARD_K="" SHARD_N="" SHARD_RE='^([1-9][0-9]*)/([1-9][0-9]*)$'
if [ -n "$SHARD" ]; then
  [[ "$SHARD" =~ $SHARD_RE ]] && [ "${BASH_REMATCH[1]}" -le "${BASH_REMATCH[2]}" ] \
    || { echo "run.sh: --shard / GAFFER_RUN_SHARD needs K/N with 1 <= K <= N (got '$SHARD')" >&2; exit 2; }
  SHARD_K="${BASH_REMATCH[1]}" SHARD_N="${BASH_REMATCH[2]}"
fi
if [ ${#FILES[@]} -eq 0 ]; then
  for f in "$HERE"/*.test.sh "$HERE"/*.test.mjs; do FILES+=("$f"); done
fi
N_ALL=${#FILES[@]}
if [ -n "$SHARD_N" ]; then
  command -v node >/dev/null 2>&1 || { echo "run.sh: node is required for --shard" >&2; exit 2; }
  sel="$(node "$HERE/lib/shard.mjs" "$SHARD_K" "$SHARD_N" "$HERE/lib/shard-weights.tsv" "${FILES[@]}")" \
    || { echo "run.sh: shard assignment failed" >&2; exit 2; }
  FILES=()
  while IFS= read -r f; do [ -n "$f" ] && FILES+=("$f"); done <<<"$sel"
fi
if [ "$LIST" = 1 ]; then
  for f in "${FILES[@]+"${FILES[@]}"}"; do echo "${f#"$ROOT"/}"; done
  exit 0
fi
SHARD_DESC="$([ -n "$SHARD_N" ] && echo "shard $SHARD_K/$SHARD_N: ${#FILES[@]} of $N_ALL")"
if [ ${#FILES[@]} -eq 0 ]; then
  echo "run.sh: $SHARD_DESC test file(s) — nothing to run"
  exit 0
fi
command -v perl >/dev/null 2>&1 || { echo "run.sh: perl is required (the per-test cap)" >&2; exit 2; }

# Cap scale: GAFFER_RUN_CAP_SCALE (a number, clamped to 1..2), else the 1-minute load
# average when the run starts divided by the CPU count, clamped to 1..2. Read before
# any test starts, so it measures what else is running, not this run. Linux has
# /proc/loadavg, macOS `sysctl -n vm.loadavg` ("{ 1.23 1.10 0.98 }"); anything
# unreadable counts as 1. GAFFER_RUN_LOADAVG stands in for the reading (tests).
# awk does the decimal arithmetic: bash 3.2 has integers only.
NUM_RE='^[0-9]+([.][0-9]+)?$'
CAP_SCALE="${GAFFER_RUN_CAP_SCALE:-}" CAP_WHY=""
if [ -n "$CAP_SCALE" ]; then
  [[ "$CAP_SCALE" =~ $NUM_RE ]] || { echo "run.sh: GAFFER_RUN_CAP_SCALE must be a number from 1 to 2 (got '$CAP_SCALE')" >&2; exit 2; }
  CAP_WHY="GAFFER_RUN_CAP_SCALE"
else
  LOAD1="${GAFFER_RUN_LOADAVG:-}"
  if [ -z "$LOAD1" ]; then
    if [ -r /proc/loadavg ]; then LOAD1="$(cut -d' ' -f1 /proc/loadavg 2>/dev/null)"
    else LOAD1="$(sysctl -n vm.loadavg 2>/dev/null | tr -d '{}' | awk '{print $1}')"; fi
  fi
  NCPU="$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 1)"
  if [[ "$LOAD1" =~ $NUM_RE ]] && [[ "$NCPU" =~ ^[1-9][0-9]*$ ]]; then
    CAP_SCALE="$(awk -v l="$LOAD1" -v c="$NCPU" 'BEGIN { printf "%.2f", l / c }')"
    CAP_WHY="load $LOAD1 on $NCPU CPUs"
  else
    CAP_SCALE=1 CAP_WHY="load unknown"
  fi
fi
CAP_SCALE="$(awk -v f="$CAP_SCALE" 'BEGIN { if (f < 1) f = 1; if (f > 2) f = 2; printf "%.2f", f }')"
scale_cap() { awk -v c="$1" -v f="$CAP_SCALE" 'BEGIN { printf "%d", c * f + 0.5 }'; }
CAP_SH="$(scale_cap "$CAP_SH")" CAP_MJS="$(scale_cap "$CAP_MJS")" CAP_LONG="$(scale_cap "$CAP_LONG")"

RES="$(mktemp -d "${TMPDIR:-/tmp}/gaffer-run.XXXXXX")"
gaffer_test_check_tmp "$RES" || exit 70
trap 'gaffer_test_rm_work "$RES"' EXIT
export GAFFER_RUN_RES="$RES"
# Node's on-disk compile cache (Node 22.1+): every dispatch CLI call, json-tool and
# helper a test starts is a fresh node process that would otherwise compile the same
# few hundred ES modules from scratch; with the cache each reuses the code a previous
# process compiled. Per run, under $RES (removed with it), so no test sees an older
# run's cache or the operator's.
export NODE_COMPILE_CACHE="$RES/node-compile-cache"
mkdir -p "$RES/tripwire"
export GAFFER_CLAUDE_TRIPWIRE_LOG="$RES/tripwire.log"
: >"$GAFFER_CLAUDE_TRIPWIRE_LOG"
cat >"$RES/tripwire/claude" <<'SH'
#!/bin/sh
# gaffer test tripwire — see runner/test/run.sh. Tests must stub the model.
[ "${1:-}" = "--version" ] && { echo "0.0.0 (Claude Code test tripwire)"; exit 0; }
printf '%s\tcwd=%s\targv=%s\n' "${GAFFER_TEST_NAME:-?}" "$PWD" "$(printf '%s ' "$@" | tr '\n\t' '  ' | cut -c1-240)" >>"$GAFFER_CLAUDE_TRIPWIRE_LOG"
echo "claude test tripwire: refusing a real model call (logged)" >&2
exit 97
SH
chmod +x "$RES/tripwire/claude"

# The HOME the run started with: tests get a private one (see --one), and this one's
# ~/.claude.json namespace is checked after the run.
export GAFFER_RUN_OPERATOR_HOME="${GAFFER_RUN_OPERATOR_HOME:-${HOME:-}}"
# The temp-dir project entries in that ~/.claude.json, one per line (none when absent
# or unparseable): a test fixture lives under the temp dir, so a new one is a leak.
claude_tmp_projects() {
  [ -f "$GAFFER_RUN_OPERATOR_HOME/.claude.json" ] && command -v node >/dev/null 2>&1 || return 0
  node -e 'try { const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    for (const k of Object.keys(c.projects || {})) if (process.argv.slice(2).some((r) => r && k.startsWith(r + "/"))) console.log(k);
  } catch {}' "$GAFFER_RUN_OPERATOR_HOME/.claude.json" "${TMPDIR:-/tmp}" /tmp 2>/dev/null | sort -u
}
claude_tmp_projects >"$RES/claude-projects.before"

# Operator-state guard: stamp now, look for anything written after it at the end.
# GAFFER_RUN_STATE_ROOT (default: this checkout) exists for run-harness.test.sh.
STATE_ROOT="${GAFFER_RUN_STATE_ROOT:-$ROOT}"
STATE_DIRS=(.gaffer .dispatch .crew runner/.crew runner/.dispatch)
for p in "$STATE_ROOT"/packages/*/; do STATE_DIRS+=("packages/$(basename "$p")/.crew" "packages/$(basename "$p")/.dispatch"); done
touch "$RES/stamp"

LONG=() REST=()
i=0
for f in "${FILES[@]}"; do
  i=$((i + 1)); echo "$f" >"$RES/$i.file"
  case "$f" in *.mjs) echo "$CAP_MJS" >"$RES/$i.cap" ;; *) echo "$CAP_SH" >"$RES/$i.cap" ;; esac
  if [[ "$(basename "$f")" =~ $LONG_RE ]]; then echo "$CAP_LONG" >"$RES/$i.cap"; LONG+=("$i"); else REST+=("$i"); fi
done
echo "run.sh: ${SHARD_DESC:-${#FILES[@]}} test file(s), -j $JOBS (${#LONG[@]} long, queued first)$([ "${GAFFER_TEST_STRICT:-0}" = 1 ] && echo ', strict'), caps x$CAP_SCALE ($CAP_WHY: ${CAP_SH}s / ${CAP_MJS}s / long ${CAP_LONG}s)"
T0="$(date +%s)"
{ [ ${#LONG[@]} -gt 0 ] && printf '%s\n' "${LONG[@]}"; [ ${#REST[@]} -gt 0 ] && printf '%s\n' "${REST[@]}"; } | xargs -n1 -P "$JOBS" bash "$SELF" --one
WALL=$(($(date +%s) - T0))

# ---------------------------------------------------------------------------
# Summary.
# ---------------------------------------------------------------------------
FAILED=() SKIPPED=() SKIPLINES=() n_pass=0
for j in $(seq 1 "$i"); do
  name="$(basename "$(cat "$RES/$j.file")")"
  rc="$(cat "$RES/$j.rc" 2>/dev/null || echo 255)"
  if [ -s "$RES/$j.badskips" ]; then
    FAILED+=("$name — strict: skip not on the allowlist: $(head -1 "$RES/$j.badskips")")
  elif [ "$rc" = 0 ]; then
    n_pass=$((n_pass + 1))
  elif [ "$rc" = 77 ]; then
    SKIPPED+=("$name")
  elif [ "$rc" = 124 ] || [ "$rc" = 142 ]; then
    FAILED+=("$name — TIMED OUT ($(cat "$RES/$j.cap")s)")
  else
    tail="$(grep -iE 'fail|✗|✘|not ok|error|expected|assert' "$RES/$j.out" | head -3 | tr '\n' '|' | cut -c1-300)"
    FAILED+=("$name — exit $rc :: ${tail:-see its log}")
  fi
  while IFS= read -r why; do SKIPLINES+=("$name: $why"); done <"$RES/$j.skips"
done

TRIP=()
while IFS= read -r l; do TRIP+=("$l"); done <"$GAFFER_CLAUDE_TRIPWIRE_LOG"
[ ${#TRIP[@]} -gt 0 ] && FAILED+=("claude tripwire: ${#TRIP[@]} real model call(s) attempted (see below)")

POLLUTED=()
for d in "${STATE_DIRS[@]}"; do
  [ -d "$STATE_ROOT/$d" ] || continue
  while IFS= read -r f; do POLLUTED+=("${f#"$STATE_ROOT"/}"); done < <(find "$STATE_ROOT/$d" -type f -newer "$RES/stamp" 2>/dev/null)
done
# The operator's agent CLI config: a trust lock / temp file / backup left in the real
# HOME, or a temp-dir project entry the run added to the real ~/.claude.json.
HOME_ENTRIES=()
if [ -n "$GAFFER_RUN_OPERATOR_HOME" ] && [ -d "$GAFFER_RUN_OPERATOR_HOME" ]; then
  # shellcheck disable=SC2088  # "~/" is a label in the report, not a path to expand
  while IFS= read -r f; do POLLUTED+=("~/${f#"$GAFFER_RUN_OPERATOR_HOME"/}"); done \
    < <(find "$GAFFER_RUN_OPERATOR_HOME" -maxdepth 1 -name '.claude.json.gaffer-*' -newer "$RES/stamp" 2>/dev/null)
  # A new temp-dir entry is reported, never failed: the operator's ~/.claude.json is
  # machine-wide, so another checkout's test run (or an older runner) adds them too.
  # shellcheck disable=SC2088
  while IFS= read -r k; do [ -n "$k" ] && HOME_ENTRIES+=("~/.claude.json projects[$k]"); done \
    < <(claude_tmp_projects | comm -13 "$RES/claude-projects.before" - 2>/dev/null)
fi
if [ ${#POLLUTED[@]} -gt 0 ] && [ "${GAFFER_TEST_STRICT:-0}" = 1 ]; then
  FAILED+=("operator state written during the run: ${POLLUTED[*]}")
fi

slowest="$(for j in $(seq 1 "$i"); do printf '%s\t%s\n' "$(cat "$RES/$j.dur" 2>/dev/null || echo 0)" "$(basename "$(cat "$RES/$j.file")")"; done | sort -rn | head -10)"

report() {
  echo "### Runner tests${SHARD_N:+ (shard $SHARD_K/$SHARD_N)}: $n_pass passed, ${#SKIPPED[@]} skipped, ${#FAILED[@]} failed (${WALL}s, -j $JOBS)"
  echo
  if [ ${#FAILED[@]} -gt 0 ]; then echo "**Failed**"; echo; for x in "${FAILED[@]}"; do echo "- $x"; done; echo; fi
  if [ ${#SKIPPED[@]} -gt 0 ]; then echo "**Skipped tests**"; echo; for x in "${SKIPPED[@]}"; do echo "- $x"; done; echo; fi
  if [ ${#SKIPLINES[@]} -gt 0 ]; then echo "**Skip reasons** (whole tests and sections)"; echo; for x in "${SKIPLINES[@]}"; do echo "- $x"; done; echo; fi
  if [ ${#TRIP[@]} -gt 0 ]; then echo "**claude tripwire hits**"; echo; for x in "${TRIP[@]}"; do echo "- \`$x\`"; done; echo; fi
  if [ ${#POLLUTED[@]} -gt 0 ]; then echo "**Operator state written during the run** (a test is missing its private GAFFER_DATA / DISPATCH_DB, or wrote the operator HOME)"; echo; for x in "${POLLUTED[@]}"; do echo "- $x"; done; echo; fi
  if [ ${#HOME_ENTRIES[@]} -gt 0 ]; then echo "**Trust entries added to the operator ~/.claude.json during the run** (tests here run with a private HOME, so this may be another run on this machine)"; echo; for x in "${HOME_ENTRIES[@]}"; do echo "- $x"; done; echo; fi
  echo "**Slowest 10**"; echo; echo "| s | test |"; echo "|---:|---|"
  printf '%s\n' "$slowest" | while IFS="$(printf '\t')" read -r s n; do echo "| $s | $n |"; done
}
echo
report
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && report >>"$GITHUB_STEP_SUMMARY"
if in_ci; then for x in "${FAILED[@]+"${FAILED[@]}"}"; do echo "::error::$x"; done; fi
[ ${#FAILED[@]} -eq 0 ]

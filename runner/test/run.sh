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
# small head start, as CI also gives it the macOS package tests). Within a shard
# everything above still holds: LONG_RE caps and queue-first, strict skips, the
# tripwire, the operator-state guard and the summary. After adding or removing a
# slow test, refresh its line in lib/shard-weights.tsv (seconds on a macOS runner).
#
# Usage: runner/test/run.sh [-j N] [--strict] [-v] [--shard K/N] [--list] [--] [FILE...]
#   -j N         parallel jobs (default: $JOBS, else the CPU count)
#   --strict     same as GAFFER_TEST_STRICT=1
#   -v           print every test's output, not only failures'
#   --shard K/N  run only shard K of N (default: $GAFFER_RUN_SHARD, else all)
#   --list       print the files that would run (after --shard), run nothing
#   --           ignored (pnpm forwards it: `pnpm test:runner -- -j 2` works too)
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SELF="$HERE/run.sh"
# shellcheck source=lib/skip.sh
. "$HERE/lib/skip.sh"

# Long end-to-end tests: queued first, with a roomier cap.
LONG_RE='^(merge-lane|waste-controls|delivery-lifecycle|security-review-lane|direct-run-isolation|review-wedge|afk-review-hold|branch-retention|branch-switch-fresh|branch-switch-recovery|e2e-.*)\.test\.(sh|mjs)$|^safety-hook\.test\.mjs$'
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
    export PATH="$R/tripwire:$PATH" CLAUDE_BIN="$R/tripwire/claude"
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

RES="$(mktemp -d "${TMPDIR:-/tmp}/gaffer-run.XXXXXX")"
trap 'rm -rf "$RES"' EXIT
export GAFFER_RUN_RES="$RES"
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
echo "run.sh: ${SHARD_DESC:-${#FILES[@]}} test file(s), -j $JOBS (${#LONG[@]} long, queued first)$([ "${GAFFER_TEST_STRICT:-0}" = 1 ] && echo ', strict')"
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
  if [ ${#POLLUTED[@]} -gt 0 ]; then echo "**Operator state written during the run** (a test is missing its private GAFFER_DATA / DISPATCH_DB)"; echo; for x in "${POLLUTED[@]}"; do echo "- $x"; done; echo; fi
  echo "**Slowest 10**"; echo; echo "| s | test |"; echo "|---:|---|"
  printf '%s\n' "$slowest" | while IFS="$(printf '\t')" read -r s n; do echo "| $s | $n |"; done
}
echo
report
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && report >>"$GITHUB_STEP_SUMMARY"
if in_ci; then for x in "${FAILED[@]+"${FAILED[@]}"}"; do echo "::error::$x"; done; fi
[ ${#FAILED[@]} -eq 0 ]

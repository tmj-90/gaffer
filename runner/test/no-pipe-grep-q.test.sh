#!/usr/bin/env bash
# =====================================================================
# Guard: no `… | grep -q` (or `grep --quiet`) in the runner's bash.
# ---------------------------------------------------------------------
# Under `set -o pipefail` (tick.sh, and every lib it sources) a pipe into an
# early-exiting grep is a RACE: grep matches, exits, and the producer's next
# write() — bash's printf writes once per LINE — hits SIGPIPE. pipefail then
# reports the pipeline as FAILED, so a MATCH reads as a MISS. Measured: 1-5 per
# 5000 evaluations on a 2-line value. In production that failed the DoD gate
# closed (tick.sh @@DOD_PARSE_OK@@), parked multi-repo tickets as parse failures,
# and — failing OPEN — labelled a diff touching auth/.github/.env "trivial" for
# lite auto-approve and skipped the security-review trigger (factory.config.sh).
# In tests it was the intermittent red that blocked running the suite in parallel.
#
# Use a here-string (`grep -q pat <<<"$X"`), `[[ $X == *lit* ]]` / `case`, or
# capture a command first (`grep -q pat <<<"$(cmd)"`). NOT `grep pat >/dev/null`:
# GNU grep spots /dev/null output and stops at the first match too.
#
#   G1  static: no such pipe in runner/*.sh, runner/gaffer, runner/lib, runner/bin,
#       runner/eval, and every runner/test file that sets pipefail (comments ignored)
#   G2  dynamic: gaffer_lite_trivial_reason on a sensitive-path diff, 2000x under
#       pipefail (8 at a time), never answers "trivial"
# Run: bash runner/test/no-pipe-grep-q.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

echo "== G1: no pipe into an early-exiting grep =="
# Every production script and sourced lib (they inherit tick.sh's pipefail), and every
# test that turns pipefail on itself.
FILES=("$RUNNER_DIR"/*.sh "$RUNNER_DIR"/gaffer "$RUNNER_DIR"/lib/*.sh "$RUNNER_DIR"/bin/*.sh
       "$RUNNER_DIR"/eval/*.sh "$RUNNER_DIR"/test/lib/*.sh)
for f in "$RUNNER_DIR"/test/*.sh; do grep -q 'pipefail' "$f" && FILES+=("$f"); done
# A `|` (not `||`) followed by grep whose flags include q, or --quiet. Lines that
# are comments are skipped; so is this file's own pattern.
HITS="$(grep -nE '(^|[^|])\|[[:space:]]*grep([[:space:]]+-[^[:space:]|]+)*[[:space:]]+(-[a-zA-Z]*q[a-zA-Z]*|--quiet)([[:space:]]|$)' "${FILES[@]}" 2>/dev/null \
  | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#' | grep -v 'no-pipe-grep-q.test.sh')"
if [ -z "$HITS" ]; then
  ok "G1 no \`| grep -q\` anywhere in the runner's bash (${#FILES[@]} files)"
else
  fail "G1 pipe into grep -q (SIGPIPE race under pipefail) — use a here-string:"
  printf '%s\n' "$HITS" | sed "s#^$RUNNER_DIR/#      #" | head -200
fi

# The guard's own regex must catch the shapes it exists for (else G1 is vacuous).
probe() { grep -cE '(^|[^|])\|[[:space:]]*grep([[:space:]]+-[^[:space:]|]+)*[[:space:]]+(-[a-zA-Z]*q[a-zA-Z]*|--quiet)([[:space:]]|$)' <<<"$1"; }
for shape in "printf '%s\n' \"\$X\" | grep -qE \"\$re\"" "cmd | grep -F -q x" "sum_show 1 | grep -qi y" \
             "git log | grep --quiet z" "  | grep -qxF \"\$n\" \\"; do
  [ "$(probe "$shape")" = 1 ] && ok "G1 regex catches: $shape" || fail "G1 regex misses: $shape"
done
for shape in "a || grep -q x f" "grep -q x <<<\"\$X\"" "cmd | grep -c x" "cmd | grep -o q"; do
  [ "$(probe "$shape")" = 0 ] && ok "G1 regex allows: $shape" || fail "G1 regex wrongly flags: $shape"
done

echo "== G2: the lite sensitive-path classifier never fails open under pipefail =="
WORK="$(mktemp -d "${TMPDIR:-/tmp}/no-pipe-grep-q.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
trap 'gaffer_test_rm_work "$WORK"' EXIT
export GAFFER_DATA="$WORK/data" DISPATCH_DB="$WORK/data/dispatch.sqlite" MEMORY_DB="$WORK/data/memory.sqlite"
mkdir -p "$GAFFER_DATA"
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
if ! declare -F gaffer_lite_trivial_reason >/dev/null; then
  fail "G2 gaffer_lite_trivial_reason not defined"
else
  # The sensitive path FIRST, so grep matches on line 1 while printf still has lines to write.
  PATHS="$(printf '.github/workflows/ci.yml\nsrc/a.ts\nsrc/b.ts\nREADME.md')"
  for w in 1 2 3 4 5 6 7 8; do
    (
      set -o pipefail
      for _ in $(seq 1 250); do
        r="$(gaffer_lite_trivial_reason low 10 4 "$PATHS")"
        [ "$r" = "nontrivial:sensitive-path" ] || echo "$r"
      done
    ) >"$WORK/g2.$w" &
  done
  wait
  bad="$(cat "$WORK"/g2.* | sort | uniq -c | tr '\n' ' ')"
  [ -z "$bad" ] && ok "G2 2000/2000 sensitive-path verdicts held (no false 'trivial')" \
    || fail "G2 sensitive-path diff misclassified: $bad"
fi

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "no-pipe-grep-q: ALL $PASS checks passed"; exit 0
fi
echo "no-pipe-grep-q: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1

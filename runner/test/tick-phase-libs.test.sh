#!/usr/bin/env bash
# =====================================================================
# The tick phases in runner/lib/tick-*.sh: required, inert to source, bash 3.2 clean.
# ---------------------------------------------------------------------
# tick.sh is orchestration only; the phase bodies (claim, launch, gates, close, idle,
# recovery, bootstrap) live in lib/tick-*.sh. A tick that ran with one of them missing
# would reach a call it cannot make half-way through a delivery (a claim held, a
# worktree made), so tick.sh sources every one up front and stops (fail closed) when one
# does not load. This pins:
#   1. every lib/tick-*.sh is sourced by tick.sh with a fail-closed guard and a
#      `# shellcheck source=` directive (tick-dead-assignments follows those), before
#      the tick's first piece of work (creating $GAFFER_DATA);
#   2. sourcing each one prints nothing and sets no variable: definitions only;
#   3. none uses a construct macOS bash 3.2 lacks (associative arrays, case
#      modification, mapfile/readarray, |&) and each passes `bash -n`;
#   4. with one lib removed from a copy of the runner (packages/ symlinked back), tick.sh
#      exits 1 before any work with TICK_RESULT=setup_error and names the missing file.
# Run: bash runner/test/tick-phase-libs.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"

PASS=0; FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

TICK="$RUNNER_DIR/tick.sh"
LIBS=()
for f in "$RUNNER_DIR"/lib/tick-*.sh; do [ -f "$f" ] && LIBS+=("$f"); done
[ "${#LIBS[@]}" -gt 0 ] && ok "tick phase libs present (${#LIBS[@]})" || fail "no runner/lib/tick-*.sh found"

echo "== 1: tick.sh sources each phase lib, guarded, before any work =="
WORK_LINE="$(grep -n '^( umask 077 && mkdir -p "\$GAFFER_DATA" )' "$TICK" | head -1 | cut -d: -f1)"
[ -n "$WORK_LINE" ] || fail "could not find the data-dir creation line in tick.sh"
for f in ${LIBS[@]+"${LIBS[@]}"}; do
  b="lib/${f##*/}"
  src="$(grep -nF "source \"\$HERE/$b\" || { echo \"gaffer: runner/$b is missing or does not load; refusing to run the tick (fail closed)\" >&2; echo \"TICK_RESULT=setup_error\"; exit 1; }" "$TICK" | head -1 | cut -d: -f1)"
  if [ -z "$src" ]; then fail "$b is not sourced by tick.sh with the fail-closed guard"; continue; fi
  prev="$(sed -n "$((src - 1))p" "$TICK")"
  [ "$prev" = "# shellcheck source=$b" ] && ok "$b: guarded source + shellcheck directive" \
    || fail "$b: no '# shellcheck source=$b' directive on the line above its source"
  [ -n "$WORK_LINE" ] && [ "$src" -lt "$WORK_LINE" ] && ok "$b: sourced before the tick's first work" \
    || fail "$b: sourced after the tick starts work (line $src)"
done

echo "== 2: sourcing a phase lib runs nothing =="
for f in ${LIBS[@]+"${LIBS[@]}"}; do
  b="lib/${f##*/}"
  out="$(env -i PATH="$PATH" bash --norc --noprofile -c '
    set -u
    before="$(compgen -v | sort)"
    nf0="$(declare -F | wc -l)"
    source "$1" || exit 3
    after="$(compgen -v | sort)"
    nf1="$(declare -F | wc -l)"
    [ "$nf1" -gt "$nf0" ] || echo "DEFINES-NOTHING"
    diff <(printf "%s\n" "$before") <(printf "%s\n" "$after") | grep "^>" | grep -vE "^> (before|nf0|_)$" || true
  ' _ "$f" 2>&1)"; rc=$?
  [ "$rc" = 0 ] && [ -z "$out" ] && ok "$b: definitions only (no output, no variable set)" \
    || fail "$b: sourcing it had side effects (rc=$rc): $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-200)"
done

echo "== 3: bash 3.2 portable =="
for f in ${LIBS[@]+"${LIBS[@]}"}; do
  b="lib/${f##*/}"
  bash -n "$f" 2>/dev/null && ok "$b: bash -n" || fail "$b: bash -n fails"
  bad="$(grep -nE '^[^#]*(declare -A|local -A|typeset -A|\$\{[A-Za-z_][A-Za-z0-9_]*(,,|\^\^|,|\^)\}|\bmapfile\b|\breadarray\b|\|&)' "$f" || true)"
  [ -z "$bad" ] && ok "$b: no bash 4+ constructs" || fail "$b: bash 4+ construct: $(printf '%s' "$bad" | head -2 | tr '\n' ' ')"
  [ "$(head -1 "$f")" = '#!/usr/bin/env bash' ] && ok "$b: bash shebang" || fail "$b: first line is not #!/usr/bin/env bash"
done

echo "== 4: a missing phase lib stops the tick before any work =="
if [ "${#LIBS[@]}" -gt 0 ]; then
  WORK="$(gaffer_test_tmpdir tick-phase-libs)" || exit 70
  trap 'gaffer_test_rm_work "$WORK"' EXIT
  CO="$WORK/checkout"; mkdir -p "$CO" "$WORK/data"
  cp -R "$RUNNER_DIR" "$CO/runner"
  rm -rf "$CO/runner/.crew" "$CO/runner/.dispatch"
  for x in packages node_modules package.json pnpm-workspace.yaml; do
    [ -e "$ROOT/$x" ] && ln -s "$ROOT/$x" "$CO/$x"
  done
  GONE="${LIBS[$(( ${#LIBS[@]} / 2 ))]##*/}"
  rm -f "$CO/runner/lib/$GONE"
  OUT="$(cd "$CO/runner" && GAFFER_DATA="$WORK/data" DRY_RUN=1 bash ./tick.sh 2>"$WORK/err")"; rc=$?
  [ "$rc" = 1 ] && ok "tick.sh without lib/$GONE exits 1" || fail "tick.sh without lib/$GONE exited $rc (want 1)"
  [ "$OUT" = "TICK_RESULT=setup_error" ] && ok "it reports TICK_RESULT=setup_error and nothing else" \
    || fail "stdout was: $(printf '%s' "$OUT" | tr '\n' ' ' | cut -c1-200)"
  grep -qF "runner/lib/$GONE is missing or does not load" "$WORK/err" && ok "stderr names the missing file" \
    || fail "stderr does not name lib/$GONE: $(tr '\n' ' ' <"$WORK/err" | cut -c1-200)"
  [ -z "$(ls -A "$WORK/data" 2>/dev/null)" ] \
    && ok "no tick state was written (the data dir is untouched)" \
    || fail "the tick wrote state before stopping: $(ls -A "$WORK/data" | tr '\n' ' ')"
fi

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS: $PASS checks"; exit 0; fi
echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1

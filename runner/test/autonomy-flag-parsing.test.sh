#!/usr/bin/env bash
# =====================================================================
# B20b/B20d — autonomy flags parse 1/true/yes/on everywhere; runner rejections are not human.
# ---------------------------------------------------------------------
# Settings validation accepts true/yes for a boolean, and `_gaffer_flag_on` accepts
# 1/true/yes/on — but several runner sites still compared the raw value to exactly "1"
# (GAFFER_AUTO_PUSH in the AFK merge, the memory-promote flag in tick.sh), and dispatch's
# env floor (`isAutonomyAllowed` → envAllowsAuto, the agent-approve gate) required "1" too.
# A stored `true` therefore read as ON for containment and OFF for the gate it governed.
# This pins: the parser's accepted spellings; the containment rule firing on every
# spelling; and a SOURCE PIN that no runner shell site compares those flags to a bare "1"
# any more. (B20d) It also pins that the runner's two `review reject` sites pass `--as`
# (agent for the reviewer agent's CHANGES verdict, system for the CI gate) so runner
# rejections stop being recorded as HUMAN decisions. Hermetic; zero deps beyond bash.
# Run: bash runner/test/autonomy-flag-parsing.test.sh   (bash 3.2 safe)
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"

PASS=0; FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/flag-parse.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/data"

# Source the REAL factory.config.sh hermetically and run one expression in it.
probe() {
  env -i PATH="$PATH" HOME="$HOME" GAFFER_DATA="$WORK/data" PROBE_EXPR="${PROBE_EXPR:-}" "$@" bash -c '
    source "'"$RUNNER_DIR"'/factory.config.sh" >/dev/null 2>&1
    eval "$PROBE_EXPR"'
}

echo "== 1: _gaffer_flag_on — the accepted spellings, case-insensitive =="
for v in 1 true yes on TRUE Yes ON; do
  [ "$(PROBE_EXPR="_gaffer_flag_on '$v' && echo on || echo off" probe)" = on ] \
    && ok "'$v' → on" || fail "'$v' should be on"
done
for v in 0 false no off "" junk 2; do
  [ "$(PROBE_EXPR="_gaffer_flag_on '$v' && echo on || echo off" probe)" = off ] \
    && ok "'$v' → off (fail-closed)" || fail "'$v' should be off"
done

echo "== 2: every spelling of a ship flag trips the autonomy→containment rule =="
for v in true yes on; do
  OUT="$(PROBE_EXPR='printf "%s %s" "${GAFFER_STRICT_REQUIRE:-unset}" "${STRICT_MODE:-unset}"' probe AUTO_MERGE="$v")"
  [ "$OUT" = "1 1" ] && ok "AUTO_MERGE=$v → GAFFER_STRICT_REQUIRE=1 STRICT_MODE=1" || fail "AUTO_MERGE=$v → '$OUT'"
done
OUT="$(PROBE_EXPR='printf "%s" "${GAFFER_STRICT_REQUIRE:-unset}"' probe AUTO_MERGE=false)"
[ "$OUT" = unset ] && ok "AUTO_MERGE=false → containment not required" || fail "AUTO_MERGE=false → '$OUT'"

echo "== 3: SOURCE PIN — no runner shell site compares an autonomy flag to a bare \"1\" =="
# The flags Settings exposes as booleans and the runner reads: any `= "1"` / `!= "1"` on
# them is a spelling the dashboard accepts but the site would ignore.
FLAGS='AUTO_MERGE|MERGE_ON_AGENT_REVIEW|DISPATCH_ALLOW_AGENT_APPROVE|GAFFER_CREATE_PR|GAFFER_REQUIRE_CI|GAFFER_AUTO_PUSH|MEMORY_AUTO_APPROVE'
HITS="$(grep -nE "\\\$\\{?(${FLAGS})(:-[^}]*)?\\}?\"? *!?= *\"?1\"?" \
  "$RUNNER_DIR"/tick.sh "$RUNNER_DIR"/loop.sh "$RUNNER_DIR"/gaffer "$RUNNER_DIR"/status.sh \
  "$RUNNER_DIR"/factory.config.sh "$RUNNER_DIR"/lib/*.sh "$RUNNER_DIR"/bin/*.sh 2>/dev/null || true)"
[ -z "$HITS" ] && ok "no bare-\"1\" comparison of an autonomy flag in the runner" || fail "bare-\"1\" comparisons remain:"$'\n'"$HITS"
grep -q '_gaffer_flag_on "${GAFFER_AUTO_PUSH:-0}"' "$RUNNER_DIR/lib/review.sh" \
  && ok "review.sh: AFK push gate goes through _gaffer_flag_on" || fail "review.sh push gate not normalised"
grep -q '_gaffer_flag_on "${GAFFER_MEMORY_AUTO_PROMOTE:-${MEMORY_AUTO_APPROVE:-0}}"' "$RUNNER_DIR/tick.sh" \
  && ok "tick.sh: memory auto-promote flag normalised before it reaches the memory CLI" || fail "tick.sh promote flag not normalised"

echo "== 4 (B20d): runner rejections carry --as, so they are not recorded as HUMAN decisions =="
grep -q 'wg review reject "$RNUM" --reason "$_rreason" --to ready --as agent --reviewer "$AGENT/reviewer"' "$RUNNER_DIR/lib/review.sh" \
  && ok "review.sh: the reviewer agent's CHANGES rework rejects --as agent (reviewer principal)" \
  || fail "review.sh rework reject lacks --as agent"
grep -q 'wg review reject "$NUM" --to refining --reviewer factory-ci --as system' "$RUNNER_DIR/tick.sh" \
  && ok "tick.sh: the CI gate rejects --as system" || fail "tick.sh CI reject lacks --as system"
HUMAN_REJECTS="$(grep -n 'wg review reject' "$RUNNER_DIR"/tick.sh "$RUNNER_DIR"/lib/*.sh | grep -v -- '--as ' || true)"
[ -z "$HUMAN_REJECTS" ] && ok "no runner reject site is left to default to a human actor" || fail "reject sites without --as:"$'\n'"$HUMAN_REJECTS"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS: $PASS checks"; exit 0; fi
echo "FAILED: ${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1

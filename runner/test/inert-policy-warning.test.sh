#!/usr/bin/env bash
# =====================================================================
# B17 — per-repo `auto` policies are INERT under REVIEW_MODE=human; the runner says so.
# ---------------------------------------------------------------------
# Autonomy policies are consulted only inside the agent review pass (REVIEW_MODE=
# agent|both → gaffer_auto_decision). In the default supervised posture the pass never
# runs, so a grant the operator enabled showed "Enabled" and never acted — silently.
# gaffer_inert_policy_check (factory.config.sh, called once per tick) now logs ONE clear
# warning per run when `auto` rows exist while REVIEW_MODE=human, and stays silent when
# the reviewer runs or nothing is enabled. Hermetic: factory.config.sh is sourced in a
# clean env and `wg` is stubbed to emulate `wg autonomy policies --mode auto`.
# Run: bash runner/test/inert-policy-warning.test.sh   (bash 3.2 safe)
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"

PASS=0; FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/inert-policy.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/data"

# Source the REAL factory.config.sh with a stub `wg` whose `autonomy policies --mode auto`
# answers STUB_POLICIES (a JSON list). Echo the check's count; the warning goes to the log.
#   probe <REVIEW_MODE> <policies-json> [extra env…]
LOG="$WORK/factory.log"
probe() {
  local mode="$1" pols="$2"; shift 2
  env -i PATH="$PATH" HOME="$HOME" GAFFER_DATA="$WORK/data" REVIEW_MODE="$mode" STUB_POLICIES="$pols" LOG_FILE="$LOG" "$@" \
    bash -c '
      source "'"$RUNNER_DIR"'/factory.config.sh" >/dev/null 2>&1
      log() { printf "%s\n" "$*" >> "$LOG_FILE"; }
      wg() {
        if [ "$1" = "autonomy" ] && [ "$2" = "policies" ]; then
          printf "{\"ok\":true,\"count\":%s,\"policies\":%s}\n" "$(printf "%s" "$STUB_POLICIES" | node -e "let s=\"\";process.stdin.on(\"data\",d=>s+=d).on(\"end\",()=>console.log(JSON.parse(s).length))")" "$STUB_POLICIES"
          return 0
        fi
        return 1
      }
      gaffer_inert_policy_check'
}
AUTO='[{"repo_name":"r","risk_level":"low","gate":"approve","mode":"auto"},{"repo_name":"r","risk_level":"low","gate":"merge","mode":"auto"}]'
WARN="per-repo 'auto' policy grant(s) are enabled but REVIEW_MODE=human"

echo "== 1: REVIEW_MODE=human + auto rows → one WARNING naming the cause and the fix =="
: > "$LOG"; rm -f "$WORK/data/.autonomy-policy-inert-warned"
N="$(probe human "$AUTO")"
[ "$N" = "2" ] && ok "reports the 2 inert grants" || fail "expected 2 got '$N'"
grep -qF "AUTONOMY: WARNING — 2 $WARN" "$LOG" && ok "warning logged: enabled but REVIEW_MODE=human → INERT" || fail "no warning: $(cat "$LOG")"
grep -q 'INERT' "$LOG" && grep -q 'Set Review mode to agent or both' "$LOG" && ok "  says INERT and how to fix it" || fail "  warning lacks the fix"
[ -f "$WORK/data/.autonomy-policy-inert-warned" ] && ok "  per-run marker written" || fail "  marker missing"

echo "== 2: a second tick in the same run stays quiet (warned once) =="
probe human "$AUTO" >/dev/null
[ "$(grep -cF "$WARN" "$LOG")" = "1" ] && ok "exactly one warning across two ticks" || fail "warning repeated: $(grep -cF "$WARN" "$LOG")"

echo "== 3: the run starters clear the marker (a new run warns again) =="
grep -q 'autonomy-policy-inert-warned' "$RUNNER_DIR/loop.sh" && grep -q 'autonomy-policy-inert-warned' "$RUNNER_DIR/bin/poll-once.sh" \
  && ok "loop.sh + poll-once.sh clear .autonomy-policy-inert-warned" || fail "marker not cleared by the run starters"
rm -f "$WORK/data/.autonomy-policy-inert-warned"; probe human "$AUTO" >/dev/null
[ "$(grep -cF "$WARN" "$LOG")" = "2" ] && ok "warns again after the marker is cleared" || fail "did not re-warn"

echo "== 4: REVIEW_MODE=agent / both → the grants are live; no warning, no CLI call needed =="
: > "$LOG"; rm -f "$WORK/data/.autonomy-policy-inert-warned"
N="$(probe agent "$AUTO")"
[ "$N" = "0" ] && [ ! -s "$LOG" ] && ok "agent: silent (0 inert)" || fail "agent: N=$N log=$(cat "$LOG")"
N="$(probe both "$AUTO")"
[ "$N" = "0" ] && [ ! -s "$LOG" ] && ok "both: silent (0 inert)" || fail "both: N=$N log=$(cat "$LOG")"

echo "== 5: REVIEW_MODE=human with NO auto rows → silent =="
: > "$LOG"
N="$(probe human '[]')"
[ "$N" = "0" ] && [ ! -s "$LOG" ] && ok "no grants → nothing to warn about" || fail "N=$N log=$(cat "$LOG")"

echo "== 6: fail-soft — a broken CLI answer never warns and never errors =="
: > "$LOG"
N="$(env -i PATH="$PATH" HOME="$HOME" GAFFER_DATA="$WORK/data" REVIEW_MODE=human LOG_FILE="$LOG" bash -c '
  source "'"$RUNNER_DIR"'/factory.config.sh" >/dev/null 2>&1
  log() { printf "%s\n" "$*" >> "$LOG_FILE"; }
  wg() { echo "boom not json"; return 1; }
  gaffer_inert_policy_check; echo "rc=$?"')"
[ "$(printf '%s\n' "$N" | head -1)" = "0" ] && [ "$(printf '%s\n' "$N" | tail -1)" = "rc=0" ] && [ ! -s "$LOG" ] \
  && ok "junk CLI output → 0, rc 0, no warning" || fail "fail-soft broken: $N / $(cat "$LOG")"

echo "== 7: tick.sh calls the check once, after the agent id is resolved =="
grep -q 'gaffer_inert_policy_check' "$RUNNER_DIR/tick.sh" && ok "tick.sh wires gaffer_inert_policy_check" || fail "tick.sh does not call the check"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS: $PASS checks"; exit 0; fi
echo "FAILED: ${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1

#!/usr/bin/env bash
# =====================================================================
# RUNNER-OWNED-BOOKKEEPING — empty-delivery park is a runner-owned release
# (runner/tick.sh). Replaces the old R-6 status-probe test: the runner now HOLDS
# the delivery claim and has NOT submitted when the empty-delivery gate runs, so it
# parks the held claim to `refining` via the runner-release path — there is no
# "did the agent submit?" status probe / review-reject-or-block fallback anymore.
#
# This drives the REAL `gaffer_release_delivery` helper (kept in step with tick.sh)
# with stubbed `wg`/`log`, over the three cases that matter now:
#   1. runner holds a token, release OK   → "released claim … → refining" (with --token)
#   2. no token (resumed delivery), OK    → "transitioned … → refining" (tokenless)
#   3. release FAILS                       → a visible WARNING naming #N + the target
# Plus a static assertion that tick.sh's empty-delivery path calls the helper.
#
# Zero deps. Run: bash test/empty-delivery-transition.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TICK="$HERE/../tick.sh"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

# Run the REAL gaffer_release_delivery helper with: $1 = CLAIM_TOKEN ("" ⇒ resumed
# delivery, no runner-held token), $2 = whether `wg runner-release` should succeed
# ("ok"|"fail"). Captures every log line + the exact `wg` invocation.
run_case() {
  local token="$1" outcome="$2"
  local wglog; wglog="$(mktemp)"
  local logs
  logs="$(NUM=4242 _TOKEN="$token" _OUTCOME="$outcome" _WGLOG="$wglog" bash -c '
    set -uo pipefail
    log() { printf "%s\n" "$*"; }
    # Stub wg(): record the runner-release invocation to _WGLOG (survives the
    # helper’s 2>&1 redirect), succeed/fail per _OUTCOME.
    wg() {
      if [ "$1" = "runner-release" ]; then
        printf "WG_CALL: %s\n" "$*" >> "$_WGLOG"
        [ "$_OUTCOME" = "ok" ] && return 0 || return 1
      fi
      return 0
    }
    CLAIM_TOKEN="$_TOKEN"
    # ── REAL helper from tick.sh (RUNNER-OWNED-BOOKKEEPING) ──
    gaffer_release_delivery() {
      local to="$1" reason="$2"
      [ "${DRY_RUN:-0}" = "1" ] && return 0
      if [ -n "${CLAIM_TOKEN:-}" ]; then
        wg runner-release "$NUM" --to "$to" --token "$CLAIM_TOKEN" --reason "$reason" >/dev/null 2>&1 \
          && log "released claim on #$NUM → $to ($reason)" \
          || log "WARNING — could not release claim on #$NUM → $to ($reason); needs a human"
      else
        wg runner-release "$NUM" --to "$to" --reason "$reason" >/dev/null 2>&1 \
          && log "transitioned #$NUM → $to ($reason)" \
          || log "WARNING — could not transition #$NUM → $to ($reason); needs a human"
      fi
    }
    # ── end helper ──
    gaffer_release_delivery refining "empty delivery: agent produced no change — needs clarification/refinement"
  ' 2>&1)"
  # Emit the captured log lines followed by the recorded wg invocation(s).
  printf '%s\n' "$logs"
  cat "$wglog"
  rm -f "$wglog"
}

echo "== 1. runner holds a token → release to refining WITH --token, logged =="
out="$(run_case "tok-123" ok)"
printf '%s' "$out" | grep -q "released claim on #4242 → refining" && ok "logs the runner-held release to refining" || fail "did not log the token release"
printf '%s' "$out" | grep -qE "WG_CALL: runner-release 4242 --to refining --token tok-123" && ok "invokes wg runner-release with --to refining --token" || fail "did not invoke runner-release with the token"
printf '%s' "$out" | grep -q "WARNING" && fail "a happy-path release wrongly emitted a WARNING" || ok "no WARNING on the happy path"

echo "== 2. no runner token (resumed delivery) → tokenless release to refining =="
out="$(run_case "" ok)"
printf '%s' "$out" | grep -q "transitioned #4242 → refining" && ok "logs the tokenless transition to refining" || fail "did not log the tokenless transition"
printf '%s' "$out" | grep -qE "WG_CALL: runner-release 4242 --to refining --reason" && ok "invokes wg runner-release tokenlessly (no --token)" || fail "did not invoke tokenless runner-release"
printf '%s' "$out" | grep -q -- "--token" && fail "a tokenless release wrongly passed --token" || ok "no --token on a tokenless release"

echo "== 3. release FAILS → a visible WARNING naming the ticket + target =="
out="$(run_case "tok-123" fail)"
printf '%s' "$out" | grep -q "WARNING — could not release claim on #4242 → refining" \
  && ok "a failed release is logged as a WARNING naming the ticket + target" \
  || fail "a failed release was swallowed silently"

echo "== 4. tick.sh's empty-delivery path parks via the runner-release helper =="
if [ -f "$TICK" ]; then
  # The empty-delivery block calls gaffer_release_delivery refining … and NO LONGER
  # probes status to review-reject/block (that fallback is deleted).
  awk '/EMPTY delivery for #\$NUM — 0 commits/{f=1} f&&/delivery PARKED for #\$NUM — empty/{print; exit} f' "$TICK" \
    | grep -q 'gaffer_release_delivery refining' \
    && ok "empty-delivery path parks via gaffer_release_delivery refining" \
    || fail "empty-delivery path does not call gaffer_release_delivery refining"
  awk '/EMPTY delivery for #\$NUM — 0 commits/{f=1} f&&/delivery PARKED for #\$NUM — empty/{print; exit} f' "$TICK" \
    | grep -q 'review reject.*factory-empty' \
    && fail "empty-delivery path still carries the deleted review-reject fallback" \
    || ok "empty-delivery path no longer carries the deleted review-reject/block fallback"
else
  ok "tick.sh not found (skipping static assertion)"
  ok "tick.sh not found (skipping static assertion)"
fi

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"
  exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi

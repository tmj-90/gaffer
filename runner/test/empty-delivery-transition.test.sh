#!/usr/bin/env bash
# =====================================================================
# R-6 — empty-delivery state transition is VISIBLE, not silent (runner/tick.sh).
# ---------------------------------------------------------------------
# When a delivery produces no diff, tick.sh parks the ticket: it fetches the
# current status and either review-rejects (in_review → refining) or blocks it.
# Two failures used to pass SILENTLY:
#   • an EMPTY status fetch (a failed `wg ticket show`) fell through to the
#     block branch with no signal — mis-routing the ticket;
#   • the state-move (`wg review reject` / `wg block`) was guarded by
#     `&& log … || true`, so a FAILED move logged nothing and the ticket
#     drifted in in_review.
# tick.sh now: warns visibly on an empty status fetch, and logs EVERY move
# failure explicitly with the ticket number + the attempted transition.
#
# This drives the EXACT transition block (kept BYTE-FOR-BYTE in step with
# tick.sh) with stubbed `wg`/`log`, over the four cases:
#   1. status=in_review, move OK     → "parked … (in_review → refining)"
#   2. status=in_review, move FAILS  → a visible WARNING naming #N + the move
#   3. status="" (fetch failed)      → a visible WARNING + a fallback block
#   4. status=other, block FAILS     → a visible WARNING naming #N
#
# Zero deps. Run: bash test/empty-delivery-transition.test.sh
# =====================================================================
set -uo pipefail

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

# Run the transition block with: $1 = status `wg ticket show` should report
# (empty string ⇒ a failed fetch), $2 = whether the move command should succeed
# ("ok"|"fail"). Captures every log line emitted, returned on stdout.
run_case() {
  local status="$1" move="$2"
  NUM=4242 _MOVE="$move" _STATUS="$status" bash -c '
    set -uo pipefail
    # Stub log(): collect every line so the test can assert visibility.
    log() { printf "%s\n" "$*"; }
    # Stub jget so the verbatim block parses the stubbed status out of `wg ticket show`.
    jget() { cat; }
    # Stub wg(): `ticket show` echoes the status (empty ⇒ simulated fetch failure
    # ⇒ non-zero); `review reject` / `block` succeed or fail per _MOVE.
    wg() {
      case "$1 $2" in
        "ticket show")
          [ -n "$_STATUS" ] || return 1
          printf "%s" "$_STATUS"; return 0 ;;
        "review reject") [ "$_MOVE" = "ok" ] && return 0 || return 1 ;;
        "block "*|"block") [ "$_MOVE" = "ok" ] && return 0 || return 1 ;;
        *) return 0 ;;
      esac
    }

    # ── verbatim from tick.sh (empty-delivery transition) ──
    _CUR_STATUS="$(wg ticket show "$NUM" 2>/dev/null | jget "d['"'"'ticket'"'"']['"'"'status'"'"']" 2>/dev/null || echo '"'"''"'"')"
    if [ -z "$_CUR_STATUS" ]; then
      log "EMPTY: WARNING — could not read status for #$NUM (status fetch returned empty); cannot confirm the in_review→refining transition. Attempting a block as a fallback."
      if wg block "$NUM" --reason "empty delivery: agent produced no change — needs clarification/refinement (status unknown — fetch failed)" >/dev/null 2>&1; then
        log "EMPTY: blocked #$NUM (status unknown)"
      else
        log "EMPTY: WARNING — could not block #$NUM after empty delivery (status unknown); ticket may be drifting — needs a human"
      fi
    elif [ "$_CUR_STATUS" = "in_review" ]; then
      if wg review reject "$NUM" --to refining --reviewer factory-empty \
        --reason "empty delivery: agent produced no change — needs clarification/refinement" >/dev/null 2>&1; then
        log "EMPTY: parked #$NUM (in_review → refining)"
      else
        log "EMPTY: WARNING — failed to move #$NUM (in_review → refining) after empty delivery; ticket left in in_review — needs a human"
      fi
    else
      if wg block "$NUM" --reason "empty delivery: agent produced no change — needs clarification/refinement" >/dev/null 2>&1; then
        log "EMPTY: blocked #$NUM (status '"'"'$_CUR_STATUS'"'"')"
      else
        log "EMPTY: WARNING — failed to block #$NUM (status '"'"'$_CUR_STATUS'"'"') after empty delivery; ticket may be drifting — needs a human"
      fi
    fi
    # ── end verbatim ──
  '
}

echo "== 1. in_review + a successful move → parked, no warning =="
out="$(run_case in_review ok)"
printf '%s' "$out" | grep -q "parked #4242 (in_review → refining)" && ok "logs the successful in_review → refining park" || fail "did not log the successful park"
printf '%s' "$out" | grep -q "WARNING" && fail "a happy-path move wrongly emitted a WARNING" || ok "no WARNING on the happy path"

echo "== 2. in_review + a FAILED move → a visible WARNING (not a silent pass) =="
out="$(run_case in_review fail)"
printf '%s' "$out" | grep -q "WARNING — failed to move #4242 (in_review → refining)" \
  && ok "a failed in_review move is logged as a WARNING naming the ticket + transition" \
  || fail "a failed in_review move was swallowed silently"

echo "== 3. empty status fetch → a visible WARNING + a fallback block =="
out="$(run_case "" ok)"
printf '%s' "$out" | grep -q "WARNING — could not read status for #4242" \
  && ok "an empty status fetch emits a visible WARNING" \
  || fail "an empty status fetch passed silently"
printf '%s' "$out" | grep -q "blocked #4242 (status unknown)" \
  && ok "falls back to a block rather than mis-routing" \
  || fail "did not fall back to a block on unknown status"

echo "== 4. non-review status + a FAILED block → a visible WARNING =="
out="$(run_case rejected fail)"
printf '%s' "$out" | grep -q "WARNING — failed to block #4242 (status 'rejected')" \
  && ok "a failed block is logged as a WARNING naming the ticket + status" \
  || fail "a failed block was swallowed silently"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"
  exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi

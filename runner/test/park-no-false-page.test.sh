#!/usr/bin/env bash
# =====================================================================
# N3 — a clean park/submit must NOT trigger the crash trap's "runner
# killed mid-delivery … needs a human" false page.
# ---------------------------------------------------------------------
# tick.sh's EXIT crash-cleanup trap releases a runner-held claim on a hard
# kill (SIGTERM/OOM/Ctrl-C) so a mid-delivery death doesn't strand the
# ticket. But after a LEGITIMATE park (gaffer_release_delivery) or submit
# (gaffer_submit_delivery), the claim is ALREADY resolved and the token is
# consumed. Without a guard, the EXIT trap re-ran the release with the now
# void token, which FAILED and logged a spurious "needs a human".
#
# The fix: gaffer_release_delivery / gaffer_submit_delivery raise
# GAFFER_CLAIM_RESOLVED=1 once the normal flow resolves the claim; the crash
# trap's release block skips when that flag is set. A GENUINE crash BEFORE
# any park/submit leaves it 0, so a truly stranded claim is still released.
#
# This drives that contract with a REAL token lifecycle: a stub `wg` that
# CONSUMES the claim token on the first successful release/submit and then
# FAILS any second attempt with the void token (exactly how dispatch's
# claim-gated transition behaves). We then assert, behaviourally:
#   1. PARK  → exactly ONE release; NO "runner killed mid-delivery"; NO
#              "needs a human"  (the false page is gone).
#   2. SUBMIT→ submit succeeds; the trap does NOT re-release; NO false page.
#   3. CRASH → NO park/submit happened; the trap DOES release the stranded
#              claim (the safety net still fires when it genuinely should).
#   4. control: the SAME park WITHOUT the GAFFER_CLAIM_RESOLVED guard DOES
#              emit the false "needs a human" (proves the guard is load-bearing).
#
# The release/submit helpers + trap block below are kept in step with
# tick.sh's gaffer_release_delivery / gaffer_submit_delivery / crash trap.
#
# Zero deps (bash only). Run: bash test/park-no-false-page.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/park-page.XXXXXX")"
cleanup_tmp() { rm -rf "$WORK"; }
trap cleanup_tmp EXIT

# ── Child that mirrors tick.sh's claim-resolved seam + crash trap. GUARD=1
# includes the GAFFER_CLAIM_RESOLVED guard (the fix); GUARD=0 omits it (the
# pre-fix behaviour) so we can prove the guard is what removes the false page.
# MODE = park | submit | crash. A stub `wg` consumes the token on first success.
make_child() {
  cat > "$WORK/child.sh" <<'CHILD'
set -uo pipefail
MODE="$1"; GUARD="$2"; LOG="$3"; TOKEN_STATE="$4"
NUM=10
CLAIM_TOKEN="TOK-$NUM"
DRY_RUN=0
printf '%s' "$CLAIM_TOKEN" > "$TOKEN_STATE"   # the currently-valid claim token
log() { printf '%s\n' "$*" >> "$LOG"; }

# Stub `wg`: a claim-gated transition SUCCEEDS only with the live token, which
# it then CONSUMES; any later attempt with the (now void) token FAILS — exactly
# like dispatch after the claim completes.
wg() {
  local cmd="$1"; shift
  local tok=""
  while [ "$#" -gt 0 ]; do case "$1" in --token) tok="$2"; shift 2;; *) shift;; esac; done
  case "$cmd" in
    runner-release|submit)
      local valid; valid="$(cat "$TOKEN_STATE" 2>/dev/null || true)"
      if [ -n "$tok" ] && [ "$tok" = "$valid" ]; then
        : > "$TOKEN_STATE"   # consume the token — the claim is now resolved
        return 0
      fi
      return 1               # void/consumed token → CLAIM_INVALID
      ;;
  esac
  return 0
}

GAFFER_DELIVERY_COMPLETE=0
GAFFER_PAUSE_KEEP_WORKTREE=0
GAFFER_CLAIM_RESOLVED=0

# ── mirrors tick.sh gaffer_release_delivery (token path only) ──
gaffer_release_delivery() {
  local to="$1" reason="$2"
  [ "${DRY_RUN:-0}" = "1" ] && return 0
  if [ -n "${CLAIM_TOKEN:-}" ]; then
    wg runner-release "$NUM" --to "$to" --token "$CLAIM_TOKEN" --reason "$reason" >/dev/null 2>&1 \
      && log "released claim on #$NUM → $to ($reason)" \
      || log "WARNING — could not release claim on #$NUM → $to ($reason); needs a human"
  fi
  [ "$GUARD" = "1" ] && GAFFER_CLAIM_RESOLVED=1
}

# ── mirrors tick.sh gaffer_submit_delivery (token path only) ──
gaffer_submit_delivery() {
  local reason="$1" _rc
  wg submit "$NUM" --token "$CLAIM_TOKEN" --reason "$reason" >/dev/null 2>&1
  _rc=$?
  { [ "$GUARD" = "1" ] && [ "$_rc" -eq 0 ]; } && GAFFER_CLAIM_RESOLVED=1
  return "$_rc"
}

# ── mirrors tick.sh crash trap's claim-release block ──
gaffer_crash_cleanup() {
  if [ -n "${CLAIM_TOKEN:-}" ] && [ -n "${NUM:-}" ] \
     && { [ "$GUARD" != "1" ] || [ "${GAFFER_CLAIM_RESOLVED:-0}" != "1" ]; } \
     && [ "${GAFFER_DELIVERY_COMPLETE:-0}" != "1" ] \
     && [ "${GAFFER_PAUSE_KEEP_WORKTREE:-0}" != "1" ]; then
    gaffer_release_delivery ready "runner killed mid-delivery — claim released by crash trap" || true
  fi
  return 0
}
gaffer_on_exit() { local rc=$?; trap - EXIT; gaffer_crash_cleanup; exit "$rc"; }
trap gaffer_on_exit EXIT

case "$MODE" in
  park)   gaffer_release_delivery refining "legit park: needs clarification"; exit 0 ;;
  submit) gaffer_submit_delivery "delivered; gates passed" && log "submitted #$NUM for review"; exit 0 ;;
  crash)  exit 1 ;;   # genuine crash: NO park/submit ran
esac
CHILD
}

run_child() {  # $1 mode  $2 guard → sets LOG to the produced log file
  make_child
  LOG="$WORK/log-$1-$2"; : > "$LOG"
  local ts="$WORK/tok-$1-$2"
  bash "$WORK/child.sh" "$1" "$2" "$LOG" "$ts" >/dev/null 2>&1 || true
}

count() { grep -cF "$2" "$1" 2>/dev/null || true; }

echo "== 1. PARK (with guard): exactly one release, no false page =="
run_child park 1
[ "$(count "$LOG" 'released claim on #10 → refining')" -eq 1 ] \
  && ok "the legit park released the claim once" || fail "legit park release missing/duplicated"
[ "$(count "$LOG" 'runner killed mid-delivery')" -eq 0 ] \
  && ok "crash trap did NOT re-release after a clean park" || fail "crash trap re-released after a clean park"
[ "$(count "$LOG" 'needs a human')" -eq 0 ] \
  && ok "no spurious 'needs a human' page after a clean park" || fail "false 'needs a human' page after a clean park"

echo "== 2. SUBMIT (with guard): trap does not re-release =="
run_child submit 1
[ "$(count "$LOG" 'submitted #10 for review')" -eq 1 ] \
  && ok "submit completed the claim" || fail "submit did not complete"
[ "$(count "$LOG" 'runner killed mid-delivery')" -eq 0 ] \
  && ok "crash trap did NOT re-release after a clean submit" || fail "crash trap re-released after a clean submit"
[ "$(count "$LOG" 'needs a human')" -eq 0 ] \
  && ok "no spurious 'needs a human' page after a clean submit" || fail "false page after a clean submit"

echo "== 3. CRASH (genuine): the trap STILL releases the stranded claim =="
run_child crash 1
[ "$(count "$LOG" 'runner killed mid-delivery')" -eq 1 ] \
  && ok "crash trap released the genuinely-stranded claim (safety net intact)" \
  || fail "crash trap did NOT release a stranded claim — safety net broken"

echo "== 4. control: PARK WITHOUT the guard emits the false page (guard is load-bearing) =="
run_child park 0
[ "$(count "$LOG" 'needs a human')" -ge 1 ] \
  && ok "unguarded park double-releases and pages (bug reproduced)" \
  || fail "unguarded park did not reproduce the false page — the test would not catch a regression"

echo "== 5. tick.sh wires the GAFFER_CLAIM_RESOLVED guard into the trap =="
grep -q 'GAFFER_CLAIM_RESOLVED:-0.*!= "1"' "$RUNNER_DIR/tick.sh" \
  && ok "crash trap release block is guarded by GAFFER_CLAIM_RESOLVED" \
  || fail "crash trap no longer guarded by GAFFER_CLAIM_RESOLVED"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "park-no-false-page: ALL $PASS checks passed"
  exit 0
fi
echo "park-no-false-page: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1

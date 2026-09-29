#!/usr/bin/env bash
# =====================================================================
# PR MODE LANDING — a failed PR merge HOLDS the ticket; it never becomes a local merge.
# ---------------------------------------------------------------------
# gaffer_land_delivery (lib/land.sh) used to fall back to gaffer_auto_merge when
# `gh pr merge` failed or gh was absent, then mark the ticket done — the PR stayed open
# and the remote default branch never received the change while Gaffer said "done".
# Now the ticket is HELD at ready_for_merge (rc 4, reason logged); the local fallback is
# an explicit operator opt-in (GAFFER_PR_LOCAL_FALLBACK=1). Stubbed collaborators, real
# function. Run: bash test/land-pr-hold.test.sh   (bash 3.2 safe)
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/land-hold.XXXXXX")"; trap 'rm -rf "$WORK"' EXIT
CALLS="$WORK/calls"; LOGF="$WORK/log"

# Stubs for land.sh's tick.sh-provided globals.
log() { printf '%s\n' "$*" >> "$LOGF"; }
jget() { printf 'https://github.com/o/r/pull/7'; }          # the ticket carries a pr_url
wg() { printf 'wg %s\n' "$*" >> "$CALLS"; }
gaffer_pr_merge() { printf 'pr_merge\n' >> "$CALLS"; return "${PR_RC:-1}"; }
gaffer_auto_merge() { printf 'auto_merge\n' >> "$CALLS"; return 0; }
gaffer_refresh_cards() { :; }
_gaffer_flag_on() { case "${1:-}" in 1|true|yes|on) return 0 ;; *) return 1 ;; esac; }
export GAFFER_DATA="$WORK/data"; mkdir -p "$GAFFER_DATA"; export RUNNER_DIR
# shellcheck source=../lib/land.sh
source "$RUNNER_DIR/lib/land.sh"
# The landing decision (lib/tester-binding.mjs) has its own suite (land-tester-binding);
# this one is about the PR-merge hold, on a non-git scratch dir — stub the decision in.
_gaffer_land_tester_binding() { _TB_PIN="0123456789abcdef0123456789abcdef01234567"; _TB_KIND="no-tester"; return 0; }

echo "== 1: gh merge fails ⇒ HELD (rc 4), no local merge, no mark-merged =="
: > "$CALLS"; : > "$LOGF"; unset GAFFER_PR_LOCAL_FALLBACK
PR_RC=1 gaffer_land_delivery 7 "$WORK" gaffer/ticket-7 main '{}' MERGE; rc=$?
[ "$rc" -eq 4 ] && ok "returns 4 (held)" || fail "expected rc 4, got $rc"
grep -q '^pr_merge$' "$CALLS" && ok "the PR merge was attempted" || fail "PR merge not attempted"
grep -q '^auto_merge$' "$CALLS" && fail "a LOCAL merge ran after the PR merge failed" || ok "no local merge ran"
grep -q 'mark-merged' "$CALLS" && fail "ticket was marked merged despite the failed PR merge" || ok "ticket not marked merged (stays ready_for_merge)"
grep -q 'HELD in ready_for_merge' "$LOGF" && grep -q 'GAFFER_PR_LOCAL_FALLBACK' "$LOGF" && ok "the hold is logged with the opt-in named" || fail "hold log line missing: $(cat "$LOGF")"

echo "== 2: gh absent (rc 2) ⇒ same hold =="
: > "$CALLS"; : > "$LOGF"
PR_RC=2 gaffer_land_delivery 7 "$WORK" gaffer/ticket-7 main '{}' MERGE; rc=$?
[ "$rc" -eq 4 ] && ! grep -q '^auto_merge$' "$CALLS" && ok "gh unavailable holds too (rc 4, no local merge)" || fail "gh-unavailable should hold (rc=$rc, calls: $(tr '\n' ' ' < "$CALLS"))"

echo "== 3: GAFFER_PR_LOCAL_FALLBACK=1 ⇒ the explicit local fallback (old behaviour) =="
: > "$CALLS"; : > "$LOGF"
GAFFER_PR_LOCAL_FALLBACK=1 PR_RC=1 gaffer_land_delivery 7 "$WORK" gaffer/ticket-7 main '{}' MERGE >/dev/null 2>&1; rc=$?
grep -q '^auto_merge$' "$CALLS" && ok "opted in: the local merge ran" || fail "opt-in should run the local merge"
grep -q 'falling back to a LOCAL merge' "$LOGF" && ok "opt-in fallback is logged as such" || fail "fallback log missing"

echo "== 4: PR merged upstream (rc 0 / 3 / 4) still lands as before =="
for prc in 0 3 4; do
  : > "$CALLS"; : > "$LOGF"
  PR_RC=$prc gaffer_land_delivery 7 "$WORK" gaffer/ticket-7 main '{}' MERGE >/dev/null 2>&1; rc=$?
  [ "$rc" -eq 0 ] && grep -q 'mark-merged' "$CALLS" && ! grep -q '^auto_merge$' "$CALLS" \
    && ok "gh rc $prc ⇒ landed through the PR and marked merged (no local merge)" || fail "gh rc $prc should land via the PR (rc=$rc; calls: $(tr '\n' ' ' < "$CALLS"))"
done

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "land-pr-hold: ALL $PASS checks passed"; exit 0
else echo "land-pr-hold: ${#FAILURES[@]} FAILED (of $((PASS + ${#FAILURES[@]})))"; exit 1; fi

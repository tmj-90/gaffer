#!/usr/bin/env bash
# =====================================================================
# GUARD B (recoverable delivery) + GUARD C (ask-on-cap) — runner.
# ---------------------------------------------------------------------
# Ticket #64 spent $2.56, failed rc=1 at a post-implement gate, and the
# failure path deleted the worktree AND the branch — work lost. These
# guards make a committed delivery RECOVERABLE and an ask-on-cap visible:
#
#   GUARD B  A failed downstream gate (DoD / hygiene / minimalism /
#            agent-exit) when the agent produced ≥1 commit must PRESERVE
#            the branch (worktree-only teardown), attach the gate output
#            as feedback, and retry-or-park — NEVER drop the branch.
#            INVARIANT: a delivery with ≥1 commit NEVER has its branch
#            deleted by the failure path.
#
#   GUARD C  A mid-delivery cap-hit (num_turns at/over the cap, or a
#            max-turns stop reason) must be detected from the captured
#            `claude -p --output-format json`, preserve the branch, emit a
#            notify, and park — not silent-fail+discard.
#
# This drives:
#   1. gaffer_branch_has_commits / gaffer_any_branch_has_commits — the
#      RECOVERABLE/UNRECOVERABLE discriminator — against a REAL git repo.
#   2. gaffer_is_cap_hit / gaffer_cap_num_turns / gaffer_delivery_spend —
#      cap detection from captured JSON fixtures.
#   3. The INVARIANT, end-to-end: a verbatim copy of tick.sh's
#      _recover_or_park run against a real branch with commits PRESERVES
#      the branch on BOTH the retry decision and the exhausted-attempts
#      park; an UNRECOVERABLE (0-commit) failure drops it.
#   4. Static guards against the REAL tick.sh: the DoD-fail and cap-hit
#      paths route through branch-preserving teardown (no `drop-branch`),
#      and the recoverable loop + notify emit are wired.
#
# Zero deps beyond git + node. Run: bash test/recoverable-delivery.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

command -v git  >/dev/null 2>&1 || { echo "SKIP: git required";  exit 0; }
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }

# shellcheck source=../lib/delivery-recovery.sh
source "$RUNNER_DIR/lib/delivery-recovery.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/recover-test.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT

# A real repo: one commit on the default branch (the delivery base).
REPO="$WORK/repo"
mkdir -p "$REPO"
git -C "$REPO" init -q
git -C "$REPO" config user.email t@e && git -C "$REPO" config user.name t
echo seed > "$REPO/seed.txt"; git -C "$REPO" add -A; git -C "$REPO" commit -qm seed
BASE="$(git -C "$REPO" rev-parse --abbrev-ref HEAD)"
WORK_BRANCH="gaffer/ticket-64-demo"
WORKTREES_BASE="$WORK/wts"

# Add a worktree on the ticket branch (mirrors tick.sh's setup).
mkdir -p "$WORKTREES_BASE"
WT="$WORKTREES_BASE/wt"
git -C "$REPO" worktree add -B "$WORK_BRANCH" "$WT" "$BASE" >/dev/null 2>&1
# Single-row WT_ROWS: rid \t rname \t rpath \t rbase \t rwt  (tick.sh shape).
WT_ROWS=$(printf '%s\t%s\t%s\t%s\t%s' "rid1" "demo" "$REPO" "$BASE" "$WT")
branch_exists() { git -C "$REPO" show-ref --verify --quiet "refs/heads/$WORK_BRANCH"; }

echo "== 1. discriminator: a branch with NO new commit reports no commits =="
gaffer_branch_has_commits "$WT" "$BASE" && fail "empty branch wrongly reports commits" \
  || ok "gaffer_branch_has_commits: empty branch → no commits (unrecoverable side)"
gaffer_any_branch_has_commits "$WT_ROWS" && fail "any: empty wrongly reports commits" \
  || ok "gaffer_any_branch_has_commits: all-empty → no commits"

echo "== 2. discriminator: a branch WITH a commit reports commits =="
echo work > "$WT/feature.txt"; git -C "$WT" add -A; git -C "$WT" commit -qm "deliver #64"
gaffer_branch_has_commits "$WT" "$BASE" && ok "gaffer_branch_has_commits: committed branch → has commits (recoverable side)" \
  || fail "committed branch wrongly reports no commits"
gaffer_any_branch_has_commits "$WT_ROWS" && ok "gaffer_any_branch_has_commits: a committed repo → has commits" \
  || fail "any wrongly reports no commits with a committed branch"

echo "== 3. GUARD C: cap detection from captured JSON =="
# num_turns at/over the cap → cap-hit.
printf '{"num_turns":60,"total_cost_usd":2.56,"result":"hi","stop_reason":"end_turn"}' > "$WORK/cap-over.json"
# num_turns below the cap → NOT a cap-hit.
printf '{"num_turns":12,"total_cost_usd":0.40}' > "$WORK/cap-under.json"
# explicit max-turns stop reason → cap-hit regardless of count.
printf '{"subtype":"error_max_turns","num_turns":3}' > "$WORK/cap-reason.json"
export GAFFER_CAP_DETECT_TURNS=60
[ "$(gaffer_cap_num_turns "$WORK/cap-over.json")" = "60" ] && ok "gaffer_cap_num_turns reads num_turns=60" || fail "num_turns not read"
gaffer_is_cap_hit "$WORK/cap-over.json" 0 && ok "cap-hit when num_turns ≥ cap (60≥60)" || fail "missed a cap-hit at the cap"
gaffer_is_cap_hit "$WORK/cap-under.json" 0 && fail "false cap-hit below the cap (12<60)" || ok "no cap-hit below the cap (12<60)"
gaffer_is_cap_hit "$WORK/cap-reason.json" 0 && ok "cap-hit on a max-turns stop reason (any count)" || fail "missed a max-turns stop-reason cap-hit"
# rc=124 is the WALL-CLOCK timeout guard, NOT a turn cap — not a cap-hit by count.
gaffer_is_cap_hit "$WORK/cap-under.json" 124 && fail "rc=124 (timeout) wrongly read as a turn cap" || ok "rc=124 (wall-clock timeout) is NOT a turn cap-hit"
# spend is relayed verbatim; a cap with no cost reads 'unknown', never $0.
[ "$(gaffer_delivery_spend "$WORK/cap-over.json")" = "\$2.5600" ] && ok "gaffer_delivery_spend relays total_cost_usd verbatim" || fail "spend not relayed ($(gaffer_delivery_spend "$WORK/cap-over.json"))"
[ "$(gaffer_delivery_spend "$WORK/cap-reason.json")" = "unknown" ] && ok "gaffer_delivery_spend → 'unknown' when no cost (never \$0)" || fail "missing cost should read 'unknown'"

echo "== 4. INVARIANT: _recover_or_park PRESERVES a committed branch (retry + park) =="
# A verbatim copy of tick.sh's _recover_or_park (the branch-preserving teardown is
# the load-bearing contract). It must NEVER call gaffer_cleanup_worktrees with
# drop-branch on a committed delivery. We stub wg + the move helpers to no-ops and
# assert the branch survives on BOTH the retry decision and the exhausted park.
run_recover() {
  # $1 = attempt, $2 = max → drives retry-vs-park inside _recover_or_park.
  local _attempt="$1" _max="$2"
  bash -c '
    set -uo pipefail
    REPO="'"$REPO"'"; WT="'"$WT"'"; BASE="'"$BASE"'"
    WORK_BRANCH="'"$WORK_BRANCH"'"; WORKTREES_BASE="'"$WORKTREES_BASE"'"
    NUM=64; _DELIV_ATTEMPT="'"$_attempt"'"; _MAX_DELIVERY_ATTEMPTS="'"$_max"'"
    WT_ROWS=$(printf "%s\t%s\t%s\t%s\t%s" "rid1" "demo" "$REPO" "$BASE" "$WT")
    # Stubs: the control-plane CLI + log are out of scope here.
    wg() { return 0; }
    jget() { cat >/dev/null; echo ""; }
    log() { :; }
    gaffer_skip_ticket() { :; }
    # ── verbatim teardown helper from tick.sh ──
    gaffer_cleanup_worktrees() {
      local drop_branch="${1:-}"; local _rid _rname _rpath _rbase _rwt
      while IFS=$'"'"'\t'"'"' read -r _rid _rname _rpath _rbase _rwt; do
        [ -n "$_rpath" ] || continue
        git -C "$_rpath" rev-parse --git-dir >/dev/null 2>&1 || { [ -e "$_rwt" ] && rm -rf "$_rwt"; continue; }
        [ -n "$_rwt" ] && [ -e "$_rwt" ] && { git -C "$_rpath" worktree remove --force "$_rwt" >/dev/null 2>&1 || rm -rf "$_rwt"; }
        git -C "$_rpath" worktree prune >/dev/null 2>&1 || true
        [ "$drop_branch" = "drop-branch" ] && { git -C "$_rpath" branch -D "$WORK_BRANCH" >/dev/null 2>&1 || true; }
      done <<< "$WT_ROWS"
    }
    # ── verbatim _recover_or_park from tick.sh ──
    _recover_or_park() {
      local gate="$1" feedback="$2"
      wg attach-evidence "$NUM" --type manual_note \
        --summary "REWORK ($gate, attempt $_DELIV_ATTEMPT/$_MAX_DELIVERY_ATTEMPTS): $feedback" >/dev/null 2>&1 || true
      if [ "$_DELIV_ATTEMPT" -lt "$_MAX_DELIVERY_ATTEMPTS" ]; then
        gaffer_cleanup_worktrees
        log "RECOVER retry"; _DELIV_OUTCOME="retry"; return 0
      fi
      local _cur; _cur="$(wg ticket show "$NUM" 2>/dev/null | jget x || echo "")"
      if [ "$_cur" = "in_review" ]; then
        wg review reject "$NUM" --to refining >/dev/null 2>&1 || true
      else
        wg block "$NUM" >/dev/null 2>&1 || true
      fi
      gaffer_cleanup_worktrees
      gaffer_skip_ticket "$NUM"
      _DELIV_OUTCOME="parked"; return 0
    }
    _recover_or_park "definition-of-done" "tests failed"
    echo "OUTCOME=$_DELIV_OUTCOME"
  '
}

# (a) attempt 1 of 2 → RETRY decision; branch preserved, worktree torn down.
out="$(run_recover 1 2)"
printf '%s' "$out" | grep -q "OUTCOME=retry" && ok "attempt 1/2 → retry decision" || fail "expected retry on attempt 1/2 (got: $out)"
branch_exists && ok "INVARIANT: branch SURVIVES a recoverable RETRY (worktree-only teardown)" \
  || fail "recoverable retry WRONGLY deleted the committed branch"
[ -e "$WT" ] && fail "retry left the worktree behind" || ok "retry tore down the disposable worktree"

# Re-create the worktree+commit for the park case (the branch still exists).
git -C "$REPO" worktree add "$WT" "$WORK_BRANCH" >/dev/null 2>&1
# (b) attempt 2 of 2 → PARK decision; branch STILL preserved (never dropped).
out="$(run_recover 2 2)"
printf '%s' "$out" | grep -q "OUTCOME=parked" && ok "attempt 2/2 → parked decision (attempts exhausted)" || fail "expected parked on attempt 2/2 (got: $out)"
branch_exists && ok "INVARIANT: branch SURVIVES the exhausted-attempts PARK (the #64 fix)" \
  || fail "exhausted-attempts park WRONGLY deleted the committed branch — work lost (#64 regression)"

echo "== 5. UNRECOVERABLE (0-commit) still drops the branch =="
# Fresh empty branch (no commit beyond base): the unrecoverable path drops it.
git -C "$REPO" worktree remove --force "$WT" >/dev/null 2>&1 || rm -rf "$WT"
git -C "$REPO" branch -D "$WORK_BRANCH" >/dev/null 2>&1 || true
git -C "$REPO" worktree add -B "$WORK_BRANCH" "$WT" "$BASE" >/dev/null 2>&1
gaffer_any_branch_has_commits "$WT_ROWS" \
  && fail "an empty (0-commit) branch wrongly classified recoverable" \
  || ok "0-commit branch classified UNRECOVERABLE → the failure path may drop it (clean rollback)"

echo "== 6. static guards against the REAL tick.sh =="
TICK="$RUNNER_DIR/tick.sh"
if [ -f "$TICK" ]; then
  # The DoD-fail path must route through _recover_or_park (recoverable), not a
  # bare drop-branch teardown.
  if grep -q '_recover_or_park "definition-of-done"' "$TICK"; then
    ok "tick.sh DoD-fail path routes through _recover_or_park (branch-preserving)"
  else
    fail "tick.sh DoD-fail path does NOT route through _recover_or_park"
  fi
  # PAUSE-ON-CAP: the cap-hit (GUARD C) path must now PAUSE IN PLACE — pause the
  # ticket via dispatch, raise the worktree-retention flag, and NOT tear the worktree
  # down. It must NOT fall back to the old park+teardown (no bare cap-hit cleanup).
  if grep -q 'PAUSED (cap-hit)' "$TICK" && grep -q 'wg ticket pause' "$TICK" \
     && grep -q 'GAFFER_PAUSE_KEEP_WORKTREE=1' "$TICK"; then
    ok "tick.sh cap-hit path PAUSES in place + raises the worktree-keep flag"
  else
    fail "tick.sh cap-hit path missing the pause-in-place wiring"
  fi
  # The crash-cleanup trap must skip teardown for a paused worktree (the survival
  # invariant), and orphan-recovery must protect a paused ticket's worktree.
  if grep -q 'GAFFER_PAUSE_KEEP_WORKTREE.*= "1"' "$TICK" || grep -q 'GAFFER_PAUSE_KEEP_WORKTREE:-0.*= "1"' "$TICK"; then
    ok "tick.sh crash-cleanup honours the paused worktree-keep flag"
  else
    fail "tick.sh crash-cleanup does not skip teardown for a paused worktree"
  fi
  # The recoverable loop is bounded by GAFFER_MAX_DELIVERY_ATTEMPTS.
  if grep -q 'GAFFER_MAX_DELIVERY_ATTEMPTS' "$TICK"; then
    ok "tick.sh bounds the retry loop by GAFFER_MAX_DELIVERY_ATTEMPTS"
  else
    fail "tick.sh does not bound the retry loop"
  fi
  # No regression: the SUCCESS path's final teardown is still a bare
  # gaffer_cleanup_worktrees (branch kept for review) — present in the file.
  if grep -qE '^[[:space:]]*gaffer_cleanup_worktrees[[:space:]]*$' "$TICK"; then
    ok "tick.sh success path still tears down worktree only (branch kept for review)"
  else
    fail "tick.sh success teardown changed unexpectedly"
  fi
else
  ok "SKIP static checks (tick.sh not found)"
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

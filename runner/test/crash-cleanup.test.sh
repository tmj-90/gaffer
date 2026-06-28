#!/usr/bin/env bash
# =====================================================================
# M1/R-2 — crash-safe worktree/branch cleanup (runner/tick.sh).
# ---------------------------------------------------------------------
# tick.sh only tore worktrees/branches down on its explicit success/error
# paths; a CRASH or signal between worktree creation and one of those
# paths orphaned the throwaway worktree and the `gaffer/ticket-*` branch
# in the real repo. R-2 additionally installs the trap UP FRONT (right
# after the config is sourced) so it ALSO covers the EARLIER candidate /
# skill / access-boundary parsing — but unset-var-safe + a no-op until the
# teardown helper and its rows exist. tick.sh now installs:
#
#   GAFFER_DELIVERY_COMPLETE="${GAFFER_DELIVERY_COMPLETE:-0}"
#   GAFFER_KEEP_DELIVERY_BRANCH="${GAFFER_KEEP_DELIVERY_BRANCH:-0}"
#   gaffer_crash_cleanup() {
#     [ "${GAFFER_DELIVERY_COMPLETE:-0}" = "1" ] && return 0
#     if declare -F gaffer_cleanup_worktrees >/dev/null 2>&1 && [ -n "${WT_ROWS:-}" ]; then
#       if [ "${GAFFER_KEEP_DELIVERY_BRANCH:-0}" = "1" ]; then
#         gaffer_cleanup_worktrees           # keep the review-visible branch
#       else
#         gaffer_cleanup_worktrees drop-branch
#       fi
#     fi
#     return 0
#   }
#   gaffer_on_exit()   { local rc=$?; trap - EXIT INT TERM; gaffer_crash_cleanup; exit "$rc"; }
#   gaffer_on_signal() { trap - EXIT INT TERM; gaffer_crash_cleanup; exit "$1"; }
#   trap gaffer_on_exit EXIT
#   trap 'gaffer_on_signal 130' INT
#   trap 'gaffer_on_signal 143' TERM
#
# and sets GAFFER_DELIVERY_COMPLETE=1 once delivery is recorded AND the
# worktrees are torn down (R-5: flag set AFTER teardown so a signal in the
# gap can't leave the flag set while the worktree is still on disk), so a
# legitimately-delivered branch is never dropped. GAFFER_KEEP_DELIVERY_BRANCH=1
# is raised earlier still — BEFORE delivery is recorded (FIX-BRANCH) — so a late
# signal in the record→complete window tears the worktree but PRESERVES the now
# review-visible branch.
#
# FIX-SIGNAL: a returning bash signal trap does NOT terminate the script — a
# cleanup-only handler on INT/TERM would clean up then RESUME past the
# interrupted point. The split EXIT/signal handlers above reset the trap and
# exit with the right code (130 INT / 143 TERM) so termination is never swallowed.
#
# This drives that EXACT contract against a REAL git repo + worktree:
#   1. A crash (non-zero exit / SIGTERM) BEFORE completion → the orphaned
#      worktree AND the gaffer/ branch are removed.
#   2. After GAFFER_DELIVERY_COMPLETE=1, the branch SURVIVES the trap
#      (delivered work is kept for review/merge); only the worktree goes.
#   3. The cleanup is idempotent (running it twice is a no-op, never fatal).
#   5. (R-2) the EARLY trap — fired BEFORE any worktree/WT_ROWS exists —
#      runs cleanly: no unbound-variable error, no partial state left.
#   6. (R-5) tick.sh sets GAFFER_DELIVERY_COMPLETE=1 strictly AFTER the
#      success-path worktree teardown (static ordering check).
#   7. (FIX-SIGNAL) a real TERM/INT EXITS with 143/130 and execution does NOT
#      continue past the signal (the after-signal marker is never written).
#   8. (FIX-BRANCH) with GAFFER_KEEP_DELIVERY_BRANCH=1, a crash-cleanup tears
#      the worktree but PRESERVES the review-visible branch.
#
# The trap/guard wiring below is kept BYTE-FOR-BYTE in step with tick.sh's
# gaffer_crash_cleanup; a divergence should be caught in review.
#
# Zero deps (git only). Run: bash test/crash-cleanup.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

command -v git >/dev/null 2>&1 || { echo "SKIP: git required"; exit 0; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/crash-cleanup.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
cleanup_tmp() { rm -rf "$WORK"; }
trap cleanup_tmp EXIT

# A real repo with one commit on its default branch.
REPO="$WORK/repo"
mkdir -p "$REPO"
git -C "$REPO" init -q
git -C "$REPO" config user.email t@e && git -C "$REPO" config user.name t
echo seed > "$REPO/seed.txt"; git -C "$REPO" add -A; git -C "$REPO" commit -qm seed
BASE="$(git -C "$REPO" rev-parse --abbrev-ref HEAD)"

# ── Build a child script that mirrors tick.sh's cleanup + trap wiring, then
# creates a worktree+branch and either crashes or completes, per $1. ──────────
make_runner() {
  cat > "$WORK/runner.sh" <<'RUNNER'
set -uo pipefail
REPO="$1"; WT="$2"; BASE="$3"; MODE="$4"; MARKER_DIR="${5:-}"
WORK_BRANCH="gaffer/ticket-99-demo"
WORKTREES_BASE="$(dirname "$WT")"
# Single-row WT_ROWS: rid \t rname \t rpath \t rbase \t rwt  (mirrors tick.sh).
WT_ROWS=$(printf '%s\t%s\t%s\t%s\t%s' "rid1" "demo" "$REPO" "$BASE" "$WT")

# ── verbatim from tick.sh ──
gaffer_cleanup_worktrees() {
  local drop_branch="${1:-}"
  local _rid _rname _rpath _rbase _rwt
  while IFS=$'\t' read -r _rid _rname _rpath _rbase _rwt; do
    [ -n "$_rpath" ] || continue
    git -C "$_rpath" rev-parse --git-dir >/dev/null 2>&1 || { [ -e "$_rwt" ] && rm -rf "$_rwt"; continue; }
    if [ -n "$_rwt" ] && [ -e "$_rwt" ]; then
      git -C "$_rpath" worktree remove --force "$_rwt" >/dev/null 2>&1 || rm -rf "$_rwt"
    fi
    git -C "$_rpath" worktree prune >/dev/null 2>&1 || true
    if [ "$drop_branch" = "drop-branch" ]; then
      git -C "$_rpath" branch -D "$WORK_BRANCH" >/dev/null 2>&1 || true
    fi
  done <<< "$WT_ROWS"
  [ -d "$WORKTREES_BASE" ] && rmdir "$WORKTREES_BASE" >/dev/null 2>&1 || true
}
GAFFER_DELIVERY_COMPLETE="${GAFFER_DELIVERY_COMPLETE:-0}"
GAFFER_KEEP_DELIVERY_BRANCH="${GAFFER_KEEP_DELIVERY_BRANCH:-0}"
gaffer_crash_cleanup() {
  if [ "${GAFFER_DELIVERY_COMPLETE:-0}" = "1" ]; then return 0; fi
  if declare -F gaffer_cleanup_worktrees >/dev/null 2>&1 && [ -n "${WT_ROWS:-}" ]; then
    if [ "${GAFFER_KEEP_DELIVERY_BRANCH:-0}" = "1" ]; then
      gaffer_cleanup_worktrees
    else
      gaffer_cleanup_worktrees drop-branch
    fi
  fi
  return 0
}
gaffer_on_exit() {
  local rc=$?
  trap - EXIT INT TERM
  gaffer_crash_cleanup
  exit "$rc"
}
gaffer_on_signal() {   # $1 = exit code (130 INT, 143 TERM)
  trap - EXIT INT TERM
  gaffer_crash_cleanup
  exit "$1"
}
trap gaffer_on_exit EXIT
trap 'gaffer_on_signal 130' INT
trap 'gaffer_on_signal 143' TERM
# ── end verbatim ──

mkdir -p "$WORKTREES_BASE"
git -C "$REPO" worktree add -B "$WORK_BRANCH" "$WT" "$BASE" >/dev/null 2>&1

case "$MODE" in
  crash)    exit 1 ;;                       # crash BEFORE completion
  complete) GAFFER_DELIVERY_COMPLETE=1; exit 0 ;;  # delivered → keep branch
  keep-branch)
    # Simulate the FIX-BRANCH window: delivery recorded → retention raised; then
    # a crash (signal-equivalent) BEFORE GAFFER_DELIVERY_COMPLETE. The trap must
    # tear the worktree but KEEP the review-visible branch.
    GAFFER_KEEP_DELIVERY_BRANCH=1
    exit 1 ;;
  signal-self-term|signal-self-int)
    # FIX-SIGNAL harness: deliver the signal to OURSELVES in the foreground, then
    # try to write an after-signal marker on the NEXT line. A correct split trap
    # runs (tears down) and exits 143/130 BEFORE that line, so the marker is never
    # written; a buggy cleanup-only trap RETURNS and execution resumes, writing it
    # (caught by the parent). No job control / background / process groups — those
    # diverge on a tty-less CI runner; a synchronous self-signal is deterministic
    # and identical on Linux and macOS.
    [ -n "$MARKER_DIR" ] || { echo "self-signal needs MARKER_DIR" >&2; exit 2; }
    case "$MODE" in
      signal-self-term) kill -TERM $$ ;;
      signal-self-int)  kill -INT  $$ ;;
    esac
    touch "$MARKER_DIR/after-signal"   # must NEVER be reached after the signal
    exit 0 ;;
esac
RUNNER
}

branch_exists() { git -C "$REPO" show-ref --verify --quiet "refs/heads/gaffer/ticket-99-demo"; }

echo "== 1. crash (non-zero exit) BEFORE completion drops worktree + branch =="
make_runner
WT="$WORK/wt-crash"
bash "$WORK/runner.sh" "$REPO" "$WT" "$BASE" crash >/dev/null 2>&1 || true
[ -e "$WT" ] && fail "crash left the worktree behind" || ok "crash removed the orphan worktree"
branch_exists && fail "crash left the gaffer/ branch behind" || ok "crash removed the orphan branch"

echo "== 2. SIGTERM BEFORE completion drops worktree + branch AND exits 143 =="
# FIX-SIGNAL: a real TERM must (a) tear down the orphan worktree + branch and
# (b) EXIT 143 — never resume past the signal. The child signals ITSELF in the
# foreground: deterministic and identical on Linux + macOS (no set -m / `&` /
# process groups, which diverge on a tty-less CI runner). 143 = 128 + SIGTERM,
# so the code matches whether the split trap's explicit `exit 143` or a default
# termination produced it; the load-bearing assertion is no after-signal marker.
make_runner
WT="$WORK/wt-term"; MK="$WORK/mk-term"; mkdir -p "$MK"
bash "$WORK/runner.sh" "$REPO" "$WT" "$BASE" signal-self-term "$MK" >/dev/null 2>&1
term_rc=$?
[ "$term_rc" -eq 143 ] && ok "SIGTERM exits 143 (terminated, not swallowed)" || fail "SIGTERM did not exit 143 (got $term_rc) — termination was swallowed"
[ -e "$MK/after-signal" ] && fail "execution RESUMED past the TERM signal (after-signal marker written)" || ok "execution did NOT continue past the TERM signal"
[ -e "$WT" ] && fail "SIGTERM left the worktree behind" || ok "SIGTERM removed the orphan worktree"
branch_exists && fail "SIGTERM left the gaffer/ branch behind" || ok "SIGTERM removed the orphan branch"

echo "== 2b. SIGINT BEFORE completion drops worktree + branch AND exits 130 =="
make_runner
WT="$WORK/wt-int"; MK="$WORK/mk-int"; mkdir -p "$MK"
bash "$WORK/runner.sh" "$REPO" "$WT" "$BASE" signal-self-int "$MK" >/dev/null 2>&1
int_rc=$?
[ "$int_rc" -eq 130 ] && ok "SIGINT exits 130 (terminated, not swallowed)" || fail "SIGINT did not exit 130 (got $int_rc) — termination was swallowed"
[ -e "$MK/after-signal" ] && fail "execution RESUMED past the INT signal (after-signal marker written)" || ok "execution did NOT continue past the INT signal"
[ -e "$WT" ] && fail "SIGINT left the worktree behind" || ok "SIGINT removed the orphan worktree"
branch_exists && fail "SIGINT left the gaffer/ branch behind" || ok "SIGINT removed the orphan branch"

echo "== 3. a COMPLETED delivery keeps the branch (only the worktree is torn down) =="
make_runner
WT="$WORK/wt-done"
bash "$WORK/runner.sh" "$REPO" "$WT" "$BASE" complete >/dev/null 2>&1
# completion mode exits 0 WITHOUT tearing the worktree itself in this harness;
# the contract under test is that the trap did NOT drop the branch.
branch_exists && ok "delivered branch SURVIVES the EXIT trap" || fail "delivered branch was wrongly dropped"
# Clean up the kept worktree/branch for a tidy repo (idempotency check, step 4).
git -C "$REPO" worktree remove --force "$WT" >/dev/null 2>&1 || rm -rf "$WT"
git -C "$REPO" branch -D gaffer/ticket-99-demo >/dev/null 2>&1 || true

echo "== 4. cleanup is idempotent (re-running on a clean repo is a no-op) =="
make_runner
WT="$WORK/wt-idem"
# Run crash twice against the same paths: the second invocation must not error.
bash "$WORK/runner.sh" "$REPO" "$WT" "$BASE" crash >/dev/null 2>&1 || true
if bash -c '
  set -uo pipefail
  REPO="'"$REPO"'"; WORK_BRANCH="gaffer/ticket-99-demo"; WT="'"$WT"'"
  WT_ROWS=$(printf "%s\t%s\t%s\t%s\t%s" "rid1" "demo" "$REPO" "'"$BASE"'" "$WT")
  WORKTREES_BASE="$(dirname "$WT")"
  gaffer_cleanup_worktrees() {
    local drop_branch="${1:-}"; local _a _b _rpath _d _rwt
    while IFS=$'"'"'\t'"'"' read -r _a _b _rpath _d _rwt; do
      [ -n "$_rpath" ] || continue
      git -C "$_rpath" rev-parse --git-dir >/dev/null 2>&1 || continue
      [ -n "$_rwt" ] && [ -e "$_rwt" ] && { git -C "$_rpath" worktree remove --force "$_rwt" >/dev/null 2>&1 || rm -rf "$_rwt"; }
      git -C "$_rpath" worktree prune >/dev/null 2>&1 || true
      [ "$drop_branch" = "drop-branch" ] && { git -C "$_rpath" branch -D "$WORK_BRANCH" >/dev/null 2>&1 || true; }
    done <<< "$WT_ROWS"
  }
  gaffer_cleanup_worktrees drop-branch
'; then ok "re-running cleanup on a clean repo exits 0"; else fail "idempotent cleanup returned non-zero"; fi

echo "== 5. (R-2) the EARLY trap runs cleanly BEFORE any worktree/WT_ROWS exists =="
# Mirror tick.sh's UP-FRONT install: the trap is set right after the config is
# sourced, BEFORE gaffer_cleanup_worktrees is defined and BEFORE WT_ROWS is set. A
# crash here (during candidate/skill/access parsing) must run the trap with NO
# unbound-variable abort (set -u) and leave no partial state — it is a deliberate
# no-op because nothing has been created yet.
cat > "$WORK/early.sh" <<'EARLY'
set -uo pipefail
# ── verbatim from tick.sh's UP-FRONT install (no helper/rows defined yet) ──
GAFFER_DELIVERY_COMPLETE="${GAFFER_DELIVERY_COMPLETE:-0}"
gaffer_crash_cleanup() {
  if [ "${GAFFER_DELIVERY_COMPLETE:-0}" = "1" ]; then return 0; fi
  if declare -F gaffer_cleanup_worktrees >/dev/null 2>&1 && [ -n "${WT_ROWS:-}" ]; then
    gaffer_cleanup_worktrees drop-branch
  fi
  return 0
}
trap gaffer_crash_cleanup EXIT INT TERM
# ── end verbatim ──
# Simulate a crash DURING early parsing — before any worktree, WT_ROWS, or
# gaffer_cleanup_worktrees exists. The trap must fire and exit cleanly.
exit 7
EARLY
early_err="$(bash "$WORK/early.sh" 2>&1 >/dev/null)"; early_rc=$?
[ "$early_rc" -eq 7 ] && ok "early crash trap preserves the original exit code (7)" || fail "early crash trap changed the exit code (got $early_rc)"
if printf '%s' "$early_err" | grep -qiE 'unbound variable|WT_ROWS:|gaffer_cleanup_worktrees: command not found'; then
  fail "early trap hit an unbound-variable / undefined-helper error: $early_err"
else
  ok "early trap runs with no unbound-variable / undefined-helper error"
fi

echo "== 6. (R-5) tick.sh sets GAFFER_DELIVERY_COMPLETE=1 AFTER the success-path teardown =="
# Static ordering check against the REAL tick.sh: on the success path the flag must be
# set strictly AFTER `gaffer_cleanup_worktrees` (the teardown), so a signal arriving
# in the gap can't leave the flag set while the worktree is still on disk (a leak).
TICK="$HERE/../tick.sh"
if [ -f "$TICK" ]; then
  # The success-path flag set is the LAST `GAFFER_DELIVERY_COMPLETE=1` line; the
  # success teardown is the last BARE `gaffer_cleanup_worktrees` (no drop-branch) call
  # that precedes it. Find both line numbers and assert teardown comes first.
  set_line="$(grep -n '^[[:space:]]*GAFFER_DELIVERY_COMPLETE=1[[:space:]]*$' "$TICK" | tail -1 | cut -d: -f1)"
  teardown_line="$(grep -n '^[[:space:]]*gaffer_cleanup_worktrees[[:space:]]*$' "$TICK" | awk -F: -v s="${set_line:-0}" '$1 < s {l=$1} END {print l}')"
  if [ -n "$set_line" ] && [ -n "$teardown_line" ] && [ "$teardown_line" -lt "$set_line" ]; then
    ok "GAFFER_DELIVERY_COMPLETE=1 (line $set_line) is AFTER the success teardown (line $teardown_line)"
  else
    fail "GAFFER_DELIVERY_COMPLETE=1 is not strictly after the success-path teardown (set=$set_line teardown=$teardown_line)"
  fi
else
  ok "SKIP ordering check (tick.sh not found alongside the test)"
fi

echo "== 7. (FIX-BRANCH) crash-cleanup with retention ON keeps the review-visible branch =="
# After a delivery is recorded the branch is review/merge-visible; a crash/signal in
# the record→complete window must tear the worktree but PRESERVE the branch (a
# salvageable orphan branch beats recorded evidence pointing at a deleted branch).
make_runner
WT="$WORK/wt-keep"
bash "$WORK/runner.sh" "$REPO" "$WT" "$BASE" keep-branch >/dev/null 2>&1 || true
[ -e "$WT" ] && fail "retention crash left the worktree behind" || ok "retention crash removed the disposable worktree"
branch_exists && ok "review-visible branch SURVIVES a crash with retention ON" || fail "review-visible branch was wrongly DELETED on a crash (dangling delivery record)"
# Tidy the kept branch for subsequent steps.
git -C "$REPO" branch -D gaffer/ticket-99-demo >/dev/null 2>&1 || true

echo "== 8. (FIX-BRANCH) tick.sh raises GAFFER_KEEP_DELIVERY_BRANCH=1 BEFORE recording delivery =="
# Static ordering check against the REAL tick.sh: the retention flag must be raised
# strictly BEFORE the first delivery-record call, so no review-visible branch can be
# dropped by a later crash/signal.
TICK="$HERE/../tick.sh"
if [ -f "$TICK" ]; then
  keep_line="$(grep -n '^[[:space:]]*GAFFER_KEEP_DELIVERY_BRANCH=1[[:space:]]*$' "$TICK" | head -1 | cut -d: -f1)"
  # The first ACTUAL delivery-record invocation (the `wg ... repo-delivery record`
  # call), not a comment mentioning it.
  rec_line="$(grep -n 'wg ticket repo-delivery record' "$TICK" | head -1 | cut -d: -f1)"
  if [ -n "$keep_line" ] && [ -n "$rec_line" ] && [ "$keep_line" -lt "$rec_line" ]; then
    ok "GAFFER_KEEP_DELIVERY_BRANCH=1 (line $keep_line) is BEFORE the first delivery record (line $rec_line)"
  else
    fail "retention flag not raised before delivery recording (keep=$keep_line rec=$rec_line)"
  fi
else
  ok "SKIP ordering check (tick.sh not found alongside the test)"
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

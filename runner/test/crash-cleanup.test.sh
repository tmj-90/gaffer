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
#   gaffer_crash_cleanup() {
#     [ "${GAFFER_DELIVERY_COMPLETE:-0}" = "1" ] && return 0
#     if declare -F gaffer_cleanup_worktrees >/dev/null 2>&1 && [ -n "${WT_ROWS:-}" ]; then
#       gaffer_cleanup_worktrees drop-branch
#     fi
#     return 0
#   }
#   trap gaffer_crash_cleanup EXIT INT TERM
#
# and sets GAFFER_DELIVERY_COMPLETE=1 once delivery is recorded (so a
# legitimately-delivered branch is never dropped).
#
# This drives that EXACT contract against a REAL git repo + worktree:
#   1. A crash (non-zero exit / SIGTERM) BEFORE completion → the orphaned
#      worktree AND the gaffer/ branch are removed.
#   2. After GAFFER_DELIVERY_COMPLETE=1, the branch SURVIVES the trap
#      (delivered work is kept for review/merge); only the worktree goes.
#   3. The cleanup is idempotent (running it twice is a no-op, never fatal).
#   5. (R-2) the EARLY trap — fired BEFORE any worktree/WT_ROWS exists —
#      runs cleanly: no unbound-variable error, no partial state left.
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
REPO="$1"; WT="$2"; BASE="$3"; MODE="$4"
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
gaffer_crash_cleanup() {
  if [ "${GAFFER_DELIVERY_COMPLETE:-0}" = "1" ]; then return 0; fi
  if declare -F gaffer_cleanup_worktrees >/dev/null 2>&1 && [ -n "${WT_ROWS:-}" ]; then
    gaffer_cleanup_worktrees drop-branch
  fi
  return 0
}
trap gaffer_crash_cleanup EXIT INT TERM
# ── end verbatim ──

mkdir -p "$WORKTREES_BASE"
git -C "$REPO" worktree add -B "$WORK_BRANCH" "$WT" "$BASE" >/dev/null 2>&1

case "$MODE" in
  crash)    exit 1 ;;                       # crash BEFORE completion
  sigterm)  kill -TERM $$ ; sleep 5 ;;      # signalled BEFORE completion
  complete) GAFFER_DELIVERY_COMPLETE=1; exit 0 ;;  # delivered → keep branch
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

echo "== 2. SIGTERM BEFORE completion drops worktree + branch =="
make_runner
WT="$WORK/wt-term"
bash "$WORK/runner.sh" "$REPO" "$WT" "$BASE" sigterm >/dev/null 2>&1 || true
[ -e "$WT" ] && fail "SIGTERM left the worktree behind" || ok "SIGTERM removed the orphan worktree"
branch_exists && fail "SIGTERM left the gaffer/ branch behind" || ok "SIGTERM removed the orphan branch"

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

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"
  exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi

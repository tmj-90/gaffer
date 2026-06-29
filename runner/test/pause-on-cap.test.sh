#!/usr/bin/env bash
# =====================================================================
# PAUSE-ON-CAP — runner-level end-to-end.
# ---------------------------------------------------------------------
# The cap-hit path no longer "bails to refining + tears down the worktree". On a
# mid-delivery cap it PAUSES IN PLACE: the worktree + branch (committed AND
# uncommitted work) stay ALIVE, the ticket becomes `paused`, the resume context is
# persisted, and a human's one-click Continue re-enters the SAME worktree.
#
# This drives the REAL dispatch CLI (the runner's `wg`) against a real DB + a real
# git worktree, proving the load-bearing invariants:
#   1. `wg ticket pause` moves the ticket -> paused, persists the resume context, and
#      the worktree dir STILL EXISTS afterwards (KEEP — never torn down).
#   2. orphan-recovery PROTECTS a paused ticket's worktree (it is not swept).
#   3. the crash-cleanup trap's guard is a no-op for a paused worktree (survival).
#   4. Continue marks it resume-requested; the loop's resume queue lists it.
#   5. resume-begin re-enters delivery (-> in_progress) in the SAME worktree path.
#   6. Stop abandons it (-> cancelled) and drops the resume context.
#
# Zero deps beyond git + node. Run: bash test/pause-on-cap.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
CLI="$ROOT/packages/dispatch/dist/cli/index.js"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

command -v git  >/dev/null 2>&1 || { echo "SKIP: git required";  exit 0; }
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
[ -f "$CLI" ] || { echo "SKIP: dispatch CLI not built ($CLI) — run: pnpm -C $ROOT/packages/dispatch build"; exit 0; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/pause-test.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT

export DISPATCH_DB="$WORK/dispatch.db"
wg() { node "$CLI" --db "$DISPATCH_DB" "$@"; }
jget() { python3 -c "import sys,json; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }

# A real repo + a worktree on the ticket branch (mirrors tick.sh's worktree setup),
# rooted under the deterministic GAFFER_DATA/worktrees/ticket-<N> layout.
export GAFFER_DATA="$WORK/data"
mkdir -p "$GAFFER_DATA"
REPO="$WORK/repo"
mkdir -p "$REPO"
git -C "$REPO" init -q
git -C "$REPO" config user.email t@e && git -C "$REPO" config user.name t
echo seed > "$REPO/seed.txt"; git -C "$REPO" add -A; git -C "$REPO" commit -qm seed
BASE="$(git -C "$REPO" rev-parse --abbrev-ref HEAD)"

wg init >/dev/null 2>&1
wg repo add -n svc --path "$REPO" --branch "$BASE" >/dev/null 2>&1

# Helper: drive a fresh ticket to `claimed`, returning its number.
make_claimed() {
  local num
  num="$(wg ticket create -t "big ticket" -d "lots of work" 2>/dev/null | jget "d['ticket']['number']")"
  wg ac add "$num" -t "do the thing" >/dev/null 2>&1
  wg repo link "$num" svc >/dev/null 2>&1
  wg ticket ready "$num" >/dev/null 2>&1
  local agent; agent="$(wg agent register -n factory --max-risk high 2>/dev/null | jget "d['agent']['id']")"
  wg claim-ticket "$num" -a "$agent" >/dev/null 2>&1
  echo "$num"
}

status_of() { wg ticket show "$1" 2>/dev/null | jget "d['ticket']['status']"; }

echo "== 1. wg ticket pause -> paused, resume context persisted, WORKTREE KEPT =="
NUM="$(make_claimed)"
[ -n "$NUM" ] && ok "set up claimed ticket #$NUM" || fail "could not set up a claimed ticket"
WORK_BRANCH="gaffer/ticket-$NUM-demo"
WTBASE="$GAFFER_DATA/worktrees/ticket-$NUM"; mkdir -p "$WTBASE"
WT="$WTBASE/svc"
git -C "$REPO" worktree add -B "$WORK_BRANCH" "$WT" "$BASE" >/dev/null 2>&1
echo work > "$WT/feature.txt"; git -C "$WT" add -A; git -C "$WT" commit -qm "deliver #$NUM (partial)"
echo "uncommitted-wip" > "$WT/wip.txt"   # uncommitted work that MUST also survive
WT_JSON="$(printf '[{"repo":"svc","path":"%s","base":"%s","wt":"%s"}]' "$REPO" "$BASE" "$WT")"

wg ticket pause "$NUM" --reason cap_hit --branch "$WORK_BRANCH" \
  --worktree "$WT" --worktrees-json "$WT_JSON" --repo "$REPO" \
  --attempt 1 --turns 200 --spend '$2.5600' >/dev/null 2>&1

[ "$(status_of "$NUM")" = "paused" ] && ok "ticket #$NUM is now 'paused'" || fail "ticket #$NUM not paused (got '$(status_of "$NUM")')"
[ -d "$WT" ] && ok "INVARIANT: the worktree dir SURVIVES the pause (kept alive)" || fail "pause WRONGLY removed the worktree"
[ -f "$WT/feature.txt" ] && ok "committed work preserved in the worktree" || fail "committed work lost"
[ -f "$WT/wip.txt" ] && ok "UNCOMMITTED work preserved in the worktree" || fail "uncommitted work lost"
git -C "$REPO" show-ref --verify --quiet "refs/heads/$WORK_BRANCH" && ok "the delivery branch survives the pause" || fail "branch was dropped on pause"

CTXWT="$(wg ticket paused-context "$NUM" 2>/dev/null | jget "d['context']['worktree_path']")"
[ "$CTXWT" = "$WT" ] && ok "resume context records the worktree path" || fail "resume context worktree path wrong ($CTXWT)"
CTXREASON="$(wg ticket paused-context "$NUM" 2>/dev/null | jget "d['context']['reason']")"
[ "$CTXREASON" = "cap_hit" ] && ok "resume context records the pause reason" || fail "resume context reason wrong ($CTXREASON)"

echo "== 2. orphan-recovery PROTECTS a paused ticket's worktree =="
# shellcheck source=../lib/orphan-recovery.sh
source "$RUNNER_DIR/lib/orphan-recovery.sh"
# Stub `ticket show` to report this paused ticket; sweep must NOT remove the dir.
_stub_show() { printf '{"ticket":{"status":"paused"}}'; }
export -f _stub_show
GAFFER_WG_SHOW_CMD="_stub_show" gaffer_cleanup_orphaned_worktrees >/dev/null 2>&1
[ -d "$WT" ] && ok "INVARIANT: orphan-recovery did NOT sweep the paused worktree" || fail "orphan-recovery WRONGLY swept a paused worktree"
# Sanity: a terminal (cancelled) ticket's worktree IS swept by the same function.
_stub_done() { printf '{"ticket":{"status":"cancelled"}}'; }
export -f _stub_done
GAFFER_WG_SHOW_CMD="_stub_done" gaffer_cleanup_orphaned_worktrees >/dev/null 2>&1
[ -d "$WT" ] && fail "orphan-recovery did NOT sweep a cancelled worktree (control)" || ok "control: a cancelled ticket's worktree IS swept"

echo "== 3. crash-cleanup trap is a no-op for a paused worktree (survival) =="
# Re-create the worktree (the control sweep above removed it) for the trap check.
git -C "$REPO" worktree add "$WT" "$WORK_BRANCH" >/dev/null 2>&1
# A verbatim copy of tick.sh's gaffer_crash_cleanup guard: with the keep flag set it
# returns 0 WITHOUT touching the worktree.
gaffer_cleanup_worktrees() { rm -rf "$WT"; }   # would-be teardown
gaffer_crash_cleanup() {
  if [ "${GAFFER_PAUSE_KEEP_WORKTREE:-0}" = "1" ]; then return 0; fi
  gaffer_cleanup_worktrees
}
GAFFER_PAUSE_KEEP_WORKTREE=1 gaffer_crash_cleanup
[ -d "$WT" ] && ok "INVARIANT: crash-cleanup skips teardown when GAFFER_PAUSE_KEEP_WORKTREE=1" || fail "crash-cleanup tore down a paused worktree"
unset -f gaffer_cleanup_worktrees gaffer_crash_cleanup

echo "== 4. Continue -> resume-requested; the loop's resume queue lists it =="
wg ticket continue "$NUM" >/dev/null 2>&1
RR="$(wg ticket paused-context "$NUM" 2>/dev/null | jget "d['context']['resume_requested']")"
[ "$RR" = "1" ] && ok "Continue marked the ticket resume-requested" || fail "Continue did not set resume_requested ($RR)"
QNUM="$(wg ticket resume-requested 2>/dev/null | jget "d[0]['number'] if d else ''")"
[ "$QNUM" = "$NUM" ] && ok "resume queue lists #$NUM (number enriched for the loop)" || fail "resume queue missing #$NUM (got '$QNUM')"

echo "== 5. resume-begin re-enters delivery in the SAME worktree (-> in_progress) =="
RB_WT="$(wg ticket resume-begin "$NUM" 2>/dev/null | jget "d['context']['worktree_path']")"
[ "$(status_of "$NUM")" = "in_progress" ] && ok "resume-begin moved #$NUM paused -> in_progress" || fail "resume-begin did not reach in_progress (got '$(status_of "$NUM")')"
[ "$RB_WT" = "$WT" ] && ok "INVARIANT: resume re-enters the SAME worktree path" || fail "resume worktree path changed ($RB_WT)"
[ -d "$WT" ] && ok "the worktree is still present for the resumed delivery" || fail "worktree vanished before resume"
# resume-begin cleared the resume-requested flag.
[ -z "$(wg ticket resume-requested 2>/dev/null | jget "d[0]['number'] if d else ''")" ] && ok "resume queue is drained after resume-begin" || fail "resume queue still lists the ticket after resume-begin"

echo "== 6. Stop abandons a paused delivery (-> cancelled) + drops the context =="
NUM2="$(make_claimed)"
wg ticket pause "$NUM2" --reason budget_cap --branch "gaffer/ticket-$NUM2-x" --attempt 1 --spend 'unknown' >/dev/null 2>&1
[ "$(status_of "$NUM2")" = "paused" ] && ok "second ticket #$NUM2 paused (budget_cap)" || fail "second ticket not paused"
wg ticket stop "$NUM2" --reason "not worth it" >/dev/null 2>&1
[ "$(status_of "$NUM2")" = "cancelled" ] && ok "Stop abandoned #$NUM2 -> cancelled" || fail "Stop did not cancel the ticket (got '$(status_of "$NUM2")')"
CTX2="$(wg ticket paused-context "$NUM2" 2>/dev/null | jget "d['context']")"
[ "$CTX2" = "None" ] && ok "Stop dropped the resume context" || fail "Stop left a stale resume context ($CTX2)"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"
  exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi

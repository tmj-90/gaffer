#!/usr/bin/env bash
# =====================================================================
# A-1 — orphaned-worktree recovery (lib/orphan-recovery.sh).
# ---------------------------------------------------------------------
# A killed worker leaves its per-ticket worktree dir under
# $GAFFER_DATA/worktrees/ticket-<NUM>/ behind. gaffer_cleanup_orphaned_worktrees
# sweeps the ones whose ticket is NO LONGER actively delivered
# (status ∉ {claimed,in_progress}) and PROTECTS the ones a live worker still
# owns. Dispatch access is stubbed via GAFFER_WG_SHOW_CMD so the test is hermetic.
#
#   AC1  a stale worktree whose ticket is terminal (done/failed/cancelled/…) or
#        gone is REMOVED, and its ticket number is echoed.
#   AC2  a worktree whose ticket is 'in_progress' (a LIVE concurrent worker) is
#        NOT removed.
#   AC3  a worktree whose ticket is 'claimed' (claimed, pre-delivery) is NOT removed.
#   AC4  a real git worktree is detached cleanly (the real repo loses the linked
#        worktree, not just the directory).
#   AC5  sweeping an empty/absent worktrees root is a no-op (never fatal).
#   AC6  (external review #4) POSITIVE EVIDENCE ONLY: a worktree is removed only on a
#        definite TERMINAL status (done/failed/cancelled). A worktree whose ticket status
#        is UNKNOWN (dispatch error, missing DB, unknown ticket) is KEPT and named; every
#        non-terminal ticket's worktree is kept and named, whether it looks clean, holds
#        uncommitted work, or holds only gitignored files (which `git status` cannot
#        see); DRY_RUN removes nothing; and the live loop (loop.sh) with Dispatch
#        unavailable leaves a worktree holding uncommitted work intact and says so.
#
# Run: bash test/orphan-recovery.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"

command -v git     >/dev/null 2>&1 || { echo "SKIP: git required";     exit 0; }

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/orphan-recovery.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT
export GAFFER_DATA="$WORK/data"
mkdir -p "$GAFFER_DATA/worktrees"

# shellcheck source=../lib/orphan-recovery.sh
source "$RUNNER_DIR/lib/orphan-recovery.sh"

# Stub dispatch: a per-ticket status map keyed by number. A number not in the map
# resolves to "" (treated as orphaned → sweepable).
cat > "$WORK/wg_show.sh" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  10) echo '{"ticket":{"status":"done"}}' ;;        # terminal → sweep
  11) echo '{"ticket":{"status":"failed"}}' ;;      # terminal → sweep
  12) echo '{"ticket":{"status":"cancelled"}}' ;;   # terminal → sweep
  20) echo '{"ticket":{"status":"in_progress"}}' ;; # LIVE worker → keep
  30) echo '{"ticket":{"status":"claimed"}}' ;;     # claimed → keep
  50) echo '{"ticket":{"status":"ready"}}' ;;       # ready + CLEAN worktree → keep (not terminal)
  55) echo '{"ticket":{"status":"ready"}}' ;;       # ready + only an IGNORED .env.local → keep
  60) echo '{"ticket":{"status":"ready"}}' ;;       # ready + UNCOMMITTED work → keep
  61) echo '{"ticket":{"status":"draft"}}' ;;       # non-terminal, clean → keep
  62) echo '{"ticket":{"status":"blocked"}}' ;;
  63) echo '{"ticket":{"status":"in_review"}}' ;;
  64) echo '{"ticket":{"status":"in_testing"}}' ;;
  65) echo '{"ticket":{"status":"ready_for_merge"}}' ;;
  70) echo 'dispatch: database not found' >&2; exit 1 ;; # a failed read → UNKNOWN → keep
  *)  echo '' ;;                                     # no answer → UNKNOWN → keep
esac
EOF
chmod +x "$WORK/wg_show.sh"
export GAFFER_WG_SHOW_CMD="$WORK/wg_show.sh"

# A real repo so a real linked worktree can be created + detached (AC4).
REPO="$WORK/repo"; mkdir -p "$REPO"
git -C "$REPO" init -q
git -C "$REPO" config user.email t@e; git -C "$REPO" config user.name t
echo seed > "$REPO/s.txt"; printf '.env.local\n' > "$REPO/.gitignore"
git -C "$REPO" add -A; git -C "$REPO" commit -qm seed
BASE="$(git -C "$REPO" rev-parse --abbrev-ref HEAD)"

mk_real_wt() { # <ticket-num> : a real linked worktree leaf under ticket-<num>/repo
  local num="$1"; local base="$GAFFER_DATA/worktrees/ticket-$num"
  mkdir -p "$base"
  git -C "$REPO" worktree add -B "gaffer/ticket-$num" "$base/repo" "$BASE" >/dev/null 2>&1
}
mk_plain_wt() { # <ticket-num> : a non-git stale dir (rm -rf fallback path)
  mkdir -p "$GAFFER_DATA/worktrees/ticket-$1/repo"; echo x > "$GAFFER_DATA/worktrees/ticket-$1/repo/f"
}

# Ticket 10 (done) → real worktree, must be swept + detached. 11 failed, 12 cancelled
# (the latter holding uncommitted work: a terminal ticket's worktree is disposable).
mk_real_wt 10
mk_real_wt 11
mk_real_wt 12; echo "abandoned" > "$GAFFER_DATA/worktrees/ticket-12/repo/wip.txt"
# Ticket 20 (in_progress) → live worker, must be kept.
mk_plain_wt 20
# Ticket 30 (claimed) → must be kept.
mk_plain_wt 30
# Ticket 40 (no answer) → UNKNOWN → must be KEPT (never delete on a failed read).
mk_plain_wt 40
# Ticket 50 (ready, clean real worktree) → KEPT: not terminal, it may be delivered again.
mk_real_wt 50
# Ticket 55 (ready, holding only a gitignored .env.local) → KEPT: `git status` shows
# nothing, but the file exists nowhere else.
mk_real_wt 55; echo "SECRET=local-only" > "$GAFFER_DATA/worktrees/ticket-55/repo/.env.local"
# Tickets 61–65 (draft/blocked/in_review/in_testing/ready_for_merge, clean) → KEPT.
for n in 61 62 63 64 65; do mk_real_wt "$n"; done
# Ticket 60 (ready, real worktree with uncommitted work) → kept.
mk_real_wt 60; echo "uncommitted" > "$GAFFER_DATA/worktrees/ticket-60/repo/wip.txt"
# Ticket 70 (dispatch errors) → UNKNOWN → kept.
mk_real_wt 70; echo "uncommitted" > "$GAFFER_DATA/worktrees/ticket-70/repo/wip.txt"

echo "== sweep =="
REMOVED="$(gaffer_cleanup_orphaned_worktrees 2>"$WORK/kept.log" | sort | tr '\n' ' ')"
echo "  removed: ${REMOVED:-<none>}"

echo "== AC1/AC4: terminal-ticket worktree (#10) removed + detached =="
[ ! -e "$GAFFER_DATA/worktrees/ticket-10" ] && ok "#10 worktree dir removed" || fail "#10 worktree dir still present"
grep -q "ticket-10/repo" <<<"$(git -C "$REPO" worktree list --porcelain 2>/dev/null)" \
  && fail "#10 still registered as a git worktree" || ok "#10 git worktree detached from the real repo"

echo "== AC2: in_progress worktree (#20) is PROTECTED =="
[ -e "$GAFFER_DATA/worktrees/ticket-20" ] && ok "#20 (in_progress) kept" || fail "#20 (live worker) was wrongly removed"

echo "== AC3: claimed worktree (#30) is PROTECTED =="
[ -e "$GAFFER_DATA/worktrees/ticket-30" ] && ok "#30 (claimed) kept" || fail "#30 (claimed) was wrongly removed"

echo "== AC6: UNKNOWN status (#40 no answer, #70 dispatch error) is KEPT and named =="
[ -e "$GAFFER_DATA/worktrees/ticket-40" ] && ok "#40 (status unknown) kept" || fail "#40 (unknown status) was deleted"
[ -f "$GAFFER_DATA/worktrees/ticket-70/repo/wip.txt" ] && ok "#70 (dispatch error) kept, uncommitted work intact" || fail "#70 deleted on a failed dispatch read"
grep -q '#70 ticket status is UNKNOWN' "$WORK/kept.log" && ok "the kept worktree is named with the reason" || fail "no 'UNKNOWN — kept' note: $(cat "$WORK/kept.log")"

echo "== AC1: every terminal status is swept (#11 failed, #12 cancelled with leftover work) =="
[ ! -e "$GAFFER_DATA/worktrees/ticket-11" ] && ok "#11 (failed) swept" || fail "#11 (failed) not swept"
[ ! -e "$GAFFER_DATA/worktrees/ticket-12" ] && ok "#12 (cancelled) swept" || fail "#12 (cancelled) not swept"

echo "== AC6: a non-terminal ticket's worktree is KEPT, clean or not (#50 #55 #60 #61-65) =="
[ -d "$GAFFER_DATA/worktrees/ticket-50/repo" ] && ok "#50 (ready, clean) kept" || fail "#50 (ready, clean) was removed"
[ -f "$GAFFER_DATA/worktrees/ticket-55/repo/.env.local" ] && ok "#55 (ready, only a gitignored .env.local) kept, the file intact" || fail "#55 deleted a worktree holding an ignored file"
[ -f "$GAFFER_DATA/worktrees/ticket-60/repo/wip.txt" ] && ok "#60 (ready, uncommitted work) kept" || fail "#60 uncommitted work deleted"
for n in 61 62 63 64 65; do
  [ -d "$GAFFER_DATA/worktrees/ticket-$n/repo" ] && ok "#$n ($("$WORK/wg_show.sh" "$n" | sed -E 's/.*"status":"([^"]+)".*/\1/'), clean) kept" || fail "#$n non-terminal worktree removed"
done
grep -q '#55 ticket is ready, not terminal — kept' "$WORK/kept.log" && ok "#55 kept with the reason on stderr" || fail "no not-terminal note for #55: $(cat "$WORK/kept.log")"
grep -q '#63 ticket is in_review, not terminal — kept' "$WORK/kept.log" && ok "#63 kept with its status named" || fail "no not-terminal note for #63"

echo "== echoed removals =="
case " $REMOVED " in *" 10 "*) ok "echoed #10";; *) fail "did not echo #10";; esac
case " $REMOVED " in *" 11 "*) ok "echoed #11";; *) fail "did not echo #11";; esac
case " $REMOVED " in *" 12 "*) ok "echoed #12";; *) fail "did not echo #12";; esac
[ "$REMOVED" = "10 11 12 " ] && ok "only the terminal tickets were removed ($REMOVED)" || fail "removed set is '$REMOVED', expected '10 11 12 '"
case " $REMOVED " in *" 20 "*) fail "wrongly echoed #20";; *) ok "did not echo #20";; esac

echo "== AC6: DRY_RUN removes nothing =="
mk_real_wt 80
cat > "$WORK/wg_done.sh" <<'EOF2'
#!/usr/bin/env bash
echo '{"ticket":{"status":"done"}}'
EOF2
chmod +x "$WORK/wg_done.sh"
DRY_OUT="$(DRY_RUN=1 GAFFER_WG_SHOW_CMD="$WORK/wg_done.sh" gaffer_cleanup_orphaned_worktrees 2>&1)"
[ -e "$GAFFER_DATA/worktrees/ticket-80" ] && ok "DRY_RUN kept even a done ticket's worktree" || fail "DRY_RUN deleted a worktree"
case "$DRY_OUT" in *"DRY_RUN: would remove the leftover worktree of #80"*) ok "DRY_RUN says what it would remove" ;; *) fail "DRY_RUN output: $DRY_OUT" ;; esac

echo "== AC6: the live loop with Dispatch UNAVAILABLE keeps uncommitted work and says so =="
LW="$WORK/loop"; mkdir -p "$LW/.gaffer/worktrees"
git -C "$REPO" worktree add -q -b gaffer/ticket-90-x "$LW/.gaffer/worktrees/ticket-90/repo" "$BASE" >/dev/null 2>&1
echo "uncommitted" > "$LW/.gaffer/worktrees/ticket-90/repo/wip.txt"
printf '#!/bin/sh\necho "{\\"type\\":\\"result\\",\\"result\\":\\"stub\\"}"\n' > "$WORK/claude"; chmod +x "$WORK/claude"
for dry in 1 0; do
  LOUT="$(env -u GAFFER_WG_SHOW_CMD GAFFER_DATA="$LW/.gaffer" DISPATCH_DB="$LW/.gaffer/missing/dispatch.sqlite" \
    MEMORY_DB="$LW/.gaffer/memory.sqlite" DISPATCH_AUDIT="$LW/.gaffer/audit.jsonl" CLAUDE_BIN="$WORK/claude" \
    DRY_RUN=$dry MAX_TICKS=1 EMPTY_POLL_LIMIT=1 perl -e 'alarm shift; exec @ARGV' 120 bash "$RUNNER_DIR/loop.sh" 2>&1)"
  [ -f "$LW/.gaffer/worktrees/ticket-90/repo/wip.txt" ] && ok "loop (DRY_RUN=$dry, no DB): the worktree with uncommitted work is intact" \
    || fail "loop (DRY_RUN=$dry) deleted the worktree: $(printf '%s' "$LOUT" | tail -5 | tr '\n' '|')"
  case "$LOUT" in *"worktree preserved: #90 ticket status is UNKNOWN"*) ok "loop (DRY_RUN=$dry) says the worktree was preserved and why" ;; *) fail "loop did not say so: $(printf '%s' "$LOUT" | head -8 | tr '\n' '|')" ;; esac
done

echo "== AC5: empty/absent root is a no-op =="
rm -rf "$GAFFER_DATA/worktrees"
gaffer_cleanup_orphaned_worktrees >/dev/null 2>&1 && ok "absent worktrees root → no-op exit 0" || fail "absent root returned non-zero"

echo "== AC6: the dashboard's Poll (bin/poll-once.sh) sweeps too, like loop.sh =="
# A factory driven only by Poll for work never runs loop.sh, so a Stopped pause's
# worktree was never reaped. Both entry points must call the sweep.
for f in "$RUNNER_DIR/loop.sh" "$RUNNER_DIR/bin/poll-once.sh"; do
  grep -q 'gaffer_cleanup_orphaned_worktrees' "$f" && ok "$(basename "$f") calls gaffer_cleanup_orphaned_worktrees" \
    || fail "$(basename "$f") never sweeps orphaned worktrees"
done

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"; exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
